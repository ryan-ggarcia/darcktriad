//! Busca das ferramentas externas: `PATH`, caminhos conhecidos da spec e a pasta da IDE.

use std::env;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use darktriad_core::ToolProbe;

#[cfg(windows)]
use crate::process::CREATE_NO_WINDOW;
use crate::process::DOTNET_QUIET;

/// Uma ferramenta que não responde ao `--version` nesse tempo é tratada como sem versão.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
/// Códigos de saída de quem não abre por falta de uma DLL: do carregador do Windows e do
/// carregamento tardio (o `lldb-dap` do LLVM 23 sem o Python).
#[cfg(windows)]
const MISSING_DLL: [u32; 2] = [0xC000_0135, 0xC06D_007E];

pub struct SystemToolProbe {
    /// `None`: o `PATH` da IDE, lido a cada busca porque, no Windows, o do MSVC chega depois.
    path: Option<OsString>,
    home: Option<PathBuf>,
    dotnet_root: Option<PathBuf>,
    /// A pasta de ferramentas da IDE (`<dados do app>/tools`).
    tools_dir: PathBuf,
    timeout: Duration,
}

impl SystemToolProbe {
    /// Usa o `PATH`, a pasta do usuário e o `DOTNET_ROOT` da IDE.
    pub fn new(tools_dir: PathBuf) -> Self {
        Self {
            path: None,
            home: env::home_dir(),
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
        let path = self.path.clone().unwrap_or_else(ide_path);
        let path_dirs: Vec<PathBuf> = env::split_paths(&path).collect();
        let on_path = path_dirs.iter().map(|dir| dir.join(executable(program)));
        let mut found = Vec::new();
        for candidate in on_path
            .chain(self.known_paths(program, &path_dirs))
            .chain([self.tools_dir.join(executable(program))])
        {
            // No Windows, o `dotnet tool install` só cria um `.cmd`.
            let candidate = if cfg!(windows) && !candidate.is_file() {
                candidate.with_extension("cmd")
            } else {
                candidate
            };
            if candidate.is_file() && !found.contains(&candidate) {
                found.push(candidate);
            }
        }
        found
    }

    fn version_output(&self, path: &Path) -> io::Result<String> {
        output_within(
            Command::new(path).arg("--version").envs(DOTNET_QUIET),
            self.timeout,
        )
    }
}

fn ide_path() -> OsString {
    #[cfg(windows)]
    if let Some(path) = crate::msvc::msvc_path() {
        return path;
    }
    env::var_os("PATH").unwrap_or_default()
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

/// Onde o instalador do LLVM põe os programas, quando a pessoa não marca a opção do `PATH`.
#[cfg(windows)]
fn llvm_paths(program: &str, _: &[PathBuf]) -> Vec<PathBuf> {
    (env::var_os("ProgramFiles").iter())
        .map(|dir| Path::new(dir).join("LLVM/bin").join(executable(program)))
        .collect()
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
    std::os::windows::process::CommandExt::creation_flags(&mut *command, CREATE_NO_WINDOW);
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
        #[cfg(windows)]
        if (output.status.code()).is_some_and(|code| MISSING_DLL.contains(&(code as u32))) {
            return Err(io::ErrorKind::NotFound.into());
        }
        return Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ));
    }
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(text)
}

#[cfg(all(test, windows))]
mod windows_tests {
    use std::fs;

    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn a_dotnet_tool_is_found_by_its_cmd_and_an_exe_comes_first() {
        let root = TempDir::new("probe-cmd");
        let dir = root.join("bin");
        fs::create_dir_all(&dir).unwrap();
        let probe = SystemToolProbe {
            path: Some(env::join_paths([&dir]).unwrap()),
            home: None,
            dotnet_root: None,
            tools_dir: root.join("tools"),
            timeout: VERSION_TIMEOUT,
        };
        assert!(probe.find("roslyn-language-server").is_empty());

        fs::write(dir.join("roslyn-language-server.cmd"), "").unwrap();
        assert_eq!(
            probe.find("roslyn-language-server"),
            [dir.join("roslyn-language-server.cmd")]
        );

        fs::write(dir.join("roslyn-language-server.exe"), "").unwrap();
        assert_eq!(
            probe.find("roslyn-language-server"),
            [dir.join("roslyn-language-server.exe")]
        );
    }

    #[test]
    fn a_program_without_its_dll_counts_as_not_found() {
        let kind_of_exit = |code: i64| {
            output_within(
                Command::new("cmd.exe").args(["/d", "/c", &format!("exit {code}")]),
                VERSION_TIMEOUT,
            )
            .unwrap_err()
            .kind()
        };
        for code in MISSING_DLL {
            assert_eq!(
                kind_of_exit(i64::from(code as i32)),
                io::ErrorKind::NotFound
            );
        }
        assert_ne!(kind_of_exit(3), io::ErrorKind::NotFound);
    }

    #[test]
    fn the_llvm_installer_folder_comes_after_the_path() {
        let program_files = env::var_os("ProgramFiles").unwrap();
        assert_eq!(
            llvm_paths("clangd", &[]),
            [Path::new(&program_files).join("LLVM/bin/clangd.exe")]
        );
    }

    #[test]
    fn the_user_folder_counts_without_a_home_variable() {
        let probe = SystemToolProbe::new(PathBuf::new());
        assert_eq!(probe.home, env::var_os("USERPROFILE").map(PathBuf::from));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::test_support::TempDir;

    fn probe(root: &Path, path_dirs: &[&str]) -> SystemToolProbe {
        SystemToolProbe {
            path: Some(env::join_paths(path_dirs.iter().map(|dir| root.join(dir))).unwrap()),
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

    #[cfg(target_os = "linux")]
    fn clangd() -> &'static darktriad_core::Tool {
        darktriad_core::TOOLS
            .iter()
            .find(|tool| tool.program == "clangd")
            .unwrap()
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
        use darktriad_core::ToolStatus;

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
    fn dotnet_version_runs_without_telemetry_or_banner() {
        let root = TempDir::new("probe-quiet");
        let dotnet = root.join("bin/dotnet");
        script(&dotnet, "echo $DOTNET_CLI_TELEMETRY_OPTOUT$DOTNET_NOLOGO");
        assert_eq!(
            probe(&root, &[]).version_output(&dotnet).unwrap().trim(),
            "11"
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
