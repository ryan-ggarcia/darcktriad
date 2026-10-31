//! Caso de uso do projeto aberto: detecta o tipo da pasta e, no CMake, configura e lista os alvos.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::tools::tool;
use crate::{
    BuildConfig, CMakeProblem, CMakeTarget, Error, ErrorKind, FileApi, FileSystem, Platform,
    ProcessRunner, ProjectChoice, ProjectKind, Result, ToolProbe, ToolStatus, cmake_build_dir,
    cmake_configure_args, cmake_preset_args, detect_project, is_hidden, parse_build_dir,
    parse_cmake_error, parse_preset_names,
};

/// Quanto esperar depois do último salvamento de um arquivo do CMake para reconfigurar.
const RECONFIGURE_DELAY: Duration = Duration::from_secs(1);
/// A detecção lê a raiz e 2 níveis abaixo (os `.csproj`).
const DETECT_DEPTH: usize = 3;
const DEBUG_RELEASE: [&str; 2] = ["Debug", "Release"];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ProjectStatus {
    /// Nada a configurar: sem projeto, ou .NET (ainda não configurado nesta versão).
    #[default]
    Idle,
    Configuring,
    Ready,
    Failed {
        message: String,
    },
}

/// Um item do painel Problemas.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub file: PathBuf,
    pub line: u32,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectState {
    pub root: Option<PathBuf>,
    pub kind: ProjectKind,
    pub warning: Option<&'static str>,
    pub configs: Vec<String>,
    pub config: Option<String>,
    pub status: ProjectStatus,
    /// A pasta de build da última configuração que deu certo.
    pub build_dir: Option<PathBuf>,
    pub targets: Vec<CMakeTarget>,
    pub target: Option<String>,
    /// Os erros da configuração atual.
    pub problems: Vec<Problem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
// Cada evento vive só até ser enviado à interface; caixa no estado seria só ruído (o lint dispara no Windows).
#[allow(clippy::large_enum_variant)]
pub enum ProjectEvent {
    /// Uma linha do canal CMake da Saída.
    Output { line: String },
    /// O estado mudou (inclusive um problema novo).
    State { state: ProjectState },
}

struct Inner {
    state: ProjectState,
    /// Aumenta a cada configuração pedida: o que uma configuração antiga produz é descartado.
    generation: u64,
    cancel: Arc<AtomicBool>,
    /// Quando reconfigurar por causa de um salvamento; `None` sem reconfiguração pendente.
    reconfigure_at: Option<Instant>,
}

type Configured = std::result::Result<(PathBuf, Vec<CMakeTarget>), String>;

/// Caso de uso: o projeto da pasta aberta.
pub struct Project<F, R, A, T> {
    fs: F,
    runner: R,
    file_api: A,
    tools: T,
    platform: Platform,
    delay: Duration,
    on_event: Box<dyn Fn(ProjectEvent) + Send + Sync>,
    inner: Mutex<Inner>,
    /// Segurado durante a configuração: a próxima só começa depois que o processo anterior morreu.
    running: Mutex<()>,
}

impl<F, R, A, T> Project<F, R, A, T>
where
    F: FileSystem + 'static,
    R: ProcessRunner + 'static,
    A: FileApi + 'static,
    T: ToolProbe + 'static,
{
    /// Os eventos chegam por `on_event`, da thread que configura.
    pub fn new(
        fs: F,
        runner: R,
        file_api: A,
        tools: T,
        on_event: impl Fn(ProjectEvent) + Send + Sync + 'static,
    ) -> Self {
        Self {
            fs,
            runner,
            file_api,
            tools,
            platform: Platform::current(),
            delay: RECONFIGURE_DELAY,
            on_event: Box::new(on_event),
            inner: Mutex::new(Inner {
                state: ProjectState::default(),
                generation: 0,
                cancel: Arc::default(),
                reconfigure_at: None,
            }),
            running: Mutex::default(),
        }
    }

    pub fn state(&self) -> ProjectState {
        self.lock().state.clone()
    }

    /// A configuração e o alvo escolhidos, para guardar por pasta.
    pub fn choice(&self) -> ProjectChoice {
        let state = &self.lock().state;
        ProjectChoice {
            config: state.config.clone(),
            target: state.target.clone(),
        }
    }

    /// Detecta o projeto de `root` e, se for CMake, configura. Volta quando a configuração termina.
    pub fn open(&self, root: &Path, choice: ProjectChoice) {
        let detected = detect_project(&self.files_of(root));
        let cmake = is_cmake(detected.kind);
        {
            let mut inner = self.lock();
            stop(&mut inner);
            let configs: Vec<String> = match detected.kind {
                ProjectKind::CMake => DEBUG_RELEASE.map(String::from).into(),
                _ => Vec::new(),
            };
            inner.state = ProjectState {
                root: Some(root.into()),
                kind: detected.kind,
                warning: detected.warning,
                // Com presets, a lista só chega na configuração.
                config: match detected.kind {
                    ProjectKind::CMakePresets => choice.config,
                    _ => pick(choice.config, configs.iter().map(String::as_str)),
                },
                configs,
                target: choice.target,
                ..ProjectState::default()
            };
            self.emit_state(&inner);
        }
        if cmake {
            let _ = self.configure();
        }
    }

    /// Esquece o projeto. Uma configuração em andamento é cancelada, e o cmake já morreu na volta.
    pub fn close(&self) {
        {
            let mut inner = self.lock();
            stop(&mut inner);
            inner.state = ProjectState::default();
            inner.reconfigure_at = None;
        }
        drop(lock(&self.running));
    }

    /// Troca a configuração ativa. Não configura: chame [`Self::configure`] em seguida.
    pub fn select_config(&self, name: &str) -> Result<()> {
        let mut inner = self.lock();
        if !inner.state.configs.iter().any(|config| config == name) {
            return Err(unknown("Configuração não encontrada", name));
        }
        inner.state.config = Some(name.into());
        Ok(())
    }

    pub fn select_target(&self, name: &str) -> Result<()> {
        let mut inner = self.lock();
        if !inner.state.targets.iter().any(|target| target.name == name) {
            return Err(unknown("Alvo não encontrado", name));
        }
        inner.state.target = Some(name.into());
        self.emit_state(&inner);
        Ok(())
    }

    /// Configura o projeto CMake aberto e volta quando termina. Uma configuração em andamento é
    /// cancelada. O resultado (pronto ou erro do CMake) fica no estado, não no `Result`.
    pub fn configure(&self) -> Result<()> {
        let (generation, cancel, root, kind) = self.begin()?;
        let _running = lock(&self.running);
        if self.lock().generation != generation {
            return Ok(());
        }
        let result = self.run_configure(generation, &cancel, &root, kind);
        self.finish(generation, result);
        Ok(())
    }

    /// Reconfigura quando um arquivo do CMake de `paths` foi salvo, 1 s depois do último
    /// salvamento. Ignora o que o próprio CMake grava nas pastas de build.
    pub fn files_changed(self: &Arc<Self>, paths: &[PathBuf]) {
        let Some(root) = self.state().root else {
            return;
        };
        if !paths.iter().any(|path| self.is_cmake_source(&root, path)) {
            return;
        }
        let mut inner = self.lock();
        if !is_cmake(inner.state.kind) {
            return;
        }
        let waiting = inner.reconfigure_at.is_some();
        inner.reconfigure_at = Some(Instant::now() + self.delay);
        if !waiting {
            let project = Arc::clone(self);
            thread::spawn(move || project.reconfigure_when_quiet());
        }
    }

    fn reconfigure_when_quiet(&self) {
        loop {
            let mut inner = self.lock();
            // `close` desiste da reconfiguração.
            let Some(at) = inner.reconfigure_at else {
                return;
            };
            let now = Instant::now();
            if now >= at {
                inner.reconfigure_at = None;
                break;
            }
            drop(inner);
            thread::sleep(at - now);
        }
        let _ = self.configure();
    }

    fn is_cmake_source(&self, root: &Path, path: &Path) -> bool {
        let name = path.file_name().and_then(OsStr::to_str).unwrap_or_default();
        let cmake_file = matches!(
            name,
            "CMakeLists.txt" | "CMakePresets.json" | "CMakeUserPresets.json"
        ) || name.ends_with(".cmake");
        // Toda pasta de build tem `CMakeFiles`; sem este filtro, configurar dispararia outra configuração.
        let generated = || {
            path.ancestors()
                .skip(1)
                .take_while(|dir| dir.starts_with(root))
                .any(|dir| self.fs.is_dir(&dir.join("CMakeFiles")))
        };
        cmake_file && path.starts_with(root) && !generated()
    }

    /// Os itens da raiz e de até 2 níveis abaixo, relativos a ela, para [`detect_project`].
    fn files_of(&self, root: &Path) -> Vec<PathBuf> {
        let mut files = Vec::new();
        let mut dirs = vec![PathBuf::new()];
        while let Some(dir) = dirs.pop() {
            let Ok(entries) = self.fs.read_dir(&root.join(&dir)) else {
                continue;
            };
            for entry in entries {
                let relative = dir.join(&entry.name);
                if entry.is_dir
                    && !entry.is_symlink
                    && relative.components().count() < DETECT_DEPTH
                    && !is_hidden(&relative)
                {
                    dirs.push(relative.clone());
                }
                files.push(relative);
            }
        }
        files
    }

    fn begin(&self) -> Result<(u64, Arc<AtomicBool>, PathBuf, ProjectKind)> {
        let mut inner = self.lock();
        let kind = inner.state.kind;
        let root = (inner.state.root.clone())
            .filter(|_| is_cmake(kind))
            .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "A pasta aberta não é CMake"))?;
        stop(&mut inner);
        let state = &mut inner.state;
        state.status = ProjectStatus::Configuring;
        state.build_dir = None;
        state.targets.clear();
        state.problems.clear();
        self.emit_state(&inner);
        Ok((inner.generation, Arc::clone(&inner.cancel), root, kind))
    }

    fn run_configure(
        &self,
        generation: u64,
        cancel: &AtomicBool,
        root: &Path,
        kind: ProjectKind,
    ) -> Configured {
        let cmake = self.find_cmake()?;
        let build_dir = if kind == ProjectKind::CMakePresets {
            let presets = self.list_presets(generation, cancel, &cmake, root)?;
            let preset = self
                .update(generation, |state| {
                    state.config = pick(state.config.take(), presets.iter().map(String::as_str));
                    state.configs = presets;
                    state.config.clone()
                })
                .flatten()
                .ok_or("Configuração cancelada.")?;
            let args = cmake_preset_args(&preset);
            let build_dir = self
                .run_cmake(generation, cancel, &cmake, &args, root)?
                .ok_or(
                    "O CMake não informou a pasta de build (\"Build files have been written to\").",
                )?;
            // Na primeira vez a consulta ainda não existia: configura de novo para ter os alvos.
            if self.file_api.write_query(&build_dir).map_err(query_error)? {
                self.run_cmake(generation, cancel, &cmake, &args, root)?;
            }
            build_dir
        } else {
            let config = match self.lock().state.config.as_deref() {
                Some("Release") => BuildConfig::Release,
                _ => BuildConfig::Debug,
            };
            let has_ninja = matches!(tool("ninja").check(&self.tools), ToolStatus::Present { .. });
            let args = cmake_configure_args(root, config, has_ninja, self.platform)
                .map_err(|error| error.message)?;
            let build_dir = cmake_build_dir(root, config);
            self.file_api.write_query(&build_dir).map_err(query_error)?;
            self.run_cmake(generation, cancel, &cmake, &args, root)?;
            build_dir
        };
        let targets = self
            .file_api
            .executables(&build_dir)
            .map_err(|error| error.message)?;
        Ok((build_dir, targets))
    }

    fn find_cmake(&self) -> std::result::Result<PathBuf, String> {
        let cmake = tool("cmake");
        match cmake.check(&self.tools) {
            ToolStatus::Present { path, .. } => Ok(path),
            _ => Err(format!(
                "Para configurar o projeto é preciso o cmake {} ou mais novo. {}",
                cmake.minimum.unwrap_or_default(),
                cmake.install
            )),
        }
    }

    fn list_presets(
        &self,
        generation: u64,
        cancel: &AtomicBool,
        cmake: &Path,
        root: &Path,
    ) -> std::result::Result<Vec<String>, String> {
        let mut lines = Vec::new();
        let success = self
            .runner
            .run(
                cmake,
                &["--list-presets".into()],
                root,
                cancel,
                &mut |line| {
                    lines.push(line.to_owned());
                },
            )
            .map_err(run_error)?;
        let presets = parse_preset_names(&lines.join("\n"));
        if success && !presets.is_empty() {
            return Ok(presets);
        }
        for line in lines {
            self.output(generation, line);
        }
        Err("Nenhum preset de configuração disponível: confira o CMakePresets.json.".into())
    }

    /// Roda o cmake com a saída indo ao vivo para o canal CMake. Devolve a pasta de build que ele
    /// informou.
    fn run_cmake(
        &self,
        generation: u64,
        cancel: &AtomicBool,
        cmake: &Path,
        args: &[OsString],
        root: &Path,
    ) -> std::result::Result<Option<PathBuf>, String> {
        let command = std::iter::once(cmake.as_os_str())
            .chain(args.iter().map(OsString::as_os_str))
            .map(OsStr::to_string_lossy)
            .collect::<Vec<_>>()
            .join(" ");
        self.output(generation, format!("> {command}"));
        let mut build_dir = None;
        // O texto do erro vem na linha seguinte à do arquivo.
        let mut pending: Option<CMakeProblem> = None;
        let success = self
            .runner
            .run(cmake, args, root, cancel, &mut |line| {
                self.output(generation, line.to_owned());
                if let Some(dir) = parse_build_dir(line) {
                    build_dir = Some(dir);
                }
                if let Some(problem) = parse_cmake_error(line) {
                    if let Some(previous) = pending.replace(problem) {
                        self.add_problem(generation, root, previous, "");
                    }
                } else if !line.trim().is_empty()
                    && let Some(problem) = pending.take()
                {
                    self.add_problem(generation, root, problem, line.trim());
                }
            })
            .map_err(run_error)?;
        if let Some(problem) = pending {
            self.add_problem(generation, root, problem, "");
        }
        if !success {
            return Err("O CMake terminou com erro: veja o canal CMake da Saída.".into());
        }
        Ok(build_dir)
    }

    fn finish(&self, generation: u64, result: Configured) {
        let mut inner = self.lock();
        if inner.generation != generation {
            return;
        }
        let state = &mut inner.state;
        match result {
            Ok((build_dir, targets)) => {
                state.target = pick(
                    state.target.take(),
                    targets.iter().map(|target| target.name.as_str()),
                );
                state.build_dir = Some(build_dir);
                state.targets = targets;
                state.status = ProjectStatus::Ready;
            }
            Err(message) => state.status = ProjectStatus::Failed { message },
        }
        self.emit_state(&inner);
    }

    /// Muda o estado e avisa, se `generation` ainda for a configuração atual.
    fn update<V>(&self, generation: u64, change: impl FnOnce(&mut ProjectState) -> V) -> Option<V> {
        let mut inner = self.lock();
        if inner.generation != generation {
            return None;
        }
        let value = change(&mut inner.state);
        self.emit_state(&inner);
        Some(value)
    }

    fn add_problem(&self, generation: u64, root: &Path, problem: CMakeProblem, message: &str) {
        let message = if message.is_empty() {
            "Erro do CMake"
        } else {
            message
        };
        self.update(generation, |state| {
            state.problems.push(Problem {
                file: root.join(problem.file),
                line: problem.line,
                message: message.into(),
            });
        });
    }

    fn output(&self, generation: u64, line: String) {
        // Sob o lock: uma linha atrasada não chega depois do aviso de uma configuração nova.
        let inner = self.lock();
        if inner.generation == generation {
            (self.on_event)(ProjectEvent::Output { line });
        }
    }

    fn emit_state(&self, inner: &Inner) {
        (self.on_event)(ProjectEvent::State {
            state: inner.state.clone(),
        });
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        lock(&self.inner)
    }
}

