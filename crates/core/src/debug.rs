//! Depuração: escolhe o depurador, monta o `launch`, inicia o adaptador e repassa as mensagens do
//! DAP sem interpretá-las, como os servidores de linguagem. O cliente DAP fica na interface.

use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};

use crate::configure::command_line;
use crate::language::{read_log, read_messages, write_messages};
use crate::tools::{missing_tool, tool};
use crate::{
    CMakeTarget, Error, ErrorKind, PtySpawner, Result, ServerProcess, ServerSpawner, SpawnedServer,
    TerminalEvent, TerminalInfo, TerminalSize, Terminals, ToolProbe, ToolStatus,
};

/// Depois que o adaptador sai, quanto esperar pelas últimas mensagens dele.
const LAST_MESSAGES: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Debugger {
    LldbDap,
    Netcoredbg,
}

impl Debugger {
    /// C/C++ (qualquer compilador) → lldb-dap; .NET → netcoredbg.
    pub fn for_target(target: &CMakeTarget) -> Self {
        match target.project {
            Some(_) => Self::Netcoredbg,
            None => Self::LldbDap,
        }
    }

    pub fn program(self) -> &'static str {
        match self {
            Self::LldbDap => "lldb-dap",
            Self::Netcoredbg => "netcoredbg",
        }
    }

    /// O netcoredbg inicia o programa; o do lldb-dap roda no terminal `🐞`, com o ambiente da IDE.
    pub fn program_inherits_env(self) -> bool {
        self == Self::Netcoredbg
    }

    pub fn args(self) -> Vec<OsString> {
        match self {
            Self::LldbDap => Vec::new(),
            Self::Netcoredbg => vec!["--interpreter=vscode".into()],
        }
    }

    /// Os argumentos do pedido `launch`: o programa do alvo (o `.dll` no .NET), sem argumentos, na
    /// raiz do projeto, rodando no terminal integrado.
    pub fn launch(self, target: &CMakeTarget, root: &Path) -> Value {
        let mut launch = json!({
            "program": target.path.to_string_lossy(),
            "args": [],
            "cwd": root.to_string_lossy(),
            "console": "integratedTerminal",
        });
        if self == Self::LldbDap {
            // O lldb-dap anterior ao 21 só conhece este; o 23 aceita os dois juntos.
            launch["runInTerminal"] = json!(true);
        }
        launch
    }
}

/// A resposta do `debug_start`: a interface manda `launch` ao adaptador.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DebugLaunch {
    /// `lldb-dap` ou `netcoredbg`, para as mensagens.
    pub adapter: &'static str,
    pub launch: Value,
}

/// O que a sessão de depuração manda para a interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DebugEvent {
    /// Uma mensagem do DAP (o JSON, sem a moldura).
    Message { message: String },
    /// Uma linha do canal Depuração na Saída.
    Log { line: String },
    /// O adaptador saiu e a sessão acabou; é sempre o último evento. `reason` não é nulo quando
    /// ele saiu com erro ou morto, e já vem pronta para mostrar.
    Ended { reason: Option<String> },
}

type OnEvent = Arc<dyn Fn(DebugEvent) + Send + Sync>;

struct Session {
    generation: u64,
    adapter: &'static str,
    target: String,
    requests: Sender<String>,
    process: Arc<dyn ServerProcess>,
    /// O terminal `🐞 <alvo>` do `runInTerminal`.
    terminal: Option<u32>,
    on_event: OnEvent,
}

#[derive(Default)]
struct Inner {
    session: Option<Session>,
    last_generation: u64,
}

/// Caso de uso: uma sessão de depuração por vez.
pub struct DebugSessions<S, T, P> {
    spawner: S,
    /// Inicia com os temporários na pasta do app o depurador cujo programa não herda o ambiente dele.
    app_temp_spawner: S,
    tools: T,
    terminals: Arc<Terminals<P>>,
    inner: Mutex<Inner>,
}

