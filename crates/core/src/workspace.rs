use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};

use crate::{Error, ErrorKind, FileSystem, FolderWatcher, Result, StateStore};

pub const MAX_RECENT_FOLDERS: usize = 10;

/// Abas abertas de uma pasta, restauradas ao reabri-la.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub open_files: Vec<PathBuf>,
    pub active_file: Option<PathBuf>,
}

/// A configuração e o alvo escolhidos numa pasta. `None` usa o primeiro da lista.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectChoice {
    pub config: Option<String>,
    pub target: Option<String>,
}

/// Um ponto de parada marcado pelo usuário.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Breakpoint {
    pub file: PathBuf,
    /// A partir de 1.
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFolder {
    pub path: PathBuf,
    #[serde(default)]
    pub session: Session,
    #[serde(default)]
    pub project: ProjectChoice,
    #[serde(default)]
    pub breakpoints: Vec<Breakpoint>,
}

/// O que o app guarda entre execuções. A primeira pasta recente é a última usada.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppState {
    pub recent_folders: Vec<RecentFolder>,
}

/// Item da lista de pastas recentes da tela inicial.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFolderView {
    pub path: PathBuf,
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFolder {
    pub path: PathBuf,
    pub session: Session,
    /// Os pontos de parada salvos para esta pasta.
    pub breakpoints: Vec<Breakpoint>,
    /// Motivo de as mudanças externas não serem detectadas; `None` quando o observador funciona.
    pub watch_error: Option<String>,
}

/// Lote de mudanças no disco dentro da pasta aberta.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeBatch {
    pub paths: Vec<PathBuf>,
    /// Eventos podem ter se perdido: recarregue tudo o que está visível.
    pub rescan: bool,
}

/// Caso de uso: a pasta aberta, as pastas recentes e as abas de cada pasta.
pub struct Workspace<F, W, S> {
    fs: F,
    watcher: W,
    store: S,
    inner: Mutex<Inner>,
}

struct Inner {
    root: Option<PathBuf>,
    state: AppState,
}

impl<F: FileSystem, W: FolderWatcher, S: StateStore> Workspace<F, W, S> {
    pub fn new(fs: F, watcher: W, store: S) -> Self {
        // Estado ilegível recomeça vazio: perder os recentes não pode impedir a IDE de abrir.
        let state = store.load().unwrap_or_default();
        Self {
            fs,
            watcher,
            store,
            inner: Mutex::new(Inner { root: None, state }),
        }
    }

    /// Abre a pasta, passa a observá-la e a põe no topo das recentes.
    /// Se o observador falhar, a pasta abre assim mesmo e `watch_error` diz o motivo.
    pub fn open(&self, path: &Path) -> Result<OpenedFolder> {
        if !self.fs.is_dir(path) {
            return Err(Error::new(
                ErrorKind::NotFound,
                format!("Pasta não encontrada: {}", path.display()),
            ));
        }
        let mut inner = self.lock();
        let watch_error = self
            .watcher
            .watch(path)
            .err()
            .map(|error| error.to_string());

        let recents = &mut inner.state.recent_folders;
        let recent = match recents.iter().position(|recent| recent.path == path) {
            Some(index) => recents.remove(index),
            None => RecentFolder {
                path: path.into(),
                session: Session::default(),
                project: ProjectChoice::default(),
                breakpoints: Vec::new(),
            },
        };
        let session = recent.session.clone();
        let breakpoints = recent.breakpoints.clone();
        recents.insert(0, recent);
        recents.truncate(MAX_RECENT_FOLDERS);
        inner.root = Some(path.into());
        // Falhar ao lembrar a pasta não impede de abri-la.
        let _ = self.store.save(&inner.state);

        Ok(OpenedFolder {
            path: path.into(),
            session,
            breakpoints,
            watch_error,
        })
    }

    pub fn close(&self) {
        let mut inner = self.lock();
        self.watcher.unwatch();
        inner.root = None;
    }

    pub fn root(&self) -> Result<PathBuf> {
        self.lock().root.clone().ok_or_else(no_folder_open)
    }

    /// A existência é conferida a cada chamada: a pasta pode ter sumido desde a última execução.
    pub fn recent_folders(&self) -> Vec<RecentFolderView> {
        let paths: Vec<PathBuf> = self
            .lock()
            .state
            .recent_folders
            .iter()
            .map(|recent| recent.path.clone())
            .collect();
        paths
            .into_iter()
            .map(|path| RecentFolderView {
                exists: self.fs.is_dir(&path),
                path,
            })
            .collect()
    }

    pub fn remove_recent_folder(&self, path: &Path) -> Result<()> {
        let mut inner = self.lock();
        inner
            .state
            .recent_folders
            .retain(|recent| recent.path != path);
        Ok(self.store.save(&inner.state)?)
    }

    /// Guarda as abas da pasta aberta.
    pub fn save_session(&self, session: Session) -> Result<()> {
        self.update_open_folder(|recent| recent.session = session)
    }

