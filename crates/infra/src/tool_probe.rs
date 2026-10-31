//! Busca das ferramentas externas: `PATH`, caminhos conhecidos da spec e a pasta da IDE.

use std::env;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use darktriad_core::ToolProbe;

/// Uma ferramenta que não responde ao `--version` nesse tempo é tratada como sem versão.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

pub struct SystemToolProbe {
    path: OsString,
    home: Option<PathBuf>,
    dotnet_root: Option<PathBuf>,
    /// A pasta de ferramentas da IDE (`<dados do app>/tools`).
    tools_dir: PathBuf,
    timeout: Duration,
}

impl SystemToolProbe {
    /// Usa o `PATH`, o `HOME` e o `DOTNET_ROOT` da IDE.
    pub fn new(tools_dir: PathBuf) -> Self {
        Self {
            path: env::var_os("PATH").unwrap_or_default(),
            home: env::var_os("HOME").map(PathBuf::from),
            dotnet_root: env::var_os("DOTNET_ROOT").map(PathBuf::from),
            tools_dir,
            timeout: VERSION_TIMEOUT,
        }
    }

    fn known_paths(&self, program: &str, path_dirs: &[PathBuf]) -> Vec<PathBuf> {
        match program {
            "clangd" | "lldb-dap" => llvm_paths(program, path_dirs),
            "dotnet" => (self.dotnet_root.iter().cloned())
                .chain(self.home.iter().map(|home| home.join(".dotnet")))
                .map(|dir| dir.join(executable(program)))
                .collect(),
            "roslyn-language-server" => (self.home.iter())
                .map(|home| home.join(".dotnet/tools").join(executable(program)))
                .collect(),
            _ => Vec::new(),
        }
    }
}

impl ToolProbe for SystemToolProbe {
    fn find(&self, program: &str) -> Vec<PathBuf> {
        let path_dirs: Vec<PathBuf> = env::split_paths(&self.path).collect();
        let on_path = path_dirs.iter().map(|dir| dir.join(executable(program)));
        let mut found = Vec::new();
        for candidate in on_path
            .chain(self.known_paths(program, &path_dirs))
            .chain([self.tools_dir.join(executable(program))])
        {
            if candidate.is_file() && !found.contains(&candidate) {
                found.push(candidate);
            }
        }
        found
    }

    fn version_output(&self, path: &Path) -> io::Result<String> {
        output_within(Command::new(path).arg("--version"), self.timeout)
    }
}

fn executable(program: &str) -> String {
    format!("{program}{}", env::consts::EXE_SUFFIX)
}

#[cfg(target_os = "macos")]
fn llvm_paths(program: &str, _: &[PathBuf]) -> Vec<PathBuf> {
    // Sem as Command Line Tools, o `xcrun` abriria o diálogo de instalação.
    let has_developer_tools =
        output_within(Command::new("xcode-select").arg("-p"), VERSION_TIMEOUT).is_ok();
    let xcrun = has_developer_tools
        .then(|| {
            output_within(
                Command::new("xcrun").args(["--find", program]),
                VERSION_TIMEOUT,
            )
            .ok()
        })
        .flatten()
        .map(|output| PathBuf::from(output.trim()));
    xcrun
        .into_iter()
        .chain(
            ["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin"]
                .map(|dir| Path::new(dir).join(program)),
        )
        .collect()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn llvm_paths(program: &str, path_dirs: &[PathBuf]) -> Vec<PathBuf> {
    versioned(program, path_dirs)
}

// shortcut: no Windows só o PATH e a pasta da IDE; `C:\Program Files\LLVM\bin` entra na rodada do Windows.
#[cfg(windows)]
fn llvm_paths(_: &str, _: &[PathBuf]) -> Vec<PathBuf> {
    Vec::new()
}

/// `<programa>-<N>` das pastas do `PATH`, da maior versão para a menor (Debian e Ubuntu).
#[cfg(not(any(target_os = "macos", windows)))]
fn versioned(program: &str, path_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let prefix = format!("{program}-");
    let mut found: Vec<(u32, PathBuf)> = path_dirs
        .iter()
        .flat_map(|dir| std::fs::read_dir(dir).into_iter().flatten().flatten())
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            Some((name.strip_prefix(&prefix)?.parse().ok()?, entry.path()))
        })
        .collect();
    found.sort_by_key(|(version, _)| std::cmp::Reverse(*version));
    found.into_iter().map(|(_, path)| path).collect()
}

