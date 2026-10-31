//! Projeto CMake (docs/specs/projeto.md) com o cmake de verdade, numa cópia temporária das
//! fixtures. Sem `cmake` no PATH os testes são pulados com um aviso. Fora do Windows: lá o
//! compilador depende do ambiente do vcvars, que ainda não é aplicado.
#![cfg(not(windows))]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use darktriad_core::{
    Project, ProjectChoice, ProjectEvent, ProjectState, ProjectStatus, ToolProbe,
};
use darktriad_infra::{LocalFileApi, LocalFileSystem, StdProcessRunner, SystemToolProbe};

/// Pasta temporária fora do repositório, apagada no fim mesmo se o teste falhar.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures")
        .join(name)
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

fn probe() -> SystemToolProbe {
    SystemToolProbe::new(std::env::temp_dir().join("darktriad-sem-ferramentas"))
}

/// Configura uma cópia da fixture e devolve o estado final e as linhas do canal CMake.
/// `None` quando não há cmake para testar.
fn configure(name: &str) -> Option<(TempDir, ProjectState, Vec<String>)> {
    if probe().find("cmake").is_empty() {
        eprintln!("PULADO: `cmake` não está no PATH; o teste de integração do CMake não rodou.");
        return None;
    }
    let path = std::env::temp_dir().join(format!("darktriad-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    copy_dir(&fixture(name), &path);
    // No macOS a pasta temporária passa por um link (/var → /private/var), e o CMake informa a
    // pasta de build pelo caminho real.
    let root = TempDir(fs::canonicalize(&path).unwrap());
    let before: Vec<_> = fs::read_dir(fixture(name))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();

    let output = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&output);
    let project = Project::new(
        LocalFileSystem,
        StdProcessRunner,
        LocalFileApi,
        probe(),
        move |event| {
            if let ProjectEvent::Output { line } = event {
                sink.lock().unwrap().push(line);
            }
        },
    );
    project.open(&root.0, ProjectChoice::default());

    let after: Vec<_> = fs::read_dir(fixture(name))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(
        before.len(),
        after.len(),
        "a fixture ganhou arquivos: {after:?}"
    );
    let output = output.lock().unwrap().clone();
    Some((root, project.state(), output))
}

fn assert_ready(state: &ProjectState, output: &[String], build_dir: &Path) {
    assert_eq!(state.status, ProjectStatus::Ready, "{}", output.join("\n"));
    assert_eq!(state.build_dir.as_deref(), Some(build_dir));
    let names: Vec<_> = state
        .targets
        .iter()
        .map(|target| target.name.as_str())
        .collect();
    assert_eq!(names, ["app", "tool"]);
    for target in &state.targets {
        assert!(
            target.path.is_absolute() && target.path.starts_with(build_dir),
            "{target:?}"
        );
    }
    assert_eq!(state.target.as_deref(), Some("app"));
    assert!(build_dir.join("compile_commands.json").is_file());
}

#[test]
fn hello_cpp_configures_in_build_debug_with_app_and_tool() {
    let Some((root, state, output)) = configure("hello-cpp") else {
        return;
    };
    assert_eq!(state.configs, ["Debug", "Release"]);
    assert_ready(&state, &output, &root.0.join("build/debug"));
    assert!(
        output
            .iter()
            .any(|line| line.starts_with("-- Build files have been written to"))
    );
}

#[test]
fn hello_cpp_presets_uses_the_binary_dir_of_the_preset() {
    let Some((root, state, output)) = configure("hello-cpp-presets") else {
        return;
    };
    assert_eq!(state.configs, ["debug", "release"]);
    assert_eq!(state.config.as_deref(), Some("debug"));
    assert_ready(&state, &output, &root.0.join("out/build/debug"));
    assert!(!root.0.join("build").exists());
}