    /// A configuração e o alvo guardados para a pasta aberta.
    pub fn project_choice(&self) -> ProjectChoice {
        let inner = self.lock();
        inner
            .state
            .recent_folders
            .iter()
            .find(|recent| Some(&recent.path) == inner.root.as_ref())
            .map(|recent| recent.project.clone())
            .unwrap_or_default()
    }

    /// Guarda a configuração e o alvo da pasta aberta.
    pub fn save_project_choice(&self, choice: ProjectChoice) -> Result<()> {
        self.update_open_folder(|recent| recent.project = choice)
    }

    /// Guarda os pontos de parada da pasta aberta.
    pub fn save_breakpoints(&self, breakpoints: Vec<Breakpoint>) -> Result<()> {
        self.update_open_folder(|recent| recent.breakpoints = breakpoints)
    }

    fn update_open_folder(&self, update: impl FnOnce(&mut RecentFolder)) -> Result<()> {
        let mut inner = self.lock();
        let root = inner.root.clone().ok_or_else(no_folder_open)?;
        if let Some(recent) = inner
            .state
            .recent_folders
            .iter_mut()
            .find(|recent| recent.path == root)
        {
            update(recent);
        }
        Ok(self.store.save(&inner.state)?)
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn no_folder_open() -> Error {
    Error::new(ErrorKind::InvalidInput, "Nenhuma pasta aberta")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::io;

    use super::*;
    use crate::Entry;

    #[derive(Default)]
    struct FakeFolders(Mutex<BTreeSet<PathBuf>>);

    impl FakeFolders {
        fn new(folders: &[&str]) -> Self {
            Self(Mutex::new(folders.iter().map(PathBuf::from).collect()))
        }
    }

    impl FileSystem for FakeFolders {
        fn read_dir(&self, _: &Path) -> io::Result<Vec<Entry>> {
            Ok(Vec::new())
        }

        fn is_dir(&self, path: &Path) -> bool {
            self.0.lock().unwrap().contains(path)
        }

        fn is_file(&self, _: &Path) -> bool {
            false
        }
    }

    #[derive(Default)]
    struct FakeWatcher {
        watching: Mutex<Option<PathBuf>>,
        fails: bool,
    }

    impl FolderWatcher for FakeWatcher {
        fn watch(&self, root: &Path) -> io::Result<()> {
            if self.fails {
                return Err(io::Error::other("limite de inotify"));
            }
            *self.watching.lock().unwrap() = Some(root.into());
            Ok(())
        }

        fn unwatch(&self) {
            *self.watching.lock().unwrap() = None;
        }
    }

    #[derive(Default)]
    struct FakeStore {
        saved: Mutex<Option<AppState>>,
        unreadable: bool,
    }

    impl StateStore for FakeStore {
        fn load(&self) -> io::Result<AppState> {
            if self.unreadable {
                return Err(io::ErrorKind::InvalidData.into());
            }
            Ok(self.saved.lock().unwrap().clone().unwrap_or_default())
        }

        fn save(&self, state: &AppState) -> io::Result<()> {
            *self.saved.lock().unwrap() = Some(state.clone());
            Ok(())
        }
    }

    type TestWorkspace = Workspace<FakeFolders, FakeWatcher, FakeStore>;

    fn workspace_with(folders: &[&str]) -> TestWorkspace {
        Workspace::new(
            FakeFolders::new(folders),
            FakeWatcher::default(),
            FakeStore::default(),
        )
    }

    fn recent_paths(workspace: &TestWorkspace) -> Vec<String> {
        let recents = workspace.recent_folders();
        recents
            .iter()
            .map(|recent| recent.path.display().to_string())
            .collect()
    }

    #[test]
    fn open_watches_the_folder_and_moves_it_to_the_top_of_recents() {
        let workspace = workspace_with(&["a", "b"]);

        workspace.open(Path::new("a")).unwrap();
        workspace.open(Path::new("b")).unwrap();
        workspace.open(Path::new("a")).unwrap();

        assert_eq!(recent_paths(&workspace), ["a", "b"]);
        assert_eq!(workspace.root().unwrap(), Path::new("a"));
        let watching = workspace.watcher.watching.lock().unwrap().clone();
        assert_eq!(watching.as_deref(), Some(Path::new("a")));
        let saved = workspace.store.saved.lock().unwrap().clone().unwrap();
        assert_eq!(saved.recent_folders.len(), 2);
    }

    #[test]
    fn recents_keep_only_the_last_ten_folders() {
        let names: Vec<String> = (0..12).map(|index| format!("p{index}")).collect();
        let folders: Vec<&str> = names.iter().map(String::as_str).collect();
        let workspace = workspace_with(&folders);

        for folder in &folders {
            workspace.open(Path::new(folder)).unwrap();
        }

        let recents = recent_paths(&workspace);
        assert_eq!(recents.len(), MAX_RECENT_FOLDERS);
        assert_eq!(recents.first().map(String::as_str), Some("p11"));
        assert_eq!(recents.last().map(String::as_str), Some("p2"));
    }

    #[test]
    fn open_of_missing_folder_fails_without_touching_recents() {
        let workspace = workspace_with(&[]);

        let error = workspace.open(Path::new("sumiu")).unwrap_err();

        assert_eq!(error.kind, ErrorKind::NotFound);
        assert!(workspace.recent_folders().is_empty());
        assert_eq!(workspace.root().unwrap_err().kind, ErrorKind::InvalidInput);
    }

    #[test]
    fn folder_opens_even_when_the_watcher_cannot_start() {
        let workspace = Workspace::new(
            FakeFolders::new(&["a"]),
            FakeWatcher {
                fails: true,
                ..FakeWatcher::default()
            },
            FakeStore::default(),
        );

        let opened = workspace.open(Path::new("a")).unwrap();

        assert_eq!(opened.watch_error.as_deref(), Some("limite de inotify"));
        assert_eq!(workspace.root().unwrap(), Path::new("a"));
    }

    #[test]
    fn reopening_a_folder_returns_the_tabs_saved_for_it() {
        let workspace = workspace_with(&["a", "b"]);
        let session = Session {
            open_files: vec!["a/main.cpp".into(), "a/util.h".into()],
            active_file: Some("a/util.h".into()),
        };

        workspace.open(Path::new("a")).unwrap();
        workspace.save_session(session.clone()).unwrap();
        workspace.open(Path::new("b")).unwrap();
        let reopened = workspace.open(Path::new("a")).unwrap();

        assert_eq!(reopened.session, session);
    }

    #[test]
    fn project_choice_is_saved_per_folder_and_survives_a_restart() {
        let workspace = workspace_with(&["a", "b"]);
        let choice = ProjectChoice {
            config: Some("Release".into()),
            target: Some("tool".into()),
        };
        workspace.open(Path::new("a")).unwrap();
        workspace.save_project_choice(choice.clone()).unwrap();
        workspace.open(Path::new("b")).unwrap();
        assert_eq!(workspace.project_choice(), ProjectChoice::default());

        let saved = workspace.store.saved.lock().unwrap().clone();
        let restarted = Workspace::new(
            FakeFolders::new(&["a", "b"]),
            FakeWatcher::default(),
            FakeStore {
                saved: Mutex::new(saved),
                unreadable: false,
            },
        );
        restarted.open(Path::new("a")).unwrap();
        assert_eq!(restarted.project_choice(), choice);
    }

    #[test]
    fn breakpoints_are_saved_per_folder_and_survive_a_restart() {
        let workspace = workspace_with(&["a", "b"]);
        let breakpoints = vec![
            Breakpoint {
                file: "a/main.cpp".into(),
                line: 8,
            },
            Breakpoint {
                file: "a/core/soma.cpp".into(),
                line: 3,
            },
        ];
        workspace.open(Path::new("a")).unwrap();
        workspace.save_breakpoints(breakpoints.clone()).unwrap();
        assert!(
            workspace
                .open(Path::new("b"))
                .unwrap()
                .breakpoints
                .is_empty()
        );

        let saved = workspace.store.saved.lock().unwrap().clone();
        let restarted = Workspace::new(
            FakeFolders::new(&["a", "b"]),
            FakeWatcher::default(),
            FakeStore {
                saved: Mutex::new(saved),
                unreadable: false,
            },
        );
        assert_eq!(
            restarted.open(Path::new("a")).unwrap().breakpoints,
            breakpoints
        );
    }

    #[test]
    fn recents_report_missing_folders_and_can_be_removed() {
        let workspace = workspace_with(&["a", "b"]);
        workspace.open(Path::new("a")).unwrap();
        workspace.open(Path::new("b")).unwrap();
        workspace.fs.0.lock().unwrap().remove(Path::new("a"));

        let existing: Vec<bool> = workspace
            .recent_folders()
            .iter()
            .map(|recent| recent.exists)
            .collect();
        workspace.remove_recent_folder(Path::new("a")).unwrap();

        assert_eq!(existing, [true, false]);
        assert_eq!(recent_paths(&workspace), ["b"]);
    }

    #[test]
    fn close_stops_watching_and_leaves_no_folder_open() {
        let workspace = workspace_with(&["a"]);
        workspace.open(Path::new("a")).unwrap();

        workspace.close();

        assert!(workspace.watcher.watching.lock().unwrap().is_none());
        assert!(workspace.root().is_err());
        assert!(workspace.save_session(Session::default()).is_err());
    }

    #[test]
    fn unreadable_state_starts_with_no_recents() {
        let workspace = Workspace::new(
            FakeFolders::default(),
            FakeWatcher::default(),
            FakeStore {
                unreadable: true,
                ..FakeStore::default()
            },
        );

        assert!(workspace.recent_folders().is_empty());
    }
}
