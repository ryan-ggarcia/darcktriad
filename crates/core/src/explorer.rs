use std::io;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::input::validate_name;
use crate::{EntryWriter, Error, ErrorKind, FileSystem, Result, Trash};

/// Itens que o explorador não mostra e cujas mudanças o observador ignora (padrão do VS Code).
pub const HIDDEN_NAMES: [&str; 6] = [".git", ".svn", ".hg", ".jj", ".DS_Store", "Thumbs.db"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: PathBuf,
    /// Para links simbólicos, diz o tipo do alvo.
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// Verdadeiro se algum trecho do caminho é um item escondido (ex.: tudo dentro de `.git`).
pub fn is_hidden(path: &Path) -> bool {
    path.components().any(|part| match part {
        Component::Normal(name) => HIDDEN_NAMES.contains(&name.to_str().unwrap_or_default()),
        _ => false,
    })
}

/// Caso de uso: o explorador de arquivos da pasta aberta.
/// As operações que alteram o disco recebem a pasta aberta (`root`) e recusam caminhos fora dela.
pub struct Explorer<F> {
    fs: F,
}

impl<F: FileSystem + EntryWriter + Trash> Explorer<F> {
    pub fn new(fs: F) -> Self {
        Self { fs }
    }

    /// Sem os itens escondidos; pastas primeiro, depois arquivos, cada grupo em ordem alfabética
    /// sem diferenciar maiúsculas.
    pub fn list(&self, path: &Path) -> Result<Vec<Entry>> {
        let mut entries = self.fs.read_dir(path)?;
        entries.retain(|entry| !HIDDEN_NAMES.contains(&entry.name.as_str()));
        entries.sort_by_cached_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
        Ok(entries)
    }

    pub fn create_file(&self, root: &Path, parent: &Path, name: &str) -> Result<PathBuf> {
        let path = child_path(root, parent, name)?;
        self.fs
            .create_file(&path)
            .map_err(|error| named(error, name))?;
        Ok(path)
    }

    pub fn create_dir(&self, root: &Path, parent: &Path, name: &str) -> Result<PathBuf> {
        let path = child_path(root, parent, name)?;
        self.fs
            .create_dir(&path)
            .map_err(|error| named(error, name))?;
        Ok(path)
    }

    /// Devolve o novo caminho do item.
    pub fn rename(&self, root: &Path, path: &Path, new_name: &str) -> Result<PathBuf> {
        ensure_strictly_inside(root, path)?;
        let parent = path.parent().unwrap_or(root);
        let target = child_path(root, parent, new_name)?;
        if target != path {
            self.fs
                .rename(path, &target)
                .map_err(|error| named(error, new_name))?;
        }
        Ok(target)
    }

    pub fn move_to_trash(&self, root: &Path, path: &Path) -> Result<()> {
        ensure_strictly_inside(root, path)?;
        self.fs
            .move_to_trash(path)
            .map_err(|error| match error.kind() {
                io::ErrorKind::NotFound => error.into(),
                _ => Error::new(ErrorKind::TrashFailed, error.to_string()),
            })
    }

    pub fn delete_permanently(&self, root: &Path, path: &Path) -> Result<()> {
        ensure_strictly_inside(root, path)?;
        Ok(self.fs.delete_permanently(path)?)
    }
}

fn child_path(root: &Path, parent: &Path, name: &str) -> Result<PathBuf> {
    validate_name(name)?;
    if !parent.starts_with(root) {
        return Err(outside_root(parent));
    }
    Ok(parent.join(name))
}

/// A própria pasta aberta não pode ser renomeada nem excluída pelo explorador.
fn ensure_strictly_inside(root: &Path, path: &Path) -> Result<()> {
    if path == root || !path.starts_with(root) {
        return Err(outside_root(path));
    }
    Ok(())
}

fn outside_root(path: &Path) -> Error {
    Error::new(
        ErrorKind::InvalidInput,
        format!("{} está fora da pasta aberta", path.display()),
    )
}

fn named(error: io::Error, name: &str) -> Error {
    match error.kind() {
        io::ErrorKind::AlreadyExists => Error::new(
            ErrorKind::AlreadyExists,
            format!("Já existe {name} nesta pasta"),
        ),
        _ => error.into(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::Mutex;

    use super::*;

    /// Disco em memória: guarda só quais caminhos existem.
    #[derive(Default)]
    struct FakeDisk {
        listing: Vec<Entry>,
        items: Mutex<BTreeSet<PathBuf>>,
        trash_fails: bool,
    }

    impl FakeDisk {
        fn with_items(items: &[&str]) -> Self {
            Self {
                items: Mutex::new(items.iter().map(PathBuf::from).collect()),
                ..Self::default()
            }
        }

        fn items(&self) -> Vec<String> {
            let items = self.items.lock().unwrap();
            items.iter().map(|path| path_text(path)).collect()
        }

        fn insert_new(&self, path: &Path) -> io::Result<()> {
            if self.items.lock().unwrap().insert(path.into()) {
                Ok(())
            } else {
                Err(io::ErrorKind::AlreadyExists.into())
            }
        }

        fn remove(&self, path: &Path) -> io::Result<()> {
            if self.items.lock().unwrap().remove(path) {
                Ok(())
            } else {
                Err(io::ErrorKind::NotFound.into())
            }
        }
    }

    impl FileSystem for FakeDisk {
        fn read_dir(&self, _: &Path) -> io::Result<Vec<Entry>> {
            Ok(self.listing.clone())
        }

        fn is_dir(&self, _: &Path) -> bool {
            true
        }
    }

    impl EntryWriter for FakeDisk {
        fn create_file(&self, path: &Path) -> io::Result<()> {
            self.insert_new(path)
        }

        fn create_dir(&self, path: &Path) -> io::Result<()> {
            self.insert_new(path)
        }

        fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
            if self.items.lock().unwrap().contains(to) {
                return Err(io::ErrorKind::AlreadyExists.into());
            }
            self.remove(from)?;
            self.insert_new(to)
        }
    }

    impl Trash for FakeDisk {
        fn move_to_trash(&self, path: &Path) -> io::Result<()> {
            if self.trash_fails && self.items.lock().unwrap().contains(path) {
                return Err(io::Error::other("lixeira indisponível"));
            }
            self.remove(path)
        }

        fn delete_permanently(&self, path: &Path) -> io::Result<()> {
            self.remove(path)
        }
    }

    fn entry(name: &str, is_dir: bool) -> Entry {
        Entry {
            name: name.into(),
            path: name.into(),
            is_dir,
            is_symlink: false,
        }
    }

    fn path_text(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    fn listed_names(listing: Vec<Entry>) -> Vec<String> {
        let explorer = Explorer::new(FakeDisk {
            listing,
            ..FakeDisk::default()
        });
        explorer
            .list(Path::new("proj"))
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect()
    }

    #[test]
    fn list_puts_folders_first_then_sorts_by_name() {
        // `Docs` e `app.h` só ficam nesta ordem se maiúsculas não contarem: em ASCII, 'D' < 'b'.
        let names = listed_names(vec![
            entry("main.cpp", false),
            entry("src", true),
            entry("CMakeLists.txt", false),
            entry("build", true),
            entry("app.h", false),
            entry("Docs", true),
        ]);

        assert_eq!(
            names,
            [
                "build",
                "Docs",
                "src",
                "app.h",
                "CMakeLists.txt",
                "main.cpp"
            ]
        );
    }

    #[test]
    fn list_hides_vcs_and_os_metadata_but_keeps_build_and_gitignore() {
        let mut listing: Vec<_> = HIDDEN_NAMES.iter().map(|name| entry(name, true)).collect();
        listing.extend([entry("build", true), entry(".gitignore", false)]);

        assert_eq!(listed_names(listing), ["build", ".gitignore"]);
    }

    #[test]
    fn is_hidden_matches_any_hidden_component() {
        assert!(is_hidden(Path::new("proj/.git/index")));
        assert!(is_hidden(Path::new("proj/app/Thumbs.db")));
        assert!(!is_hidden(Path::new("proj/.gitignore")));
        assert!(!is_hidden(Path::new("proj/build/app.o")));
    }

    #[test]
    fn create_with_existing_name_fails_and_leaves_disk_unchanged() {
        let explorer = Explorer::new(FakeDisk::with_items(&["proj/app/util.cpp"]));

        let error = explorer
            .create_file(Path::new("proj"), Path::new("proj/app"), "util.cpp")
            .unwrap_err();

        assert_eq!(error.kind, ErrorKind::AlreadyExists);
        assert_eq!(error.message, "Já existe util.cpp nesta pasta");
        assert_eq!(explorer.fs.items(), ["proj/app/util.cpp"]);
    }

    #[test]
    fn create_with_invalid_name_fails_and_leaves_disk_unchanged() {
        let explorer = Explorer::new(FakeDisk::default());

        for name in ["", "a/b", "a\\b"] {
            let error = explorer
                .create_dir(Path::new("proj"), Path::new("proj"), name)
                .unwrap_err();
            assert_eq!(error.kind, ErrorKind::InvalidInput, "{name:?}");
        }
        assert!(explorer.fs.items().is_empty());
    }

    #[test]
    fn create_returns_the_new_path_inside_the_parent() {
        let explorer = Explorer::new(FakeDisk::default());

        let path = explorer
            .create_file(Path::new("proj"), Path::new("proj/app"), "util.cpp")
            .unwrap();

        assert_eq!(path_text(&path), "proj/app/util.cpp");
        assert_eq!(explorer.fs.items(), ["proj/app/util.cpp"]);
    }

    #[test]
    fn operations_outside_the_open_folder_are_refused() {
        let explorer = Explorer::new(FakeDisk::with_items(&["outro/a.cpp", "proj"]));
        let root = Path::new("proj");

        let errors = [
            explorer.create_file(root, Path::new("outro"), "b.cpp"),
            explorer.rename(root, Path::new("outro/a.cpp"), "b.cpp"),
            explorer.rename(root, root, "novo"),
        ]
        .map(|result| result.unwrap_err().kind);
        let deletions = [
            explorer.move_to_trash(root, root),
            explorer.delete_permanently(root, Path::new("outro/a.cpp")),
        ]
        .map(|result| result.unwrap_err().kind);

        assert_eq!(errors, [ErrorKind::InvalidInput; 3]);
        assert_eq!(deletions, [ErrorKind::InvalidInput; 2]);
        assert_eq!(explorer.fs.items(), ["outro/a.cpp", "proj"]);
    }

    #[test]
    fn rename_moves_the_item_and_returns_the_new_path() {
        let explorer = Explorer::new(FakeDisk::with_items(&["proj/src/a.cpp"]));

        let path = explorer
            .rename(Path::new("proj"), Path::new("proj/src/a.cpp"), "b.cpp")
            .unwrap();

        assert_eq!(path_text(&path), "proj/src/b.cpp");
        assert_eq!(explorer.fs.items(), ["proj/src/b.cpp"]);
    }

    #[test]
    fn rename_onto_existing_name_fails_and_leaves_disk_unchanged() {
        let explorer = Explorer::new(FakeDisk::with_items(&["proj/a.cpp", "proj/b.cpp"]));

        let error = explorer
            .rename(Path::new("proj"), Path::new("proj/a.cpp"), "b.cpp")
            .unwrap_err();

        assert_eq!(error.kind, ErrorKind::AlreadyExists);
        assert_eq!(explorer.fs.items(), ["proj/a.cpp", "proj/b.cpp"]);
    }

    #[test]
    fn trash_failure_is_reported_so_the_ui_can_offer_permanent_deletion() {
        let explorer = Explorer::new(FakeDisk {
            trash_fails: true,
            ..FakeDisk::with_items(&["proj/a.cpp"])
        });
        let root = Path::new("proj");

        let failed = explorer.move_to_trash(root, Path::new("proj/a.cpp"));
        let missing = explorer.move_to_trash(root, Path::new("proj/sumiu.cpp"));

        assert_eq!(failed.unwrap_err().kind, ErrorKind::TrashFailed);
        assert_eq!(missing.unwrap_err().kind, ErrorKind::NotFound);
        explorer
            .delete_permanently(root, Path::new("proj/a.cpp"))
            .unwrap();
        assert!(explorer.fs.items().is_empty());
    }
}
