//! Adaptadores: implementações concretas das portas definidas em `darktriad-core`.

use std::fs;
use std::io;
use std::path::Path;

use darktriad_core::{Entry, FileSystem};

/// Sistema de arquivos local do sistema operacional.
pub struct LocalFileSystem;

impl FileSystem for LocalFileSystem {
    fn read_dir(&self, path: &Path) -> io::Result<Vec<Entry>> {
        fs::read_dir(path)?
            .map(|item| {
                let item = item?;
                Ok(Entry {
                    name: item.file_name().to_string_lossy().into_owned(),
                    path: item.path(),
                    is_dir: item.file_type()?.is_dir(),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_dir_reports_files_and_folders() {
        let root = std::env::temp_dir().join(format!("darktriad-infra-{}", std::process::id()));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("main.c"), "int main(void) { return 0; }").unwrap();

        let mut entries = LocalFileSystem.read_dir(&root).unwrap();
        fs::remove_dir_all(&root).unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));

        let summary: Vec<_> = entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.is_dir))
            .collect();
        assert_eq!(summary, [("main.c", false), ("src", true)]);
    }
}
