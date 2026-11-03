//! Windows: o ambiente do compilador da Microsoft. Aberto pelo menu Iniciar, o app não tem o `cl` no
//! `PATH`, e quem cria esse ambiente é o `vcvars64.bat`; o `vswhere` diz onde ele está. Regra da
//! spec (docs/specs/projeto.md): só vale sem compilador no `PATH` e sem `CC`/`CXX`, porque quem tem
//! um já escolheu.

use std::env;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{OnceLock, mpsc};
use std::thread;
use std::time::Duration;

use crate::process::{CREATE_NO_WINDOW, kill_tree};

const COMPILERS: [&str; 6] = ["cl", "clang++", "clang", "g++", "gcc", "c++"];
const VC_TOOLS: &str = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64";
/// O `vcvars64.bat` leva cerca de 1,5 s. Quem precisar do ambiente antes disso espera, no máximo, isto.
const VCVARS_TIMEOUT: Duration = Duration::from_secs(30);

static ENVIRONMENT: OnceLock<Vec<(OsString, OsString)>> = OnceLock::new();

/// O que muda no ambiente de quem a IDE inicia. Vazio com compilador no `PATH` ou sem o MSVC.
pub fn msvc_environment() -> &'static [(OsString, OsString)] {
    ENVIRONMENT.get_or_init(load)
}

/// Calcula o ambiente em segundo plano: o `vcvars64.bat` não pode atrasar a abertura da janela.
pub fn prepare_msvc_environment() {
    thread::spawn(msvc_environment);
}

/// O `PATH` do ambiente do MSVC, que traz o `cl` e, com as CMake tools, o `cmake` e o `ninja`.
pub(crate) fn msvc_path() -> Option<OsString> {
    (msvc_environment().iter())
        .find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value.clone())
}

fn load() -> Vec<(OsString, OsString)> {
    let chosen = ["CC", "CXX"].iter().any(|name| env::var_os(name).is_some());
    if chosen || has_compiler(&env::var_os("PATH").unwrap_or_default()) {
        return Vec::new();
    }
    let Some(vcvars) = find_vcvars() else {
        return Vec::new();
    };
    let Some(output) = run_vcvars(&vcvars) else {
        return Vec::new();
    };
    changed_by_vcvars(&output, |name| env::var_os(name))
}

fn has_compiler(path: &OsStr) -> bool {
    env::split_paths(path).any(|dir| {
        COMPILERS
            .iter()
            .any(|compiler| dir.join(format!("{compiler}.exe")).is_file())
    })
}

fn find_vcvars() -> Option<PathBuf> {
    let vswhere = Path::new(&env::var_os("ProgramFiles(x86)")?)
        .join("Microsoft Visual Studio/Installer/vswhere.exe");
    let output = Command::new(vswhere)
        .args(["-products", "*", "-requires", VC_TOOLS, "-latest", "-utf8"])
        .args(["-property", "installationPath"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let installation = String::from_utf8_lossy(&output.stdout);
    let vcvars = Path::new(installation.trim()).join("VC/Auxiliary/Build/vcvars64.bat");
    vcvars.is_file().then_some(vcvars)
}

/// A saída do `set` depois do `vcvars64.bat`, em UTF-16 (`/u`): em código de página, um caminho com
/// acento viria errado.
fn run_vcvars(vcvars: &Path) -> Option<String> {
    let mut child = Command::new("cmd.exe")
        .args(["/d", "/u", "/s", "/c"])
        .raw_arg(format!("\"\"{}\" >nul 2>&1 & set\"", vcvars.display()))
        .env("VSCMD_SKIP_SENDTELEMETRY", "1")
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let pid = child.id();
    let mut stdout = child.stdout.take()?;
    let (sender, received) = mpsc::channel();
    // Lê enquanto ele roda: a saída é maior que o buffer do cano.
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let read = stdout.read_to_end(&mut bytes);
        let _ = sender.send(read.map(|_| utf16_text(&bytes)));
    });
    let output = (received.recv_timeout(VCVARS_TIMEOUT).ok()).and_then(Result::ok);
    if output.is_none() {
        kill_tree(pid);
    }
    let _ = child.wait();
    output
}

fn utf16_text(bytes: &[u8]) -> String {
    let units: Vec<u16> = (bytes.as_chunks().0.iter())
        .map(|pair| u16::from_le_bytes(*pair))
        .collect();
    String::from_utf16_lossy(&units)
}

/// As variáveis de `NOME=valor` que o `vcvars64.bat` criou ou mudou. Sem o `VCToolsInstallDir`, ele
/// falhou, e nada é aplicado.
fn changed_by_vcvars(
    output: &str,
    current: impl Fn(&str) -> Option<OsString>,
) -> Vec<(OsString, OsString)> {
    let variables: Vec<(&str, &str)> = output
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(name, _)| !name.is_empty())
        .collect();
    if !variables
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("VCToolsInstallDir"))
    {
        return Vec::new();
    }
    variables
        .into_iter()
        // O MSBuild lê o ambiente como propriedades: com ela, o `dotnet build` iria para `bin\x64`.
        .filter(|(name, _)| !name.eq_ignore_ascii_case("Platform"))
        .filter(|(name, value)| current(name).as_deref() != Some(OsStr::new(value)))
        .map(|(name, value)| (name.into(), value.into()))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn only_a_compiler_on_the_path_counts() {
        let root = TempDir::new("msvc-path");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("cmake.exe"), "").unwrap();
        let path = env::join_paths([&bin]).unwrap();
        assert!(!has_compiler(&path));

        fs::write(bin.join("clang++.exe"), "").unwrap();
        assert!(has_compiler(&path));
    }

    #[test]
    fn keeps_what_vcvars_changed_and_ignores_the_rest() {
        let output = "PATH=C:\\vs;C:\\win\r\nVCToolsInstallDir=C:\\vs\\tools\\\r\nINCLUDE=C:\\vs\\in\r\nPlatform=x64\r\nWINDIR=C:\\win\r\n\r\nsem igual\r\n";
        let current = |name: &str| match name {
            "PATH" => Some(OsString::from("C:\\win")),
            "WINDIR" => Some(OsString::from("C:\\win")),
            _ => None,
        };

        let changed = changed_by_vcvars(output, current);

        let names: Vec<_> = changed
            .iter()
            .map(|(name, _)| name.to_str().unwrap())
            .collect();
        assert_eq!(names, ["PATH", "VCToolsInstallDir", "INCLUDE"]);
        assert_eq!(changed[0].1, "C:\\vs;C:\\win");
    }

    #[test]
    fn a_vcvars_that_failed_changes_nothing() {
        assert!(changed_by_vcvars("PATH=C:\\vs\r\nINCLUDE=x\r\n", |_| None).is_empty());
    }

    /// Com o MSVC instalado e sem compilador no `PATH`, roda o `vcvars64.bat` de verdade.
    #[test]
    fn the_real_vcvars_brings_the_compiler() {
        let Some(vcvars) = find_vcvars() else {
            eprintln!("PULADO: sem o MSVC");
            return;
        };
        let output = run_vcvars(&vcvars).unwrap();
        let changed = changed_by_vcvars(&output, |_| None);
        let value = |wanted: &str| {
            changed
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(wanted))
                .map(|(_, value)| value.clone())
                .unwrap_or_else(|| panic!("sem {wanted}"))
        };
        assert!(has_compiler(&value("PATH")));
        assert!(!value("INCLUDE").is_empty());
        assert!(!value("LIB").is_empty());
    }
}
