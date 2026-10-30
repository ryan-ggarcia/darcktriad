use std::collections::HashSet;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};

use darktriad_core::{ProjectWalker, is_hidden};
use ignore::{DirEntry, WalkBuilder};

/// Percorre a pasta aberta com o crate `ignore` (o do ripgrep).
pub struct IgnoreWalker;

impl ProjectWalker for IgnoreWalker {
    fn walk(
        &self,
        root: &Path,
        scope: &[PathBuf],
        found: &mut dyn FnMut(PathBuf) -> ControlFlow<()>,
    ) {
        let targets: HashSet<PathBuf> = scope.iter().cloned().collect();
        let on_the_way: HashSet<PathBuf> = scope
            .iter()
            .flat_map(|path| path.ancestors())
            .map(Path::to_path_buf)
            .collect();
        // O percurso sai sempre da raiz, mesmo para reler um caminho só: assim as regras de
        // ignorar de cada pasta no caminho até ele valem como na montagem completa.
        let walk = WalkBuilder::new(root)
            // Como o VS Code: valem o `.gitignore` e o `.ignore` da pasta aberta, mesmo fora de
            // um repositório git; o global e os de pastas acima dela, não.
            .require_git(false)
            .git_global(false)
            .parents(false)
            // Nomes com ponto (`.gitignore`, `.clang-format`) aparecem, como no explorador.
            .hidden(false)
            .filter_entry(move |entry| {
                let path = entry.path();
                !is_hidden(Path::new(entry.file_name()))
                    && (on_the_way.contains(path)
                        || path.ancestors().any(|parent| targets.contains(parent)))
            })
            .build();

        for entry in walk.flatten() {
            if is_file(&entry) && found(entry.into_path()).is_break() {
                return;
            }
        }
    }
}

/// Links simbólicos não são seguidos; o que aponta para um arquivo entra como arquivo.
fn is_file(entry: &DirEntry) -> bool {
    entry
        .file_type()
        .is_some_and(|kind| kind.is_file() || kind.is_symlink() && entry.path().is_file())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use darktriad_core::{ChangeBatch, FileIndex};

    use super::*;
    use crate::test_support::TempDir;

    fn copy_dir(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for item in fs::read_dir(from).unwrap() {
            let item = item.unwrap();
            let target = to.join(item.file_name());
            if item.file_type().unwrap().is_dir() {
                copy_dir(&item.path(), &target);
            } else {
                fs::copy(item.path(), target).unwrap();
            }
        }
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// Cópia do `hello-cpp` com uma pasta `build/` e uma `.git/`, como depois de compilar.
    fn hello_cpp_with_build(name: &str) -> TempDir {
        let root = TempDir::new(name);
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/hello-cpp");
        copy_dir(&fixture, &root);
        write(&root.join("build/app.o"), "");
        write(&root.join("build/CMakeFiles/cache.txt"), "");
        write(&root.join(".git/config"), "");
        root
    }

    fn index_of(root: &Path) -> FileIndex<IgnoreWalker> {
        let index = FileIndex::new(IgnoreWalker, || {});
        index.run(index.start(root));
        index
    }

    fn relative_files(index: &FileIndex<IgnoreWalker>) -> Vec<String> {
        let mut files: Vec<String> = index
            .snapshot()
            .files
            .iter()
            .map(|path| path.replace('\\', "/"))
            .collect();
        files.sort();
        files
    }

    const SOURCES: [&str; 5] = [
        "CMakeLists.txt",
        "app/main.cpp",
        "core/soma.cpp",
        "core/soma.h",
        "tool/main.cpp",
    ];

    #[test]
    fn index_skips_what_gitignore_lists_and_lists_it_without_the_gitignore() {
        let root = hello_cpp_with_build("indice-gitignore");
        write(&root.join(".gitignore"), "build/\n");

        let with_gitignore = relative_files(&index_of(&root));
        fs::remove_file(root.join(".gitignore")).unwrap();
        let without_gitignore = relative_files(&index_of(&root));

        let mut expected = vec![".gitignore"];
        expected.extend(SOURCES);
        assert_eq!(with_gitignore, expected);
        let mut expected = vec!["build/CMakeFiles/cache.txt", "build/app.o"];
        expected.extend(SOURCES);
        expected.sort();
        assert_eq!(without_gitignore, expected);
    }

    #[test]
    fn update_applies_the_ignore_rules_of_every_folder_on_the_way() {
        let root = hello_cpp_with_build("indice-lote");
        write(&root.join(".gitignore"), "build/\n");
        write(&root.join("app/.ignore"), "*.tmp\n");
        let index = index_of(&root);

        write(&root.join("build/novo.o"), "");
        write(&root.join("app/rascunho.tmp"), "");
        write(&root.join("app/util.cpp"), "");
        index.update(&ChangeBatch {
            paths: ["build/novo.o", "app/rascunho.tmp", "app/util.cpp"]
                .map(|path| root.join(path))
                .into(),
            rescan: false,
        });
        let files = relative_files(&index);

        assert!(files.contains(&"app/util.cpp".to_owned()), "{files:?}");
        assert!(!files.iter().any(|file| file.ends_with(".o")), "{files:?}");
        assert!(!files.contains(&"app/rascunho.tmp".to_owned()), "{files:?}");
    }

    #[test]
    fn editing_the_gitignore_brings_back_what_it_no_longer_ignores() {
        let root = hello_cpp_with_build("indice-editar-gitignore");
        write(&root.join(".gitignore"), "build/\n");
        let index = index_of(&root);

        write(&root.join(".gitignore"), "");
        index.update(&ChangeBatch {
            paths: vec![root.join(".gitignore")],
            rescan: false,
        });

        assert!(relative_files(&index).contains(&"build/app.o".to_owned()));
    }
}
