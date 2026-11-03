//! Servidores de linguagem (docs/specs/linguagem.md, critério 4) com o clangd e o Roslyn de
//! verdade, sobre cópias temporárias das fixtures já configuradas. O handshake do LSP é escrito à
//! mão. Sem a ferramenta os testes são pulados com um aviso.

mod common;

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use common::{TempDir, configure, probe};
use darktriad_core::{
    Language, LanguageEvent, LanguageServers, ProjectState, ProjectStatus, ToolProbe,
};
use darktriad_infra::{StdServerSpawner, SystemToolProbe};
use serde_json::{Value, json};

const DIAGNOSTICS_TIMEOUT: Duration = Duration::from_secs(10);
/// O `initialize` espera o servidor subir; o Roslyn leva alguns segundos.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);
const ERROR_LINE: &str = "int x = \"a\";\n";

struct Lsp {
    servers: Arc<LanguageServers<StdServerSpawner, SystemToolProbe>>,
    language: Language,
    messages: Receiver<Value>,
}

impl Lsp {
    /// `temp` é a pasta temporária dos servidores, como a que o app dá a eles.
    fn start(language: Language, project: &ProjectState, temp: &Path) -> Self {
        let spawner = StdServerSpawner::with_temp_dir(temp.to_owned()).unwrap();
        let servers = Arc::new(LanguageServers::new(spawner, probe()));
        let (sender, messages) = mpsc::channel();
        servers
            .start(language, project, move |event| match event {
                LanguageEvent::Message { message } => {
                    let _ = sender.send(serde_json::from_str(&message).unwrap());
                }
                LanguageEvent::Log { line } => eprintln!("[{language:?}] {line}"),
                LanguageEvent::State { state } => eprintln!("[{language:?}] {state:?}"),
            })
            .unwrap();
        Self {
            servers,
            language,
            messages,
        }
    }

    fn send(&self, message: Value) {
        self.servers
            .send(self.language, &message.to_string())
            .unwrap();
    }

    /// A primeira mensagem do servidor que satisfaz `wanted`, antes de `deadline`. Pedidos do
    /// servidor ao cliente (configuração, registro de recursos) recebem uma resposta vazia.
    fn wait_for(&self, deadline: Instant, wanted: impl Fn(&Value) -> bool) -> Value {
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let message = self
                .messages
                .recv_timeout(left)
                .expect("o servidor não respondeu a tempo");
            if message.get("method").is_some()
                && let Some(id) = message.get("id")
            {
                // O `workspace/configuration` espera um valor por item pedido.
                let result = match message["params"]["items"].as_array() {
                    Some(items) => json!(vec![Value::Null; items.len()]),
                    None => Value::Null,
                };
                self.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
            }
            if wanted(&message) {
                return message;
            }
        }
    }

    /// A resposta ao pedido `id` do cliente.
    fn reply(&self, id: u32, deadline: Instant) -> Value {
        let reply = self.wait_for(deadline, |message| {
            message["id"] == id && message.get("method").is_none()
        });
        assert!(reply.get("result").is_some(), "{reply}");
        reply
    }

    /// `initialize` e `initialized`.
    fn handshake(&self, root: &Path) {
        let uri = uri(root);
        self.send(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": std::process::id(),
                "rootUri": uri,
                "workspaceFolders": [{"uri": uri, "name": "fixture"}],
                "capabilities": {"textDocument": {
                    "publishDiagnostics": {},
                    "diagnostic": {"dynamicRegistration": true},
                }},
            },
        }));
        self.reply(1, Instant::now() + INITIALIZE_TIMEOUT);
        self.send(json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}));
    }

    /// Abre `file` com `int x = "a";` numa linha nova no fim e devolve essa linha (base 0).
    fn open_with_error(&self, file: &Path, language_id: &str) -> usize {
        let mut text = fs::read_to_string(file).unwrap();
        let error_line = text.lines().count();
        text.push_str(ERROR_LINE);
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {"uri": uri(file), "languageId": language_id, "version": 1, "text": text},
            },
        }));
        error_line
    }

    /// clangd: os erros do primeiro `publishDiagnostics` de `file` que tiver algum.
    fn pushed_errors(&self, file: &Path, deadline: Instant) -> Vec<Value> {
        let published = |message: &Value| {
            message["method"] == "textDocument/publishDiagnostics"
                && message["params"]["uri"] == uri(file)
                && !errors_in(&message["params"]["diagnostics"]).is_empty()
        };
        errors_in(&self.wait_for(deadline, published)["params"]["diagnostics"])
    }

    /// Roslyn: não publica diagnósticos, só responde ao `textDocument/diagnostic`, uma categoria
    /// (`identifier`) por pedido.
    fn pulled_errors(&self, file: &Path, identifier: &str, deadline: Instant) -> Vec<Value> {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "textDocument/diagnostic",
            "params": {"textDocument": {"uri": uri(file)}, "identifier": identifier},
        }));
        errors_in(&self.reply(2, deadline)["result"]["items"])
    }
}

