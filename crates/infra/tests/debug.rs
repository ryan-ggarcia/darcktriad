//! Depuração (docs/specs/depuracao.md, critério 4) com o lldb-dap e o netcoredbg de verdade, sobre
//! cópias temporárias das fixtures compiladas. O cliente DAP é escrito à mão. Sem a ferramenta os
//! testes são pulados com um aviso. Fora do Windows, como os testes de compilar: lá o compilador
//! depende do ambiente do vcvars.
#![cfg(not(windows))]

mod common;

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use common::{TempDir, open, probe};
use darktriad_core::{
    CMakeTarget, DebugEvent, DebugLaunch, DebugSessions, TerminalEvent, TerminalSize, Terminals,
    ToolProbe,
};
use darktriad_infra::{PortablePty, StdServerSpawner, SystemToolProbe, detect_default_shell};
use serde_json::{Value, json};

const TIMEOUT: Duration = Duration::from_secs(60);
const SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };

type Sessions = DebugSessions<StdServerSpawner, SystemToolProbe, PortablePty>;

/// Um cliente DAP mínimo sobre a sessão do núcleo.
struct Dap {
    sessions: Arc<Sessions>,
    events: Receiver<DebugEvent>,
    seq: u32,
    /// Mensagens que chegaram antes de alguém esperar por elas (ex.: a resposta do `launch`, que o
    /// netcoredbg manda antes do `configurationDone`).
    unread: Vec<Value>,
    /// O que chegou pelo terminal `🐞`, se o adaptador pediu um.
    terminal: Option<(String, Receiver<TerminalEvent>)>,
}

impl Dap {
    fn new(sessions: Arc<Sessions>, events: Receiver<DebugEvent>) -> Self {
        Self {
            sessions,
            events,
            seq: 0,
            unread: Vec::new(),
            terminal: None,
        }
    }

    fn request(&mut self, command: &str, arguments: Value) -> u32 {
        self.seq += 1;
        let request =
            json!({"seq": self.seq, "type": "request", "command": command, "arguments": arguments});
        self.sessions.send(&request.to_string()).unwrap();
        self.seq
    }

    /// A primeira mensagem que satisfaz `wanted`. O pedido reverso `runInTerminal` é atendido
    /// como a interface faz.
    fn wait_for(&mut self, wanted: impl Fn(&Value) -> bool) -> Value {
        if let Some(index) = self.unread.iter().position(&wanted) {
            return self.unread.remove(index);
        }
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self
                .events
                .recv_timeout(left)
                .expect("o depurador não respondeu a tempo")
            {
                DebugEvent::Message { message } => {
                    let message: Value = serde_json::from_str(&message).unwrap();
                    if message["type"] == "request" && message["command"] == "runInTerminal" {
                        self.run_in_terminal(&message);
                    }
                    if wanted(&message) {
                        return message;
                    }
                    self.unread.push(message);
                }
                DebugEvent::Log { line } => eprintln!("[Depuração] {line}"),
                DebugEvent::Ended { reason } => panic!("a sessão acabou antes: {reason:?}"),
            }
        }
    }

    fn run_in_terminal(&mut self, request: &Value) {
        let arguments = &request["arguments"];
        let args: Vec<OsString> = (arguments["args"].as_array().unwrap().iter())
            .map(|arg| arg.as_str().unwrap().into())
            .collect();
        let cwd = PathBuf::from(arguments["cwd"].as_str().unwrap());
        let (sender, output) = mpsc::channel();
        let info = self
            .sessions
            .run_in_terminal(&args, &cwd, SIZE, move |event| {
                let _ = sender.send(event);
            })
            .unwrap();
        self.terminal = Some((info.name, output));
        self.seq += 1;
        let response = json!({
            "seq": self.seq, "type": "response", "request_seq": request["seq"],
            "command": "runInTerminal", "success": true, "body": {},
        });
        self.sessions.send(&response.to_string()).unwrap();
    }

    /// O corpo da resposta ao pedido `seq`, que tem de ter dado certo.
    fn reply(&mut self, seq: u32) -> Value {
        let reply = self.wait_for(|m| m["type"] == "response" && m["request_seq"] == seq);
        assert_eq!(reply["success"], true, "{reply}");
        reply["body"].clone()
    }

    fn event(&mut self, name: &str) -> Value {
        self.wait_for(|m| m["type"] == "event" && m["event"] == name)["body"].clone()
    }
}

