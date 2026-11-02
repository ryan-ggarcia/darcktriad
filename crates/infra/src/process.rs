//! Processos externos com `std::process`: os que rodam até o fim (cmake…), linha a linha e
//! canceláveis, e os servidores de linguagem, que falam pelo stdio.

use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use darktriad_core::{ProcessRunner, ServerProcess, ServerSpawner, SpawnedServer};

/// De quanto em quanto tempo o pedido de cancelamento é conferido.
const CANCEL_POLL: Duration = Duration::from_millis(50);
pub(crate) const DOTNET_QUIET: [(&str, &str); 2] =
    [("DOTNET_CLI_TELEMETRY_OPTOUT", "1"), ("DOTNET_NOLOGO", "1")];

pub struct StdProcessRunner;

impl ProcessRunner for StdProcessRunner {
    fn run(
        &self,
        program: &Path,
        args: &[OsString],
        cwd: &Path,
        cancel: &AtomicBool,
        on_line: &mut dyn FnMut(&str),
    ) -> io::Result<bool> {
        let mut child = command(program, args, cwd).stdin(Stdio::null()).spawn()?;

        let (sender, lines) = mpsc::channel();
        let stdout = child
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>);
        let stderr = child
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>);
        for pipe in [stdout, stderr].into_iter().flatten() {
            let sender = sender.clone();
            thread::spawn(move || read_lines(pipe, &sender));
        }
        drop(sender);

        loop {
            if cancel.load(Ordering::Acquire) {
                kill(&mut child);
                return Err(io::ErrorKind::Interrupted.into());
            }
            match lines.recv_timeout(CANCEL_POLL) {
                Ok(line) => on_line(&line),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        Ok(child.wait()?.success())
    }
}

/// O processo com stdout e stderr ligados à IDE.
fn command(program: &Path, args: &[OsString], cwd: &Path) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        // Os dotnet que a IDE roda não mandam telemetria em nome do usuário nem põem o banner na Saída.
        .envs(DOTNET_QUIET)
        // shortcut: sem símbolos do debuginfod; o lldb-dap travava baixando os do próprio lldb-dap
        // (o lançador do runInTerminal). Ligar quando houver um limite de tempo ou progresso.
        .env_remove("DEBUGINFOD_URLS")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Sessão própria: encerrar mata também o que o processo iniciou (ninja, compiladores, BuildHost
    // do Roslyn). Grupo não basta: o ninja põe cada compilador num grupo próprio.
    #[cfg(unix)]
    // SAFETY: entre o fork e o exec só chama o setsid, que é seguro ali.
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(&mut command, || {
            libc::setsid();
            Ok(())
        });
    }
    // Sem a janela de console que o Windows abriria para um app sem console (build de release).
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    command
}

/// Servidores de linguagem (clangd, Roslyn) falando pelo stdio.
pub struct StdServerSpawner;

impl ServerSpawner for StdServerSpawner {
    fn spawn(&self, program: &Path, args: &[OsString], cwd: &Path) -> io::Result<SpawnedServer> {
        let mut child = command(program, args, cwd).stdin(Stdio::piped()).spawn()?;
        let missing = || io::Error::other("o servidor iniciou sem stdio");
        Ok(SpawnedServer {
            stdout: Box::new(child.stdout.take().ok_or_else(missing)?),
            stderr: Box::new(child.stderr.take().ok_or_else(missing)?),
            stdin: Box::new(child.stdin.take().ok_or_else(missing)?),
            process: Box::new(ServerChild(Mutex::new(child))),
        })
    }
}

/// O `wait` consulta o processo aos poucos, soltando o lock entre uma consulta e outra, para o
/// `kill` poder entrar no meio.
struct ServerChild(Mutex<Child>);

impl ServerProcess for ServerChild {
    fn kill(&self) -> io::Result<()> {
        let mut child = lock(&self.0);
        // Depois de recolhido, o PID pode ser de outro processo.
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        kill(&mut child);
        Ok(())
    }

