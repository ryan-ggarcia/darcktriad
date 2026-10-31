//! Domínio, casos de uso e portas do Dark Triad.
//! Este crate não conhece nenhuma implementação concreta: tudo entra por trait.

mod editor;
mod error;
mod explorer;
mod file_index;
mod input;
mod ports;
mod project;
mod terminal;
mod tools;
mod workspace;

pub use editor::{Editor, Eol, FileContent};
pub use error::{Error, ErrorKind, Result};
pub use explorer::{Entry, Explorer, is_hidden};
pub use file_index::{FileIndex, IndexJob, ProjectFiles};
pub use input::{validate_name, validate_path};
pub use ports::{
    EntryWriter, FileStat, FileStore, FileSystem, FolderWatcher, ProjectWalker, PtySpawner,
    SpawnedTerminal, StateStore, TerminalProcess, TerminalSize, ToolProbe, Trash,
};
pub use project::{
    BuildConfig, CMakeProblem, CMakeTarget, DetectedProject, ProjectKind, cmake_build_dir,
    cmake_configure_args, cmake_preset_args, detect_project, file_api_executables, file_api_query,
    parse_build_dir, parse_cmake_error, parse_preset_names,
};
pub use terminal::{Platform, TerminalEvent, TerminalInfo, Terminals, default_shell, shell_name};
pub use tools::{TOOLS, Tool, ToolStatus};
pub use workspace::{
    AppState, ChangeBatch, OpenedFolder, RecentFolder, RecentFolderView, Session, Workspace,
};
