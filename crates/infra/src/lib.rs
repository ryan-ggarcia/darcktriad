//! Adaptadores: implementações concretas das portas definidas em `darktriad-core`.

mod file_api;
mod local_fs;
#[cfg(any(target_os = "macos", test))]
mod login_shell;
mod process;
mod project_walker;
mod pty;
mod state_store;
mod tool_probe;
mod watcher;

pub use file_api::LocalFileApi;
pub use local_fs::LocalFileSystem;
#[cfg(target_os = "macos")]
pub use login_shell::use_login_shell_path;
pub use process::{StdProcessRunner, StdServerSpawner};
pub use project_walker::IgnoreWalker;
pub use pty::{PortablePty, detect_default_shell};
pub use state_store::JsonStateStore;
pub use tool_probe::SystemToolProbe;
pub use watcher::NotifyWatcher;

#[cfg(test)]
mod test_support {
    use std::ops::Deref;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Pasta temporária exclusiva do teste, apagada no fim mesmo se o teste falhar.
    pub struct TempDir(PathBuf);

    impl TempDir {
        pub fn new(name: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let serial = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("darktriad-{name}-{}-{serial}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Deref for TempDir {
        type Target = Path;

        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
