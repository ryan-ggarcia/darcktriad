use std::collections::BTreeSet;
use std::ops::{Bound, ControlFlow};
use std::path::{Path, PathBuf};
use std::slice;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::{ChangeBatch, ProjectWalker};

/// De quanto em quanto tempo a montagem avisa que achou mais arquivos: a lista parcial do
/// Abrir rápido cresce sem que a interface releia tudo a cada arquivo.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// Arquivos que mudam o que é ignorado na pasta onde estão.
const IGNORE_FILES: [&str; 2] = [".gitignore", ".ignore"];

/// Os arquivos da pasta aberta que o Abrir rápido (Ctrl+P) lista.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFiles {
    /// A pasta a que `files` se refere; `None` sem pasta aberta.
    pub root: Option<PathBuf>,
    /// Relativos a `root`: com 50.000 arquivos, o caminho inteiro mais que dobraria o que vai
    /// para a interface.
    pub files: Vec<String>,
    /// O índice ainda está sendo montado: `files` tem só o que já foi achado.
    pub indexing: bool,
}

/// Montagem pendente, criada por [`FileIndex::start`] e feita por [`FileIndex::run`].
pub struct IndexJob {
    root: PathBuf,
    generation: u64,
}

/// Caso de uso: o índice de arquivos do Abrir rápido, montado em segundo plano ao abrir a pasta
/// e mantido em dia pelos lotes do observador.
pub struct FileIndex<W> {
    walker: W,
    on_change: Box<dyn Fn() + Send + Sync>,
    state: Mutex<State>,
    /// Um percurso por vez: um lote que chega durante a montagem é aplicado depois dela, então o
    /// resultado de um percurso antigo nunca passa por cima de uma mudança mais nova.
    walking: Mutex<()>,
}

#[derive(Default)]
struct State {
    root: Option<PathBuf>,
    files: BTreeSet<PathBuf>,
    indexing: bool,
    /// Muda a cada pasta aberta ou fechada; percursos de uma geração anterior param.
    generation: u64,
}

