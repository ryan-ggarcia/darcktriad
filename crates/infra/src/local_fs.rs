use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;
use std::time::UNIX_EPOCH;

use darktriad_core::{Entry, EntryWriter, FileStat, FileStore, FileSystem, Trash};

/// Sistema de arquivos local do sistema operacional, com a lixeira do sistema.
pub struct LocalFileSystem;

impl FileSystem for LocalFileSystem {
    fn read_dir(&self, path: &Path) -> io::Result<Vec<Entry>> {
        fs::read_dir(path)?
            .map(|item| {
                let item = item?;
                let path = item.path();
                let file_type = item.file_type()?;
                // Link aparece como o tipo do alvo; link quebrado aparece como arquivo.
                let is_dir = if file_type.is_symlink() {
                    path.is_dir()
                } else {
                    file_type.is_dir()
                };
                Ok(Entry {
                    name: item.file_name().to_string_lossy().into_owned(),
                    path,
                    is_dir,
                    is_symlink: file_type.is_symlink(),
                })
            })
            .collect()
    }

    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }
}

impl EntryWriter for LocalFileSystem {
    fn create_file(&self, path: &Path) -> io::Result<()> {
        File::create_new(path).map(drop)
    }

    fn create_dir(&self, path: &Path) -> io::Result<()> {
        fs::create_dir(path)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        // `fs::rename` sobrescreve o destino. Só deixa passar quando o destino é o próprio item,
        // como ao trocar só maiúsculas num sistema de arquivos que não as diferencia.
        if fs::symlink_metadata(to).is_ok() && !same_item(from, to) {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
        fs::rename(from, to)
    }
}

fn same_item(a: &Path, b: &Path) -> bool {
    matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b)
}

impl Trash for LocalFileSystem {
    fn move_to_trash(&self, path: &Path) -> io::Result<()> {
        // Item que já sumiu não é falha da lixeira.
        fs::symlink_metadata(path)?;
        trash::delete(path).map_err(io::Error::other)
    }

    fn delete_permanently(&self, path: &Path) -> io::Result<()> {
        // `symlink_metadata` e `remove_dir_all` não seguem links: apaga o link, nunca o alvo.
        // shortcut: link para pasta no Windows falha em `remove_file`; tratar se alguém precisar.
        if fs::symlink_metadata(path)?.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        }
    }
}

