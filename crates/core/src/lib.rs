//! Domínio, casos de uso e portas do Dark Triad.
//! Este crate não conhece nenhuma implementação concreta: tudo entra por trait.

mod configure;
mod editor;
mod error;
mod explorer;
mod file_index;
mod input;
mod language;
mod ports;
mod project;
mod terminal;
mod tools;
mod workspace;

pub use configure::{BuildStatus, Problem, Project, ProjectEvent, ProjectState, ProjectStatus};
pub use editor::{Editor, Eol, FileContent};
pub use error::{Error, ErrorKind, Result};
pub use explorer::{Entry, Explorer, is_hidden};
pub use file_index::{FileIndex, IndexJob, ProjectFiles};
pub use input::{validate_name, validate_path};
pub use language::{Language, LanguageEvent, LanguageServers, ServerState};
pub use ports::{
    EntryWriter, FileApi, FileStat, FileStore, FileSystem, FolderWatcher, ProcessRunner,
    ProjectWalker, PtySpawner, ServerProcess, ServerSpawner, SpawnedServer, SpawnedTerminal,
    StateStore, TerminalProcess, TerminalSize, ToolProbe, Trash,
};
pub use project::{
    BUILD_FAILED, BuildConfig, BuildProblem, CMakeProblem, CMakeTarget, DetectedProject,
    DotnetProperties, ProjectKind, RunCommand, Severity, build_problems, cmake_build_args,
    cmake_build_dir, cmake_configure_args, cmake_preset_args, detect_project, dotnet_build_args,
    dotnet_property_args, dotnet_run_args, file_api_executables, file_api_query, parse_build_dir,
    parse_build_line, parse_cmake_error, parse_dotnet_properties, parse_msbuild_error,
    parse_preset_names, parse_solution_projects,
};
pub use terminal::{Platform, TerminalEvent, TerminalInfo, Terminals, default_shell, shell_name};
pub use tools::{TOOLS, Tool, ToolCheck, ToolStatus, check_tools};
pub use workspace::{
    AppState, ChangeBatch, OpenedFolder, ProjectChoice, RecentFolder, RecentFolderView, Session,
    Workspace,
};