    fn wait(&self) -> io::Result<Option<i32>> {
        loop {
            let mut child = lock(&self.0);
            // O que o servidor iniciou não sobrevive a ele (ex.: o programa sob o netcoredbg).
            #[cfg(unix)]
            if exited_unreaped(&child) {
                kill(&mut child);
            }
            if let Some(status) = child.try_wait()? {
                return Ok(status.code());
            }
            drop(child);
            thread::sleep(CANCEL_POLL);
        }
    }
}

/// O processo terminou e ainda não foi recolhido: o id da sessão continua sendo dele.
#[cfg(unix)]
fn exited_unreaped(child: &Child) -> bool {
    // SAFETY: o `waitid` com WNOWAIT só consulta o filho e preenche `info`; não o recolhe.
    unsafe {
        let mut info: libc::siginfo_t = std::mem::zeroed();
        let flags = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
        libc::waitid(libc::P_PID, child.id(), &mut info, flags) == 0
            && info.si_signo == libc::SIGCHLD
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Manda cada linha, sem o fim de linha. Texto que não é UTF-8 vira �, sem parar a leitura.
fn read_lines(pipe: Box<dyn Read + Send>, sender: &Sender<String>) {
    let mut reader = BufReader::new(pipe);
    let mut line = Vec::new();
    while matches!(reader.read_until(b'\n', &mut line), Ok(read) if read > 0) {
        let text = String::from_utf8_lossy(&line);
        if sender
            .send(text.trim_end_matches(['\r', '\n']).to_owned())
            .is_err()
        {
            return;
        }
        line.clear();
    }
}

fn kill(child: &mut Child) {
    // O processo ainda não foi recolhido, então o id do grupo e da sessão continua sendo dele.
    #[cfg(unix)]
    {
        let session = child.id() as libc::pid_t;
        // SAFETY: só consulta a sessão e envia sinais aos processos dela. O grupo morre primeiro,
        // para o cmake e o ninja não iniciarem mais nada durante a varredura.
        unsafe {
            libc::kill(-session, libc::SIGKILL);
            for pid in crate::pty::all_pids() {
                if libc::getsid(pid) == session {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }
    #[cfg(windows)]
    if !kill_tree(child.id()) {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// Encerra o processo e tudo o que ele iniciou (ninja, compiladores, BuildHost do Roslyn).
/// `true` se o `taskkill` deu certo.
#[cfg(windows)]
pub(crate) fn kill_tree(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;

    Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(0x0800_0000)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(all(test, unix))]
mod tests {
    use std::io::Write;
    use std::sync::Arc;
    use std::time::Instant;

    use super::*;

    fn run(script: &str, cancel: &AtomicBool) -> (io::Result<bool>, Vec<String>) {
        let mut lines = Vec::new();
        let result = StdProcessRunner.run(
            Path::new("/bin/sh"),
            &["-c".into(), script.into()],
            &std::env::temp_dir(),
            cancel,
            &mut |line| lines.push(line.to_owned()),
        );
        (result, lines)
    }

    fn is_alive(pid: libc::pid_t) -> bool {
        // SAFETY: o sinal 0 só confere se o processo existe.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn lines_of_stdout_and_stderr_arrive_and_the_exit_code_counts() {
        let cancel = AtomicBool::new(false);
        let (result, lines) = run(
            "printf 'um\\r\\ndois\\n'; echo erro >&2; printf '\\377fim'",
            &cancel,
        );
        assert!(result.unwrap());
        for line in ["um", "dois", "erro", "\u{FFFD}fim"] {
            assert!(lines.contains(&line.to_string()), "{lines:?}");
        }

        let (result, _) = run("exit 3", &cancel);
        assert!(!result.unwrap());
    }

    #[test]
    fn dotnet_runs_without_telemetry_or_banner() {
        let (result, lines) = run(
            "echo $DOTNET_CLI_TELEMETRY_OPTOUT$DOTNET_NOLOGO",
            &AtomicBool::new(false),
        );
        assert!(result.unwrap());
        assert_eq!(lines, ["11"]);
    }

    #[test]
    fn cancel_kills_the_process_and_what_it_started() {
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancel);
        let (pids, received) = mpsc::channel();
        let worker = thread::spawn(move || {
            let mut on_line = |line: &str| {
                let _ = pids.send(line.parse::<libc::pid_t>().unwrap());
            };
            let start = Instant::now();
            let result = StdProcessRunner.run(
                Path::new("/bin/sh"),
                &["-c".into(), "sleep 30 & echo $!; wait".into()],
                &std::env::temp_dir(),
                &flag,
                &mut on_line,
            );
            (result, start.elapsed())
        });
        let grandchild = received.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(is_alive(grandchild));

        cancel.store(true, Ordering::Release);
        let (result, elapsed) = worker.join().unwrap();
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert!(elapsed < Duration::from_secs(10), "{elapsed:?}");
        // O `sleep` é filho do sh: depois do SIGKILL vira zumbi até o init recolhê-lo.
        let start = Instant::now();
        while is_alive(grandchild) && !is_zombie(grandchild) {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "o filho continua vivo"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn server_talks_through_stdio_and_kill_ends_it_and_its_children() {
        let script = "echo log >&2; sleep 30 & echo $!; cat";
        let spawned = StdServerSpawner
            .spawn(
                Path::new("/bin/sh"),
                &["-c".into(), script.into()],
                &std::env::temp_dir(),
            )
            .unwrap();
        let mut stdin = spawned.stdin;
        stdin.write_all(b"ola\n").unwrap();
        stdin.flush().unwrap();
        let mut stdout = BufReader::new(spawned.stdout);
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let grandchild: libc::pid_t = line.trim().parse().unwrap();
        line.clear();
        stdout.read_line(&mut line).unwrap();
        assert_eq!(line, "ola\n");
        line.clear();
        BufReader::new(spawned.stderr).read_line(&mut line).unwrap();
        assert_eq!(line, "log\n");

        let process: Arc<dyn ServerProcess> = Arc::from(spawned.process);
        let waiter = {
            let process = Arc::clone(&process);
            thread::spawn(move || process.wait())
        };
        process.kill().unwrap();
        assert_eq!(waiter.join().unwrap().unwrap(), None);
        process.kill().unwrap();
        let start = Instant::now();
        while is_alive(grandchild) && !is_zombie(grandchild) {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "o filho continua vivo"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_server_that_exits_on_its_own_takes_its_children_along() {
        let spawned = StdServerSpawner
            .spawn(
                Path::new("/bin/sh"),
                &["-c".into(), "sleep 30 & echo $!; read x; exit 3".into()],
                &std::env::temp_dir(),
            )
            .unwrap();
        let mut line = String::new();
        BufReader::new(spawned.stdout).read_line(&mut line).unwrap();
        let grandchild: libc::pid_t = line.trim().parse().unwrap();
        let mut stdin = spawned.stdin;
        stdin.write_all(b"fim\n").unwrap();
        stdin.flush().unwrap();

        assert_eq!(spawned.process.wait().unwrap(), Some(3));
        let start = Instant::now();
        while is_alive(grandchild) && !is_zombie(grandchild) {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "o filho continua vivo"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn debuginfod_is_off_for_the_processes_of_the_ide() {
        let spawned = StdServerSpawner
            .spawn(Path::new("/usr/bin/env"), &[], &std::env::temp_dir())
            .unwrap();
        let mut env = String::new();
        BufReader::new(spawned.stdout)
            .read_to_string(&mut env)
            .unwrap();
        assert!(!env.contains("DEBUGINFOD_URLS="), "{env}");
    }

    #[cfg(target_os = "linux")]
    fn is_zombie(pid: libc::pid_t) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
            stat.rsplit_once(')')
                .is_some_and(|(_, rest)| rest.trim_start().starts_with('Z'))
        })
    }

    #[cfg(not(target_os = "linux"))]
    fn is_zombie(_: libc::pid_t) -> bool {
        false
    }
}
