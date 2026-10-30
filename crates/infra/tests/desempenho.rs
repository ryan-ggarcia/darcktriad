//! Metas de desempenho da v0.1 (docs/specs/README.md), na parte que cabe ao núcleo, com o projeto
//! `grande` gerado aqui: uma pasta com 5.000 arquivos e um `.cpp` de 10.000 linhas.
//! A meta de 300 ms vale do clique até a tela; o núcleo precisa caber numa fração dela, e o limite
//! abaixo deixa folga para máquinas de CI lentas e para o build de teste sem otimização.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use darktriad_core::{Editor, Explorer, FileContent};
use darktriad_infra::LocalFileSystem;

const CORE_BUDGET: Duration = Duration::from_millis(100);

/// Pasta temporária do teste, apagada no fim mesmo se o teste falhar.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("darktriad-{name}-{}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// O mais rápido de três: tira o ruído dos outros testes que rodam em paralelo.
fn fastest_of_three(mut job: impl FnMut()) -> Duration {
    (0..3)
        .map(|_| {
            let start = Instant::now();
            job();
            start.elapsed()
        })
        .min()
        .unwrap()
}

#[test]
fn listing_a_folder_with_5000_files_fits_the_budget() {
    let folder = TempDir::new("grande-pasta");
    for index in 0..5000 {
        fs::write(folder.path().join(format!("arquivo{index:04}.cpp")), "").unwrap();
    }
    let explorer = Explorer::new(LocalFileSystem);

    let mut listed = 0;
    let elapsed = fastest_of_three(|| listed = explorer.list(folder.path()).unwrap().len());

    assert_eq!(listed, 5000);
    assert!(
        elapsed < CORE_BUDGET,
        "listar 5.000 itens levou {elapsed:?}"
    );
}

#[test]
fn reading_a_10000_line_file_fits_the_budget() {
    let folder = TempDir::new("grande-arquivo");
    let path = folder.path().join("grande.cpp");
    let line = "    total = soma(total, valores[indice]); // linha de tamanho típico\r\n";
    fs::write(&path, line.repeat(10_000)).unwrap();
    let editor = Editor::new(LocalFileSystem);

    let mut lines = 0;
    let elapsed = fastest_of_three(|| match editor.read(&path).unwrap() {
        FileContent::Text { content, .. } => lines = content.lines().count(),
        other => panic!("esperava texto, veio {other:?}"),
    });

    assert_eq!(lines, 10_000);
    assert!(elapsed < CORE_BUDGET, "ler 10.000 linhas levou {elapsed:?}");
}
