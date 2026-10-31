//! Processos externos (cmake…) com `std::process`, linha a linha e canceláveis.

use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;

use darktriad_core::ProcessRunner;

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
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(cwd)
            // Os dotnet que a IDE roda não mandam telemetria em nome do usuário nem põem o banner na Saída.
            .envs(DOTNET_QUIET)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Grupo próprio: cancelar mata também o que o cmake iniciou (compilador, ninja).
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        // Sem a janela de console que o Windows abriria para um app sem console (build de release).
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
        let mut child = command.spawn()?;

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
    // O processo ainda não foi recolhido, então o id do grupo continua sendo dele.
    #[cfg(unix)]
    // SAFETY: só envia um sinal ao grupo criado para este processo.
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    // shortcut: no Windows só o cmake morre, não os filhos dele; usar um Job Object ao ligar o vcvars.
    #[cfg(windows)]
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(test, unix))]
mod tests {
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
