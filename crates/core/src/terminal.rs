//! Terminais integrados: o shell padrão, a saída em lotes e o ciclo de vida de cada terminal.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::{Error, ErrorKind, PtySpawner, Result, SpawnedTerminal, TerminalProcess, TerminalSize};

/// A saída vai para a interface no máximo uma vez por quadro (60 Hz): um programa que despeja
/// 100.000 linhas não afoga a interface com uma mensagem por leitura.
const FRAME: Duration = Duration::from_millis(16);
/// Depois que o shell termina, quanto esperar pela saída que ainda está a caminho.
const EXIT_GRACE: Duration = Duration::from_millis(100);
const READ_BUFFER: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Unix,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }
}

/// O shell de um terminal novo. Windows: `pwsh` se estiver no PATH, senão o Windows PowerShell.
/// macOS e Linux: o de `$SHELL`, ou `/bin/sh` sem ele.
pub fn default_shell(platform: Platform, shell_var: Option<&str>, pwsh_on_path: bool) -> PathBuf {
    match platform {
        Platform::Windows if pwsh_on_path => "pwsh".into(),
        Platform::Windows => "powershell.exe".into(),
        Platform::Unix => match shell_var {
            Some(shell) if !shell.trim().is_empty() => shell.into(),
            _ => "/bin/sh".into(),
        },
    }
}

/// O nome que a lista de terminais mostra: o do programa, sem pasta nem extensão.
pub fn shell_name(program: &Path) -> String {
    program.file_stem().map_or_else(
        || program.display().to_string(),
        |stem| stem.to_string_lossy().into_owned(),
    )
}

/// O que um terminal manda para a interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TerminalEvent {
    /// Texto que o processo escreveu, com as sequências de escape intactas.
    Output { data: String },
    /// O shell terminou; é sempre o último evento. `code` é `None` se o sistema não o informou.
    Exited { code: Option<u32> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: u32,
    /// O nome do shell (`pwsh`, `bash`…).
    pub name: String,
}

struct Session {
    /// Fila da thread que escreve no terminal: as escritas chegam ao processo na ordem pedida, e
    /// quem pede não espera um programa que não lê a entrada.
    requests: Sender<Request>,
    process: Arc<dyn TerminalProcess>,
    exited: Arc<AtomicBool>,
}

enum Request {
    Write(String),
    Resize(TerminalSize),
}

/// Caso de uso: os terminais abertos na IDE.
pub struct Terminals<P> {
    spawner: P,
    shell: PathBuf,
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
    last_id: AtomicU32,
}

impl<P: PtySpawner> Terminals<P> {
    /// `shell` é o programa de todo terminal novo (ver [`default_shell`]).
    pub fn new(spawner: P, shell: PathBuf) -> Self {
        Self {
            spawner,
            shell,
            sessions: Mutex::default(),
            last_id: AtomicU32::new(0),
        }
    }

    /// Abre um shell em `cwd`. A saída e o fim do shell chegam por `on_event`, de outra thread.
    pub fn create(
        &self,
        cwd: &Path,
        size: TerminalSize,
        on_event: impl Fn(TerminalEvent) + Send + 'static,
    ) -> Result<TerminalInfo> {
        let name = shell_name(&self.shell);
        self.run(name, &self.shell, &[], cwd, size, on_event)
    }

