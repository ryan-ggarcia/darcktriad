//! Domínio, casos de uso e portas do Dark Triad.
//! Este crate não conhece nenhuma implementação concreta: tudo entra por trait.

use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
}

/// Porta de acesso ao sistema de arquivos.
pub trait FileSystem: Send + Sync {
    fn read_dir(&self, path: &Path) -> io::Result<Vec<Entry>>;
}

/// Caso de uso: listar o conteúdo de uma pasta do explorador de arquivos.
pub struct Explorer<F: FileSystem> {
    fs: F,
}

impl<F: FileSystem> Explorer<F> {
    pub fn new(fs: F) -> Self {
        Self { fs }
    }

    /// Pastas primeiro, depois arquivos; cada grupo em ordem alfabética sem diferenciar maiúsculas.
    pub fn list(&self, path: &Path) -> io::Result<Vec<Entry>> {
        let mut entries = self.fs.read_dir(path)?;
        entries.sort_by_cached_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeFileSystem(Vec<Entry>);

    impl FileSystem for FakeFileSystem {
        fn read_dir(&self, _: &Path) -> io::Result<Vec<Entry>> {
            Ok(self.0.clone())
        }
    }

    fn entry(name: &str, is_dir: bool) -> Entry {
        Entry {
            name: name.into(),
            path: name.into(),
            is_dir,
        }
    }

    #[test]
    fn list_puts_folders_first_then_sorts_by_name() {
        let explorer = Explorer::new(FakeFileSystem(vec![
            entry("main.cpp", false),
            entry("src", true),
            entry("CMakeLists.txt", false),
            entry("build", true),
        ]));

        let names: Vec<_> = explorer
            .list(Path::new("."))
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();

        assert_eq!(names, ["build", "src", "CMakeLists.txt", "main.cpp"]);
    }
}