/// Cancela a configuração em andamento: o que ela ainda produzir é descartado.
fn stop(inner: &mut Inner) {
    inner.cancel.store(true, Ordering::Release);
    inner.cancel = Arc::default();
    inner.generation += 1;
}

fn is_cmake(kind: ProjectKind) -> bool {
    matches!(kind, ProjectKind::CMake | ProjectKind::CMakePresets)
}

/// O nome guardado, se ainda existir; senão o primeiro.
fn pick<'a>(
    saved: Option<String>,
    mut names: impl Iterator<Item = &'a str> + Clone,
) -> Option<String> {
    match saved {
        Some(saved) if names.clone().any(|name| name == saved) => Some(saved),
        _ => names.next().map(str::to_owned),
    }
}

fn unknown(what: &str, name: &str) -> Error {
    Error::new(ErrorKind::InvalidInput, format!("{what}: {name}"))
}

fn run_error(error: std::io::Error) -> String {
    format!("Não foi possível rodar o cmake: {error}")
}

fn query_error(error: std::io::Error) -> String {
    format!("Não foi possível criar a consulta da File API do CMake: {error}")
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::io;

    use super::*;
    use crate::Entry;

    const TIMEOUT: Duration = Duration::from_secs(5);
    const ROOT: &str = "/proj";
    const LIST_PRESETS: [&str; 4] = [
        "Available configure presets:",
        "",
        "  \"debug\"   - Debug",
        "  \"release\" - Release",
    ];

    type Log = Arc<Mutex<Vec<String>>>;
    type Script =
        dyn Fn(&[String], &AtomicBool, &mut dyn FnMut(&str)) -> io::Result<bool> + Send + Sync;

    struct FakeFs {
        root_files: Vec<&'static str>,
        dirs: Vec<PathBuf>,
    }

    impl FileSystem for FakeFs {
        fn read_dir(&self, path: &Path) -> io::Result<Vec<Entry>> {
            if path != Path::new(ROOT) {
                return Ok(Vec::new());
            }
            Ok(self
                .root_files
                .iter()
                .map(|name| Entry {
                    name: (*name).into(),
                    path: path.join(name),
                    is_dir: false,
                    is_symlink: false,
                })
                .collect())
        }

        fn is_dir(&self, path: &Path) -> bool {
            self.dirs.iter().any(|dir| dir == path)
        }
    }

    /// Anota cada processo no log e responde pelo roteiro do teste.
    struct FakeRunner {
        log: Log,
        script: Box<Script>,
    }

    impl ProcessRunner for FakeRunner {
        fn run(
            &self,
            program: &Path,
            args: &[OsString],
            _: &Path,
            cancel: &AtomicBool,
            on_line: &mut dyn FnMut(&str),
        ) -> io::Result<bool> {
            let args: Vec<String> = args.iter().map(|a| a.to_string_lossy().into()).collect();
            lock(&self.log).push(format!("{} {}", program.display(), args.join(" ")));
            (self.script)(&args, cancel, on_line)
        }
    }

    struct FakeFileApi {
        log: Log,
        queries: Mutex<HashSet<PathBuf>>,
    }

    impl FileApi for FakeFileApi {
        fn write_query(&self, build_dir: &Path) -> io::Result<bool> {
            lock(&self.log).push(format!("query {}", build_dir.display()));
            Ok(lock(&self.queries).insert(build_dir.into()))
        }

        fn executables(&self, build_dir: &Path) -> Result<Vec<CMakeTarget>> {
            Ok(["app", "tool"]
                .map(|name| CMakeTarget {
                    name: name.into(),
                    path: build_dir.join(name),
                })
                .into())
        }
    }

    #[derive(Clone, Copy)]
    struct FakeTools {
        cmake: bool,
        ninja: bool,
    }

    impl ToolProbe for FakeTools {
        fn find(&self, program: &str) -> Vec<PathBuf> {
            let found = match program {
                "cmake" => self.cmake,
                "ninja" => self.ninja,
                _ => false,
            };
            found
                .then(|| PathBuf::from(format!("/bin/{program}")))
                .into_iter()
                .collect()
        }

        fn version_output(&self, path: &Path) -> io::Result<String> {
            Ok(format!("{} version 3.28.3", path.display()))
        }
    }

    type TestProject = Project<FakeFs, FakeRunner, FakeFileApi, FakeTools>;

    struct Fixture {
        project: Arc<TestProject>,
        log: Log,
        events: Arc<Mutex<Vec<ProjectEvent>>>,
    }

    impl Fixture {
        fn new(
            root_files: &[&'static str],
            script: impl Fn(&[String], &AtomicBool, &mut dyn FnMut(&str)) -> io::Result<bool>
            + Send
            + Sync
            + 'static,
        ) -> Self {
            Self::with(
                root_files,
                FakeTools {
                    cmake: true,
                    ninja: true,
                },
                Vec::new(),
                script,
            )
        }

        fn with(
            root_files: &[&'static str],
            tools: FakeTools,
            dirs: Vec<PathBuf>,
            script: impl Fn(&[String], &AtomicBool, &mut dyn FnMut(&str)) -> io::Result<bool>
            + Send
            + Sync
            + 'static,
        ) -> Self {
            let log = Log::default();
            let events = Arc::<Mutex<Vec<ProjectEvent>>>::default();
            let sink = Arc::clone(&events);
            let mut project = Project::new(
                FakeFs {
                    root_files: root_files.into(),
                    dirs,
                },
                FakeRunner {
                    log: Arc::clone(&log),
                    script: Box::new(script),
                },
                FakeFileApi {
                    log: Arc::clone(&log),
                    queries: Mutex::default(),
                },
                tools,
                move |event| lock(&sink).push(event),
            );
            project.platform = Platform::Unix;
            // Folga larga sobre os 25 ms entre salvamentos do teste: no runner do macOS um sleep atrasa.
            project.delay = Duration::from_millis(500);
            Self {
                project: Arc::new(project),
                log,
                events,
            }
        }

        fn open(&self, choice: ProjectChoice) {
            self.project.open(Path::new(ROOT), choice);
        }

        /// Com `/` em todo sistema: no Windows o `join` do caminho de build põe `\`.
        fn log(&self) -> Vec<String> {
            lock(&self.log)
                .iter()
                .map(|line| line.replace('\\', "/"))
                .collect()
        }

        fn output(&self) -> Vec<String> {
            lock(&self.events)
                .iter()
                .filter_map(|event| match event {
                    // Com `/` em todo sistema, como em `log`.
                    ProjectEvent::Output { line } => Some(line.replace('\\', "/")),
                    ProjectEvent::State { .. } => None,
                })
                .collect()
        }

        fn statuses(&self) -> Vec<ProjectStatus> {
            lock(&self.events)
                .iter()
                .filter_map(|event| match event {
                    ProjectEvent::State { state } => Some(state.status.clone()),
                    ProjectEvent::Output { .. } => None,
                })
                .collect()
        }
    }

    fn succeed(_: &[String], _: &AtomicBool, on_line: &mut dyn FnMut(&str)) -> io::Result<bool> {
        on_line("-- Configuring done");
        Ok(true)
    }

    /// `--list-presets` lista debug e release; `--preset` informa a pasta do `binaryDir`.
    fn presets(args: &[String], _: &AtomicBool, on_line: &mut dyn FnMut(&str)) -> io::Result<bool> {
        if args[0] == "--list-presets" {
            LIST_PRESETS.iter().for_each(|line| on_line(line));
        } else {
            on_line(&format!(
                "-- Build files have been written to: /proj/out/build/{}",
                args[1]
            ));
        }
        Ok(true)
    }

    /// Um cmake que só termina quando é cancelado, e leva um tempo para morrer.
    fn die_when_cancelled(cancel: &AtomicBool, died: &AtomicBool) -> io::Result<bool> {
        let start = Instant::now();
        while !cancel.load(Ordering::Acquire) && start.elapsed() < TIMEOUT {
            thread::sleep(Duration::from_millis(1));
        }
        thread::sleep(Duration::from_millis(20));
        died.store(cancel.load(Ordering::Acquire), Ordering::Release);
        Err(io::ErrorKind::Interrupted.into())
    }

    fn configure_line(config: &str) -> String {
        format!(
            "/bin/cmake -S /proj -B /proj/build/{} -G Ninja -DCMAKE_BUILD_TYPE={config} \
             -DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
            config.to_lowercase()
        )
    }

    fn target_names(state: &ProjectState) -> Vec<&str> {
        state
            .targets
            .iter()
            .map(|target| target.name.as_str())
            .collect()
    }

    fn wait_until(done: impl Fn() -> bool) {
        let start = Instant::now();
        while !done() {
            assert!(start.elapsed() < TIMEOUT, "o tempo acabou");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn cmake_writes_the_query_then_configures_and_lists_the_targets() {
        let fixture = Fixture::new(&["CMakeLists.txt"], succeed);
        fixture.open(ProjectChoice::default());

        assert_eq!(
            fixture.log(),
            [
                "query /proj/build/debug".to_string(),
                configure_line("Debug")
            ]
        );
        let state = fixture.project.state();
        assert_eq!(state.kind, ProjectKind::CMake);
        assert_eq!(state.configs, DEBUG_RELEASE);
        assert_eq!(state.config.as_deref(), Some("Debug"));
        assert_eq!(state.status, ProjectStatus::Ready);
        assert_eq!(
            state.build_dir.as_deref(),
            Some(Path::new("/proj/build/debug"))
        );
        assert_eq!(target_names(&state), ["app", "tool"]);
        assert_eq!(state.target.as_deref(), Some("app"));
        assert_eq!(
            fixture.output(),
            [
                format!("> {}", configure_line("Debug")),
                "-- Configuring done".into()
            ]
        );
        assert_eq!(
            fixture.statuses(),
            [
                ProjectStatus::Idle,
                ProjectStatus::Configuring,
                ProjectStatus::Ready
            ]
        );
    }

    #[test]
    fn events_have_the_shape_of_the_ipc_contract() {
        let fixture = Fixture::new(&["CMakeLists.txt", "CMakePresets.json"], presets);
        fixture.open(ProjectChoice::default());
        let state = serde_json::to_value(ProjectEvent::State {
            state: fixture.project.state(),
        })
        .unwrap();
        assert_eq!(state["kind"], "state");
        assert_eq!(state["state"]["kind"], "cmakePresets");
        assert_eq!(
            state["state"]["status"],
            serde_json::json!({ "kind": "ready" })
        );
        assert_eq!(state["state"]["buildDir"], "/proj/out/build/debug");
        assert_eq!(
            state["state"]["targets"][0]["path"],
            Path::new("/proj/out/build/debug")
                .join("app")
                .to_str()
                .unwrap()
        );
        let output = serde_json::to_value(ProjectEvent::Output { line: "x".into() }).unwrap();
        assert_eq!(output, serde_json::json!({ "kind": "output", "line": "x" }));
    }

    #[test]
    fn without_ninja_unix_configures_with_makefiles() {
        let tools = FakeTools {
            cmake: true,
            ninja: false,
        };
        let fixture = Fixture::with(&["CMakeLists.txt"], tools, Vec::new(), succeed);
        fixture.open(ProjectChoice::default());
        assert!(
            fixture.log()[1].contains("-G Unix Makefiles"),
            "{:?}",
            fixture.log()
        );
    }

    #[test]
    fn presets_come_from_cmake_and_the_build_dir_from_its_output() {
        let fixture = Fixture::new(&["CMakeLists.txt", "CMakePresets.json"], presets);
        fixture.open(ProjectChoice::default());

        let configure = "/bin/cmake --preset debug -DCMAKE_EXPORT_COMPILE_COMMANDS=ON";
        // Na primeira vez a consulta não existia: configura de novo.
        assert_eq!(
            fixture.log(),
            [
                "/bin/cmake --list-presets",
                configure,
                "query /proj/out/build/debug",
                configure
            ]
        );
        let state = fixture.project.state();
        assert_eq!(state.kind, ProjectKind::CMakePresets);
        assert_eq!(state.configs, ["debug", "release"]);
        assert_eq!(state.config.as_deref(), Some("debug"));
        assert_eq!(
            state.build_dir.as_deref(),
            Some(Path::new("/proj/out/build/debug"))
        );
        assert_eq!(state.status, ProjectStatus::Ready);

        lock(&fixture.log).clear();
        fixture.project.configure().unwrap();
        assert_eq!(
            fixture.log(),
            [
                "/bin/cmake --list-presets",
                configure,
                "query /proj/out/build/debug"
            ]
        );
    }

    #[test]
    fn the_saved_choice_is_used_while_it_still_exists() {
        let fixture = Fixture::new(&["CMakeLists.txt"], succeed);
        fixture.open(ProjectChoice {
            config: Some("Release".into()),
            target: Some("tool".into()),
        });
        assert_eq!(fixture.log()[1], configure_line("Release"));
        assert_eq!(fixture.project.state().target.as_deref(), Some("tool"));

        fixture.open(ProjectChoice {
            config: Some("debug".into()),
            target: Some("core".into()),
        });
        let state = fixture.project.state();
        assert_eq!(state.config.as_deref(), Some("Debug"));
        assert_eq!(state.target.as_deref(), Some("app"));
    }

    #[test]
    fn selecting_config_and_target_checks_the_lists_and_changes_the_choice() {
        let fixture = Fixture::new(&["CMakeLists.txt"], succeed);
        fixture.open(ProjectChoice::default());

        fixture.project.select_config("Release").unwrap();
        fixture.project.select_target("tool").unwrap();
        assert_eq!(
            fixture.project.choice(),
            ProjectChoice {
                config: Some("Release".into()),
                target: Some("tool".into()),
            }
        );
        let config = fixture.project.select_config("MinSizeRel").unwrap_err();
        let target = fixture.project.select_target("core").unwrap_err();
        assert_eq!(
            (config.kind, target.kind),
            (ErrorKind::InvalidInput, ErrorKind::InvalidInput)
        );

        fixture.project.configure().unwrap();
        assert_eq!(fixture.log().last(), Some(&configure_line("Release")));
        assert_eq!(fixture.project.state().target.as_deref(), Some("tool"));
    }

    #[test]
    fn cmake_error_becomes_a_problem_and_the_state_an_error() {
        let fixed = Arc::new(AtomicBool::new(false));
        let script_fixed = Arc::clone(&fixed);
        let fixture = Fixture::new(&["CMakeLists.txt"], move |_, _, on_line| {
            if script_fixed.load(Ordering::Acquire) {
                return Ok(true);
            }
            for line in [
                "CMake Error at CMakeLists.txt:7 (add_executabl):",
                "  Unknown CMake command \"add_executabl\".",
                "",
                "CMake Error at /usr/share/cmake/x.cmake:3:",
                "-- Configuring incomplete, errors occurred!",
            ] {
                on_line(line);
            }
            Ok(false)
        });
        fixture.open(ProjectChoice::default());

        let state = fixture.project.state();
        assert!(
            matches!(state.status, ProjectStatus::Failed { .. }),
            "{:?}",
            state.status
        );
        assert!(state.targets.is_empty());
        assert_eq!(
            state.problems,
            [
                Problem {
                    file: "/proj/CMakeLists.txt".into(),
                    line: 7,
                    message: "Unknown CMake command \"add_executabl\".".into(),
                },
                Problem {
                    file: "/usr/share/cmake/x.cmake".into(),
                    line: 3,
                    message: "-- Configuring incomplete, errors occurred!".into(),
                }
            ]
        );
        assert_eq!(fixture.output().len(), 6);

        // Corrigido: a configuração seguinte limpa os problemas.
        fixed.store(true, Ordering::Release);
        fixture.project.configure().unwrap();
        let state = fixture.project.state();
        assert_eq!(state.status, ProjectStatus::Ready);
        assert!(state.problems.is_empty());
    }

    #[test]
    fn a_new_configure_kills_the_running_one_and_starts_after_it_died() {
        let died = Arc::new(AtomicBool::new(false));
        let script_died = Arc::clone(&died);
        let fixture = Fixture::new(&["CMakeLists.txt"], move |args, cancel, on_line| {
            if args.iter().any(|arg| arg == "-DCMAKE_BUILD_TYPE=Debug") {
                let result = die_when_cancelled(cancel, &script_died);
                // Linha que o processo escreveu antes de morrer: não pode aparecer.
                on_line("atrasada");
                return result;
            }
            assert!(
                script_died.load(Ordering::Acquire),
                "começou antes de o anterior morrer"
            );
            Ok(true)
        });
        let project = Arc::clone(&fixture.project);
        let first = thread::spawn(move || project.open(Path::new(ROOT), ProjectChoice::default()));
        wait_until(|| fixture.log().len() == 2);

        fixture.project.select_config("Release").unwrap();
        fixture.project.configure().unwrap();
        first.join().unwrap();

        assert_eq!(
            fixture.log(),
            [
                "query /proj/build/debug".to_string(),
                configure_line("Debug"),
                "query /proj/build/release".to_string(),
                configure_line("Release"),
            ]
        );
        let state = fixture.project.state();
        assert_eq!(state.status, ProjectStatus::Ready);
        assert_eq!(
            state.build_dir.as_deref(),
            Some(Path::new("/proj/build/release"))
        );
        assert!(!fixture.output().contains(&"atrasada".to_string()));
        assert!(
            !fixture
                .statuses()
                .iter()
                .any(|status| matches!(status, ProjectStatus::Failed { .. }))
        );
    }

    #[test]
    fn close_kills_the_running_configure_and_forgets_the_project() {
        let died = Arc::new(AtomicBool::new(false));
        let script_died = Arc::clone(&died);
        let fixture = Fixture::new(&["CMakeLists.txt"], move |_, cancel, _| {
            die_when_cancelled(cancel, &script_died)
        });
        let project = Arc::clone(&fixture.project);
        let first = thread::spawn(move || project.open(Path::new(ROOT), ProjectChoice::default()));
        wait_until(|| fixture.log().len() == 2);

        fixture.project.close();
        assert!(
            died.load(Ordering::Acquire),
            "close voltou com o cmake vivo"
        );
        first.join().unwrap();
        assert_eq!(fixture.project.state(), ProjectState::default());
        assert_eq!(
            fixture.project.configure().unwrap_err().kind,
            ErrorKind::InvalidInput
        );
    }

    #[test]
    fn missing_cmake_is_an_error_with_install_steps_and_runs_nothing() {
        let tools = FakeTools {
            cmake: false,
            ninja: true,
        };
        let fixture = Fixture::with(&["CMakeLists.txt"], tools, Vec::new(), succeed);
        fixture.open(ProjectChoice::default());

        let ProjectStatus::Failed { message } = fixture.project.state().status else {
            panic!("esperava erro");
        };
        assert!(message.contains("cmake 3.21"), "{message}");
        assert!(message.contains("cmake.org"), "{message}");
        assert!(fixture.log().is_empty());
    }

    #[test]
    fn folder_without_cmake_is_not_configured() {
        let fixture = Fixture::new(&["main.c"], succeed);
        fixture.open(ProjectChoice::default());

        let state = fixture.project.state();
        assert_eq!(
            (state.kind, state.status),
            (ProjectKind::EditOnly, ProjectStatus::Idle)
        );
        assert!(fixture.log().is_empty());
        assert_eq!(
            fixture.project.configure().unwrap_err().kind,
            ErrorKind::InvalidInput
        );
    }

    #[test]
    fn saving_cmake_files_reconfigures_once_after_the_quiet_delay() {
        let build = PathBuf::from("/proj/build/debug");
        let tools = FakeTools {
            cmake: true,
            ninja: true,
        };
        let fixture = Fixture::with(
            &["CMakeLists.txt"],
            tools,
            vec![build.join("CMakeFiles")],
            succeed,
        );
        fixture.open(ProjectChoice::default());
        lock(&fixture.log).clear();

        // O código-fonte e o que o CMake grava na pasta de build não reconfiguram.
        fixture.project.files_changed(&[
            "/proj/app/main.cpp".into(),
            build.join("cmake_install.cmake"),
            build.join("CMakeFiles/4.0/CMakeCXXCompiler.cmake"),
            "/outro/CMakeLists.txt".into(),
        ]);
        thread::sleep(Duration::from_millis(700));
        assert!(fixture.log().is_empty(), "{:?}", fixture.log());

        // Salvamentos a cada 25 ms por 200 ms, com espera de 500 ms: cada um adia a reconfiguração.
        for path in [
            "/proj/CMakeLists.txt",
            "/proj/cmake/opcoes.cmake",
            "/proj/CMakePresets.json",
        ]
        .iter()
        .cycle()
        .take(8)
        {
            fixture.project.files_changed(&[path.into()]);
            thread::sleep(Duration::from_millis(25));
        }
        wait_until(|| fixture.log().len() >= 2);
        thread::sleep(Duration::from_millis(700));
        assert_eq!(fixture.log().len(), 2, "{:?}", fixture.log());
    }
}
