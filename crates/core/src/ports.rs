//! Portas: o que o núcleo precisa do mundo de fora. Os adaptadores ficam em `darktriad-infra`.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use crate::{AppState, CMakeTarget, Entry, Result};

/// Leitura de pastas.
pub trait FileSystem: Send + Sync {
    fn read_dir(&self, path: &Path) -> io::Result<Vec<Entry>>;
    fn is_dir(&self, path: &Path) -> bool;
    fn is_file(&self, path: &Path) -> bool;
    /// O caminho real, sem links simbólicos. O padrão serve a quem não tem links.
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        Ok(path.to_path_buf())
    }
}

/// Criação e renomeação de itens. Nunca sobrescreve um item existente: devolve `AlreadyExists`.
pub trait EntryWriter: Send + Sync {
    fn create_file(&self, path: &Path) -> io::Result<()>;
    fn create_dir(&self, path: &Path) -> io::Result<()>;
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
}

/// Exclusão de itens.
pub trait Trash: Send + Sync {
    fn move_to_trash(&self, path: &Path) -> io::Result<()>;
    fn delete_permanently(&self, path: &Path) -> io::Result<()>;
}

/// Tamanho e versão de um arquivo. A versão muda sempre que o conteúdo no disco muda.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStat {
    pub size: u64,
    pub version: String,
}

/// Conteúdo de arquivos, com as primitivas que a gravação atômica do editor usa.
pub trait FileStore: Send + Sync {
    /// `Ok(None)` quando o arquivo não existe.
    fn stat(&self, path: &Path) -> io::Result<Option<FileStat>>;
    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
    /// Cria ou trunca `path` e só retorna depois que os bytes chegaram ao disco.
    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()>;
    /// Põe `from` no lugar de `to` numa única operação, mantendo as permissões de `to`.
    fn replace(&self, from: &Path, to: &Path) -> io::Result<()>;
    fn remove(&self, path: &Path) -> io::Result<()>;
}

/// Observação recursiva da pasta aberta. Um `watch` novo substitui o anterior.
pub trait FolderWatcher: Send + Sync {
    fn watch(&self, root: &Path) -> io::Result<()>;
    fn unwatch(&self);
}

/// Estado do app que sobrevive entre execuções (fica na pasta de dados do app).
pub trait StateStore: Send + Sync {
    fn load(&self) -> io::Result<AppState>;
    fn save(&self, state: &AppState) -> io::Result<()>;
}

/// Percurso dos arquivos da pasta aberta como o Abrir rápido os lista: sem os ignorados por
/// `.gitignore` e `.ignore` nem os itens escondidos do explorador.
pub trait ProjectWalker: Send + Sync {
    /// Entrega a `found` cada arquivo de `root` que é um dos caminhos de `scope` ou está dentro
    /// de um deles, até `found` pedir para parar. Itens ilegíveis são pulados.
    fn walk(
        &self,
        root: &Path,
        scope: &[PathBuf],
        found: &mut dyn FnMut(PathBuf) -> ControlFlow<()>,
    );
}

/// Tamanho do terminal em células.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

/// Um shell recém-criado num pseudo-terminal.
pub struct SpawnedTerminal {
    /// O que o processo escreve no terminal. Chega ao fim quando o terminal é encerrado.
    pub output: Box<dyn Read + Send>,
    /// O que o usuário digita.
    pub input: Box<dyn Write + Send>,
    pub process: Box<dyn TerminalProcess>,
}

/// O processo do shell e o pseudo-terminal dele.
pub trait TerminalProcess: Send + Sync {
    fn pid(&self) -> Option<u32>;
    fn resize(&self, size: TerminalSize) -> io::Result<()>;
    /// Encerra o shell e o que roda nele. Volta quando eles terminaram ou foram forçados a terminar.
    fn kill(&self) -> io::Result<()>;
    /// Espera o shell terminar e devolve o código de saída.
    fn wait(&self) -> io::Result<u32>;
}

/// Criação de pseudo-terminais (ConPTY no Windows, PTY no Unix).
pub trait PtySpawner: Send + Sync {
    fn spawn(
        &self,
        program: &Path,
        args: &[OsString],
        cwd: &Path,
        size: TerminalSize,
    ) -> io::Result<SpawnedTerminal>;
}

/// Busca de ferramentas externas (cmake, clangd…).
pub trait ToolProbe: Send + Sync {
    /// Os caminhos de `program`, na ordem de busca da IDE: `PATH`, caminhos conhecidos, pasta da IDE.
    fn find(&self, program: &str) -> Vec<PathBuf>;
    /// O que `<path> --version` escreve.
    fn version_output(&self, path: &Path) -> io::Result<String>;
}

/// Processos externos que rodam até o fim (cmake…).
pub trait ProcessRunner: Send + Sync {
    /// Roda `program` em `cwd` e entrega a `on_line` cada linha da saída (stdout e stderr) assim
    /// que ela sai. Volta quando o processo termina: `true` se ele terminou com sucesso.
    /// Quando `cancel` fica verdadeiro, mata o processo e os que ele iniciou e devolve `Interrupted`.
    fn run(
        &self,
        program: &Path,
        args: &[OsString],
        cwd: &Path,
        cancel: &AtomicBool,
        on_line: &mut dyn FnMut(&str),
    ) -> io::Result<bool>;
}

/// A File API do CMake numa pasta de build.
pub trait FileApi: Send + Sync {
    /// Cria a consulta (`file_api_query`) e as pastas que faltarem. `true` se ela não existia.
    fn write_query(&self, build_dir: &Path) -> io::Result<bool>;
    /// Os alvos executáveis da última resposta (`file_api_executables`).
    fn executables(&self, build_dir: &Path) -> Result<Vec<CMakeTarget>>;
}

/// Um servidor de linguagem ou adaptador de depuração recém-iniciado, falando pelo stdio.
pub struct SpawnedServer {
    /// As mensagens do servidor, com a moldura `Content-Length` (LSP e DAP usam a mesma).
    pub stdout: Box<dyn Read + Send>,
    /// O log do servidor.
    pub stderr: Box<dyn Read + Send>,
    pub stdin: Box<dyn Write + Send>,
    pub process: Box<dyn ServerProcess>,
}

/// O processo de um servidor de linguagem.
pub trait ServerProcess: Send + Sync {
    /// Encerra o servidor e o que ele iniciou. Não espera o fim: isso é com o `wait`.
    fn kill(&self) -> io::Result<()>;
    /// Espera o servidor terminar e devolve o código de saída (`None` se morreu por sinal). O que
    /// ele iniciou e ainda roda é encerrado junto.
    fn wait(&self) -> io::Result<Option<i32>>;
}

/// Início de servidores de linguagem (clangd, Roslyn…) e adaptadores de depuração (lldb-dap,
/// netcoredbg): só o programa e os argumentos mudam.
pub trait ServerSpawner: Send + Sync {
    fn spawn(&self, program: &Path, args: &[OsString], cwd: &Path) -> io::Result<SpawnedServer>;
}