/// O que o programa escreve (stdout e stderr), se ele terminar a tempo.
// shortcut: lê a saída só no fim; serve para `--version`, não para saídas maiores que o buffer do pipe.
fn output_within(command: &mut Command, timeout: Duration) -> io::Result<String> {
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut *command, 0x0800_0000);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let start = Instant::now();
    while child.try_wait()?.is_none() {
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::ErrorKind::TimedOut.into());
        }
        thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ));
    }
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(text)
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    use darktriad_core::{TOOLS, ToolStatus};

    use super::*;
    use crate::test_support::TempDir;

    fn probe(root: &Path, path_dirs: &[&str]) -> SystemToolProbe {
        SystemToolProbe {
            path: env::join_paths(path_dirs.iter().map(|dir| root.join(dir))).unwrap(),
            home: Some(root.join("home")),
            dotnet_root: Some(root.join("dotnet-root")),
            tools_dir: root.join("tools"),
            timeout: Duration::from_millis(500),
        }
    }

    /// Um programa falso que roda `body`.
    fn script(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn clangd() -> &'static darktriad_core::Tool {
        TOOLS.iter().find(|tool| tool.program == "clangd").unwrap()
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn path_comes_first_then_the_highest_clangd_n_then_the_ide_folder() {
        let root = TempDir::new("probe-order");
        for file in [
            "a/clangd",
            "b/clangd-15",
            "b/clangd-18",
            "b/clangd-tidy",
            "tools/clangd",
        ] {
            script(&root.join(file), "");
        }

        let found = probe(&root, &["a", "b"]).find("clangd");

        let expected =
            ["a/clangd", "b/clangd-18", "b/clangd-15", "tools/clangd"].map(|file| root.join(file));
        assert_eq!(found, expected);
    }

    #[test]
    fn dotnet_is_found_in_dotnet_root_and_in_the_home_folder() {
        let root = TempDir::new("probe-dotnet");
        for file in [
            "dotnet-root/dotnet",
            "home/.dotnet/dotnet",
            "home/.dotnet/tools/roslyn-language-server",
        ] {
            script(&root.join(file), "");
        }
        let probe = probe(&root, &[]);

        assert_eq!(
            probe.find("dotnet"),
            [
                root.join("dotnet-root/dotnet"),
                root.join("home/.dotnet/dotnet")
            ]
        );
        assert_eq!(
            probe.find("roslyn-language-server"),
            [root.join("home/.dotnet/tools/roslyn-language-server")]
        );
    }

    // No macOS o clangd do Xcode e o do Homebrew também contam, e os runners têm os dois.
    #[cfg(target_os = "linux")]
    #[test]
    fn clangd_off_the_path_is_missing_and_clangd_16_is_outdated() {
        let root = TempDir::new("probe-clangd");
        assert_eq!(clangd().check(&probe(&root, &["bin"])), ToolStatus::Missing);

        script(&root.join("bin/clangd"), "echo 'clangd version 16.0.0'");
        assert_eq!(
            clangd().check(&probe(&root, &["bin"])),
            ToolStatus::Outdated {
                path: root.join("bin/clangd"),
                version: Some("16.0.0".into()),
            }
        );
    }

    #[test]
    fn a_tool_that_does_not_answer_in_time_has_no_version() {
        let root = TempDir::new("probe-timeout");
        script(&root.join("bin/clangd"), "exec sleep 30");
        let probe = probe(&root, &["bin"]);

        let start = Instant::now();
        let error = probe.version_output(&root.join("bin/clangd")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