impl Drop for Lsp {
    fn drop(&mut self) {
        self.servers.stop_all();
    }
}

/// Os diagnósticos de gravidade 1 (erro).
fn errors_in(diagnostics: &Value) -> Vec<Value> {
    (diagnostics.as_array().into_iter().flatten())
        .filter(|diagnostic| diagnostic["severity"] == 1)
        .cloned()
        .collect()
}

fn uri(path: &Path) -> String {
    let path = path.display().to_string().replace('\\', "/");
    let root = if path.starts_with('/') { "" } else { "/" };
    format!("file://{root}{path}")
}

/// A fixture configurada, ou `None` quando falta alguma das ferramentas.
fn configured(fixture: &str, build_tool: &str, server: &str) -> Option<(TempDir, ProjectState)> {
    if probe().find(server).is_empty() {
        eprintln!("PULADO: `{server}` não foi encontrado; o teste de {fixture} não rodou.");
        return None;
    }
    let (root, state, output) = configure(fixture, build_tool)?;
    assert_eq!(state.status, ProjectStatus::Ready, "{}", output.join("\n"));
    Some((root, state))
}

fn assert_single_error_on_line(errors: &[Value], line: usize) {
    let [error] = errors else {
        panic!("esperava 1 erro: {errors:#?}");
    };
    assert_eq!(error["range"]["start"]["line"], line, "{error:#}");
}

#[test]
fn clangd_reports_the_error_of_an_opened_file_in_hello_cpp() {
    let Some((root, state)) = configured("hello-cpp", "cmake", "clangd") else {
        return;
    };
    let temp = root.0.join(".tmp");
    let lsp = Lsp::start(Language::Cpp, &state, &temp);
    lsp.handshake(&root.0);
    let file = root.0.join("app/main.cpp");
    let line = lsp.open_with_error(&file, "cpp");
    // Sem o compile_commands.json, o `#include "soma.h"` também seria um erro.
    let errors = lsp.pushed_errors(&file, Instant::now() + DIAGNOSTICS_TIMEOUT);
    assert_single_error_on_line(&errors, line);

    // O preâmbulo (o `#include` do main.cpp) vai para a pasta dos servidores, e não para a do
    // sistema. Encerrado à força, o clangd o deixa lá até o app abrir de novo.
    assert_eq!(preambles(&temp), 1);
    let servers = Arc::downgrade(&lsp.servers);
    drop(lsp);
    assert_eq!(preambles(&temp), 1);
    // O app que fechou: as threads de cada servidor seguram os servidores (e o lock da pasta) até
    // verem o processo morto, a cada 50 ms.
    let deadline = Instant::now() + Duration::from_secs(5);
    while servers.strong_count() > 0 {
        assert!(Instant::now() < deadline, "os servidores não foram soltos");
        std::thread::sleep(Duration::from_millis(10));
    }
    StdServerSpawner::with_temp_dir(temp.clone()).unwrap();
    assert_eq!(preambles(&temp), 0);
}

fn preambles(dir: &Path) -> usize {
    (fs::read_dir(dir).unwrap())
        .filter(|entry| {
            let name = entry.as_ref().unwrap().file_name();
            let name = name.to_string_lossy();
            name.starts_with("preamble-") && name.ends_with(".pch")
        })
        .count()
}

#[test]
fn roslyn_reports_cs0029_in_hello_cs() {
    let Some((root, state)) = configured("hello-cs", "dotnet", "roslyn-language-server") else {
        return;
    };
    let lsp = Lsp::start(Language::CSharp, &state, &root.0.join(".tmp"));
    lsp.handshake(&root.0);
    // Antes do projeto carregar, o arquivo não tem as referências do .NET.
    lsp.wait_for(Instant::now() + INITIALIZE_TIMEOUT, |message| {
        message["method"] == "workspace/projectInitializationComplete"
    });
    let file = root.0.join("Program.cs");
    let line = lsp.open_with_error(&file, "csharp");
    let deadline = Instant::now() + DIAGNOSTICS_TIMEOUT;
    let errors = lsp.pulled_errors(&file, "DocumentCompilerSemantic", deadline);
    assert_single_error_on_line(&errors, line);
    assert_eq!(errors[0]["code"], "CS0029", "{:#}", errors[0]);
}