/// O critério 4: para na linha, `main` no topo da pilha, a variável com o valor e o fim com 0.
fn debug_until_exit(
    dap: &mut Dap,
    launch: &DebugLaunch,
    source: &Path,
    line: u32,
    function: &str,
    variable: (&str, &str),
) {
    let seq = dap.request(
        "initialize",
        json!({"adapterID": launch.adapter, "linesStartAt1": true, "columnsStartAt1": true,
               "pathFormat": "path", "supportsRunInTerminalRequest": true}),
    );
    dap.reply(seq);
    let launched = dap.request("launch", launch.launch.clone());
    dap.event("initialized");
    let seq = dap.request(
        "setBreakpoints",
        json!({"source": {"path": source}, "breakpoints": [{"line": line}]}),
    );
    dap.reply(seq);
    let seq = dap.request("configurationDone", json!({}));
    dap.reply(seq);
    dap.reply(launched);

    let stopped = dap.event("stopped");
    assert_eq!(stopped["reason"], "breakpoint", "{stopped}");
    let thread = stopped["threadId"].clone();
    let seq = dap.request("stackTrace", json!({"threadId": thread}));
    let top = dap.reply(seq)["stackFrames"][0].clone();
    assert_eq!(top["line"], line, "{top}");
    assert!(top["name"].as_str().unwrap().contains(function), "{top}");
    let seq = dap.request("scopes", json!({"frameId": top["id"]}));
    let locals = dap.reply(seq)["scopes"][0]["variablesReference"].clone();
    let seq = dap.request("variables", json!({"variablesReference": locals}));
    let variables = dap.reply(seq)["variables"].clone();
    let (name, value) = variable;
    assert!(
        (variables.as_array().unwrap().iter()).any(|v| v["name"] == name && v["value"] == value),
        "{variables:#}"
    );

    dap.request("continue", json!({"threadId": thread}));
    assert_eq!(dap.event("exited")["exitCode"], 0);
    let seq = dap.request("disconnect", json!({"terminateDebuggee": true}));
    dap.reply(seq);
    // Como a interface: o netcoredbg às vezes responde ao `disconnect` e não sai (corrida no CommandLoop dele).
    dap.sessions.stop();
}

fn sessions() -> (Arc<Sessions>, Arc<Terminals<PortablePty>>) {
    let terminals = Arc::new(Terminals::new(PortablePty, detect_default_shell()));
    let sessions = DebugSessions::new(StdServerSpawner::default(), probe(), Arc::clone(&terminals));
    (Arc::new(sessions), terminals)
}

/// O alvo compilado da fixture e a sessão com o depurador iniciado.
fn start(fixture: &str, tool: &str, debugger: &str, edit: impl Fn(&Path)) -> Option<Started> {
    if probe().find(debugger).is_empty() {
        eprintln!("PULADO: `{debugger}` não foi encontrado; o teste de {fixture} não rodou.");
        return None;
    }
    let (root, project, _) = open(fixture, tool)?;
    edit(&root.0);
    let command = project
        .build_for_run()
        .unwrap()
        .expect("a compilação falhou");
    let (sessions, _) = sessions();
    let (sender, events) = mpsc::channel();
    let launch = sessions
        .start(&command.target, &command.cwd, move |event| {
            let _ = sender.send(event);
        })
        .unwrap();
    assert_eq!(launch.adapter, debugger);
    assert_eq!(launch.launch["cwd"], root.0.to_str().unwrap());
    assert_eq!(launch.launch["console"], "integratedTerminal");
    Some(Started {
        dap: Dap::new(sessions, events),
        launch,
        root,
    })
}

struct Started {
    dap: Dap,
    launch: DebugLaunch,
    root: TempDir,
}

#[test]
fn lldb_dap_stops_at_a_breakpoint_in_hello_cpp_and_runs_to_the_end() {
    let Some(Started {
        mut dap,
        launch,
        root,
    }) = start("hello-cpp", "cmake", "lldb-dap", |_| {})
    else {
        return;
    };
    let program = launch.launch["program"].as_str().unwrap();
    assert!(Path::new(program).is_absolute() && program.ends_with("app"));

    let main = root.0.join("app/main.cpp");
    debug_until_exit(
        &mut dap,
        &launch,
        &main,
        8,
        "main",
        ("mensagem", "\"2 + 3 = 5\""),
    );

    let (name, output) = dap
        .terminal
        .take()
        .expect("o lldb-dap não pediu o terminal");
    assert_eq!(name, "🐞 app");
    let mut printed = String::new();
    while let TerminalEvent::Output { data } = output.recv_timeout(TIMEOUT).unwrap() {
        printed.push_str(&data);
    }
    assert!(printed.contains("2 + 3 = 5"), "{printed:?}");
}

