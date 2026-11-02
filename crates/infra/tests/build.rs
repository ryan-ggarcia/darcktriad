//! Compilar e executar (docs/specs/compilar-e-executar.md) com o cmake, o dotnet e o PTY de
//! verdade, numa cópia temporária das fixtures: a parte do núcleo dos critérios 8 a 14. Sem a
//! ferramenta no PATH os testes são pulados com um aviso. Fora do Windows: lá o compilador
//! depende do ambiente do vcvars, que ainda não é aplicado.
#![cfg(not(windows))]

mod common;

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use common::{Events, TestProject, open};
use darktriad_core::{
    BuildProblem, BuildStatus, ProjectEvent, RunCommand, Severity, TerminalEvent, TerminalSize,
    Terminals,
};
use darktriad_infra::{PortablePty, detect_default_shell};

const TIMEOUT: Duration = Duration::from_secs(60);

fn results(events: &Events) -> Vec<(BuildStatus, Vec<BuildProblem>)> {
    (events.lock().unwrap().iter())
        .filter_map(|event| match event {
            ProjectEvent::BuildFinished { status, problems } => Some((*status, problems.clone())),
            _ => None,
        })
        .collect()
}

fn build_output(events: &Events) -> Vec<String> {
    (events.lock().unwrap().iter())
        .filter_map(|event| match event {
            ProjectEvent::BuildOutput { line } => Some(line.clone()),
            _ => None,
        })
        .collect()
}

/// Compila e devolve o resultado desta compilação.
fn build(project: &TestProject, events: &Events) -> (BuildStatus, Vec<BuildProblem>) {
    events.lock().unwrap().clear();
    project.build().unwrap();
    let [result] = results(events).try_into().unwrap();
    result
}

fn edit(file: &Path, from: &str, to: &str) {
    let text = fs::read_to_string(file).unwrap();
    assert!(text.contains(from), "{text}");
    fs::write(file, text.replacen(from, to, 1)).unwrap();
}

#[test]
fn hello_cpp_builds_and_a_missing_semicolon_becomes_a_problem() {
    let Some((root, project, events)) = open("hello-cpp", "cmake") else {
        return;
    };
    let (status, problems) = build(&project, &events);
    let output = build_output(&events);
    assert_eq!(status, BuildStatus::Succeeded, "{}", output.join("\n"));
    assert!(problems.is_empty(), "{problems:?}");
    let command = format!("--build {}", root.0.join("build/debug").display());
    assert!(output[0].starts_with("> ") && output[0].ends_with(&command));
    assert!(output.last().unwrap().starts_with("Concluída em "));

    let main = root.0.join("app/main.cpp");
    edit(&main, "return 0;", "return 0");
    let (status, problems) = build(&project, &events);
    assert_eq!(status, BuildStatus::Failed);
    let errors: Vec<_> = (problems.iter())
        .filter(|problem| problem.severity == Severity::Error)
        .collect();
    let [error] = errors.as_slice() else {
        panic!("{problems:#?}\n{}", build_output(&events).join("\n"));
    };
    assert_eq!(error.file.as_deref(), Some(main.as_path()));
    assert_eq!(error.line, Some(9));
    assert!(error.column.is_some());
    assert!(
        build_output(&events)
            .last()
            .unwrap()
            .starts_with("Falhou em ")
    );
}

#[test]
fn a_linker_error_gives_the_fallback_problem() {
    let Some((root, project, events)) = open("hello-cpp", "cmake") else {
        return;
    };
    edit(
        &root.0.join("app/main.cpp"),
        "int main() {",
        "int falta();\nint main() {\n    falta();",
    );
    let (status, problems) = build(&project, &events);
    assert_eq!(status, BuildStatus::Failed);
    let [problem] = problems.as_slice() else {
        panic!("{problems:#?}");
    };
    assert_eq!(problem.file, None);
    assert_eq!(problem.message, "A compilação falhou. Veja a Saída.");
}

