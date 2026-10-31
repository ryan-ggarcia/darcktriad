//! Pseudo-terminais com o portable-pty: ConPTY no Windows, PTY no Unix.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use darktriad_core::{
    Platform, PtySpawner, SpawnedTerminal, TerminalProcess, TerminalSize, default_shell,
};
#[cfg(windows)]
use portable_pty::ChildKiller;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};

/// O shell padrão deste computador (regras em [`default_shell`]).
pub fn detect_default_shell() -> PathBuf {
    let shell_var = std::env::var("SHELL").ok();
    let pwsh_on_path = cfg!(windows) && is_on_path("pwsh.exe");
    default_shell(Platform::current(), shell_var.as_deref(), pwsh_on_path)
}

fn is_on_path(program: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(program).is_file()))
}

pub struct PortablePty;

impl PtySpawner for PortablePty {
    fn spawn(&self, program: &Path, cwd: &Path, size: TerminalSize) -> io::Result<SpawnedTerminal> {
        let pair = native_pty_system()
            .openpty(pty_size(size))
            .map_err(io::Error::other)?;
        let mut command = CommandBuilder::new(program);
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(io::Error::other)?;
        // A saída só chega ao fim quando ninguém mais segura o lado do shell.
        drop(pair.slave);

        let output = pair.master.try_clone_reader().map_err(io::Error::other)?;
        let input = pair.master.take_writer().map_err(io::Error::other)?;
        Ok(SpawnedTerminal {
            output,
            input,
            process: Box::new(PtyProcess {
                pid: child.process_id(),
                #[cfg(windows)]
                killer: Mutex::new(child.clone_killer()),
                child: Mutex::new(child),
                master: Mutex::new(Some(pair.master)),
                exited: AtomicBool::new(false),
            }),
        })
    }
}

fn pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

struct PtyProcess {
    /// No Unix é também o id da sessão: o shell é o líder da sessão do PTY.
    pid: Option<u32>,
    #[cfg(windows)]
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Preso pelo `wait` enquanto o shell roda; por isso o `kill` não passa por ele.
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// `None` depois de fechado. No Windows, soltar o ConPTY encerra os programas ligados a ele.
    /// No Unix não desliga o terminal (o leitor e o escritor seguram cópias do descritor), por isso
    /// o `kill` sinaliza a sessão do shell.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    /// O shell já foi recolhido pelo `wait`: o PID pode ter ido para outro processo.
    exited: AtomicBool,
}

impl PtyProcess {
    fn close_terminal(&self) {
        lock(&self.master).take();
    }

