//! Servidores de linguagem (clangd, Roslyn): iniciar, repassar as mensagens do LSP sem
//! interpretá-las, reiniciar quando caem e parar. O cliente LSP fica na interface.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::configure::command_line;
use crate::tools::tool;
use crate::{
    Error, ErrorKind, ProjectKind, ProjectState, Result, ServerProcess, ServerSpawner,
    SpawnedServer, ToolProbe, ToolStatus,
};

/// Quedas dentro desta janela contam para a política de reinício.
const RESTART_WINDOW: Duration = Duration::from_secs(5 * 60);
/// Reinícios automáticos permitidos dentro da janela; a queda seguinte deixa o servidor parado.
const MAX_RESTARTS: usize = 3;
const READ_BUFFER: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    /// C e C++, com o clangd.
    Cpp,
    /// C#, com o Roslyn.
    CSharp,
}

impl Language {
    fn program(self) -> &'static str {
        match self {
            Self::Cpp => "clangd",
            Self::CSharp => "roslyn-language-server",
        }
    }

    fn server_name(self) -> &'static str {
        match self {
            Self::Cpp => "clangd",
            Self::CSharp => "Roslyn",
        }
    }

    /// O canal do log no painel Saída.
    fn channel(self) -> &'static str {
        match self {
            Self::Cpp => "clangd",
            Self::CSharp => "C#",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ServerState {
    Starting,
    /// O processo está de pé: a interface faz o `initialize` (de novo, depois de um reinício).
    Running,
    /// Não reinicia sozinho; `reason` já vem pronta para mostrar.
    Stopped {
        reason: String,
    },
    /// C# fora de pasta .NET: nenhum servidor.
    NoProject,
}

/// O que o servidor de uma linguagem manda para a interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum LanguageEvent {
    /// Uma mensagem do LSP (o JSON, sem a moldura).
    Message {
        message: String,
    },
    /// Uma linha do canal do servidor na Saída.
    Log {
        line: String,
    },
    State {
        state: ServerState,
    },
}

/// Os argumentos e a pasta do servidor para o projeto aberto.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Launch {
    args: Vec<OsString>,
    cwd: PathBuf,
}

/// `None` quando a linguagem precisa de um projeto que a pasta não tem (C# fora de pasta .NET).
fn server_launch(language: Language, project: &ProjectState) -> Option<Launch> {
    match language {
        Language::Cpp => {
            let args = (project.build_dir.iter())
                .map(|dir| {
                    let mut arg = OsString::from("--compile-commands-dir=");
                    arg.push(dir);
                    arg
                })
                .collect();
            // Sem pasta aberta a pasta do processo não importa: o LSP só usa caminhos absolutos.
            let cwd = project.root.clone().unwrap_or_else(std::env::temp_dir);
            Some(Launch { args, cwd })
        }
        Language::CSharp => {
            let dotnet = matches!(
                project.kind,
                ProjectKind::DotnetSolution | ProjectKind::DotnetProjects
            );
            let root = project.root.clone().filter(|_| dotnet)?;
            Some(Launch {
                args: vec!["--stdio".into(), "--autoLoadProjects".into()],
                cwd: root,
            })
        }
    }
}

/// Reinicia sozinho até 3 vezes em 5 minutos; na 4ª queda dentro da janela, fica parado.
#[derive(Default)]
struct RestartPolicy {
    crashes: Vec<Instant>,
}

impl RestartPolicy {
    /// Anota uma queda em `now`. `true` se o servidor deve reiniciar sozinho.
    fn should_restart(&mut self, now: Instant) -> bool {
        self.crashes
            .retain(|&at| now.duration_since(at) < RESTART_WINDOW);
        self.crashes.push(now);
        self.crashes.len() <= MAX_RESTARTS
    }
}

/// Uma mensagem com a moldura do LSP: `Content-Length` conta bytes, não caracteres.
fn encode_frame(message: &str) -> Vec<u8> {
    let mut frame = format!("Content-Length: {}\r\n\r\n", message.len()).into_bytes();
    frame.extend_from_slice(message.as_bytes());
    frame
}