impl FileStore for LocalFileSystem {
    fn stat(&self, path: &Path) -> io::Result<Option<FileStat>> {
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let modified = metadata.modified()?.duration_since(UNIX_EPOCH);
        let nanos = modified.unwrap_or_default().as_nanos();
        Ok(Some(FileStat {
            size: metadata.len(),
            version: format!("{nanos}-{}", metadata.len()),
        }))
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        fs::read(path)
    }

    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        let mut file = File::create(path)?;
        file.write_all(bytes)?;
        file.sync_all()
    }

    fn replace(&self, from: &Path, to: &Path) -> io::Result<()> {
        // Grava no alvo de um link simbólico, sem trocar o link por um arquivo comum.
        let to = fs::canonicalize(to).unwrap_or_else(|_| to.to_path_buf());
        if let Ok(metadata) = fs::metadata(&to) {
            // O rename passaria por cima da proteção; recusa como a escrita direta recusaria.
            if metadata.permissions().readonly() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "o arquivo é somente leitura",
                ));
            }
            #[cfg(unix)]
            fs::set_permissions(from, metadata.permissions())?;
        }
        fs::rename(from, to)
    }

    fn remove(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn read_dir_reports_files_and_folders() {
        let root = TempDir::new("read-dir");
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("main.c"), "int main(void) { return 0; }").unwrap();

        let mut entries = LocalFileSystem.read_dir(&root).unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));

        let summary: Vec<_> = entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.is_dir, entry.is_symlink))
            .collect();
        assert_eq!(summary, [("main.c", false, false), ("src", true, false)]);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_listed_with_the_type_of_their_target() {
        let root = TempDir::new("symlink-list");
        fs::create_dir(root.join("real")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        std::os::unix::fs::symlink(root.join("sumiu"), root.join("quebrado")).unwrap();

        let mut entries = LocalFileSystem.read_dir(&root).unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));

        let summary: Vec<_> = entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.is_dir, entry.is_symlink))
            .collect();
        assert_eq!(
            summary,
            [
                ("link", true, true),
                ("quebrado", false, true),
                ("real", true, false)
            ]
        );
    }

    #[test]
    fn create_never_overwrites_an_existing_item() {
        let root = TempDir::new("create");
        fs::write(root.join("util.cpp"), "original").unwrap();

        let file = LocalFileSystem.create_file(&root.join("util.cpp"));
        let dir = LocalFileSystem.create_dir(&root.join("util.cpp"));

        assert_eq!(file.unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(dir.unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read_to_string(root.join("util.cpp")).unwrap(),
            "original"
        );
    }

    #[test]
    fn rename_never_overwrites_an_existing_item() {
        let root = TempDir::new("rename");
        fs::write(root.join("a.cpp"), "a").unwrap();
        fs::write(root.join("b.cpp"), "b").unwrap();

        let error = LocalFileSystem
            .rename(&root.join("a.cpp"), &root.join("b.cpp"))
            .unwrap_err();
        LocalFileSystem
            .rename(&root.join("a.cpp"), &root.join("c.cpp"))
            .unwrap();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(root.join("b.cpp")).unwrap(), "b");
        assert_eq!(fs::read_to_string(root.join("c.cpp")).unwrap(), "a");
    }

    #[cfg(windows)]
    #[test]
    fn rename_that_only_changes_case_is_allowed() {
        let root = TempDir::new("rename-case");
        fs::write(root.join("main.cpp"), "x").unwrap();

        LocalFileSystem
            .rename(&root.join("main.cpp"), &root.join("Main.cpp"))
            .unwrap();

        let names: Vec<_> = LocalFileSystem
            .read_dir(&root)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, ["Main.cpp"]);
    }

    #[test]
    fn delete_permanently_removes_files_and_whole_folders() {
        let root = TempDir::new("delete");
        fs::create_dir_all(root.join("build/obj")).unwrap();
        fs::write(root.join("build/obj/a.o"), "").unwrap();
        fs::write(root.join("main.c"), "").unwrap();

        LocalFileSystem
            .delete_permanently(&root.join("build"))
            .unwrap();
        LocalFileSystem
            .delete_permanently(&root.join("main.c"))
            .unwrap();

        assert_eq!(root.read_dir().unwrap().count(), 0);
    }

    #[test]
    fn trashing_a_missing_item_reports_not_found() {
        let root = TempDir::new("trash");

        let error = LocalFileSystem
            .move_to_trash(&root.join("sumiu.cpp"))
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn stat_reports_missing_files_and_a_new_version_after_each_write() {
        let root = TempDir::new("stat");
        let path = root.join("main.cpp");

        assert_eq!(LocalFileSystem.stat(&path).unwrap(), None);
        LocalFileSystem.write(&path, b"a").unwrap();
        let first = LocalFileSystem.stat(&path).unwrap().unwrap();
        LocalFileSystem.write(&path, b"ab").unwrap();
        let second = LocalFileSystem.stat(&path).unwrap().unwrap();

        assert_eq!(second.size, 2);
        assert_ne!(first.version, second.version);
    }

    #[test]
    fn replace_puts_the_new_content_in_place_of_the_old() {
        let root = TempDir::new("replace");
        fs::write(root.join("main.cpp"), "velho").unwrap();
        fs::write(root.join(".main.cpp.tmp"), "novo").unwrap();

        LocalFileSystem
            .replace(&root.join(".main.cpp.tmp"), &root.join("main.cpp"))
            .unwrap();

        assert_eq!(fs::read_to_string(root.join("main.cpp")).unwrap(), "novo");
        assert!(!root.join(".main.cpp.tmp").exists());
    }

    #[test]
    fn replace_refuses_a_read_only_target() {
        let root = TempDir::new("replace-readonly");
        let target = root.join("main.cpp");
        fs::write(&target, "protegido").unwrap();
        fs::write(root.join(".tmp"), "novo").unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&target, permissions.clone()).unwrap();

        let error = LocalFileSystem
            .replace(&root.join(".tmp"), &target)
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read_to_string(&target).unwrap(), "protegido");
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(&target, permissions).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn replace_keeps_permissions_and_symlinks() {
        use std::os::unix::fs::PermissionsExt;

        let root = TempDir::new("replace-unix");
        let script = root.join("build.sh");
        fs::write(&script, "velho").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(&script, root.join("link.sh")).unwrap();
        fs::write(root.join(".tmp"), "novo").unwrap();

        LocalFileSystem
            .replace(&root.join(".tmp"), &root.join("link.sh"))
            .unwrap();

        let mode = fs::metadata(&script).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
        assert_eq!(fs::read_to_string(&script).unwrap(), "novo");
        assert!(
            fs::symlink_metadata(root.join("link.sh"))
                .unwrap()
                .is_symlink()
        );
    }
}
