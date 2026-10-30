//! Domínio, casos de uso e portas do Dark Triad.
//! Este crate não conhece nenhuma implementação concreta: tudo entra por trait.

mod editor;
mod error;
mod explorer;
mod input;
mod ports;
mod workspace;

pub use editor::{Editor, Eol, FileContent};
pub use error::{Error, ErrorKind, Result};
pub use explorer::{Entry, Explorer, is_hidden};
pub use input::{validate_name, validate_path};
pub use ports::{EntryWriter, FileStat, FileStore, FileSystem, FolderWatcher, StateStore, Trash};
pub use workspace::{
    AppState, ChangeBatch, OpenedFolder, RecentFolder, RecentFolderView, Session, Workspace,
};