/// Separa as mensagens do LSP que chegam em pedaços pelo stdout do servidor.
#[derive(Default)]
struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    fn push(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    /// A próxima mensagem completa, ou `None` até chegar o resto. Um cabeçalho sem
    /// `Content-Length` válido é descartado e volta como `Err`.
    fn next_message(&mut self) -> Option<std::result::Result<String, String>> {
        const SEPARATOR: &[u8] = b"\r\n\r\n";
        let header_end = (self.buffer.windows(SEPARATOR.len())).position(|w| w == SEPARATOR)?;
        let header = String::from_utf8_lossy(&self.buffer[..header_end]).into_owned();
        let body_start = header_end + SEPARATOR.len();
        let Some(length) = content_length(&header) else {
            self.buffer.drain(..body_start);
            return Some(Err(header));
        };
        let body_end = body_start.checked_add(length)?;
        if self.buffer.len() < body_end {
            return None;
        }
        let body = String::from_utf8_lossy(&self.buffer[body_start..body_end]).into_owned();
        self.buffer.drain(..body_end);
        Some(Ok(body))
    }
}

fn content_length(header: &str) -> Option<usize> {
    header.split("\r\n").find_map(|line| {
        let (name, value) = line.split_once(':')?;
        let is_length = name.trim().eq_ignore_ascii_case("content-length");
        is_length.then(|| value.trim().parse().ok()).flatten()
    })
}

type OnEvent = Arc<dyn Fn(LanguageEvent) + Send + Sync>;

struct Server {
    on_event: OnEvent,
    /// `None` com a ferramenta ausente (ou ainda não procurada, sem projeto).
    program: Option<PathBuf>,
    /// `None` sem projeto.
    launch: Option<Launch>,
    /// Muda a cada processo: o que um processo antigo ainda manda é descartado.
    generation: u64,
    running: Option<Running>,
    crashes: RestartPolicy,
}

struct Running {
    /// Fila da thread que escreve no stdin: as mensagens chegam ao servidor na ordem pedida.
    requests: Sender<String>,
    process: Arc<dyn ServerProcess>,
}

impl Server {
    fn emit(&self, state: ServerState) {
        (self.on_event)(LanguageEvent::State { state });
    }

    fn kill(&mut self) {
        if let Some(running) = self.running.take() {
            // Falha só com o processo já encerrado.
            let _ = running.process.kill();
        }
    }
}

#[derive(Default)]
struct Inner {
    servers: HashMap<Language, Server>,
    last_generation: u64,
}

/// Caso de uso: um servidor de linguagem por linguagem, cada um num processo separado.
pub struct LanguageServers<S, T> {
    spawner: S,
    tools: T,
    inner: Mutex<Inner>,
}

