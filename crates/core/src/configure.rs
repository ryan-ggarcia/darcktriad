//! Caso de uso do projeto aberto: detecta o tipo da pasta e, no CMake e no .NET, configura e lista
//! os alvos.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::tools::tool;
use crate::{
    BuildConfig, BuildProblem, CMakeProblem, CMakeTarget, DotnetProperties, Error, ErrorKind,
    FileApi, FileSystem, Platform, ProcessRunner, ProjectChoice, ProjectKind, Result, RunCommand,
    ToolProbe, ToolStatus, build_problems, cmake_build_args, cmake_build_dir, cmake_configure_args,
    cmake_preset_args, detect_project, dotnet_build_args, dotnet_property_args, dotnet_run_args,
    is_hidden, parse_build_dir, parse_cmake_error, parse_dotnet_properties, parse_msbuild_error,
    parse_preset_names, parse_solution_projects,
    project::{has_extension, located_problem},
};

/// Quanto esperar depois do último salvamento de um arquivo do projeto para reconfigurar.
const RECONFIGURE_DELAY: Duration = Duration::from_secs(1);
/// De quanto em quanto tempo a reconfiguração pendente confere se a configuração ou a compilação
/// em andamento terminou.
const BUSY_POLL: Duration = Duration::from_millis(50);
/// A detecção lê a raiz e 2 níveis abaixo (os `.csproj`).
const DETECT_DEPTH: usize = 3;
const DEBUG_RELEASE: [&str; 2] = ["Debug", "Release"];
const NO_PROGRAM: &str = "Nenhum programa para executar. Escolha um alvo na barra de status.";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ProjectStatus {
    /// Nada a configurar: sem projeto.
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
    /// A pasta de build da última configuração do CMake que deu certo; no .NET, `None`.
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
    /// Uma linha da Saída: canal CMake ou dotnet, conforme o `kind` do projeto.
    Output { line: String },
    /// O estado mudou (inclusive um problema novo).
    State { state: ProjectState },
    /// Uma linha do canal Build da Saída; `problem`, se ela citar um erro: a linha vira link.
    BuildOutput {
        line: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        problem: Option<BuildProblem>,
    },
    /// A compilação terminou. `problems` substitui os itens de origem `build`.
    BuildFinished {
        status: BuildStatus,
        problems: Vec<BuildProblem>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BuildStatus {
    Succeeded,
    Failed,
    Cancelled,
}

struct Inner {
    state: ProjectState,
    /// Aumenta a cada configuração pedida: o que uma configuração antiga produz é descartado.
    generation: u64,
    cancel: Arc<AtomicBool>,
    /// Quando reconfigurar por causa de um salvamento; `None` sem reconfiguração pendente.
    reconfigure_at: Option<Instant>,
}

type Configured = std::result::Result<(Option<PathBuf>, Vec<CMakeTarget>), String>;
/// Uma configuração começada: a geração, o cancelamento, a raiz e o tipo do projeto.
type Begun = (u64, Arc<AtomicBool>, PathBuf, ProjectKind);

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
    /// O pedido de cancelamento da compilação em andamento; `None` sem compilação.
    build: Mutex<Option<Arc<AtomicBool>>>,
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
            build: Mutex::default(),
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

    /// Detecta o projeto de `root` e, se for CMake ou .NET, configura. Volta quando a configuração
    /// termina.
    pub fn open(&self, root: &Path, choice: ProjectChoice) {
        self.cancel_build();
        let detected = detect_project(&self.files_of(root));
        {
            let mut inner = self.lock();
            stop(&mut inner);
            let configs: Vec<String> = match detected.kind {
                ProjectKind::CMakePresets | ProjectKind::EditOnly => Vec::new(),
                _ => DEBUG_RELEASE.map(String::from).into(),
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
        if detected.kind != ProjectKind::EditOnly {
            let _ = self.configure();
        }
    }

    /// Esquece o projeto. A configuração e a compilação em andamento são canceladas, e os
    /// processos já morreram na volta.
    pub fn close(&self) {
        {
            let mut inner = self.lock();
            stop(&mut inner);
            inner.state = ProjectState::default();
            inner.reconfigure_at = None;
        }
        self.cancel_build();
        drop(lock(&self.running));
        while lock(&self.build).is_some() {
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// Compila todos os alvos e volta quando termina. A saída chega ao vivo (`BuildOutput`), e o
    /// resultado em `BuildFinished`. Antes, configura se for preciso.
    pub fn build(&self) -> Result<()> {
        self.exclusive_build(|cancel| {
            let Some(state) = self.configured(cancel)? else {
                return Ok(());
            };
            self.run_build(cancel, &state, None).map(drop)
        })
    }

    /// Compila só o alvo ativo e devolve como rodá-lo, ou `None` se a compilação não deu certo.
    pub fn build_for_run(&self) -> Result<Option<RunCommand>> {
        self.exclusive_build(|cancel| {
            let Some(state) = self.configured(cancel)? else {
                return Ok(None);
            };
            let target = (state.targets.iter())
                .find(|target| Some(&target.name) == state.target.as_ref())
                .ok_or_else(|| Error::new(ErrorKind::InvalidInput, NO_PROGRAM))?;
            if self.run_build(cancel, &state, Some(target))? != BuildStatus::Succeeded {
                return Ok(None);
            }
            let cwd = state.root.clone().unwrap_or_default();
            let name = format!("▶ {}", target.name);
            Ok(Some(match &target.project {
                Some(project) => RunCommand {
                    name,
                    program: self.find_tool("dotnet").map_err(not_found)?,
                    args: dotnet_run_args(
                        project,
                        self.build_config(),
                        target.framework.as_deref(),
                    ),
                    cwd,
                    target: target.clone(),
                },
                None => RunCommand {
                    name,
                    program: target.path.clone(),
                    args: Vec::new(),
                    cwd,
                    target: target.clone(),
                },
            }))
        })
    }

    /// Cancela a compilação em andamento: o processo e os filhos dele morrem, também o cmake ou
    /// o dotnet da configuração que vem antes.
    pub fn cancel_build(&self) {
        let Some(cancel) = lock(&self.build).clone() else {
            return;
        };
        cancel.store(true, Ordering::Release);
        // shortcut: também cancela uma configuração pedida por fora durante a compilação (trocar
        // Debug/Release); ela fica com erro até a próxima. Separar se isso incomodar.
        self.lock().cancel.store(true, Ordering::Release);
    }

    fn exclusive_build<V>(&self, job: impl FnOnce(&AtomicBool) -> Result<V>) -> Result<V> {
        let cancel = {
            let mut build = lock(&self.build);
            if build.is_some() {
                return Err(Error::new(
                    ErrorKind::Other,
                    "Já há uma compilação em andamento",
                ));
            }
            Arc::clone(build.insert(Arc::default()))
        };
        let result = job(&cancel);
        lock(&self.build).take();
        result
    }

    /// O estado pronto, configurando antes se o projeto não foi configurado, se há uma
    /// reconfiguração pendente ou se a pasta de build sumiu. `None` se a compilação foi cancelada
    /// durante a configuração: o fim (`Cancelled`) já foi avisado.
    fn configured(&self, cancel: &AtomicBool) -> Result<Option<ProjectState>> {
        let start = Instant::now();
        let pending = {
            let mut inner = self.lock();
            // O usuário pode ter apagado a pasta de build: compilar nela falharia na hora.
            let deleted =
                (inner.state.build_dir.as_deref()).is_some_and(|dir| !self.fs.is_dir(dir));
            inner.reconfigure_at.take().is_some()
                || inner.state.status != ProjectStatus::Ready
                || deleted
        };
        if pending {
            self.configure()?;
        }
        if cancel.load(Ordering::Acquire) {
            self.end_build(BuildStatus::Cancelled, start, Vec::new());
            return Ok(None);
        }
        let state = self.state();
        match &state.status {
            ProjectStatus::Ready => Ok(Some(state)),
            ProjectStatus::Failed { message } => Err(Error::new(ErrorKind::Other, message.clone())),
            _ => Err(Error::new(
                ErrorKind::Other,
                "A configuração do projeto foi interrompida.",
            )),
        }
    }

    /// Roda os comandos de compilação um depois do outro, até o primeiro que falhar.
    fn run_build(
        &self,
        cancel: &AtomicBool,
        state: &ProjectState,
        target: Option<&CMakeTarget>,
    ) -> Result<BuildStatus> {
        let root = state.root.clone().unwrap_or_default();
        let (program, commands) = self.build_commands(state, &root, target)?;
        let dirs: Vec<&Path> = state
            .build_dir
            .iter()
            .map(PathBuf::as_path)
            .chain([root.as_path()])
            .collect();
        let start = Instant::now();
        let mut lines = Vec::new();
        let mut status = BuildStatus::Succeeded;
        for args in commands {
            if cancel.load(Ordering::Acquire) {
                status = BuildStatus::Cancelled;
                break;
            }
            self.build_output(format!("> {}", command_line(&program, &args)));
            let result = self
                .runner
                .run(&program, &args, &root, cancel, &mut |line| {
                    (self.on_event)(ProjectEvent::BuildOutput {
                        line: line.to_owned(),
                        problem: located_problem(line, &dirs, |path| self.fs.is_file(path)),
                    });
                    lines.push(line.to_owned());
                });
            status = match result {
                Ok(true) => continue,
                Ok(false) => BuildStatus::Failed,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                    BuildStatus::Cancelled
                }
                Err(error) => {
                    self.build_output(run_error(&program.to_string_lossy(), error));
                    BuildStatus::Failed
                }
            };
            break;
        }
        let problems = build_problems(&lines, status == BuildStatus::Failed, &dirs, |path| {
            self.fs.is_file(path)
        });
        self.end_build(status, start, problems);
        Ok(status)
    }

    /// A última linha do canal Build ("Concluída em 3,2 s") e o `BuildFinished`.
    fn end_build(&self, status: BuildStatus, start: Instant, problems: Vec<BuildProblem>) {
        let verb = match status {
            BuildStatus::Succeeded => "Concluída",
            BuildStatus::Failed => "Falhou",
            BuildStatus::Cancelled => "Cancelada",
        };
        let seconds = format!("{:.1}", start.elapsed().as_secs_f64()).replace('.', ",");
        self.build_output(format!("{verb} em {seconds} s"));
        (self.on_event)(ProjectEvent::BuildFinished { status, problems });
    }

    /// O programa e os argumentos de cada comando: um só no CMake e na solução .NET, um por
    /// `.csproj` sem solução.
    fn build_commands(
        &self,
        state: &ProjectState,
        root: &Path,
        target: Option<&CMakeTarget>,
    ) -> Result<(PathBuf, Vec<Vec<OsString>>)> {
        if is_cmake(state.kind) {
            let cmake = self.find_tool("cmake").map_err(not_found)?;
            let build_dir = state.build_dir.as_deref().unwrap_or(root);
            let target = target.map(|target| target.name.as_str());
            return Ok((cmake, vec![cmake_build_args(build_dir, target)]));
        }
        let dotnet = self.find_tool("dotnet").map_err(not_found)?;
        let files = self.files_of(root);
        let projects = match target.and_then(|target| target.project.clone()) {
            Some(project) => vec![project],
            None if state.kind == ProjectKind::DotnetSolution => {
                solution_of(root, &files).into_iter().collect()
            }
            None => csprojs_of(root, &files),
        };
        let config = self.build_config();
        let commands = projects
            .iter()
            .map(|project| dotnet_build_args(project, config))
            .collect();
        Ok((dotnet, commands))
    }

    fn build_output(&self, line: String) {
        (self.on_event)(ProjectEvent::BuildOutput {
            line,
            problem: None,
        });
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

    /// Configura o projeto aberto (CMake, ou restore e leitura dos alvos no .NET) e volta quando
    /// termina. Uma configuração em andamento é cancelada. O resultado (pronto ou erro) fica no
    /// estado, não no `Result`.
    pub fn configure(&self) -> Result<()> {
        let begun = self.begin(&mut self.lock())?;
        self.configure_begun(begun);
        Ok(())
    }

    fn configure_begun(&self, (generation, cancel, root, kind): Begun) {
        let _running = lock(&self.running);
        if self.lock().generation != generation {
            return;
        }
        let result = self.run_configure(generation, &cancel, &root, kind);
        self.finish(generation, result);
    }

    /// Reconfigura 1 s depois do último salvamento de um arquivo do projeto em `paths` (CMake,
    /// `.csproj`, `.sln`), ou quando a pasta de build sumiu. Ignora o que o próprio CMake grava
    /// nas pastas de build.
    pub fn files_changed(self: &Arc<Self>, paths: &[PathBuf]) {
        let state = self.state();
        let Some(root) = state.root else {
            return;
        };
        // No macOS os avisos chegam com o caminho real (`/private/tmp/x`, e não `/tmp/x`).
        let real_root = self.fs.canonicalize(&root).unwrap_or_else(|_| root.clone());
        let mut paths = paths
            .iter()
            .map(|path| match path.strip_prefix(&real_root) {
                Ok(relative) => root.join(relative),
                Err(_) => path.clone(),
            });
        // Sem a pasta de build (`rm -rf build`), o clangd fica sem o `compile_commands.json`.
        let build_dir_gone = (state.build_dir.as_deref()).is_some_and(|dir| !self.fs.is_dir(dir));
        if !build_dir_gone && !paths.any(|path| self.is_project_source(&root, &path, state.kind)) {
            return;
        }
        let mut inner = self.lock();
        if inner.state.kind != state.kind {
            return;
        }
        let waiting = inner.reconfigure_at.is_some();
        inner.reconfigure_at = Some(Instant::now() + self.delay);
        if !waiting {
            let project = Arc::clone(self);
            thread::spawn(move || project.reconfigure_when_quiet());
        }
    }

    /// Não interrompe a configuração nem a compilação em andamento: espera as duas terminarem.
    /// A compilação que começa antes leva a reconfiguração pendente com ela (`configured`).
    fn reconfigure_when_quiet(&self) {
        let begun = loop {
            let building = lock(&self.build).is_some();
            let mut inner = self.lock();
            // `close` e a compilação desistem da reconfiguração.
            let Some(at) = inner.reconfigure_at else {
                return;
            };
            let now = Instant::now();
            if now >= at && !building && inner.state.status != ProjectStatus::Configuring {
                inner.reconfigure_at = None;
                // Sob o mesmo lock: nenhuma configuração começa entre a conferência e esta.
                break self.begin(&mut inner);
            }
            drop(inner);
            thread::sleep(at.saturating_duration_since(now).max(BUSY_POLL));
        };
        if let Ok(begun) = begun {
            self.configure_begun(begun);
        }
    }

    fn is_project_source(&self, root: &Path, path: &Path, kind: ProjectKind) -> bool {
        let name = path.file_name().and_then(OsStr::to_str).unwrap_or_default();
        let project_file = match kind {
            ProjectKind::CMake | ProjectKind::CMakePresets => {
                matches!(
                    name,
                    "CMakeLists.txt" | "CMakePresets.json" | "CMakeUserPresets.json"
                ) || name.ends_with(".cmake")
            }
            ProjectKind::DotnetSolution | ProjectKind::DotnetProjects => ["csproj", "sln", "slnx"]
                .iter()
                .any(|extension| has_extension(name, extension)),
            ProjectKind::EditOnly => false,
        };
        // Toda pasta de build tem `CMakeFiles`; sem este filtro, configurar dispararia outra configuração.
        let generated = || {
            path.ancestors()
                .skip(1)
                .take_while(|dir| dir.starts_with(root))
                .any(|dir| self.fs.is_dir(&dir.join("CMakeFiles")))
        };
        // Só salvamentos: o que foi apagado (um `rm -rf build`, já sem `CMakeFiles`) não conta.
        project_file && path.starts_with(root) && self.fs.is_file(path) && !generated()
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

    fn begin(&self, inner: &mut Inner) -> Result<Begun> {
        let kind = inner.state.kind;
        let root = (inner.state.root.clone())
            .filter(|_| kind != ProjectKind::EditOnly)
            .ok_or_else(|| {
                Error::new(
                    ErrorKind::InvalidInput,
                    "A pasta aberta não tem projeto CMake nem .NET",
                )
            })?;
        stop(inner);
        let state = &mut inner.state;
        state.status = ProjectStatus::Configuring;
        state.build_dir = None;
        state.targets.clear();
        state.problems.clear();
        self.emit_state(inner);
        Ok((inner.generation, Arc::clone(&inner.cancel), root, kind))
    }

    fn run_configure(
        &self,
        generation: u64,
        cancel: &AtomicBool,
        root: &Path,
        kind: ProjectKind,
    ) -> Configured {
        if !is_cmake(kind) {
            return self.configure_dotnet(generation, cancel, root, kind);
        }
        let explain = |message| self.explain(generation, message);
        let cmake = self.find_tool("cmake").map_err(explain)?;
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
            let config = self.build_config();
            let has_ninja = matches!(tool("ninja").check(&self.tools), ToolStatus::Present { .. });
            let args = cmake_configure_args(root, config, has_ninja, self.platform)
                .map_err(|error| explain(error.message))?;
            let build_dir = cmake_build_dir(root, config);
            self.file_api.write_query(&build_dir).map_err(query_error)?;
            self.run_cmake(generation, cancel, &cmake, &args, root)?;
            build_dir
        };
        let targets = self
            .file_api
            .executables(&build_dir)
            .map_err(|error| error.message)?;
        Ok((Some(build_dir), targets))
    }

    /// `dotnet restore`, a lista de projetos e os alvos executáveis de cada um.
    fn configure_dotnet(
        &self,
        generation: u64,
        cancel: &AtomicBool,
        root: &Path,
        kind: ProjectKind,
    ) -> Configured {
        let dotnet =
            (self.find_tool("dotnet")).map_err(|message| self.explain(generation, message))?;
        let config = self.build_config();
        let files = self.files_of(root);
        let projects = if kind == ProjectKind::DotnetSolution {
            let solution = solution_of(root, &files).ok_or("A solução .sln sumiu da pasta.")?;
            let restore = ["restore".into(), solution.clone().into()];
            self.run_dotnet(generation, cancel, &dotnet, &restore, root, true)?;
            let list = ["sln".into(), solution.into(), "list".into()];
            let lines = self.run_dotnet(generation, cancel, &dotnet, &list, root, false)?;
            parse_solution_projects(&lines.join("\n"))
                .into_iter()
                .map(|project| root.join(project))
                .collect()
        } else {
            let projects = csprojs_of(root, &files);
            for project in &projects {
                let restore = ["restore".into(), project.into()];
                self.run_dotnet(generation, cancel, &dotnet, &restore, root, true)?;
            }
            projects
        };
        let mut targets = Vec::new();
        for project in &projects {
            let target = self.dotnet_target(generation, cancel, &dotnet, project, config, root)?;
            targets.extend(target);
        }
        Ok((None, targets))
    }

    /// O alvo de um projeto .NET, ou `None` se ele não é executável (`Exe`/`WinExe`).
    fn dotnet_target(
        &self,
        generation: u64,
        cancel: &AtomicBool,
        dotnet: &Path,
        project: &Path,
        config: BuildConfig,
        root: &Path,
    ) -> std::result::Result<Option<CMakeTarget>, String> {
        let read = |framework| {
            let args = dotnet_property_args(project, config, framework);
            let lines = self.run_dotnet(generation, cancel, dotnet, &args, root, false)?;
            parse_dotnet_properties(&lines.join("\n")).ok_or_else(|| {
                lines
                    .into_iter()
                    .for_each(|line| self.output(generation, line));
                format!(
                    "O dotnet msbuild não informou as propriedades de {}.",
                    project.display()
                )
            })
        };
        let properties: DotnetProperties = read(None)?;
        if !properties.is_executable() {
            return Ok(None);
        }
        // Com `TargetFrameworks`, o MSBuild só informa o `TargetPath` de um framework escolhido.
        let framework = properties.first_framework().map(str::to_owned);
        let properties = match &framework {
            Some(framework) => read(Some(framework))?,
            None => properties,
        };
        if properties.target_path.is_empty() {
            return Err(format!(
                "O dotnet msbuild não informou o TargetPath de {}.",
                project.display()
            ));
        }
        let name = project.file_stem().unwrap_or_default().to_string_lossy();
        Ok(Some(CMakeTarget {
            name: name.into(),
            path: properties.target_path.into(),
            project: Some(project.into()),
            framework,
        }))
    }

    /// Roda o dotnet. Com `live`, mostra o comando e a saída ao vivo no canal dotnet; sem ele, a
    /// saída só aparece se der erro. Os erros do MSBuild viram problemas.
    fn run_dotnet(
        &self,
        generation: u64,
        cancel: &AtomicBool,
        dotnet: &Path,
        args: &[OsString],
        root: &Path,
        live: bool,
    ) -> std::result::Result<Vec<String>, String> {
        if live {
            self.output(generation, format!("> {}", command_line(dotnet, args)));
        }
        let mut lines = Vec::new();
        let success = self
            .runner
            .run(dotnet, args, root, cancel, &mut |line| {
                if live {
                    self.output(generation, line.to_owned());
                }
                lines.push(line.to_owned());
            })
            .map_err(|error| run_error("dotnet", error))?;
        if success {
            return Ok(lines);
        }
        self.update(generation, |state| {
            for line in &lines {
                let Some(mut problem) = parse_msbuild_error(line) else {
                    continue;
                };
                problem.file = root.join(problem.file);
                // O MSBuild repete os erros no resumo do fim.
                if !state.problems.contains(&problem) {
                    state.problems.push(problem);
                }
            }
        });
        if !live {
            lines
                .into_iter()
                .for_each(|line| self.output(generation, line));
        }
        Err("O dotnet terminou com erro: veja o canal dotnet da Saída.".into())
    }

    fn build_config(&self) -> BuildConfig {
        match self.lock().state.config.as_deref() {
            Some("Release") => BuildConfig::Release,
            _ => BuildConfig::Debug,
        }
    }

    fn find_tool(&self, program: &str) -> std::result::Result<PathBuf, String> {
        let tool = tool(program);
        match tool.check(&self.tools) {
            ToolStatus::Present { path, .. } => Ok(path),
            _ => Err(format!(
                "Para configurar o projeto é preciso o {program} {} ou mais novo. {}",
                tool.minimum.unwrap_or_default(),
                tool.install
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
            .map_err(|error| run_error("cmake", error))?;
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
        self.output(generation, format!("> {}", command_line(cmake, args)));
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
            .map_err(|error| run_error("cmake", error))?;
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
                state.build_dir = build_dir;
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

    /// Falhou antes de rodar qualquer coisa: a barra de status manda ver a Saída, e nada escreveu lá.
    fn explain(&self, generation: u64, message: String) -> String {
        self.output(generation, message.clone());
        message
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

/// A solução da raiz (`.sln` ou `.slnx`); com várias, a de menor nome.
fn solution_of(root: &Path, files: &[PathBuf]) -> Option<PathBuf> {
    files
        .iter()
        .filter(|file| file.components().count() == 1)
        .filter(|file| {
            let name = file.to_string_lossy();
            has_extension(&name, "sln") || has_extension(&name, "slnx")
        })
        .min()
        .map(|file| root.join(file))
}

/// Os `.csproj` de `files`, absolutos e em ordem.
fn csprojs_of(root: &Path, files: &[PathBuf]) -> Vec<PathBuf> {
    let mut projects: Vec<PathBuf> = files
        .iter()
        .filter(|file| has_extension(&file.to_string_lossy(), "csproj"))
        .map(|file| root.join(file))
        .collect();
    projects.sort();
    projects
}

fn not_found(message: String) -> Error {
    Error::new(ErrorKind::NotFound, message)
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

fn run_error(program: &str, error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::Interrupted {
        return "Configuração cancelada.".into();
    }
    format!("Não foi possível rodar o {program}: {error}")
}

pub(crate) fn command_line(program: &Path, args: &[OsString]) -> String {
    std::iter::once(program.as_os_str())
        .chain(args.iter().map(OsString::as_os_str))
        .map(OsStr::to_string_lossy)
        .collect::<Vec<_>>()
        .join(" ")
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
    type Paths = Arc<Mutex<Vec<PathBuf>>>;
    type Script =
        dyn Fn(&[String], &AtomicBool, &mut dyn FnMut(&str)) -> io::Result<bool> + Send + Sync;

    struct FakeFs {
        root_files: Vec<&'static str>,
        /// Os outros itens que existem, pastas ou arquivos. A pasta de build entra com a consulta.
        paths: Paths,
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
            lock(&self.paths).iter().any(|item| item == path)
        }

        fn is_file(&self, path: &Path) -> bool {
            let in_root = path.parent() == Some(Path::new(ROOT))
                && (self.root_files.iter()).any(|name| path.file_name() == Some(OsStr::new(name)));
            in_root || self.is_dir(path)
        }

        /// A raiz é um link simbólico para `/real/proj`, como o `/tmp` do macOS.
        fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
            Ok(match path.strip_prefix(ROOT) {
                Ok(relative) => Path::new("/real/proj").join(relative),
                Err(_) => path.into(),
            })
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
        paths: Paths,
    }

    impl FileApi for FakeFileApi {
        fn write_query(&self, build_dir: &Path) -> io::Result<bool> {
            lock(&self.log).push(format!("query {}", build_dir.display()));
            lock(&self.paths).push(build_dir.into());
            Ok(lock(&self.queries).insert(build_dir.into()))
        }

        fn executables(&self, build_dir: &Path) -> Result<Vec<CMakeTarget>> {
            Ok(["app", "tool"]
                .map(|name| CMakeTarget {
                    name: name.into(),
                    path: build_dir.join(name),
                    project: None,
                    framework: None,
                })
                .into())
        }
    }

    #[derive(Clone, Copy)]
    struct FakeTools {
        cmake: bool,
        ninja: bool,
        dotnet: bool,
    }

    impl ToolProbe for FakeTools {
        fn find(&self, program: &str) -> Vec<PathBuf> {
            let found = match program {
                "cmake" => self.cmake,
                "ninja" => self.ninja,
                "dotnet" => self.dotnet,
                _ => false,
            };
            found
                .then(|| PathBuf::from(format!("/bin/{program}")))
                .into_iter()
                .collect()
        }

        fn version_output(&self, path: &Path) -> io::Result<String> {
            Ok(format!("{} version 10.0.113", path.display()))
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
                    dotnet: true,
                },
                Vec::new(),
                script,
            )
        }

        fn with(
            root_files: &[&'static str],
            tools: FakeTools,
            paths: Vec<PathBuf>,
            script: impl Fn(&[String], &AtomicBool, &mut dyn FnMut(&str)) -> io::Result<bool>
            + Send
            + Sync
            + 'static,
        ) -> Self {
            let log = Log::default();
            let events = Arc::<Mutex<Vec<ProjectEvent>>>::default();
            let sink = Arc::clone(&events);
            let paths = Paths::new(Mutex::new(paths));
            let mut project = Project::new(
                FakeFs {
                    root_files: root_files.into(),
                    paths: Arc::clone(&paths),
                },
                FakeRunner {
                    log: Arc::clone(&log),
                    script: Box::new(script),
                },
                FakeFileApi {
                    log: Arc::clone(&log),
                    queries: Mutex::default(),
                    paths,
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
                    _ => None,
                })
                .collect()
        }

        fn statuses(&self) -> Vec<ProjectStatus> {
            lock(&self.events)
                .iter()
                .filter_map(|event| match event {
                    ProjectEvent::State { state } => Some(state.status.clone()),
                    _ => None,
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
            dotnet: true,
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
            dotnet: true,
        };
        let fixture = Fixture::with(&["CMakeLists.txt"], tools, Vec::new(), succeed);
        fixture.open(ProjectChoice::default());

        let ProjectStatus::Failed { message } = fixture.project.state().status else {
            panic!("esperava erro");
        };
        assert!(message.contains("cmake 3.21"), "{message}");
        assert!(message.contains("cmake.org"), "{message}");
        assert!(fixture.log().is_empty());
        assert_eq!(fixture.output(), [message]);
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
            dotnet: true,
        };
        let fixture = Fixture::with(
            &["CMakeLists.txt"],
            tools,
            [
                "CMakeFiles",
                "cmake_install.cmake",
                "CMakeFiles/4.0/CMakeCXXCompiler.cmake",
            ]
            .map(|path| build.join(path))
            .into_iter()
            .chain([
                "/proj/cmake/opcoes.cmake".into(),
                "/proj/CMakePresets.json".into(),
            ])
            .collect(),
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

    /// Um dotnet que restaura, lista `src/app/app.csproj` na solução e informa as propriedades:
    /// `app` é Exe e `lib`, biblioteca. Com `multi` no nome, o projeto tem dois frameworks-alvo.
    fn dotnet(args: &[String], _: &AtomicBool, on_line: &mut dyn FnMut(&str)) -> io::Result<bool> {
        match args[0].as_str() {
            "restore" => on_line("  Restored"),
            "sln" => ["Project(s)", "----------", "src/app/app.csproj"]
                .iter()
                .for_each(|line| on_line(line)),
            _ => {
                let project = Path::new(&args[1]).file_stem().unwrap().to_str().unwrap();
                let config = args[5].trim_start_matches("-p:Configuration=");
                let framework = args
                    .get(6)
                    .map(|arg| arg.trim_start_matches("-p:TargetFramework="));
                let (frameworks, path) = match (project, framework) {
                    ("multi", None) => ("net10.0;net8.0", String::new()),
                    (_, framework) => (
                        "",
                        format!(
                            "/proj/bin/{config}/{}/{project}.dll",
                            framework.unwrap_or("net10.0")
                        ),
                    ),
                };
                let kind = if project == "lib" { "Library" } else { "Exe" };
                on_line(
                    &serde_json::json!({ "Properties": {
                        "OutputType": kind, "TargetPath": path, "TargetFrameworks": frameworks
                    }})
                    .to_string(),
                );
            }
        }
        Ok(true)
    }

    fn msbuild_line(project: &str, config: &str, framework: &str) -> String {
        format!(
            "/bin/dotnet msbuild {project} -getProperty:OutputType -getProperty:TargetPath \
             -getProperty:TargetFrameworks -p:Configuration={config}{framework}"
        )
    }

    /// Um alvo .NET de `/proj/<nome>.csproj`.
    fn target(name: &str, path: &str) -> CMakeTarget {
        CMakeTarget {
            name: name.into(),
            path: path.into(),
            project: Some(Path::new(ROOT).join(format!("{name}.csproj"))),
            framework: None,
        }
    }

    #[test]
    fn dotnet_projects_restore_then_read_the_executable_targets() {
        let fixture = Fixture::new(&["lib.csproj", "app.csproj", "Program.cs"], dotnet);
        fixture.open(ProjectChoice::default());

        assert_eq!(
            fixture.log(),
            [
                "/bin/dotnet restore /proj/app.csproj".to_string(),
                "/bin/dotnet restore /proj/lib.csproj".to_string(),
                msbuild_line("/proj/app.csproj", "Debug", ""),
                msbuild_line("/proj/lib.csproj", "Debug", ""),
            ]
        );
        let state = fixture.project.state();
        assert_eq!(state.kind, ProjectKind::DotnetProjects);
        assert_eq!(state.configs, DEBUG_RELEASE);
        assert_eq!(state.config.as_deref(), Some("Debug"));
        assert_eq!(state.status, ProjectStatus::Ready);
        assert_eq!(state.build_dir, None);
        assert_eq!(
            state.targets,
            [target("app", "/proj/bin/Debug/net10.0/app.dll")]
        );
        assert_eq!(state.target.as_deref(), Some("app"));
        // Só o restore vai para o canal dotnet; a leitura das propriedades não.
        assert_eq!(
            fixture.output(),
            [
                "> /bin/dotnet restore /proj/app.csproj",
                "  Restored",
                "> /bin/dotnet restore /proj/lib.csproj",
                "  Restored",
            ]
        );
    }

    #[test]
    fn dotnet_solution_lists_its_projects_and_multi_target_uses_the_first_framework() {
        let fixture = Fixture::new(&["b.slnx", "a.sln"], |args, cancel, on_line| {
            match args[0].as_str() {
                "sln" => on_line("src/multi/multi.csproj"),
                "build" => {}
                _ => return dotnet(args, cancel, on_line),
            }
            Ok(true)
        });
        fixture.open(ProjectChoice::default());

        assert_eq!(
            fixture.log(),
            [
                "/bin/dotnet restore /proj/a.sln".to_string(),
                "/bin/dotnet sln /proj/a.sln list".to_string(),
                msbuild_line("/proj/src/multi/multi.csproj", "Debug", ""),
                msbuild_line(
                    "/proj/src/multi/multi.csproj",
                    "Debug",
                    " -p:TargetFramework=net10.0"
                ),
            ]
        );
        let state = fixture.project.state();
        assert_eq!(state.kind, ProjectKind::DotnetSolution);
        assert_eq!(
            state.targets,
            [CMakeTarget {
                project: Some("/proj/src/multi/multi.csproj".into()),
                framework: Some("net10.0".into()),
                ..target("multi", "/proj/bin/Debug/net10.0/multi.dll")
            }]
        );
        // Sem `--framework`, o `dotnet run` recusa um projeto com vários frameworks-alvo.
        let command = fixture.project.build_for_run().unwrap().unwrap();
        assert_eq!(
            command.args,
            dotnet_run_args(
                // O separador é o do sistema: `join`, como o caminho que o núcleo monta.
                &Path::new(ROOT).join("src/multi/multi.csproj"),
                BuildConfig::Debug,
                Some("net10.0")
            )
        );
    }

    #[test]
    fn dotnet_saved_choice_is_used_and_changing_the_config_reads_the_targets_again() {
        let fixture = Fixture::new(&["app.csproj"], dotnet);
        fixture.open(ProjectChoice {
            config: Some("Release".into()),
            target: Some("app".into()),
        });
        assert_eq!(
            fixture.log()[1],
            msbuild_line("/proj/app.csproj", "Release", "")
        );
        assert_eq!(
            fixture.project.state().targets,
            [target("app", "/proj/bin/Release/net10.0/app.dll")]
        );

        fixture.project.select_config("Debug").unwrap();
        fixture.project.configure().unwrap();
        let state = fixture.project.state();
        assert_eq!(
            state.targets,
            [target("app", "/proj/bin/Debug/net10.0/app.dll")]
        );
        assert_eq!(
            fixture.project.choice(),
            ProjectChoice {
                config: Some("Debug".into()),
                target: Some("app".into()),
            }
        );
    }

    #[test]
    fn dotnet_restore_error_becomes_a_problem_and_stops_there() {
        // Relativo: o arquivo do problema fica absoluto a partir da raiz.
        let error = "app.csproj(9,5): error MSB4025: The project file could not be loaded. \
                     [/proj/app.csproj]";
        let fixture = Fixture::new(&["app.csproj"], move |_, _, on_line| {
            on_line(error);
            on_line(error);
            on_line("/proj/app.csproj : error NU1101: Unable to find package Nada.");
            Ok(false)
        });
        fixture.open(ProjectChoice::default());

        assert_eq!(fixture.log(), ["/bin/dotnet restore /proj/app.csproj"]);
        let state = fixture.project.state();
        assert_eq!(
            state.status,
            ProjectStatus::Failed {
                message: "O dotnet terminou com erro: veja o canal dotnet da Saída.".into()
            }
        );
        assert_eq!(
            state.problems,
            [
                Problem {
                    file: "/proj/app.csproj".into(),
                    line: 9,
                    message: "MSB4025: The project file could not be loaded.".into(),
                },
                // Sem linha no erro: a linha 1 do projeto.
                Problem {
                    file: "/proj/app.csproj".into(),
                    line: 1,
                    message: "NU1101: Unable to find package Nada.".into(),
                }
            ]
        );
    }

    #[test]
    fn saving_a_dotnet_project_file_reconfigures() {
        let fixture = Fixture::new(&["app.csproj", "Program.cs"], dotnet);
        fixture.open(ProjectChoice::default());
        lock(&fixture.log).clear();
        fixture
            .project
            .files_changed(&["/proj/Program.cs".into(), "/proj/app.csproj".into()]);
        wait_until(|| fixture.log().len() == 2);
        assert_eq!(fixture.log()[0], "/bin/dotnet restore /proj/app.csproj");
    }

    #[test]
    fn dotnet_msbuild_failure_shows_its_output_in_the_channel() {
        let fixture = Fixture::new(&["app.csproj"], |args, cancel, on_line| {
            if args[0] == "msbuild" {
                on_line("MSBUILD : error MSB1009: Project file does not exist.");
                return Ok(false);
            }
            dotnet(args, cancel, on_line)
        });
        fixture.open(ProjectChoice::default());

        assert!(matches!(
            fixture.project.state().status,
            ProjectStatus::Failed { .. }
        ));
        assert_eq!(
            fixture.output().last().map(String::as_str),
            Some("MSBUILD : error MSB1009: Project file does not exist.")
        );
    }

    #[test]
    fn dotnet_without_a_target_path_is_an_error() {
        let fixture = Fixture::new(&["app.csproj"], |args, _, on_line| {
            if args[0] == "msbuild" {
                on_line(
                    r#"{"Properties": {"OutputType": "Exe", "TargetPath": "", "TargetFrameworks": ""}}"#,
                );
            }
            Ok(true)
        });
        fixture.open(ProjectChoice::default());

        let ProjectStatus::Failed { message } = fixture.project.state().status else {
            panic!("esperava erro");
        };
        assert!(message.contains("TargetPath"), "{message}");
    }

    #[test]
    fn a_new_dotnet_configure_kills_the_running_restore_first() {
        let died = Arc::new(AtomicBool::new(false));
        let script_died = Arc::clone(&died);
        let fixture = Fixture::new(&["app.csproj"], move |args, cancel, on_line| {
            if args[0] == "restore" && !script_died.load(Ordering::Acquire) {
                let result = die_when_cancelled(cancel, &script_died);
                on_line("atrasada");
                return result;
            }
            dotnet(args, cancel, on_line)
        });
        let project = Arc::clone(&fixture.project);
        let first = thread::spawn(move || project.open(Path::new(ROOT), ProjectChoice::default()));
        wait_until(|| fixture.log().len() == 1);

        fixture.project.select_config("Release").unwrap();
        fixture.project.configure().unwrap();
        first.join().unwrap();

        assert!(died.load(Ordering::Acquire));
        let state = fixture.project.state();
        assert_eq!(state.status, ProjectStatus::Ready);
        assert_eq!(
            state.targets,
            [target("app", "/proj/bin/Release/net10.0/app.dll")]
        );
        assert!(!fixture.output().contains(&"atrasada".to_string()));
    }

    #[test]
    fn missing_dotnet_is_an_error_with_install_steps_and_runs_nothing() {
        let tools = FakeTools {
            cmake: true,
            ninja: true,
            dotnet: false,
        };
        let fixture = Fixture::with(&["app.csproj"], tools, Vec::new(), dotnet);
        fixture.open(ProjectChoice::default());

        let ProjectStatus::Failed { message } = fixture.project.state().status else {
            panic!("esperava erro");
        };
        assert!(message.contains("dotnet 8"), "{message}");
        assert!(message.contains("dotnet.microsoft.com"), "{message}");
        assert!(fixture.log().is_empty());
    }

    impl Fixture {
        fn build_output(&self) -> Vec<String> {
            lock(&self.events)
                .iter()
                .filter_map(|event| match event {
                    ProjectEvent::BuildOutput { line, .. } => Some(line.replace('\\', "/")),
                    _ => None,
                })
                .collect()
        }

        fn build_results(&self) -> Vec<(BuildStatus, Vec<BuildProblem>)> {
            lock(&self.events)
                .iter()
                .filter_map(|event| match event {
                    ProjectEvent::BuildFinished { status, problems } => {
                        Some((*status, problems.clone()))
                    }
                    _ => None,
                })
                .collect()
        }
    }

    /// Configura sem erro; `cmake --build` escreve `lines` e termina com `success`.
    fn cmake_build(lines: &'static [&'static str], success: bool) -> Box<Script> {
        Box::new(move |args, _, on_line| {
            if args[0] != "--build" {
                return Ok(true);
            }
            lines.iter().for_each(|line| on_line(line));
            Ok(success)
        })
    }

    #[test]
    fn build_configures_first_then_builds_all_with_live_output_and_duration() {
        let fixture = Fixture::new(
            &["CMakeLists.txt"],
            cmake_build(&["[1/1] Linking app"], true),
        );
        fixture
            .project
            .open(Path::new(ROOT), ProjectChoice::default());
        fixture.project.close();
        // Fechado e reaberto sem configurar: o build configura antes.
        lock(&fixture.log).clear();
        {
            let mut inner = fixture.project.lock();
            inner.state.root = Some(ROOT.into());
            inner.state.kind = ProjectKind::CMake;
            inner.state.configs = DEBUG_RELEASE.map(String::from).into();
        }
        fixture.project.build().unwrap();

        assert_eq!(
            fixture.log(),
            [
                "query /proj/build/debug".to_string(),
                configure_line("Debug"),
                "/bin/cmake --build /proj/build/debug".to_string(),
            ]
        );
        let output = fixture.build_output();
        assert_eq!(
            output[..2],
            [
                "> /bin/cmake --build /proj/build/debug",
                "[1/1] Linking app"
            ]
        );
        assert!(output[2].starts_with("Concluída em 0,"), "{output:?}");
        assert!(output[2].ends_with(" s"));
        assert_eq!(
            fixture.build_results(),
            [(BuildStatus::Succeeded, Vec::new())]
        );

        // Já configurado: compila direto.
        lock(&fixture.log).clear();
        fixture.project.build().unwrap();
        assert_eq!(fixture.log(), ["/bin/cmake --build /proj/build/debug"]);
    }

    #[test]
    fn a_pending_reconfigure_runs_before_the_build() {
        let fixture = Fixture::new(&["CMakeLists.txt"], cmake_build(&[], true));
        fixture.open(ProjectChoice::default());
        fixture.project.lock().reconfigure_at = Some(Instant::now() + TIMEOUT);
        lock(&fixture.log).clear();
        fixture.project.build().unwrap();
        assert_eq!(
            fixture.log(),
            [
                "query /proj/build/debug".to_string(),
                configure_line("Debug"),
                "/bin/cmake --build /proj/build/debug".to_string(),
            ]
        );
        assert_eq!(fixture.project.lock().reconfigure_at, None);
    }

    /// `rm -rf build`: o aviso do observador chega com a pasta e o `CMakeFiles` já sumidos.
    fn delete_the_build_dir(fixture: &Fixture) {
        lock(&fixture.project.fs.paths).clear();
        lock(&fixture.log).clear();
        fixture.project.files_changed(&[
            "/proj/build/debug/cmake_install.cmake".into(),
            "/proj/build/debug/CMakeFiles/app.dir/DependInfo.cmake".into(),
        ]);
    }

    #[test]
    fn a_deleted_build_dir_is_configured_again_alone() {
        let fixture = Fixture::new(&["CMakeLists.txt"], cmake_build(&[], true));
        fixture.open(ProjectChoice::default());
        delete_the_build_dir(&fixture);
        wait_until(|| {
            fixture.log().len() == 2 && fixture.project.state().status == ProjectStatus::Ready
        });
        assert_eq!(
            fixture.log(),
            [
                "query /proj/build/debug".to_string(),
                configure_line("Debug")
            ]
        );
    }

    #[test]
    fn a_build_right_after_deleting_the_build_dir_configures_once() {
        let fixture = Fixture::new(&["CMakeLists.txt"], cmake_build(&[], true));
        fixture.open(ProjectChoice::default());
        delete_the_build_dir(&fixture);
        fixture.project.build().unwrap();
        // A compilação levou a reconfiguração pendente: nada roda depois.
        thread::sleep(Duration::from_millis(700));
        assert_eq!(
            fixture.log(),
            [
                "query /proj/build/debug".to_string(),
                configure_line("Debug"),
                "/bin/cmake --build /proj/build/debug".to_string(),
            ]
        );
    }

    /// Configura sem esperar enquanto `hold` é falso; com ele, só termina quando é cancelado (e
    /// anota em `died`), quando `hold` volta a ser falso ou depois de `TIMEOUT`. `cmake --build`
    /// dá certo.
    fn held_configure(hold: &Arc<AtomicBool>, died: &Arc<AtomicBool>) -> Box<Script> {
        let (hold, died) = (Arc::clone(hold), Arc::clone(died));
        Box::new(move |args, cancel, _| {
            if args[0] == "--build" || !hold.load(Ordering::Acquire) {
                return Ok(true);
            }
            let start = Instant::now();
            while hold.load(Ordering::Acquire) && start.elapsed() < TIMEOUT {
                if cancel.load(Ordering::Acquire) {
                    died.store(true, Ordering::Release);
                    return Err(io::ErrorKind::Interrupted.into());
                }
                thread::sleep(Duration::from_millis(1));
            }
            Ok(true)
        })
    }

    /// Abre o projeto e começa uma compilação que configura antes, com o cmake preso.
    fn build_while_configure_is_held(
        fixture: &Fixture,
        hold: &AtomicBool,
    ) -> thread::JoinHandle<Result<()>> {
        fixture.open(ProjectChoice::default());
        hold.store(true, Ordering::Release);
        fixture.project.lock().reconfigure_at = Some(Instant::now() + TIMEOUT);
        lock(&fixture.log).clear();
        let project = Arc::clone(&fixture.project);
        let build = thread::spawn(move || project.build());
        wait_until(|| fixture.log().len() == 2);
        build
    }

    #[test]
    fn saving_cmake_files_while_the_build_configures_waits_and_reconfigures_after() {
        let (hold, died) = (Arc::default(), Arc::default());
        let fixture = Fixture::new(&["CMakeLists.txt"], held_configure(&hold, &died));
        let build = build_while_configure_is_held(&fixture, &hold);

        fixture
            .project
            .files_changed(&["/proj/CMakeLists.txt".into()]);
        thread::sleep(Duration::from_millis(700));
        assert!(
            !died.load(Ordering::Acquire),
            "a configuração foi interrompida"
        );
        assert_eq!(fixture.log().len(), 2, "{:?}", fixture.log());

        hold.store(false, Ordering::Release);
        build.join().unwrap().unwrap();
        assert_eq!(
            fixture.build_results(),
            [(BuildStatus::Succeeded, Vec::new())]
        );
        // Salvo depois de a configuração começar: reconfigura quando a compilação termina.
        wait_until(|| fixture.log().len() == 5);
        assert_eq!(
            fixture.log()[2..],
            [
                "/bin/cmake --build /proj/build/debug".to_string(),
                "query /proj/build/debug".to_string(),
                configure_line("Debug"),
            ]
        );
    }

    #[test]
    fn cancelling_while_the_build_configures_stops_the_configure_at_once() {
        let (hold, died) = (Arc::default(), Arc::default());
        let fixture = Fixture::new(&["CMakeLists.txt"], held_configure(&hold, &died));
        let build = build_while_configure_is_held(&fixture, &hold);

        let start = Instant::now();
        fixture.project.cancel_build();
        build.join().unwrap().unwrap();
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "{:?}",
            start.elapsed()
        );
        assert!(died.load(Ordering::Acquire));
        assert_eq!(fixture.log().len(), 2, "compilou: {:?}", fixture.log());
        assert_eq!(
            fixture.build_results(),
            [(BuildStatus::Cancelled, Vec::new())]
        );
        assert!(
            fixture
                .build_output()
                .last()
                .unwrap()
                .starts_with("Cancelada em ")
        );
        assert_eq!(
            fixture.project.state().status,
            ProjectStatus::Failed {
                message: "Configuração cancelada.".into()
            }
        );
    }

    #[test]
    fn saving_through_the_real_path_of_a_linked_root_reconfigures() {
        let fixture = Fixture::new(&["CMakeLists.txt"], succeed);
        fixture.open(ProjectChoice::default());
        lock(&fixture.log).clear();
        fixture
            .project
            .files_changed(&["/real/proj/CMakeLists.txt".into()]);
        wait_until(|| fixture.log().len() == 2);
        assert_eq!(fixture.log()[1], configure_line("Debug"));
    }

    #[test]
    fn build_errors_become_problems_and_an_unknown_failure_the_fallback() {
        let fixture = Fixture::new(
            &["CMakeLists.txt", "main.cpp"],
            cmake_build(
                &[
                    "/proj/main.cpp:5:10: error: expected ';'",
                    "/proj/sumiu.cpp:1:1: error: x",
                ],
                false,
            ),
        );
        fixture.open(ProjectChoice::default());
        fixture.project.build().unwrap();
        let [(status, problems)] = fixture.build_results().try_into().unwrap();
        assert_eq!(status, BuildStatus::Failed);
        assert_eq!(
            problems,
            [BuildProblem {
                file: Some("/proj/main.cpp".into()),
                line: Some(5),
                column: Some(10),
                severity: crate::Severity::Error,
                code: None,
                message: "expected ';'".into(),
            }]
        );
        assert!(
            fixture
                .build_output()
                .last()
                .unwrap()
                .starts_with("Falhou em ")
        );
        // A linha já chega com o destino do link, antes do fim da compilação.
        let links: Vec<_> = lock(&fixture.events)
            .iter()
            .filter_map(|event| match event {
                ProjectEvent::BuildOutput { line, problem } => {
                    Some((line.clone(), problem.as_ref()?.file.clone()?))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            links,
            [(
                "/proj/main.cpp:5:10: error: expected ';'".to_owned(),
                PathBuf::from("/proj/main.cpp")
            )]
        );

        let linker = Fixture::new(&["CMakeLists.txt"], cmake_build(&["ld: undefined"], false));
        linker.open(ProjectChoice::default());
        linker.project.build().unwrap();
        let [(_, problems)] = linker.build_results().try_into().unwrap();
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].message, crate::BUILD_FAILED);
    }

    #[test]
    fn one_build_at_a_time_and_cancel_kills_it() {
        let died = Arc::new(AtomicBool::new(false));
        let script_died = Arc::clone(&died);
        let fixture = Fixture::new(&["CMakeLists.txt"], move |args, cancel, _| {
            if args[0] != "--build" {
                return Ok(true);
            }
            die_when_cancelled(cancel, &script_died)
        });
        fixture.open(ProjectChoice::default());
        let project = Arc::clone(&fixture.project);
        let first = thread::spawn(move || project.build());
        wait_until(|| fixture.log().len() == 3);

        let busy = fixture.project.build().unwrap_err();
        assert_eq!(busy.message, "Já há uma compilação em andamento");
        assert!(fixture.project.build_for_run().is_err());
        fixture.project.cancel_build();
        first.join().unwrap().unwrap();

        assert!(died.load(Ordering::Acquire));
        assert_eq!(
            fixture.build_results(),
            [(BuildStatus::Cancelled, Vec::new())]
        );
        assert!(
            fixture
                .build_output()
                .last()
                .unwrap()
                .starts_with("Cancelada em ")
        );
        // Livre de novo.
        fixture.project.cancel_build();
        let project = Arc::clone(&fixture.project);
        let again = thread::spawn(move || project.build());
        wait_until(|| fixture.log().len() == 4);
        fixture.project.close();
        again.join().unwrap().unwrap();
    }

    #[test]
    fn run_builds_only_the_active_cmake_target_and_runs_its_program() {
        let fixture = Fixture::new(&["CMakeLists.txt"], cmake_build(&[], true));
        fixture.open(ProjectChoice::default());
        fixture.project.select_target("tool").unwrap();
        lock(&fixture.log).clear();

        let command = fixture.project.build_for_run().unwrap().unwrap();
        assert_eq!(
            fixture.log(),
            ["/bin/cmake --build /proj/build/debug --target tool"]
        );
        assert_eq!(
            command,
            RunCommand {
                name: "▶ tool".into(),
                program: Path::new("/proj/build/debug").join("tool"),
                args: Vec::new(),
                cwd: ROOT.into(),
                target: CMakeTarget {
                    name: "tool".into(),
                    path: Path::new("/proj/build/debug").join("tool"),
                    project: None,
                    framework: None,
                },
            }
        );

        let failing = Fixture::new(&["CMakeLists.txt"], cmake_build(&[], false));
        failing.open(ProjectChoice::default());
        assert_eq!(failing.project.build_for_run().unwrap(), None);
    }

    #[test]
    fn dotnet_builds_each_project_or_the_target_and_runs_with_dotnet_run() {
        let fixture = Fixture::new(&["lib.csproj", "app.csproj"], |args, cancel, on_line| {
            if args[0] == "build" {
                return Ok(true);
            }
            dotnet(args, cancel, on_line)
        });
        fixture.open(ProjectChoice::default());
        lock(&fixture.log).clear();
        fixture.project.build().unwrap();
        assert_eq!(
            fixture.log(),
            [
                "/bin/dotnet build /proj/app.csproj -c Debug",
                "/bin/dotnet build /proj/lib.csproj -c Debug"
            ]
        );

        lock(&fixture.log).clear();
        let command = fixture.project.build_for_run().unwrap().unwrap();
        assert_eq!(
            fixture.log(),
            ["/bin/dotnet build /proj/app.csproj -c Debug"]
        );
        assert_eq!(command.name, "▶ app");
        assert_eq!(command.program, Path::new("/bin/dotnet"));
        assert_eq!(
            command.args,
            dotnet_run_args(
                &Path::new(ROOT).join("app.csproj"),
                BuildConfig::Debug,
                None
            )
        );
    }

    #[test]
    fn run_without_an_executable_target_says_so_and_builds_nothing() {
        let fixture = Fixture::new(&["lib.csproj"], dotnet);
        fixture.open(ProjectChoice::default());
        lock(&fixture.log).clear();
        let error = fixture.project.build_for_run().unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidInput);
        assert_eq!(
            error.message,
            "Nenhum programa para executar. Escolha um alvo na barra de status."
        );
        assert!(fixture.log().is_empty());

        let empty = Fixture::new(&[], succeed);
        empty.open(ProjectChoice::default());
        assert_eq!(
            empty.project.build().unwrap_err().kind,
            ErrorKind::InvalidInput
        );
    }
}
