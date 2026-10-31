//! Projeto CMake e .NET (docs/specs/projeto.md) com o cmake e o dotnet de verdade, numa cópia
//! temporária das fixtures. Sem a ferramenta no PATH os testes são pulados com um aviso. Fora do Windows: lá o
//! compilador depende do ambiente do vcvars, que ainda não é aplicado.
#![cfg(not(windows))]

mod common;

use std::path::Path;

use common::configure;
use darktriad_core::{ProjectState, ProjectStatus};

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
    let Some((root, state, output)) = configure("hello-cpp", "cmake") else {
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
    let Some((root, state, output)) = configure("hello-cpp-presets", "cmake") else {
        return;
    };
    assert_eq!(state.configs, ["debug", "release"]);
    assert_eq!(state.config.as_deref(), Some("debug"));
    assert_ready(&state, &output, &root.0.join("out/build/debug"));
    assert!(!root.0.join("build").exists());
}

#[test]
fn hello_cs_restores_and_targets_its_dll() {
    let Some((root, state, output)) = configure("hello-cs", "dotnet") else {
        return;
    };
    assert_eq!(state.status, ProjectStatus::Ready, "{}", output.join("\n"));
    assert_eq!(state.configs, ["Debug", "Release"]);
    assert_eq!(state.config.as_deref(), Some("Debug"));
    assert_eq!(state.target.as_deref(), Some("hello-cs"));
    let [target] = state.targets.as_slice() else {
        panic!("{:?}", state.targets);
    };
    assert_eq!(target.name, "hello-cs");
    assert_eq!(target.path, root.0.join("bin/Debug/net10.0/hello-cs.dll"));
    assert!(output[0].starts_with("> ") && output[0].contains(" restore "));
    assert!(root.0.join("obj/project.assets.json").is_file());
}
