//! macOS: o `PATH` do shell de login. Aberto pelo Finder, o app não herda o do `~/.zprofile`
//! (Homebrew, cmake, dotnet), como no VS Code.

/// Cerca a saída do `env`: o que o shell interativo escreve antes ou depois fica de fora.
const MARK: &str = "__DARKTRIAD_ENV__";

/// O `PATH` da saída de `echo MARK; env; echo MARK`.
pub fn parse_login_path(output: &str) -> Option<&str> {
    let (_, rest) = output.split_once(MARK)?;
    let (env, _) = rest.rsplit_once(MARK)?;
    env.lines()
        .find_map(|line| line.strip_prefix("PATH="))
        .filter(|path| !path.is_empty())
}

/// Troca o `PATH` do app pelo do shell de login (`$SHELL -l -i`). Chame no começo do `main`,
/// antes de qualquer outra thread: os processos, o terminal e a busca de ferramentas herdam dele.
/// Um shell que não responde em 3 s é deixado de lado.
#[cfg(target_os = "macos")]
pub fn use_login_shell_path() {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    const TIMEOUT: Duration = Duration::from_secs(3);
    let Some(shell) = std::env::var_os("SHELL") else {
        return;
    };
    let script = format!("echo {MARK}; /usr/bin/env; echo {MARK}");
    let Ok(mut child) = Command::new(shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let Some(stdout) = child.stdout.take() else {
        return;
    };
    let (sender, received) = mpsc::channel();
    // Para na segunda marca: algo que o shell deixou rodando pode segurar o stdout aberto.
    std::thread::spawn(move || {
        let mut output = String::new();
        let mut marks = 0;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            marks += usize::from(line == MARK);
            output.push_str(&line);
            output.push('\n');
            if marks == 2 {
                break;
            }
        }
        let _ = sender.send(output);
    });
    let output = received.recv_timeout(TIMEOUT).unwrap_or_default();
    let _ = child.kill();
    let _ = child.wait();
    if let Some(path) = parse_login_path(&output) {
        // SAFETY: no começo do `main`, nenhuma outra thread lê o ambiente (a leitora só lê o cano).
        unsafe { std::env::set_var("PATH", path) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_path_comes_from_between_the_marks() {
        let output = format!(
            "Bem-vindo ao zsh\nPATH=/falso\n{MARK}\nHOME=/Users/a\n\
             PATH=/opt/homebrew/bin:/usr/bin\nMANPATH=/x\n{MARK}\nPATH=/depois\n"
        );
        assert_eq!(
            parse_login_path(&output),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(
            parse_login_path(&format!("{MARK}\nHOME=/a\n{MARK}\n")),
            None
        );
        assert_eq!(parse_login_path(&format!("{MARK}\nPATH=\n{MARK}\n")), None);
        assert_eq!(parse_login_path("PATH=/sem/marcas\n"), None);
    }
}