impl<W: ProjectWalker> FileIndex<W> {
    /// `on_change` é chamado quando a lista ou o `indexing` mudam.
    pub fn new(walker: W, on_change: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            walker,
            on_change: Box::new(on_change),
            state: Mutex::default(),
            walking: Mutex::default(),
        }
    }

    /// Esvazia o índice e o marca como em montagem. Rápido: o percurso fica para `run`, que pode
    /// rodar em outra thread; assim a interface já vê "Indexando…" quando a pasta abre.
    pub fn start(&self, root: &Path) -> IndexJob {
        let mut state = self.lock();
        state.generation += 1;
        state.root = Some(root.into());
        state.files.clear();
        state.indexing = true;
        let job = IndexJob {
            root: root.into(),
            generation: state.generation,
        };
        drop(state);
        (self.on_change)();
        job
    }

    /// Percorre a pasta, publicando cada arquivo assim que é achado. Para no meio se outra
    /// pasta foi aberta ou a pasta foi fechada.
    pub fn run(&self, job: IndexJob) {
        let _walking = lock(&self.walking);
        let mut last_report = Instant::now();
        self.walker
            .walk(&job.root, slice::from_ref(&job.root), &mut |file| {
                let mut state = self.lock();
                if state.generation != job.generation {
                    return ControlFlow::Break(());
                }
                state.files.insert(file);
                drop(state);
                if last_report.elapsed() >= PROGRESS_INTERVAL {
                    last_report = Instant::now();
                    (self.on_change)();
                }
                ControlFlow::Continue(())
            });

        let mut state = self.lock();
        if state.generation == job.generation {
            state.indexing = false;
            drop(state);
            (self.on_change)();
        }
    }

    /// Relê do disco os caminhos do lote (ou a pasta inteira, com `rescan`) e troca o que o
    /// índice tinha deles de uma vez, sem a lista passar por um estado pela metade.
    pub fn update(&self, batch: &ChangeBatch) {
        let _walking = lock(&self.walking);
        let (job, scope) = {
            let state = self.lock();
            let Some(root) = state.root.clone() else {
                return;
            };
            let scope = if batch.rescan {
                vec![root.clone()]
            } else {
                affected(&root, &batch.paths)
            };
            let job = IndexJob {
                root,
                generation: state.generation,
            };
            (job, scope)
        };
        if scope.is_empty() {
            return;
        }

        let mut found = Vec::new();
        self.walker.walk(&job.root, &scope, &mut |file| {
            if self.lock().generation != job.generation {
                return ControlFlow::Break(());
            }
            found.push(file);
            ControlFlow::Continue(())
        });

        let mut state = self.lock();
        if state.generation != job.generation {
            return;
        }
        let mut removed: Vec<PathBuf> = scope
            .iter()
            .flat_map(|path| take_inside(&mut state.files, path))
            .collect();
        removed.sort();
        found.sort();
        // Salvar um arquivo relê o próprio arquivo: a lista não muda e a interface não é avisada.
        let changed = removed != found;
        state.files.extend(found);
        drop(state);
        if changed {
            (self.on_change)();
        }
    }

    /// Esvazia o índice ao fechar a pasta e interrompe a montagem em andamento.
    pub fn clear(&self) {
        let mut state = self.lock();
        state.generation += 1;
        state.root = None;
        state.files.clear();
        state.indexing = false;
        drop(state);
        (self.on_change)();
    }

    /// Os arquivos achados até agora, em ordem de caminho. Nomes que não são UTF-8 ficam de fora:
    /// a interface não teria como pedir o arquivo de volta.
    pub fn snapshot(&self) -> ProjectFiles {
        let state = self.lock();
        let files = match &state.root {
            Some(root) => state
                .files
                .iter()
                .filter_map(|file| file.strip_prefix(root).ok()?.to_str().map(str::to_owned))
                .collect(),
            None => Vec::new(),
        };
        ProjectFiles {
            root: state.root.clone(),
            files,
            indexing: state.indexing,
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// O que reler: os caminhos do lote dentro da pasta e, quando muda um `.gitignore` ou `.ignore`,
/// a pasta inteira onde ele está, porque o que é ignorado lá dentro pode ter mudado.
fn affected(root: &Path, paths: &[PathBuf]) -> Vec<PathBuf> {
    paths
        .iter()
        .filter(|path| path.starts_with(root))
        .map(|path| {
            let is_ignore_file = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| IGNORE_FILES.contains(&name));
            match path.parent() {
                Some(parent) if is_ignore_file => parent.to_path_buf(),
                _ => path.clone(),
            }
        })
        .collect()
}

/// Tira do índice `path` e tudo o que está dentro dele. No `BTreeSet` os caminhos são ordenados
/// por componente, então o que está dentro de `path` vem logo depois dele, em sequência.
fn take_inside(files: &mut BTreeSet<PathBuf>, path: &Path) -> Vec<PathBuf> {
    let inside: Vec<PathBuf> = files
        .range::<Path, _>((Bound::Included(path), Bound::Unbounded))
        .take_while(|file| file.starts_with(path))
        .cloned()
        .collect();
    for file in &inside {
        files.remove(file);
    }
    inside
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// Disco em memória: os arquivos que o percurso acharia, já sem os ignorados.
    #[derive(Default)]
    struct FakeWalker {
        files: Mutex<Vec<PathBuf>>,
        scopes: Mutex<Vec<Vec<PathBuf>>>,
    }

    impl FakeWalker {
        fn set_files(&self, files: &[&str]) {
            *self.files.lock().unwrap() = files.iter().map(PathBuf::from).collect();
        }
    }

    impl ProjectWalker for FakeWalker {
        fn walk(
            &self,
            root: &Path,
            scope: &[PathBuf],
            found: &mut dyn FnMut(PathBuf) -> ControlFlow<()>,
        ) {
            self.scopes.lock().unwrap().push(scope.to_vec());
            let files = self.files.lock().unwrap().clone();
            for file in files {
                let in_scope = scope.iter().any(|path| file.starts_with(path));
                if file.starts_with(root) && in_scope && found(file).is_break() {
                    return;
                }
            }
        }
    }

    struct Fixture {
        index: FileIndex<FakeWalker>,
        changes: Arc<AtomicUsize>,
    }

    impl Fixture {
        fn with_files(files: &[&str]) -> Self {
            let walker = FakeWalker::default();
            walker.set_files(files);
            let changes = Arc::new(AtomicUsize::new(0));
            let counter = Arc::clone(&changes);
            let index = FileIndex::new(walker, move || {
                counter.fetch_add(1, Ordering::Relaxed);
            });
            Self { index, changes }
        }

        fn open(&self, root: &str) {
            let job = self.index.start(Path::new(root));
            self.index.run(job);
        }

        fn files(&self) -> Vec<String> {
            let snapshot = self.index.snapshot();
            snapshot
                .files
                .iter()
                .map(|path| path.replace('\\', "/"))
                .collect()
        }

        fn changes(&self) -> usize {
            self.changes.load(Ordering::Relaxed)
        }

        fn update(&self, paths: &[&str]) {
            self.index.update(&ChangeBatch {
                paths: paths.iter().map(PathBuf::from).collect(),
                rescan: false,
            });
        }
    }

    #[test]
    fn start_marks_the_index_as_indexing_until_run_finishes() {
        let fixture = Fixture::with_files(&["p/b.cpp", "p/a.cpp", "outra/c.cpp"]);

        let job = fixture.index.start(Path::new("p"));
        let during = fixture.index.snapshot();
        fixture.index.run(job);
        let done = fixture.index.snapshot();

        assert!(during.files.is_empty() && during.indexing);
        assert_eq!(fixture.files(), ["a.cpp", "b.cpp"]);
        assert_eq!(done.root.as_deref(), Some(Path::new("p")));
        assert!(!done.indexing);
        assert!(fixture.changes() >= 2, "avisa ao começar e ao terminar");
    }

    #[test]
    fn a_walk_for_a_folder_that_is_no_longer_open_adds_nothing() {
        let fixture = Fixture::with_files(&["a/velho.cpp", "b/novo.cpp"]);

        let old = fixture.index.start(Path::new("a"));
        let new = fixture.index.start(Path::new("b"));
        fixture.index.run(old);
        let after_old = fixture.index.snapshot();
        fixture.index.run(new);

        assert!(after_old.files.is_empty() && after_old.indexing);
        assert_eq!(fixture.files(), ["novo.cpp"]);
    }

    #[test]
    fn update_rereads_only_the_paths_in_the_batch() {
        let fixture = Fixture::with_files(&["p/a.cpp", "p/src/b.cpp"]);
        fixture.open("p");
        fixture
            .index
            .walker
            .set_files(&["p/a.cpp", "p/src/c.cpp", "p/fora-do-lote.cpp"]);

        fixture.update(&["p/src/b.cpp", "p/src/c.cpp"]);

        assert_eq!(fixture.files(), ["a.cpp", "src/c.cpp"]);
    }

    #[test]
    fn a_removed_folder_takes_everything_inside_it_and_nothing_else() {
        let fixture = Fixture::with_files(&["p/src/a.cpp", "p/src/sub/b.cpp", "p/src2/c.cpp"]);
        fixture.open("p");
        fixture.index.walker.set_files(&["p/src2/c.cpp"]);

        fixture.update(&["p/src"]);

        assert_eq!(fixture.files(), ["src2/c.cpp"]);
    }

    #[test]
    fn saving_a_file_does_not_notify_but_creating_one_does() {
        let fixture = Fixture::with_files(&["p/a.cpp"]);
        fixture.open("p");
        let before = fixture.changes();

        fixture.update(&["p/a.cpp"]);
        let after_save = fixture.changes();
        fixture.index.walker.set_files(&["p/a.cpp", "p/b.cpp"]);
        fixture.update(&["p/b.cpp"]);

        assert_eq!(after_save, before);
        assert_eq!(fixture.changes(), before + 1);
    }

    #[test]
    fn a_changed_ignore_file_rereads_its_whole_folder() {
        let fixture = Fixture::with_files(&[]);
        fixture.open("p");

        fixture.update(&["p/sub/.gitignore", "p/.ignore", "p/main.cpp"]);

        let scopes = fixture.index.walker.scopes.lock().unwrap().clone();
        let expected: Vec<PathBuf> = ["p/sub", "p", "p/main.cpp"].map(PathBuf::from).into();
        assert_eq!(scopes.last(), Some(&expected));
    }

    #[test]
    fn rescan_rereads_the_whole_folder() {
        let fixture = Fixture::with_files(&["p/a.cpp", "p/b.cpp"]);
        fixture.open("p");
        fixture.index.walker.set_files(&["p/b.cpp", "p/c.cpp"]);

        fixture.index.update(&ChangeBatch {
            paths: Vec::new(),
            rescan: true,
        });

        assert_eq!(fixture.files(), ["b.cpp", "c.cpp"]);
    }

    #[test]
    fn batches_outside_the_open_folder_or_after_closing_are_ignored() {
        let fixture = Fixture::with_files(&["p/a.cpp", "outra/b.cpp"]);
        fixture.open("p");

        fixture.update(&["outra/b.cpp"]);
        let before_close = fixture.files();
        fixture.index.clear();
        fixture.update(&["p/a.cpp"]);

        assert_eq!(before_close, ["a.cpp"]);
        assert_eq!(fixture.index.snapshot(), ProjectFiles::default());
    }
}