    /// Roda `program` num terminal novo chamado `name`, como [`Self::create`]. O fim do programa
    /// chega como `Exited`, com o código de saída dele.
    pub fn run(
        &self,
        name: String,
        program: &Path,
        args: &[OsString],
        cwd: &Path,
        size: TerminalSize,
        on_event: impl Fn(TerminalEvent) + Send + 'static,
    ) -> Result<TerminalInfo> {
        validate_size(size)?;
        let SpawnedTerminal {
            output,
            input,
            process,
        } = self
            .spawner
            .spawn(program, args, cwd, size)
            .map_err(|error| spawn_error(program, error))?;
        let process: Arc<dyn TerminalProcess> = Arc::from(process);
        let exited = Arc::new(AtomicBool::new(false));
        start_pump(
            output,
            Arc::clone(&process),
            Arc::clone(&exited),
            Box::new(on_event),
        );
        let (requests, receiver) = mpsc::channel();
        let target = Arc::clone(&process);
        thread::spawn(move || serve_requests(input, &*target, &receiver));

        let id = self.last_id.fetch_add(1, Ordering::Relaxed) + 1;
        let session = Session {
            requests,
            process,
            exited,
        };
        lock(&self.sessions).insert(id, Arc::new(session));
        Ok(TerminalInfo { id, name })
    }

    /// Envia ao processo o que o usuário digitou ou colou.
    /// Só põe na fila: volta na hora, mesmo que o programa não esteja lendo a entrada.
    pub fn write(&self, id: u32, data: &str) -> Result<()> {
        self.send(id, Request::Write(data.to_owned()))
    }

    /// Vai pela mesma fila das escritas: o último tamanho pedido é o que fica.
    pub fn resize(&self, id: u32, size: TerminalSize) -> Result<()> {
        validate_size(size)?;
        self.send(id, Request::Resize(size))
    }

    fn send(&self, id: u32, request: Request) -> Result<()> {
        let session = self.session(id)?;
        if session.exited.load(Ordering::Acquire) {
            return Err(shell_ended());
        }
        session.requests.send(request).map_err(|_| shell_ended())
    }

    /// Encerra o shell e tudo o que roda nele.
    pub fn close(&self, id: u32) -> Result<()> {
        let session = lock(&self.sessions).remove(&id).ok_or_else(not_found)?;
        session.process.kill()?;
        Ok(())
    }

    /// Encerra todos os terminais ao mesmo tempo, para a IDE não deixar processos órfãos ao fechar.
    pub fn close_all(&self) {
        let sessions: Vec<_> = lock(&self.sessions).drain().map(|(_, s)| s).collect();
        thread::scope(|scope| {
            for session in &sessions {
                scope.spawn(|| session.process.kill());
            }
        });
    }

    fn session(&self, id: u32) -> Result<Arc<Session>> {
        lock(&self.sessions).get(&id).cloned().ok_or_else(not_found)
    }
}

fn validate_size(size: TerminalSize) -> Result<()> {
    if size.cols == 0 || size.rows == 0 {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "O terminal precisa de pelo menos uma linha e uma coluna",
        ));
    }
    Ok(())
}

fn spawn_error(program: &Path, error: io::Error) -> Error {
    let mut error = Error::from(error);
    error.message = format!(
        "Não foi possível iniciar o terminal com {}: {}",
        program.display(),
        error.message
    );
    error
}

fn shell_ended() -> Error {
    Error::new(ErrorKind::Other, "O shell deste terminal já terminou")
}

/// Atende a fila de um terminal, em ordem, até o terminal ser fechado.
fn serve_requests(
    mut input: Box<dyn Write + Send>,
    process: &dyn TerminalProcess,
    requests: &Receiver<Request>,
) {
    for request in requests {
        // Um erro aqui é o shell terminando, e isso já chega à interface como `exited`.
        let _ = match request {
            Request::Write(data) => input
                .write_all(data.as_bytes())
                .and_then(|()| input.flush()),
            Request::Resize(size) => process.resize(size),
        };
    }
}

fn not_found() -> Error {
    Error::new(ErrorKind::NotFound, "Este terminal já foi fechado")
}

enum Message {
    Output(Vec<u8>),
    Exited(Option<u32>),
}

