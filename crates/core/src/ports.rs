//! Portas: o que o núcleo precisa do mundo de fora. Os adaptadores ficam em `darktriad-infra`.

use std::io;
use std::path::Path;

use crate::{AppState, Entry};

/// Leitura de pastas.
pub trait FileSystem: Send + Sync {
    fn read_dir(&self, path: &Path) -> io::Result<Vec<Entry>>;
    fn is_dir(&self, path: &Path) -> bool;
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