    /// O shell teve a chance de sair com o SIGHUP; quem o ignora é encerrado à força.
    #[cfg(unix)]
    fn force_kill_after_grace(&self) {
        use std::time::{Duration, Instant};

        const GRACE: Duration = Duration::from_millis(500);
        let deadline = Instant::now() + GRACE;
        while Instant::now() < deadline {
            if self.exited.load(Ordering::Acquire) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        self.signal_session(libc::SIGKILL);
    }

    /// Sinaliza o shell e todo processo da sessão dele, inclusive os trabalhos em segundo plano,
    /// que o controle de trabalhos põe em outros grupos de processos.
    #[cfg(unix)]
    fn signal_session(&self, signal: libc::c_int) {
        let Some(session) = self.pid.map(|pid| pid as libc::pid_t) else {
            return;
        };
        // Com o shell recolhido, o PID (e o id da sessão) pode ser de outro processo.
        if self.exited.load(Ordering::Acquire) {
            return;
        }
        // SAFETY: só consulta a sessão e envia sinais.
        for pid in all_pids() {
            if unsafe { libc::getsid(pid) } == session {
                unsafe { libc::kill(pid, signal) };
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn all_pids() -> Vec<libc::pid_t> {
    std::fs::read_dir("/proc")
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn all_pids() -> Vec<libc::pid_t> {
    // SAFETY: com buffer nulo só conta os processos; depois preenche no máximo `pids.len()`.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    // Folga para os processos que nascerem entre as duas chamadas.
    let mut pids: Vec<libc::pid_t> = vec![0; count.max(0) as usize + 64];
    let bytes = (pids.len() * size_of::<libc::pid_t>()) as libc::c_int;
    let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    pids.truncate(filled.max(0) as usize);
    pids
}

impl TerminalProcess for PtyProcess {
    fn pid(&self) -> Option<u32> {
        self.pid
    }

    fn resize(&self, size: TerminalSize) -> io::Result<()> {
        match lock(&self.master).as_ref() {
            Some(master) => master.resize(pty_size(size)).map_err(io::Error::other),
            None => Ok(()),
        }
    }

    #[cfg(unix)]
    fn kill(&self) -> io::Result<()> {
        // O SIGHUP de um terminal que desliga.
        self.signal_session(libc::SIGHUP);
        self.close_terminal();
        self.force_kill_after_grace();
        Ok(())
    }

    #[cfg(windows)]
    fn kill(&self) -> io::Result<()> {
        // O portable-pty 0.9 inverte o resultado do TerminateProcess (sucesso vira Err com código 0);
        // o próprio WinChild::kill dele ignora o resultado. O `wait` confirma o fim.
        let _ = lock(&self.killer).kill();
        self.close_terminal();
        Ok(())
    }

    fn wait(&self) -> io::Result<u32> {
        let status = lock(&self.child).wait()?;
        self.exited.store(true, Ordering::Release);
        // No Windows a leitura do ConPTY só chega ao fim depois que o terminal é fechado.
        #[cfg(windows)]
        self.close_terminal();
        Ok(status.exit_code())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::test_support::TempDir;

    const TIMEOUT: Duration = Duration::from_secs(20);

    fn collect(mut output: Box<dyn Read + Send>) -> Arc<Mutex<Vec<u8>>> {
        let collected = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&collected);
        thread::spawn(move || {
            let mut buffer = [0; 4096];
            while let Ok(read @ 1..) = output.read(&mut buffer) {
                lock(&sink).extend_from_slice(&buffer[..read]);
            }
        });
        collected
    }

    /// O texto que o terminal mostraria, sem as sequências de escape (cores, cursor, título).
    fn visible_text(bytes: &[u8]) -> String {
        let text = String::from_utf8_lossy(bytes);
        let mut visible = String::new();
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '\x1b' {
                visible.push(c);
                continue;
            }
            match chars.next() {
                Some('[') => while chars.next().is_some_and(|c| !('@'..='~').contains(&c)) {},
                Some(']') => {
                    while let Some(c) = chars.next() {
                        if c == '\x07' || (c == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
                            break;
                        }
                    }
                }
                _ => {}
            }
        }
        visible
    }

    fn wait_until(what: &str, done: impl Fn() -> bool) {
        let start = Instant::now();
        while !done() {
            assert!(start.elapsed() < TIMEOUT, "esperando {what}");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn shell_runs_in_the_pty_and_ends_when_killed() {
        let folder = TempDir::new("terminal");
        let size = TerminalSize {
            cols: 100,
            rows: 30,
        };
        let spawned = PortablePty
            .spawn(&detect_default_shell(), &folder, size)
            .unwrap();
        let process: Arc<dyn TerminalProcess> = Arc::from(spawned.process);
        let output = collect(spawned.output);
        let waiter = {
            let process = Arc::clone(&process);
            thread::spawn(move || process.wait())
        };
        let mut input = spawned.input;

        // O ConPTY pede a posição do cursor e não mostra nada até a resposta (na IDE, o xterm.js
        // responde). No Unix ninguém pergunta.
        #[cfg(windows)]
        {
            let asked = || lock(&output).windows(4).any(|bytes| bytes == b"\x1b[6n");
            wait_until("o pedido da posição do cursor", asked);
            input.write_all(b"\x1b[1;1R").unwrap();
        }

        // As aspas fazem o eco do que foi digitado diferir da saída do comando (sh, zsh e pwsh).
        input.write_all(b"echo dark-\"triad\"\r").unwrap();
        input.flush().unwrap();
        let printed = |text: &str| visible_text(&lock(&output)).contains(text);
        wait_until("a saída do echo", || printed("dark-triad"));

        #[cfg(unix)]
        {
            input.write_all(b"stty size\r").unwrap();
            input.flush().unwrap();
            wait_until("o tamanho pedido", || printed("30 100"));
        }

        let pid = process.pid().unwrap();
        process.kill().unwrap();
        wait_until("o shell terminar", || waiter.is_finished());
        waiter.join().unwrap().unwrap();
        #[cfg(unix)]
        {
            // SAFETY: o sinal 0 só consulta se o processo existe.
            let alive = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
            assert!(!alive, "o processo {pid} continua existindo");
        }
        #[cfg(not(unix))]
        let _ = pid;
    }

    #[cfg(unix)]
    #[test]
    fn killing_the_terminal_also_ends_the_program_running_in_it() {
        let folder = TempDir::new("terminal-filho");
        let size = TerminalSize { cols: 80, rows: 24 };
        let spawned = PortablePty
            .spawn(&detect_default_shell(), &folder, size)
            .unwrap();
        let process: Arc<dyn TerminalProcess> = Arc::from(spawned.process);
        let _output = collect(spawned.output);
        let waiter = {
            let process = Arc::clone(&process);
            thread::spawn(move || process.wait())
        };
        let mut input = spawned.input;
        input.write_all(b"sleep 1000\r").unwrap();
        input.flush().unwrap();

        let shell = process.pid().unwrap().to_string();
        let children = || {
            let out = std::process::Command::new("pgrep")
                .args(["-P", &shell, "sleep"])
                .output()
                .unwrap();
            String::from_utf8(out.stdout).unwrap()
        };
        wait_until("o sleep começar", || !children().trim().is_empty());
        let sleep: libc::pid_t = children().trim().parse().unwrap();

        process.kill().unwrap();
        wait_until("o shell terminar", || waiter.is_finished());
        // SAFETY: o sinal 0 só consulta se o processo existe.
        wait_until("o sleep terminar", || unsafe { libc::kill(sleep, 0) } != 0);
    }

    /// Um shell que já terminou e foi recolhido não leva sinal: o PID dele pode ser de outro
    /// processo. Aqui o PID é o de outro terminal, que precisa continuar vivo.
    #[cfg(unix)]
    #[test]
    fn closing_after_the_shell_exited_signals_nobody() {
        let folder = TempDir::new("terminal-pid");
        let size = TerminalSize { cols: 80, rows: 24 };
        let stranger = PortablePty
            .spawn(&detect_default_shell(), &folder, size)
            .unwrap();
        let stranger: Arc<dyn TerminalProcess> = Arc::from(stranger.process);
        let stranger_waiter = {
            let stranger = Arc::clone(&stranger);
            thread::spawn(move || stranger.wait())
        };

        let pair = native_pty_system().openpty(pty_size(size)).unwrap();
        let child = pair
            .slave
            .spawn_command(CommandBuilder::new("true"))
            .unwrap();
        let exited = PtyProcess {
            pid: stranger.pid(),
            child: Mutex::new(child),
            master: Mutex::new(Some(pair.master)),
            exited: AtomicBool::new(false),
        };
        exited.wait().unwrap();
        exited.kill().unwrap();

        thread::sleep(Duration::from_millis(200));
        assert!(
            !stranger_waiter.is_finished(),
            "o sinal atingiu outro processo"
        );
        stranger.kill().unwrap();
        stranger_waiter.join().unwrap().unwrap();
    }
}
