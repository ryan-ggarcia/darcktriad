//! O que os testes de integração dividem: cópias temporárias das fixtures, configuradas com as
//! ferramentas de verdade.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use darktriad_core::{Project, ProjectChoice, ProjectEvent, ProjectState, ToolProbe};
use darktriad_infra::{LocalFileApi, LocalFileSystem, StdProcessRunner, SystemToolProbe};

/// Pasta temporária fora do repositório, apagada no fim mesmo se o teste falhar.
pub struct TempDir(pub PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures")
        .join(name)
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

pub fn probe() -> SystemToolProbe {
    SystemToolProbe::new(std::env::temp_dir().join("darktriad-sem-ferramentas"))
}

pub type TestProject = Project<LocalFileSystem, StdProcessRunner, LocalFileApi, SystemToolProbe>;
pub type Events = Arc<Mutex<Vec<ProjectEvent>>>;

/// Configura uma cópia da fixture com `tool` e devolve o estado final e as linhas da Saída.
/// `None` quando não há `tool` para testar.
// Cada arquivo de teste inclui este módulo e usa só parte dele.
#[allow(dead_code)]
pub fn configure(name: &str, tool: &str) -> Option<(TempDir, ProjectState, Vec<String>)> {
    let (root, project, events) = open(name, tool)?;
    let output = (events.lock().unwrap().iter())
        .filter_map(|event| match event {
            ProjectEvent::Output { line } => Some(line.clone()),
            _ => None,
        })
        .collect();
    Some((root, project.state(), output))
}

/// Abre e configura uma cópia da fixture com `tool`. `events` recebe tudo o que o projeto avisa.
/// `None` quando não há `tool` para testar.
pub fn open(name: &str, tool: &str) -> Option<(TempDir, TestProject, Events)> {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    if probe().find(tool).is_empty() {
        eprintln!("PULADO: `{tool}` não está no PATH; o teste de integração de {name} não rodou.");
        return None;
    }
    let serial = NEXT.fetch_add(1, Ordering::Relaxed);
    let path =
        std::env::temp_dir().join(format!("darktriad-{name}-{}-{serial}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    copy_dir(&fixture(name), &path);
    // No macOS a pasta temporária passa por um link (/var → /private/var), e o CMake informa a
    // pasta de build pelo caminho real. No Windows, o caminho real troca o nome curto (`RUNNER~1`, no
    // CI) pelo longo, que é o que o dotnet informa, mas vem como `\\?\C:\...`, que o cmake e o dotnet
    // não aceitam; a IDE recebe a pasta sem esse prefixo.
    let real = fs::canonicalize(&path).unwrap();
    let root = TempDir(PathBuf::from(
        real.display().to_string().trim_start_matches(r"\\?\"),
    ));
    let before: Vec<_> = fs::read_dir(fixture(name))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();

    let events = Events::default();
    let sink = Arc::clone(&events);
    let project = Project::new(
        LocalFileSystem,
        StdProcessRunner,
        LocalFileApi,
        probe(),
        move |event| sink.lock().unwrap().push(event),
    );
    project.open(&root.0, ProjectChoice::default());

    let after: Vec<_> = fs::read_dir(fixture(name))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(
        before.len(),
        after.len(),
        "a fixture ganhou arquivos: {after:?}"
    );
    Some((root, project, events))
}