impl<S, T> LanguageServers<S, T>
where
    S: ServerSpawner + 'static,
    T: ToolProbe + 'static,
{
    pub fn new(spawner: S, tools: T) -> Self {
        Self {
            spawner,
            tools,
            inner: Mutex::default(),
        }
    }

    /// Inicia o servidor de `language` para `project`, no lugar do que já estivesse rodando. O
    /// estado, as mensagens e o log chegam por `on_event`, de outras threads.
    pub fn start(
        self: &Arc<Self>,
        language: Language,
        project: &ProjectState,
        on_event: impl Fn(LanguageEvent) + Send + Sync + 'static,
    ) -> Result<()> {
        let launch = server_launch(language, project);
        let program = match launch {
            Some(_) => Some(self.find(language)?),
            None => None,
        };
        let server = Server {
            on_event: Arc::new(on_event),
            program,
            launch,
            generation: 0,
            running: None,
            crashes: RestartPolicy::default(),
        };
        let mut inner = self.lock();
        if let Some(mut previous) = inner.servers.insert(language, server) {
            previous.kill();
        }
        self.launch(&mut inner, language);
        Ok(())
    }

    /// Põe a mensagem (JSON) na fila do servidor e volta na hora.
    pub fn send(&self, language: Language, message: &str) -> Result<()> {
        let inner = self.lock();
        let server = inner.servers.get(&language).ok_or_else(not_started)?;
        let running = server
            .running
            .as_ref()
            .ok_or_else(|| not_running(language))?;
        (running.requests)
            .send(message.to_owned())
            .map_err(|_| not_running(language))
    }

    /// O botão Reiniciar: começa de novo e zera a contagem de quedas.
    pub fn restart(self: &Arc<Self>, language: Language) -> Result<()> {
        let needs_program = {
            let inner = self.lock();
            let server = inner.servers.get(&language).ok_or_else(not_started)?;
            server.program.is_none() && server.launch.is_some()
        };
        // A ferramenta pode ter sido instalada com a IDE aberta.
        let program = self.find_outside_lock(language, needs_program);
        let mut inner = self.lock();
        let server = inner.servers.get_mut(&language).ok_or_else(not_started)?;
        server.program = server.program.take().or(program);
        server.crashes = RestartPolicy::default();
        self.launch(&mut inner, language);
        Ok(())
    }

    pub fn stop(&self, language: Language) -> Result<()> {
        let mut server = self
            .lock()
            .servers
            .remove(&language)
            .ok_or_else(not_started)?;
        server.kill();
        Ok(())
    }

    /// Encerra todos os servidores (pasta fechada ou IDE fechando).
    pub fn stop_all(&self) {
        for (_, mut server) in self.lock().servers.drain() {
            server.kill();
        }
    }

    /// Acompanha o projeto: o clangd reinicia com a pasta de build nova, e o C# inicia quando a
    /// pasta passa a ser .NET.
    pub fn project_changed(self: &Arc<Self>, project: &ProjectState) {
        for language in [Language::Cpp, Language::CSharp] {
            // Configurando, o CMake ainda não tem pasta de build: o clangd fica com a anterior.
            if language == Language::Cpp && project.build_dir.is_none() {
                continue;
            }
            self.follow_project(language, server_launch(language, project));
        }
    }

    fn follow_project(self: &Arc<Self>, language: Language, launch: Option<Launch>) {
        let needs_program = match self.lock().servers.get(&language) {
            Some(server) if server.launch != launch => server.program.is_none() && launch.is_some(),
            _ => return,
        };
        let program = self.find_outside_lock(language, needs_program);
        let mut inner = self.lock();
        let Some(server) = inner.servers.get_mut(&language) else {
            return;
        };
        if server.launch == launch {
            return;
        }
        server.launch = launch;
        server.program = server.program.take().or(program);
        self.launch(&mut inner, language);
    }

    /// Inicia um processo novo no lugar do atual, ou avisa por que não há processo.
    fn launch(self: &Arc<Self>, inner: &mut Inner, language: Language) {
        inner.last_generation += 1;
        let generation = inner.last_generation;
        let Some(server) = inner.servers.get_mut(&language) else {
            return;
        };
        server.kill();
        server.generation = generation;
        let (Some(launch), Some(program)) = (&server.launch, &server.program) else {
            let state = match server.launch {
                None => ServerState::NoProject,
                Some(_) => ServerState::Stopped {
                    reason: missing_tool(language).message,
                },
            };
            server.emit(state);
            return;
        };
        server.emit(ServerState::Starting);
        (server.on_event)(LanguageEvent::Log {
            line: format!("> {}", command_line(program, &launch.args)),
        });
        match self.spawner.spawn(program, &launch.args, &launch.cwd) {
            Ok(spawned) => {
                server.running = Some(self.connect(language, generation, spawned));
                server.emit(ServerState::Running);
            }
            Err(error) => server.emit(ServerState::Stopped {
                reason: format!(
                    "Não foi possível iniciar o {}: {error}",
                    language.server_name()
                ),
            }),
        }
    }

    /// Liga o processo à interface: uma thread para cada ponta do stdio e uma que espera o fim.
    fn connect(
        self: &Arc<Self>,
        language: Language,
        generation: u64,
        spawned: SpawnedServer,
    ) -> Running {
        let SpawnedServer {
            stdout,
            stderr,
            stdin,
            process,
        } = spawned;
        let process: Arc<dyn ServerProcess> = Arc::from(process);
        let servers = Arc::clone(self);
        let emit = move |event| servers.emit(language, generation, event);
        let messages = emit.clone();
        thread::spawn(move || read_messages(stdout, &messages));
        thread::spawn(move || read_log(stderr, &emit));
        let (requests, receiver) = mpsc::channel();
        thread::spawn(move || write_messages(stdin, &receiver));
        let servers = Arc::clone(self);
        let waited = Arc::clone(&process);
        thread::spawn(move || {
            let code = waited.wait();
            servers.exited(language, generation, code);
        });
        Running { requests, process }
    }

    /// O processo terminou sem a IDE pedir: reinicia, ou fica parado depois de quedas demais.
    fn exited(
        self: &Arc<Self>,
        language: Language,
        generation: u64,
        code: io::Result<Option<i32>>,
    ) {
        let mut inner = self.lock();
        let Some(server) =
            (inner.servers.get_mut(&language)).filter(|s| s.generation == generation)
        else {
            return;
        };
        server.running = None;
        let name = language.server_name();
        let line = match code {
            Ok(Some(code)) => format!("O {name} terminou com código {code}."),
            _ => format!("O {name} terminou."),
        };
        (server.on_event)(LanguageEvent::Log { line });
        if server.crashes.should_restart(Instant::now()) {
            self.launch(&mut inner, language);
        } else {
            server.emit(ServerState::Stopped {
                reason: format!(
                    "O {name} parou várias vezes. Veja o canal {} na Saída.",
                    language.channel()
                ),
            });
        }
    }

    fn emit(&self, language: Language, generation: u64, event: LanguageEvent) {
        // Sob o lock: nada de um processo antigo chega depois do estado de um novo.
        let inner = self.lock();
        if let Some(server) = (inner.servers.get(&language)).filter(|s| s.generation == generation)
        {
            (server.on_event)(event);
        }
    }

    fn find(&self, language: Language) -> Result<PathBuf> {
        match tool(language.program()).check(&self.tools) {
            ToolStatus::Present { path, .. } => Ok(path),
            _ => Err(missing_tool(language)),
        }
    }

    /// A busca roda `--version` (até alguns segundos): nunca sob o lock, que a fila de envio usa.
    fn find_outside_lock(&self, language: Language, needed: bool) -> Option<PathBuf> {
        needed.then(|| self.find(language).ok()).flatten()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        lock(&self.inner)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn read_messages(mut stdout: Box<dyn Read + Send>, emit: &dyn Fn(LanguageEvent)) {
    let mut decoder = FrameDecoder::default();
    let mut buffer = vec![0; READ_BUFFER];
    loop {
        match stdout.read(&mut buffer) {
            Ok(0) => return,
            Ok(read) => decoder.push(&buffer[..read]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        }
        while let Some(frame) = decoder.next_message() {
            emit(match frame {
                Ok(message) => LanguageEvent::Message { message },
                Err(header) => LanguageEvent::Log {
                    line: format!("Cabeçalho LSP inválido descartado: {header}"),
                },
            });
        }
    }
}

/// Manda cada linha do stderr, sem o fim de linha. Texto que não é UTF-8 vira �.
fn read_log(stderr: Box<dyn Read + Send>, emit: &dyn Fn(LanguageEvent)) {
    let mut reader = BufReader::new(stderr);
    let mut line = Vec::new();
    while matches!(reader.read_until(b'\n', &mut line), Ok(read) if read > 0) {
        let text = String::from_utf8_lossy(&line);
        emit(LanguageEvent::Log {
            line: text.trim_end_matches(['\r', '\n']).to_owned(),
        });
        line.clear();
    }
}

fn write_messages(mut stdin: Box<dyn Write + Send>, requests: &Receiver<String>) {
    for message in requests {
        // Um erro aqui é o servidor terminando, e isso já chega à interface pelo estado.
        if (stdin.write_all(&encode_frame(&message)))
            .and_then(|()| stdin.flush())
            .is_err()
        {
            return;
        }
    }
}

fn missing_tool(language: Language) -> Error {
    let tool = tool(language.program());
    let minimum = (tool.minimum)
        .map(|minimum| format!(" {minimum} ou mais novo"))
        .unwrap_or_default();
    Error::new(
        ErrorKind::NotFound,
        format!(
            "Para {}, é preciso o {}{minimum}. {}",
            tool.purpose, tool.program, tool.install
        ),
    )
}

fn not_started() -> Error {
    Error::new(
        ErrorKind::NotFound,
        "O servidor desta linguagem não foi iniciado",
    )
}

fn not_running(language: Language) -> Error {
    Error::new(
        ErrorKind::Other,
        format!("O {} não está rodando", language.server_name()),
    )
}

#[cfg(test)]
mod tests {
    use std::io::PipeWriter;
    use std::path::Path;
    use std::sync::Condvar;

    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(5);
    const MINUTE: Duration = Duration::from_secs(60);

    fn decode_all(decoder: &mut FrameDecoder) -> Vec<std::result::Result<String, String>> {
        std::iter::from_fn(|| decoder.next_message()).collect()
    }

    #[test]
    fn frame_length_counts_bytes() {
        let frame = encode_frame(r#"{"texto":"ação ✓"}"#);
        assert_eq!(
            String::from_utf8(frame).unwrap(),
            "Content-Length: 22\r\n\r\n{\"texto\":\"ação ✓\"}"
        );
    }

    #[test]
    fn decoder_waits_for_a_message_split_across_reads() {
        let message = r#"{"id":1,"result":"ação 日本 🙂"}"#;
        let mut decoder = FrameDecoder::default();
        let mut decoded = Vec::new();
        for byte in encode_frame(message) {
            decoder.push(&[byte]);
            decoded.extend(decode_all(&mut decoder));
        }
        assert_eq!(decoded, [Ok(message.to_owned())]);
    }

    #[test]
    fn decoder_splits_several_messages_from_one_read() {
        let mut bytes = encode_frame("{\"a\":1}");
        bytes.extend(
            b"content-length:  7\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n{\"b\":2}",
        );
        bytes.extend(encode_frame("{\"c\":\"é\"}"));
        bytes.extend(b"Content-Length: 9\r\n\r\n{\"d\"");
        let mut decoder = FrameDecoder::default();
        decoder.push(&bytes);
        assert_eq!(
            decode_all(&mut decoder),
            [
                Ok("{\"a\":1}".to_owned()),
                Ok("{\"b\":2}".to_owned()),
                Ok("{\"c\":\"é\"}".to_owned()),
            ]
        );
        decoder.push(b":4}\r\n");
        assert_eq!(decode_all(&mut decoder), [Ok("{\"d\":4}\r\n".to_owned())]);
    }

    #[test]
    fn decoder_discards_a_header_without_length_and_goes_on() {
        let mut decoder = FrameDecoder::default();
        decoder.push(b"Content-Type: x\r\n\r\n");
        decoder.push(&encode_frame("{}"));
        assert_eq!(
            decode_all(&mut decoder),
            [Err("Content-Type: x".to_owned()), Ok("{}".to_owned())]
        );
    }

    #[test]
    fn four_crashes_within_five_minutes_restart_three_times_then_stop() {
        let start = Instant::now();
        let mut policy = RestartPolicy::default();
        let decisions: Vec<bool> = [0, 1, 2, 4]
            .map(|minutes| policy.should_restart(start + MINUTE * minutes))
            .into();
        assert_eq!(decisions, [true, true, true, false]);
    }

    #[test]
    fn crashes_more_than_five_minutes_apart_always_restart() {
        let start = Instant::now();
        let mut policy = RestartPolicy::default();
        for crash in 0..10 {
            assert!(policy.should_restart(start + MINUTE * 6 * crash));
        }
        // A janela anda: aos 6 min só a queda dos 2 min ainda conta, então a parada é na 3ª dos 6 min.
        let mut policy = RestartPolicy::default();
        let decisions: Vec<bool> = [0, 1, 2, 6, 6, 6]
            .map(|minutes| policy.should_restart(start + MINUTE * minutes))
            .into();
        assert_eq!(decisions, [true, true, true, true, true, false]);
    }

    fn project(kind: ProjectKind, build_dir: Option<&str>) -> ProjectState {
        ProjectState {
            root: Some("/proj".into()),
            kind,
            build_dir: build_dir.map(PathBuf::from),
            ..ProjectState::default()
        }
    }

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|arg| arg.to_string_lossy().into())
            .collect()
    }

    #[test]
    fn clangd_reads_the_active_build_dir_and_roslyn_needs_a_dotnet_folder() {
        let cmake = project(ProjectKind::CMake, Some("/proj/build/release"));
        let launch = server_launch(Language::Cpp, &cmake).unwrap();
        assert_eq!(
            strings(&launch.args),
            ["--compile-commands-dir=/proj/build/release"]
        );
        assert_eq!(launch.cwd, Path::new("/proj"));
        let edit_only = project(ProjectKind::EditOnly, None);
        assert!(
            server_launch(Language::Cpp, &edit_only)
                .unwrap()
                .args
                .is_empty()
        );
        assert!(server_launch(Language::Cpp, &ProjectState::default()).is_some());

        for kind in [ProjectKind::DotnetSolution, ProjectKind::DotnetProjects] {
            let launch = server_launch(Language::CSharp, &project(kind, None)).unwrap();
            assert_eq!(strings(&launch.args), ["--stdio", "--autoLoadProjects"]);
            assert_eq!(launch.cwd, Path::new("/proj"));
        }
        assert_eq!(server_launch(Language::CSharp, &cmake), None);
        assert_eq!(server_launch(Language::CSharp, &edit_only), None);
    }

    /// O servidor de mentira: termina quando o teste manda ou quando é encerrado.
    #[derive(Default)]
    struct FakeProcess {
        exit_code: Mutex<Option<i32>>,
        exited: Condvar,
        killed: Mutex<bool>,
    }

    impl FakeProcess {
        fn exit(&self, code: i32) {
            *lock(&self.exit_code) = Some(code);
            self.exited.notify_all();
        }
    }

    struct SharedProcess(Arc<FakeProcess>);

    impl ServerProcess for SharedProcess {
        fn kill(&self) -> io::Result<()> {
            *lock(&self.0.killed) = true;
            self.0.exit(9);
            Ok(())
        }

        fn wait(&self) -> io::Result<Option<i32>> {
            let mut code = lock(&self.0.exit_code);
            while code.is_none() {
                code = self.0.exited.wait(code).unwrap();
            }
            Ok(*code)
        }
    }

    #[derive(Clone, Default)]
    struct SharedInput(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedInput {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            lock(&self.0).extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// As pontas que o teste controla de um processo iniciado.
    struct Ends {
        program: PathBuf,
        args: Vec<String>,
        stdout: PipeWriter,
        stderr: PipeWriter,
        stdin: SharedInput,
        process: Arc<FakeProcess>,
    }

    #[derive(Default)]
    struct FakeSpawner {
        spawned: Mutex<Vec<Ends>>,
    }

    impl ServerSpawner for FakeSpawner {
        fn spawn(&self, program: &Path, args: &[OsString], _: &Path) -> io::Result<SpawnedServer> {
            let (stdout, stdout_writer) = io::pipe()?;
            let (stderr, stderr_writer) = io::pipe()?;
            let stdin = SharedInput::default();
            let process = Arc::new(FakeProcess::default());
            lock(&self.spawned).push(Ends {
                program: program.into(),
                args: strings(args),
                stdout: stdout_writer,
                stderr: stderr_writer,
                stdin: stdin.clone(),
                process: Arc::clone(&process),
            });
            Ok(SpawnedServer {
                stdout: Box::new(stdout),
                stderr: Box::new(stderr),
                stdin: Box::new(stdin),
                process: Box::new(SharedProcess(process)),
            })
        }
    }

    struct FakeTools {
        present: bool,
    }

    impl ToolProbe for FakeTools {
        fn find(&self, program: &str) -> Vec<PathBuf> {
            (self
                .present
                .then(|| PathBuf::from(format!("/bin/{program}"))))
            .into_iter()
            .collect()
        }

        fn version_output(&self, _: &Path) -> io::Result<String> {
            Ok("version 23.1.3".into())
        }
    }

    type Events = Arc<Mutex<Vec<LanguageEvent>>>;

    struct Fixture {
        servers: Arc<LanguageServers<FakeSpawner, FakeTools>>,
        events: Events,
    }

    impl Fixture {
        fn new(tools_present: bool) -> Self {
            let tools = FakeTools {
                present: tools_present,
            };
            Self {
                servers: Arc::new(LanguageServers::new(FakeSpawner::default(), tools)),
                events: Arc::default(),
            }
        }

        fn start(&self, language: Language, project: &ProjectState) -> Result<()> {
            let events = Arc::clone(&self.events);
            self.servers.start(language, project, move |event| {
                lock(&events).push(event);
            })
        }

        fn spawned(&self) -> MutexGuard<'_, Vec<Ends>> {
            lock(&self.servers.spawner.spawned)
        }

        fn states(&self) -> Vec<ServerState> {
            (lock(&self.events).iter())
                .filter_map(|event| match event {
                    LanguageEvent::State { state } => Some(state.clone()),
                    _ => None,
                })
                .collect()
        }

        fn wait_until(&self, done: impl Fn(&[LanguageEvent]) -> bool) {
            let start = Instant::now();
            while !done(&lock(&self.events)) {
                assert!(
                    start.elapsed() < TIMEOUT,
                    "eventos: {:?}",
                    lock(&self.events)
                );
                thread::sleep(Duration::from_millis(5));
            }
        }

        fn wait_for_spawns(&self, count: usize) {
            wait_until(|| {
                self.spawned().len() == count && self.states().last() == Some(&ServerState::Running)
            });
        }

        fn crash(&self, index: usize) {
            self.spawned()[index].process.exit(1);
        }
    }

    fn wait_until(done: impl Fn() -> bool) {
        let start = Instant::now();
        while !done() {
            assert!(start.elapsed() < TIMEOUT, "o tempo acabou");
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn stopped(reason: &str) -> ServerState {
        ServerState::Stopped {
            reason: reason.into(),
        }
    }

    #[test]
    fn clangd_starts_and_relays_messages_and_log_in_order() {
        let fixture = Fixture::new(true);
        let cmake = project(ProjectKind::CMake, Some("/proj/build/debug"));
        fixture.start(Language::Cpp, &cmake).unwrap();
        {
            let spawned = fixture.spawned();
            assert_eq!(spawned[0].program, Path::new("/bin/clangd"));
            assert_eq!(
                spawned[0].args,
                ["--compile-commands-dir=/proj/build/debug"]
            );
        }
        let mut expected = Vec::new();
        for id in 0..500 {
            let message = format!("{{\"id\":{id},\"texto\":\"ação\"}}");
            fixture.servers.send(Language::Cpp, &message).unwrap();
            expected.extend(encode_frame(&message));
        }
        wait_until(|| *lock(&fixture.spawned()[0].stdin.0) == expected);

        {
            let mut spawned = fixture.spawned();
            let mut reply = encode_frame("{\"id\":1}");
            reply.extend(encode_frame("{\"id\":2}"));
            spawned[0].stdout.write_all(&reply).unwrap();
            spawned[0]
                .stderr
                .write_all(b"I[10:00] clangd pronto\r\n")
                .unwrap();
        }
        let message = |text: &str| LanguageEvent::Message {
            message: text.into(),
        };
        fixture.wait_until(|events| events.len() == 6);
        let events = lock(&fixture.events).clone();
        assert_eq!(
            events[..3],
            [
                LanguageEvent::State {
                    state: ServerState::Starting
                },
                LanguageEvent::Log {
                    line: "> /bin/clangd --compile-commands-dir=/proj/build/debug".into()
                },
                LanguageEvent::State {
                    state: ServerState::Running
                },
            ]
        );
        let messages: Vec<_> = (events[3..].iter())
            .filter(|event| matches!(event, LanguageEvent::Message { .. }))
            .collect();
        assert_eq!(messages, [&message("{\"id\":1}"), &message("{\"id\":2}")]);
        assert!(events.contains(&LanguageEvent::Log {
            line: "I[10:00] clangd pronto".into()
        }));
    }

    #[test]
    fn events_have_the_shape_of_the_ipc_contract() {
        let json = |event: LanguageEvent| serde_json::to_value(event).unwrap();
        assert_eq!(
            json(LanguageEvent::State {
                state: ServerState::NoProject
            }),
            serde_json::json!({"kind": "state", "state": {"kind": "noProject"}})
        );
        assert_eq!(
            json(LanguageEvent::State {
                state: stopped("x")
            }),
            serde_json::json!({"kind": "state", "state": {"kind": "stopped", "reason": "x"}})
        );
        assert_eq!(
            json(LanguageEvent::Message {
                message: "{}".into()
            }),
            serde_json::json!({"kind": "message", "message": "{}"})
        );
        let languages: Vec<Language> = serde_json::from_str(r#"["cpp","csharp"]"#).unwrap();
        assert_eq!(languages, [Language::Cpp, Language::CSharp]);
    }

    #[test]
    fn csharp_outside_a_dotnet_folder_has_no_server() {
        let fixture = Fixture::new(false);
        let cmake = project(ProjectKind::CMake, None);
        fixture.start(Language::CSharp, &cmake).unwrap();

        assert_eq!(fixture.states(), [ServerState::NoProject]);
        assert!(fixture.spawned().is_empty());
        let error = fixture.servers.send(Language::CSharp, "{}").unwrap_err();
        assert_eq!(error.kind, ErrorKind::Other);
    }

    #[test]
    fn missing_tool_is_an_error_with_purpose_and_install_steps() {
        let fixture = Fixture::new(false);
        let error = fixture
            .start(Language::Cpp, &ProjectState::default())
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert!(
            error.message.contains("erros e autocomplete C/C++"),
            "{}",
            error.message
        );
        assert!(
            error.message.contains("clangd.llvm.org"),
            "{}",
            error.message
        );
        assert!(fixture.spawned().is_empty());

        let dotnet = project(ProjectKind::DotnetProjects, None);
        let error = fixture.start(Language::CSharp, &dotnet).unwrap_err();
        assert!(
            error.message.contains("dotnet tool install"),
            "{}",
            error.message
        );
    }

    #[test]
    fn a_fake_server_that_crashes_four_times_restarts_three_times_and_stops() {
        let fixture = Fixture::new(true);
        fixture
            .start(Language::Cpp, &ProjectState::default())
            .unwrap();
        for crash in 0..3 {
            fixture.wait_for_spawns(crash + 1);
            fixture.crash(crash);
        }
        fixture.wait_for_spawns(4);
        fixture.crash(3);

        let reason = "O clangd parou várias vezes. Veja o canal clangd na Saída.";
        fixture.wait_until(|events| {
            events.last()
                == Some(&LanguageEvent::State {
                    state: stopped(reason),
                })
        });
        assert_eq!(fixture.spawned().len(), 4);
        assert!(lock(&fixture.events).contains(&LanguageEvent::Log {
            line: "O clangd terminou com código 1.".into()
        }));
        let error = fixture.servers.send(Language::Cpp, "{}").unwrap_err();
        assert_eq!(error.kind, ErrorKind::Other);

        // Reiniciar zera a contagem: a próxima queda reinicia de novo.
        fixture.servers.restart(Language::Cpp).unwrap();
        fixture.wait_for_spawns(5);
        fixture.crash(4);
        fixture.wait_for_spawns(6);
    }

    #[test]
    fn a_new_build_dir_restarts_clangd_and_old_messages_are_dropped() {
        let fixture = Fixture::new(true);
        let debug = project(ProjectKind::CMake, Some("/proj/build/debug"));
        fixture.start(Language::Cpp, &debug).unwrap();
        fixture
            .servers
            .project_changed(&project(ProjectKind::CMake, None));
        fixture.servers.project_changed(&debug);
        assert_eq!(fixture.spawned().len(), 1);

        let release = project(ProjectKind::CMake, Some("/proj/build/release"));
        fixture.servers.project_changed(&release);
        let spawned = fixture.spawned();
        assert_eq!(spawned.len(), 2);
        assert!(*lock(&spawned[0].process.killed));
        assert_eq!(
            spawned[1].args,
            ["--compile-commands-dir=/proj/build/release"]
        );
        drop(spawned);

        fixture.spawned()[0]
            .stdout
            .write_all(&encode_frame("{\"velho\":1}"))
            .unwrap();
        fixture.spawned()[1]
            .stdout
            .write_all(&encode_frame("{\"novo\":1}"))
            .unwrap();
        fixture.wait_until(|events| {
            events.contains(&LanguageEvent::Message {
                message: "{\"novo\":1}".into(),
            })
        });
        thread::sleep(Duration::from_millis(50));
        let events = lock(&fixture.events).clone();
        assert!(!events.iter().any(
            |event| matches!(event, LanguageEvent::Message { message } if message.contains("velho"))
        ));
        assert!(!events.iter().any(|event| matches!(
            event,
            LanguageEvent::State {
                state: ServerState::Stopped { .. }
            }
        )));
    }

    #[test]
    fn csharp_starts_when_the_folder_turns_out_to_be_dotnet() {
        let fixture = Fixture::new(true);
        fixture
            .start(Language::CSharp, &ProjectState::default())
            .unwrap();
        fixture
            .servers
            .project_changed(&project(ProjectKind::DotnetSolution, None));

        let spawned = fixture.spawned();
        assert_eq!(spawned.len(), 1);
        assert_eq!(spawned[0].program, Path::new("/bin/roslyn-language-server"));
        assert_eq!(spawned[0].args, ["--stdio", "--autoLoadProjects"]);
        drop(spawned);
        assert_eq!(
            fixture.states(),
            [
                ServerState::NoProject,
                ServerState::Starting,
                ServerState::Running
            ]
        );
    }

    #[test]
    fn starting_again_replaces_the_running_server() {
        let fixture = Fixture::new(true);
        let project = ProjectState::default();
        fixture.start(Language::Cpp, &project).unwrap();
        fixture.start(Language::Cpp, &project).unwrap();

        let spawned = fixture.spawned();
        assert_eq!(spawned.len(), 2);
        assert!(*lock(&spawned[0].process.killed));
        assert!(!*lock(&spawned[1].process.killed));
    }

    #[test]
    fn stop_kills_the_server_and_nothing_else_arrives() {
        let fixture = Fixture::new(true);
        let dotnet = project(ProjectKind::DotnetProjects, None);
        fixture.start(Language::Cpp, &dotnet).unwrap();
        fixture.start(Language::CSharp, &dotnet).unwrap();
        fixture.servers.stop(Language::Cpp).unwrap();
        assert!(*lock(&fixture.spawned()[0].process.killed));
        assert!(!*lock(&fixture.spawned()[1].process.killed));
        let error = fixture.servers.send(Language::Cpp, "{}").unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);

        let before = lock(&fixture.events).len();
        fixture.spawned()[0]
            .stdout
            .write_all(&encode_frame("{}"))
            .unwrap();
        fixture.servers.stop_all();
        assert!(*lock(&fixture.spawned()[1].process.killed));
        thread::sleep(Duration::from_millis(50));
        assert_eq!(lock(&fixture.events).len(), before);
        assert_eq!(
            fixture.servers.restart(Language::CSharp).unwrap_err().kind,
            ErrorKind::NotFound
        );
    }
}