#[cfg(target_os = "linux")]
#[test]
fn cancel_leaves_no_process_of_the_build_behind() {
    let Some((root, project, events)) = open("hello-cpp", "cmake") else {
        return;
    };
    let project = Arc::new(project);
    let builder = Arc::clone(&project);
    let worker = thread::spawn(move || builder.build());
    let start = Instant::now();
    while build_output(&events).is_empty() {
        assert!(start.elapsed() < TIMEOUT);
        thread::sleep(Duration::from_millis(5));
    }
    project.cancel_build();
    worker.join().unwrap().unwrap();

    let [(status, _)] = results(&events).try_into().unwrap();
    assert_eq!(status, BuildStatus::Cancelled);
    let root = root.0.display().to_string();
    // O SIGKILL leva um instante para chegar; um processo morto (zumbi) tem `cmdline` vazio. O
    // prazo fica abaixo do tempo de compilar: um compilador que escapou ainda estaria rodando.
    let leftovers = || -> Vec<String> {
        fs::read_dir("/proc")
            .unwrap()
            .filter_map(|entry| fs::read(entry.ok()?.path().join("cmdline")).ok())
            .map(|cmdline| String::from_utf8_lossy(&cmdline).replace('\0', " "))
            .filter(|cmdline| cmdline.contains(&root))
            .collect()
    };
    let start = Instant::now();
    while !leftovers().is_empty() {
        assert!(
            start.elapsed() < Duration::from_millis(500),
            "{:#?}",
            leftovers()
        );
        thread::sleep(Duration::from_millis(10));
    }
}

/// Roda o comando num PTY de verdade, digita `input` e devolve a saída e o código de saída.
fn run_in_terminal(command: &RunCommand, input: &str) -> (String, Option<u32>) {
    let terminals = Terminals::new(PortablePty, detect_default_shell());
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let size = TerminalSize { cols: 80, rows: 24 };
    let info = terminals
        .run(
            command.name.clone(),
            &command.program,
            &command.args,
            &command.cwd,
            size,
            move |event| sink.lock().unwrap().push(event),
        )
        .unwrap();
    assert_eq!(info.name, command.name);
    terminals.write(info.id, input).unwrap();
    let start = Instant::now();
    loop {
        let events = events.lock().unwrap();
        if let Some(TerminalEvent::Exited { code }) = events.last() {
            let output = (events.iter())
                .filter_map(|event| match event {
                    TerminalEvent::Output { data } => Some(data.clone()),
                    TerminalEvent::Exited { .. } => None,
                })
                .collect();
            return (output, *code);
        }
        assert!(start.elapsed() < TIMEOUT, "{events:?}");
        drop(events);
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn hello_c_runs_in_a_terminal_and_reads_the_keyboard() {
    let Some((root, project, _events)) = open("hello-c", "cmake") else {
        return;
    };
    let command = project.build_for_run().unwrap().unwrap();
    assert_eq!(command.name, "▶ hello");
    assert_eq!(command.cwd, root.0);
    let (output, code) = run_in_terminal(&command, "21\r");
    assert!(output.contains("42"), "{output:?}");
    assert_eq!(code, Some(0));
}

#[test]
fn hello_cs_runs_with_dotnet_run_and_its_errors_appear_once() {
    let Some((root, project, events)) = open("hello-cs", "dotnet") else {
        return;
    };
    let command = project.build_for_run().unwrap().unwrap();
    assert_eq!(command.name, "▶ hello-cs");
    let (output, code) = run_in_terminal(&command, "abc\r");
    assert!(output.contains("cba"), "{output:?}");
    assert_eq!(code, Some(0));

    let program = root.0.join("Program.cs");
    edit(
        &program,
        "var linha = Console.ReadLine() ?? \"\";",
        "int linha = \"x\";",
    );
    let (status, problems) = build(&project, &events);
    assert_eq!(status, BuildStatus::Failed);
    let errors: Vec<_> = (problems.iter())
        .filter(|problem| problem.code.as_deref() == Some("CS0029"))
        .collect();
    let [error] = errors.as_slice() else {
        panic!("{problems:#?}\n{}", build_output(&events).join("\n"));
    };
    assert_eq!(error.file.as_deref(), Some(program.as_path()));
    assert_eq!(error.line, Some(1));
    assert!(!error.message.ends_with(']'), "{}", error.message);
}