/// Liga o terminal à interface: uma thread lê a saída, outra espera o shell terminar e uma
/// terceira entrega os dois em ordem.
fn start_pump(
    mut output: Box<dyn Read + Send>,
    process: Arc<dyn TerminalProcess>,
    exited: Arc<AtomicBool>,
    on_event: Box<dyn Fn(TerminalEvent) + Send>,
) {
    let (sender, receiver) = mpsc::channel();
    let reader = sender.clone();
    thread::spawn(move || read_output(&mut *output, &reader));
    thread::spawn(move || {
        let code = process.wait().ok();
        // Antes do aviso: quando a interface recebe `exited`, escrever já dá erro.
        exited.store(true, Ordering::Release);
        let _ = sender.send(Message::Exited(code));
    });
    thread::spawn(move || deliver(&receiver, &*on_event));
}

fn read_output(output: &mut dyn Read, sender: &Sender<Message>) {
    let mut buffer = vec![0; READ_BUFFER];
    loop {
        match output.read(&mut buffer) {
            Ok(0) => return,
            Ok(read) => {
                if sender
                    .send(Message::Output(buffer[..read].to_vec()))
                    .is_err()
                {
                    return;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            // No Linux, ler o terminal depois que o shell saiu dá erro em vez de fim.
            Err(_) => return,
        }
    }
}

/// Junta a saída num lote por quadro e, por último, avisa que o shell terminou.
fn deliver(receiver: &Receiver<Message>, on_event: &dyn Fn(TerminalEvent)) {
    let mut decoder = Utf8Decoder::default();
    let mut pending = String::new();
    let mut last_flush: Option<Instant> = None;
    let mut exit: Option<(Option<u32>, Instant)> = None;
    let flush = |pending: &mut String| {
        if !pending.is_empty() {
            on_event(TerminalEvent::Output {
                data: std::mem::take(pending),
            });
        }
    };

    loop {
        let next_frame = last_flush.map(|at| at + FRAME);
        let deadline = match exit {
            Some((_, grace_end)) => Some(grace_end),
            None if pending.is_empty() => None,
            None => next_frame,
        };
        let message = match deadline {
            None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(at) => receiver.recv_timeout(at.saturating_duration_since(Instant::now())),
        };
        match message {
            Ok(Message::Output(bytes)) => pending.push_str(&decoder.decode(&bytes)),
            Ok(Message::Exited(code)) => exit = Some((code, Instant::now() + EXIT_GRACE)),
            Err(RecvTimeoutError::Timeout) if exit.is_none() => {}
            Err(_) => break,
        }
        if next_frame.is_none_or(|at| Instant::now() >= at) && !pending.is_empty() {
            flush(&mut pending);
            last_flush = Some(Instant::now());
        }
    }

    pending.push_str(&decoder.finish());
    flush(&mut pending);
    let code = exit.and_then(|(code, _)| code);
    on_event(TerminalEvent::Exited { code });
}

/// Transforma bytes em texto sem partir um caractere UTF-8 que chegou dividido entre duas leituras.
#[derive(Default)]
struct Utf8Decoder {
    incomplete: Vec<u8>,
}

impl Utf8Decoder {
    fn decode(&mut self, bytes: &[u8]) -> String {
        self.incomplete.extend_from_slice(bytes);
        let complete = complete_prefix_len(&self.incomplete);
        let text = String::from_utf8_lossy(&self.incomplete[..complete]).into_owned();
        self.incomplete.drain(..complete);
        text
    }

    fn finish(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.incomplete).into_owned();
        self.incomplete.clear();
        text
    }
}

/// Quantos bytes do começo já podem virar texto: todos, menos um caractere incompleto no fim.
fn complete_prefix_len(bytes: &[u8]) -> usize {
    let tail = bytes.len().saturating_sub(3);
    for start in (tail..bytes.len()).rev() {
        let needed = match bytes[start] {
            0x80..=0xBF => continue,
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => 1,
        };
        return if bytes.len() - start < needed {
            start
        } else {
            bytes.len()
        };
    }
    bytes.len()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::io::PipeWriter;
    use std::sync::Condvar;

    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(5);
    const SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };

    /// O shell de mentira: termina quando o teste manda ou quando é encerrado.
    #[derive(Default)]
    struct FakeProcess {
        exit_code: Mutex<Option<u32>>,
        exited: Condvar,
        killed: Mutex<bool>,
        sizes: Mutex<Vec<TerminalSize>>,
    }

    impl FakeProcess {
        fn exit(&self, code: u32) {
            *lock(&self.exit_code) = Some(code);
            self.exited.notify_all();
        }
    }

    struct SharedProcess(Arc<FakeProcess>);

    impl TerminalProcess for SharedProcess {
        fn pid(&self) -> Option<u32> {
            Some(42)
        }

        fn resize(&self, size: TerminalSize) -> io::Result<()> {
            lock(&self.0.sizes).push(size);
            Ok(())
        }

        fn kill(&self) -> io::Result<()> {
            *lock(&self.0.killed) = true;
            self.0.exit(1);
            Ok(())
        }

        fn wait(&self) -> io::Result<u32> {
            let mut code = lock(&self.0.exit_code);
            while code.is_none() {
                code = self.0.exited.wait(code).unwrap();
            }
            Ok(code.unwrap())
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

    /// As pontas que o teste controla do último terminal criado.
    struct Ends {
        output: PipeWriter,
        input: SharedInput,
        process: Arc<FakeProcess>,
    }

    /// O programa, os argumentos, a pasta e o tamanho de um terminal criado.
    type Spawned = (PathBuf, Vec<OsString>, PathBuf, TerminalSize);

    #[derive(Default)]
    struct FakeSpawner {
        spawned: Mutex<Vec<Spawned>>,
        ends: Mutex<Vec<Ends>>,
        fail: bool,
    }

    impl PtySpawner for FakeSpawner {
        fn spawn(
            &self,
            program: &Path,
            args: &[OsString],
            cwd: &Path,
            size: TerminalSize,
        ) -> io::Result<SpawnedTerminal> {
            if self.fail {
                return Err(io::Error::new(io::ErrorKind::NotFound, "não existe"));
            }
            lock(&self.spawned).push((program.into(), args.into(), cwd.into(), size));
            let (reader, writer) = io::pipe()?;
            let input = SharedInput::default();
            let process = Arc::new(FakeProcess::default());
            lock(&self.ends).push(Ends {
                output: writer,
                input: input.clone(),
                process: Arc::clone(&process),
            });
            Ok(SpawnedTerminal {
                output: Box::new(reader),
                input: Box::new(input),
                process: Box::new(SharedProcess(process)),
            })
        }
    }

    struct Fixture {
        terminals: Terminals<FakeSpawner>,
        events: Arc<Mutex<Vec<TerminalEvent>>>,
    }

    impl Fixture {
        fn new() -> Self {
            Self::with_spawner(FakeSpawner::default())
        }

        fn with_spawner(spawner: FakeSpawner) -> Self {
            Self {
                terminals: Terminals::new(spawner, "/bin/bash".into()),
                events: Arc::default(),
            }
        }

        fn create(&self) -> Result<TerminalInfo> {
            let events = Arc::clone(&self.events);
            self.terminals
                .create(Path::new("/proj"), SIZE, move |event| {
                    lock(&events).push(event);
                })
        }

        fn ends(&self, index: usize) -> MutexGuard<'_, Vec<Ends>> {
            let ends = lock(&self.terminals.spawner.ends);
            assert!(ends.len() > index);
            ends
        }

        fn output_text(&self) -> String {
            output_of(&lock(&self.events))
        }

        fn wait_until(&self, done: impl Fn(&[TerminalEvent]) -> bool) {
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

        fn wait_for_input(&self, expected: &[u8]) {
            wait_until(|| *lock(&self.ends(0)[0].input.0) == expected);
        }

        fn wait_for_exit(&self) {
            self.wait_until(|events| matches!(events.last(), Some(TerminalEvent::Exited { .. })));
        }
    }

    fn wait_until(done: impl Fn() -> bool) {
        let start = Instant::now();
        while !done() {
            assert!(start.elapsed() < TIMEOUT, "o tempo acabou");
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn output_of(events: &[TerminalEvent]) -> String {
        events
            .iter()
            .filter_map(|event| match event {
                TerminalEvent::Output { data } => Some(data.as_str()),
                TerminalEvent::Exited { .. } => None,
            })
            .collect()
    }

    #[test]
    fn default_shell_follows_the_platform_rules() {
        let unix = Platform::Unix;
        let windows = Platform::Windows;
        assert_eq!(
            default_shell(unix, Some("/bin/zsh"), false),
            Path::new("/bin/zsh")
        );
        assert_eq!(default_shell(unix, None, false), Path::new("/bin/sh"));
        assert_eq!(default_shell(unix, Some(""), true), Path::new("/bin/sh"));
        assert_eq!(default_shell(windows, None, true), Path::new("pwsh"));
        assert_eq!(
            default_shell(windows, Some("/usr/bin/bash"), false),
            Path::new("powershell.exe")
        );
    }

    #[test]
    fn shell_name_is_the_program_without_folder_or_extension() {
        assert_eq!(shell_name(Path::new("/bin/zsh")), "zsh");
        assert_eq!(shell_name(Path::new("powershell.exe")), "powershell");
        assert_eq!(shell_name(Path::new("pwsh")), "pwsh");
    }

    #[test]
    fn decoder_keeps_characters_split_between_reads() {
        let text = "echo ação ✓ 日本 🙂";
        let mut decoder = Utf8Decoder::default();
        let mut decoded: String = text
            .as_bytes()
            .iter()
            .map(|byte| decoder.decode(&[*byte]))
            .collect();
        decoded.push_str(&decoder.finish());
        assert_eq!(decoded, text);
    }

    #[test]
    fn decoder_replaces_invalid_bytes_instead_of_stalling() {
        let mut decoder = Utf8Decoder::default();
        assert_eq!(decoder.decode(b"a\xFFb"), "a\u{FFFD}b");
        assert_eq!(decoder.decode(b"\xE2\x9C"), "");
        assert_eq!(decoder.finish(), "\u{FFFD}");
    }

    #[test]
    fn create_starts_the_shell_in_the_folder_with_the_size() {
        let fixture = Fixture::new();
        let info = fixture.create().unwrap();
        let second = fixture.create().unwrap();

        assert_eq!(
            info,
            TerminalInfo {
                id: 1,
                name: "bash".into()
            }
        );
        assert_eq!(second.id, 2);
        let spawned = lock(&fixture.terminals.spawner.spawned).clone();
        assert_eq!(
            spawned[0],
            ("/bin/bash".into(), Vec::new(), "/proj".into(), SIZE)
        );
    }

    #[test]
    fn run_starts_the_program_with_its_args_and_name() {
        let fixture = Fixture::new();
        let info = fixture
            .terminals
            .run(
                "▶ app".into(),
                Path::new("/bin/dotnet"),
                &["run".into()],
                Path::new("/proj"),
                SIZE,
                |_| {},
            )
            .unwrap();

        assert_eq!(info.name, "▶ app");
        let spawned = lock(&fixture.terminals.spawner.spawned).clone();
        assert_eq!(
            spawned[0],
            (
                "/bin/dotnet".into(),
                vec!["run".into()],
                "/proj".into(),
                SIZE
            )
        );
    }

    #[test]
    fn typed_text_reaches_the_process() {
        let fixture = Fixture::new();
        let info = fixture.create().unwrap();
        fixture.terminals.write(info.id, "ls -la\r").unwrap();
        fixture.wait_for_input(b"ls -la\r");
    }

    #[test]
    fn writes_reach_the_process_in_the_order_they_were_made() {
        let fixture = Fixture::new();
        let info = fixture.create().unwrap();
        let mut expected = Vec::new();
        for i in 0..2000 {
            let text = format!("a{i}\n");
            fixture.terminals.write(info.id, &text).unwrap();
            expected.extend_from_slice(text.as_bytes());
        }
        fixture.wait_for_input(&expected);
    }

    #[test]
    fn writing_or_resizing_after_the_shell_exited_is_an_error() {
        let fixture = Fixture::new();
        let info = fixture.create().unwrap();
        fixture.ends(0)[0].process.exit(0);
        fixture.wait_for_exit();

        let write = fixture.terminals.write(info.id, "x").unwrap_err();
        let resize = fixture.terminals.resize(info.id, SIZE).unwrap_err();
        assert_eq!(
            (write.kind, resize.kind),
            (ErrorKind::Other, ErrorKind::Other)
        );
        assert!(lock(&fixture.ends(0)[0].input.0).is_empty());
    }

    #[test]
    fn output_arrives_in_order_and_in_few_batches() {
        let fixture = Fixture::new();
        fixture.create().unwrap();
        let mut expected = String::new();
        for line in 0..2000 {
            let text = format!("linha {line} ✓\r\n");
            fixture.ends(0)[0]
                .output
                .write_all(text.as_bytes())
                .unwrap();
            expected.push_str(&text);
        }

        fixture.wait_until(|events| output_of(events) == expected);
        let batches = lock(&fixture.events).len();
        assert!(batches < 200, "{batches} lotes para 2000 escritas");
    }

    #[test]
    fn exit_comes_after_the_last_output_with_the_code() {
        let fixture = Fixture::new();
        fixture.create().unwrap();
        {
            let mut ends = fixture.ends(0);
            ends[0].output.write_all(b"tchau\r\n").unwrap();
            ends[0].process.exit(3);
        }

        fixture.wait_for_exit();
        assert_eq!(fixture.output_text(), "tchau\r\n");
        assert_eq!(
            lock(&fixture.events).last(),
            Some(&TerminalEvent::Exited { code: Some(3) })
        );
    }

    #[test]
    fn exit_is_reported_even_if_the_output_never_ends() {
        let fixture = Fixture::new();
        fixture.create().unwrap();
        fixture.ends(0)[0].process.exit(0);
        fixture.wait_for_exit();
    }

    #[test]
    fn resize_reaches_the_process_and_rejects_an_empty_size() {
        let fixture = Fixture::new();
        let info = fixture.create().unwrap();
        let sizes: Vec<_> = (1..=50)
            .map(|rows| TerminalSize { cols: 120, rows })
            .collect();
        for &size in &sizes {
            fixture.terminals.resize(info.id, size).unwrap();
        }

        wait_until(|| *lock(&fixture.ends(0)[0].process.sizes) == sizes);
        let empty = TerminalSize { cols: 0, rows: 40 };
        let error = fixture.terminals.resize(info.id, empty).unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidInput);
    }

    #[test]
    fn close_kills_the_shell_and_forgets_the_terminal() {
        let fixture = Fixture::new();
        let info = fixture.create().unwrap();
        fixture.terminals.close(info.id).unwrap();

        assert!(*lock(&fixture.ends(0)[0].process.killed));
        fixture.wait_for_exit();
        let error = fixture.terminals.write(info.id, "x").unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert_eq!(
            fixture.terminals.close(info.id).unwrap_err().kind,
            ErrorKind::NotFound
        );
    }

    #[test]
    fn close_all_kills_every_shell() {
        let fixture = Fixture::new();
        fixture.create().unwrap();
        fixture.create().unwrap();
        fixture.terminals.close_all();

        let ends = fixture.ends(1);
        assert!(ends.iter().all(|end| *lock(&end.process.killed)));
    }

    #[test]
    fn spawn_failure_names_the_shell_it_tried() {
        let fixture = Fixture::with_spawner(FakeSpawner {
            fail: true,
            ..FakeSpawner::default()
        });
        let error = fixture.create().unwrap_err();

        assert_eq!(error.kind, ErrorKind::NotFound);
        assert!(error.message.contains("/bin/bash"), "{}", error.message);
    }
}