impl<S, T, P> DebugSessions<S, T, P>
where
    S: ServerSpawner + 'static,
    T: ToolProbe + 'static,
    P: PtySpawner + 'static,
{
    pub fn new(spawner: S, app_temp_spawner: S, tools: T, terminals: Arc<Terminals<P>>) -> Self {
        Self {
            spawner,
            app_temp_spawner,
            tools,
            terminals,
            inner: Mutex::default(),
        }
    }

    /// Inicia o adaptador do alvo já compilado, no lugar da sessão anterior. As mensagens, o log
    /// e o fim chegam por `on_event`, de outras threads.
    pub fn start(
        self: &Arc<Self>,
        target: &CMakeTarget,
        root: &Path,
        on_event: impl Fn(DebugEvent) + Send + Sync + 'static,
    ) -> Result<DebugLaunch> {
        let debugger = Debugger::for_target(target);
        let adapter = debugger.program();
        // A busca roda `--version`: nunca sob o lock.
        let ToolStatus::Present { path: program, .. } = tool(adapter).check(&self.tools) else {
            return Err(missing_tool(adapter));
        };
        self.stop();
        let args = debugger.args();
        on_event(DebugEvent::Log {
            line: format!("> {}", command_line(&program, &args)),
        });
        let spawner = if debugger.program_inherits_env() {
            &self.spawner
        } else {
            &self.app_temp_spawner
        };
        let spawned = spawner.spawn(&program, &args, root).map_err(|error| {
            Error::new(
                ErrorKind::Other,
                format!("Não foi possível iniciar o {adapter}: {error}"),
            )
        })?;
        let mut inner = self.lock();
        inner.last_generation += 1;
        let generation = inner.last_generation;
        // Sob o lock: as threads só entregam depois que a sessão está registrada.
        let (requests, process) = self.connect(generation, spawned);
        if let Some(previous) = inner.session.replace(Session {
            generation,
            adapter,
            target: target.name.clone(),
            requests,
            process,
            terminal: None,
            on_event: Arc::new(on_event),
        }) {
            drop(inner);
            self.end(previous);
        }
        Ok(DebugLaunch {
            adapter,
            launch: debugger.launch(target, root),
        })
    }

    /// Põe a mensagem (JSON) na fila do adaptador e volta na hora.
    pub fn send(&self, message: &str) -> Result<()> {
        let inner = self.lock();
        let session = inner.session.as_ref().ok_or_else(no_session)?;
        (session.requests)
            .send(message.to_owned())
            .map_err(|_| no_session())
    }

    /// O pedido reverso `runInTerminal`: roda `args` num terminal `🐞 <alvo>` novo.
    pub fn run_in_terminal(
        &self,
        args: &[OsString],
        cwd: &Path,
        size: TerminalSize,
        on_event: impl Fn(TerminalEvent) + Send + 'static,
    ) -> Result<TerminalInfo> {
        let Some((program, args)) = args.split_first() else {
            return Err(Error::new(
                ErrorKind::InvalidInput,
                "O depurador pediu um terminal sem programa",
            ));
        };
        let (generation, target) = {
            let inner = self.lock();
            let session = inner.session.as_ref().ok_or_else(no_session)?;
            (session.generation, session.target.clone())
        };
        let name = format!("🐞 {target}");
        let info = (self.terminals).run(name, Path::new(program), args, cwd, size, on_event)?;
        let mut inner = self.lock();
        let Some(session) = (inner.session.as_mut()).filter(|s| s.generation == generation) else {
            drop(inner);
            // A sessão acabou enquanto o terminal abria.
            let _ = self.terminals.close(info.id);
            return Err(no_session());
        };
        let previous = session.terminal.replace(info.id);
        drop(inner);
        if let Some(previous) = previous {
            let _ = self.terminals.close(previous);
        }
        Ok(info)
    }

    /// Encerra à força o adaptador, o que ele iniciou e o terminal do programa. Nenhum evento
    /// chega depois.
    pub fn stop(&self) {
        let session = self.lock().session.take();
        if let Some(session) = session {
            self.end(session);
        }
    }

    fn end(&self, session: Session) {
        // Falha só com o processo já encerrado.
        let _ = session.process.kill();
        if let Some(id) = session.terminal {
            let _ = self.terminals.close(id);
        }
    }

    /// Liga o processo à interface: uma thread para cada ponta do stdio e uma que espera o fim.
    fn connect(
        self: &Arc<Self>,
        generation: u64,
        spawned: SpawnedServer,
    ) -> (Sender<String>, Arc<dyn ServerProcess>) {
        let SpawnedServer {
            stdout,
            stderr,
            stdin,
            process,
        } = spawned;
        let process: Arc<dyn ServerProcess> = Arc::from(process);
        let sessions = Arc::clone(self);
        let emit = move |event| sessions.emit(generation, event);
        let messages = emit.clone();
        let (read_all, last_messages) = mpsc::channel::<()>();
        thread::spawn(move || {
            read_messages(
                stdout,
                &|message| messages(DebugEvent::Message { message }),
                &|line| messages(DebugEvent::Log { line }),
            );
            drop(read_all);
        });
        thread::spawn(move || read_log(stderr, &|line| emit(DebugEvent::Log { line })));
        let (requests, receiver) = mpsc::channel();
        thread::spawn(move || write_messages(stdin, &receiver));
        let sessions = Arc::clone(self);
        let waited = Arc::clone(&process);
        thread::spawn(move || {
            let code = waited.wait();
            // O `exited` e o `terminated` saem logo antes do fim: não podem se perder.
            let _ = last_messages.recv_timeout(LAST_MESSAGES);
            sessions.exited(generation, code);
        });
        (requests, process)
    }

    /// O adaptador saiu sem a IDE pedir: a sessão acaba, e o programa junto.
    fn exited(&self, generation: u64, code: io::Result<Option<i32>>) {
        let session = {
            let mut inner = self.lock();
            if inner.session.as_ref().map(|s| s.generation) != Some(generation) {
                return;
            }
            inner.session.take()
        };
        let Some(session) = session else { return };
        let adapter = session.adapter;
        let crashed = !matches!(code, Ok(Some(0)));
        let line = match code {
            Ok(Some(code)) => format!("O {adapter} terminou com código {code}."),
            _ => format!("O {adapter} terminou."),
        };
        let reason = crashed.then(|| {
            format!(
                "O depurador ({adapter}) encerrou inesperadamente. Veja o canal Depuração na Saída."
            )
        });
        let on_event = Arc::clone(&session.on_event);
        self.end(session);
        on_event(DebugEvent::Log { line });
        on_event(DebugEvent::Ended { reason });
    }

    fn emit(&self, generation: u64, event: DebugEvent) {
        // Sob o lock: nada de uma sessão antiga chega depois do início de uma nova.
        let inner = self.lock();
        if let Some(session) = (inner.session.as_ref()).filter(|s| s.generation == generation) {
            (session.on_event)(event);
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn no_session() -> Error {
    Error::new(ErrorKind::NotFound, "Nenhuma sessão de depuração ativa")
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn cmake_target() -> CMakeTarget {
        CMakeTarget {
            name: "app".into(),
            path: "/proj/build/debug/app/app".into(),
            project: None,
            framework: None,
        }
    }

    fn dotnet_target() -> CMakeTarget {
        CMakeTarget {
            name: "hello-cs".into(),
            path: "/proj/bin/Debug/net10.0/hello-cs.dll".into(),
            project: Some("/proj/hello-cs.csproj".into()),
            framework: None,
        }
    }

    #[test]
    fn c_and_cpp_use_lldb_dap_and_dotnet_uses_netcoredbg_in_dap_mode() {
        let lldb = Debugger::for_target(&cmake_target());
        assert_eq!(lldb, Debugger::LldbDap);
        assert_eq!((lldb.program(), lldb.args()), ("lldb-dap", vec![]));

        let netcoredbg = Debugger::for_target(&dotnet_target());
        assert_eq!(netcoredbg, Debugger::Netcoredbg);
        assert_eq!(netcoredbg.program(), "netcoredbg");
        assert_eq!(netcoredbg.args(), [OsString::from("--interpreter=vscode")]);
    }

    #[test]
    fn launch_runs_the_target_program_from_the_root_in_the_integrated_terminal() {
        let root = PathBuf::from("/proj");
        let launch = Debugger::LldbDap.launch(&cmake_target(), &root);
        assert_eq!(
            launch,
            json!({
                "program": "/proj/build/debug/app/app",
                "args": [],
                "cwd": "/proj",
                "console": "integratedTerminal",
                "runInTerminal": true,
            })
        );

        let launch = Debugger::Netcoredbg.launch(&dotnet_target(), &root);
        assert!(
            launch["program"]
                .as_str()
                .unwrap()
                .ends_with("hello-cs.dll")
        );
        assert_eq!(launch["cwd"], "/proj");
        assert_eq!(launch["console"], "integratedTerminal");
        assert_eq!(launch.get("runInTerminal"), None);
    }

    #[test]
    fn events_have_the_shape_of_the_ipc_contract() {
        let json = |event| serde_json::to_value(event).unwrap();
        assert_eq!(
            json(DebugEvent::Ended { reason: None }),
            json!({"kind": "ended", "reason": null})
        );
        assert_eq!(
            json(DebugEvent::Message {
                message: "{}".into()
            }),
            json!({"kind": "message", "message": "{}"})
        );
    }
}
