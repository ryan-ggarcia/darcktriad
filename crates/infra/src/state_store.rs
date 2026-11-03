use std::fs;
use std::io;
use std::path::PathBuf;

use darktriad_core::{AppState, StateStore};

/// Estado do app num arquivo JSON da pasta de dados do app.
pub struct JsonStateStore {
    path: PathBuf,
}

impl JsonStateStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl StateStore for JsonStateStore {
    fn load(&self) -> io::Result<AppState> {
        match fs::read(&self.path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(AppState::default()),
            Err(error) => Err(error),
        }
    }

    fn save(&self, state: &AppState) -> io::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        // Temporário e rename: uma queda no meio não deixa o arquivo pela metade.
        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, serde_json::to_vec_pretty(state)?)?;
        fs::rename(&temp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use darktriad_core::{Breakpoint, ProjectChoice, RecentFolder, Session};

    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn missing_file_loads_as_empty_state() {
        let root = TempDir::new("state-missing");

        let state = JsonStateStore::new(root.join("state.json")).load().unwrap();

        assert_eq!(state, AppState::default());
    }

    #[test]
    fn saved_state_loads_back_unchanged() {
        let root = TempDir::new("state-roundtrip");
        let store = JsonStateStore::new(root.join("dados").join("state.json"));
        let state = AppState {
            recent_folders: vec![RecentFolder {
                path: root.join("hello-cpp"),
                last_opened: Some(1_793_700_000_000),
                session: Session {
                    open_files: vec![root.join("hello-cpp/app/main.cpp")],
                    active_file: Some(root.join("hello-cpp/app/main.cpp")),
                },
                project: ProjectChoice {
                    config: Some("Release".into()),
                    target: Some("tool".into()),
                },
                breakpoints: vec![Breakpoint {
                    file: root.join("hello-cpp/app/main.cpp"),
                    line: 8,
                }],
            }],
        };

        store.save(&state).unwrap();

        assert_eq!(store.load().unwrap(), state);
    }

    #[test]
    fn corrupt_file_is_an_error() {
        let root = TempDir::new("state-corrupt");
        fs::write(root.join("state.json"), "{ quebrado").unwrap();

        let error = JsonStateStore::new(root.join("state.json"))
            .load()
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