#[test]
fn netcoredbg_stops_at_a_breakpoint_in_hello_cs_and_runs_to_the_end() {
    // O netcoredbg não atende o `runInTerminal`: o programa não teria de onde ler a entrada.
    let without_input = |root: &Path| {
        let program = root.join("Program.cs");
        let text = fs::read_to_string(&program).unwrap();
        fs::write(
            &program,
            text.replace("Console.ReadLine() ?? \"\"", "\"abc\""),
        )
        .unwrap();
    };
    let Some(Started {
        mut dap,
        launch,
        root,
    }) = start("hello-cs", "dotnet", "netcoredbg", without_input)
    else {
        return;
    };
    assert!(
        (launch.launch["program"].as_str().unwrap()).ends_with("hello-cs.dll"),
        "{}",
        launch.launch
    );
    debug_until_exit(
        &mut dap,
        &launch,
        &root.0.join("Program.cs"),
        3,
        "Main",
        ("linha", "\"abc\""),
    );
    assert!(dap.terminal.is_none());
}

/// Um adaptador de mentira: um script no lugar do lldb-dap.
struct FakeAdapter(PathBuf);

impl ToolProbe for FakeAdapter {
    fn find(&self, _: &str) -> Vec<PathBuf> {
        vec![self.0.clone()]
    }

    fn version_output(&self, _: &Path) -> std::io::Result<String> {
        Ok("1.0".into())
    }
}

/// Inicia uma sessão com `script` no lugar do adaptador.
fn start_fake(
    name: &str,
    script: &str,
) -> (
    TempDir,
    Arc<DebugSessions<StdServerSpawner, FakeAdapter, PortablePty>>,
    Receiver<DebugEvent>,
) {
    let dir =
        TempDir(std::env::temp_dir().join(format!("darktriad-{name}-{}", std::process::id())));
    fs::create_dir_all(&dir.0).unwrap();
    let adapter = dir.0.join("lldb-dap");
    fs::write(&adapter, format!("#!/bin/sh\n{script}\n")).unwrap();
    fs::set_permissions(
        &adapter,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    let terminals = Arc::new(Terminals::new(PortablePty, detect_default_shell()));
    let sessions = Arc::new(DebugSessions::new(
        StdServerSpawner::default(),
        FakeAdapter(adapter),
        terminals,
    ));
    let target = CMakeTarget {
        name: "app".into(),
        path: "/bin/true".into(),
        project: None,
    };
    let (sender, events) = mpsc::channel();
    sessions
        .start(&target, &dir.0, move |event| {
            let _ = sender.send(event);
        })
        .unwrap();
    (dir, sessions, events)
}

fn sleep_in_terminal(
    sessions: &DebugSessions<StdServerSpawner, FakeAdapter, PortablePty>,
) -> Receiver<TerminalEvent> {
    let (sender, output) = mpsc::channel();
    let args = ["/bin/sleep".into(), "30".into()];
    let info = sessions
        .run_in_terminal(&args, &std::env::temp_dir(), SIZE, move |event| {
            let _ = sender.send(event);
        })
        .unwrap();
    assert_eq!(info.name, "🐞 app");
    output
}

fn wait_exited(output: &Receiver<TerminalEvent>) {
    let deadline = Instant::now() + TIMEOUT;
    while !matches!(
        output.recv_timeout(deadline.saturating_duration_since(Instant::now())),
        Ok(TerminalEvent::Exited { .. })
    ) {}
}

#[test]
fn an_adapter_that_dies_ends_the_session_and_the_program() {
    let (_dir, sessions, events) = start_fake("adaptador-cai", "echo falhou >&2; read x; exit 3");
    let output = sleep_in_terminal(&sessions);
    sessions.send("{}").unwrap();

    let mut log = Vec::new();
    let reason = loop {
        match events.recv_timeout(TIMEOUT).unwrap() {
            DebugEvent::Log { line } => log.push(line),
            DebugEvent::Ended { reason } => break reason,
            DebugEvent::Message { message } => panic!("{message}"),
        }
    };
    assert_eq!(
        reason.as_deref(),
        Some("O depurador (lldb-dap) encerrou inesperadamente. Veja o canal Depuração na Saída.")
    );
    assert!(
        log[0].starts_with("> ") && log[0].ends_with("lldb-dap"),
        "{log:?}"
    );
    assert!(log.contains(&"falhou".to_owned()), "{log:?}");
    assert_eq!(log.last().unwrap(), "O lldb-dap terminou com código 3.");
    wait_exited(&output);
    assert!(sessions.send("{}").is_err());
}

#[test]
fn stop_kills_the_adapter_and_the_program_and_nothing_else_arrives() {
    let (_dir, sessions, events) = start_fake("parar", "cat > /dev/null");
    let output = sleep_in_terminal(&sessions);

    sessions.stop();
    wait_exited(&output);
    assert!(sessions.send("{}").is_err());
    std::thread::sleep(Duration::from_millis(200));
    let after: Vec<_> = events.try_iter().skip(1).collect();
    assert!(after.is_empty(), "{after:?}");
}
