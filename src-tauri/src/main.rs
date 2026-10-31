// Esconde o console extra no Windows em builds de release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Ponto de montagem: cria os adaptadores, injeta nos casos de uso e expõe comandos ao frontend.
//! O contrato com a interface está em docs/ipc.md.

mod menu;

use std::path::PathBuf;

use darktriad_core::{
    Editor, Entry, Eol, Error, ErrorKind, Explorer, FileContent, FileIndex, OpenedFolder,
    ProjectFiles, RecentFolderView, Session, TerminalEvent, TerminalInfo, TerminalSize, Terminals,
    Workspace, validate_name, validate_path,
};
use darktriad_infra::{
    IgnoreWalker, JsonStateStore, LocalFileSystem, NotifyWatcher, PortablePty, detect_default_shell,
};
use menu::MenuEntry;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Window, Wry};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};

type AppExplorer = Explorer<LocalFileSystem>;
type AppEditor = Editor<LocalFileSystem>;
type AppWorkspace = Workspace<LocalFileSystem, NotifyWatcher, JsonStateStore>;
type AppIndex = FileIndex<IgnoreWalker>;
type AppTerminals = Terminals<PortablePty>;

const MAIN_WINDOW: &str = "main";
/// Evento com as mudanças no disco dentro da pasta aberta.
const FS_CHANGED: &str = "fs-changed";
/// Evento sem dados: a lista do Abrir rápido mudou (`project_files` devolve a nova).
const PROJECT_FILES_CHANGED: &str = "project-files-changed";
/// Evento com o id do comando escolhido no menu nativo.
const MENU_COMMAND: &str = "menu-command";

/// Roda `job` numa thread de I/O: nem a thread de UI nem o runtime assíncrono esperam o disco.
async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|error| Error::new(ErrorKind::Other, error.to_string()))?
}

#[tauri::command]
async fn list_dir(app: AppHandle, path: PathBuf) -> Result<Vec<Entry>, Error> {
    validate_path(&path)?;
    blocking(move || app.state::<AppExplorer>().list(&path)).await
}

#[tauri::command]
async fn create_file(app: AppHandle, parent: PathBuf, name: String) -> Result<PathBuf, Error> {
    validate_path(&parent)?;
    blocking(move || {
        let root = app.state::<AppWorkspace>().root()?;
        app.state::<AppExplorer>()
            .create_file(&root, &parent, &name)
    })
    .await
}

#[tauri::command]
async fn create_dir(app: AppHandle, parent: PathBuf, name: String) -> Result<PathBuf, Error> {
    validate_path(&parent)?;
    blocking(move || {
        let root = app.state::<AppWorkspace>().root()?;
        app.state::<AppExplorer>().create_dir(&root, &parent, &name)
    })
    .await
}

#[tauri::command]
async fn rename_entry(app: AppHandle, path: PathBuf, new_name: String) -> Result<PathBuf, Error> {
    validate_path(&path)?;
    blocking(move || {
        let root = app.state::<AppWorkspace>().root()?;
        app.state::<AppExplorer>().rename(&root, &path, &new_name)
    })
    .await
}

#[tauri::command]
async fn move_to_trash(app: AppHandle, path: PathBuf) -> Result<(), Error> {
    validate_path(&path)?;
    blocking(move || {
        let root = app.state::<AppWorkspace>().root()?;
        app.state::<AppExplorer>().move_to_trash(&root, &path)
    })
    .await
}

#[tauri::command]
async fn delete_permanently(app: AppHandle, path: PathBuf) -> Result<(), Error> {
    validate_path(&path)?;
    blocking(move || {
        let root = app.state::<AppWorkspace>().root()?;
        app.state::<AppExplorer>().delete_permanently(&root, &path)
    })
    .await
}

#[tauri::command]
async fn read_file(app: AppHandle, path: PathBuf) -> Result<FileContent, Error> {
    validate_path(&path)?;
    blocking(move || app.state::<AppEditor>().read(&path)).await
}

#[tauri::command]
async fn save_file(
    app: AppHandle,
    path: PathBuf,
    content: String,
    eol: Eol,
    bom: bool,
    expected_version: Option<String>,
) -> Result<String, Error> {
    validate_path(&path)?;
    blocking(move || {
        app.state::<AppEditor>()
            .save(&path, &content, eol, bom, expected_version.as_deref())
    })
    .await
}

#[tauri::command]
async fn default_eol() -> Eol {
    Eol::system_default()
}

#[tauri::command]
async fn open_folder(app: AppHandle, path: PathBuf) -> Result<OpenedFolder, Error> {
    validate_path(&path)?;
    let worker = app.clone();
    let (opened, job) = blocking(move || {
        let opened = worker.state::<AppWorkspace>().open(&path)?;
        Ok((opened, worker.state::<AppIndex>().start(&path)))
    })
    .await?;
    // A pasta abre sem esperar o índice; o Abrir rápido mostra "Indexando…" até ele terminar.
    tauri::async_runtime::spawn_blocking(move || app.state::<AppIndex>().run(job));
    Ok(opened)
}

#[tauri::command]
async fn close_folder(app: AppHandle) -> Result<(), Error> {
    blocking(move || {
        app.state::<AppWorkspace>().close();
        app.state::<AppIndex>().clear();
        Ok(())
    })
    .await
}

#[tauri::command]
async fn project_files(app: AppHandle) -> Result<ProjectFiles, Error> {
    blocking(move || Ok(app.state::<AppIndex>().snapshot())).await
}

#[tauri::command]
async fn set_menu(app: AppHandle, items: Vec<MenuEntry>) -> Result<(), Error> {
    blocking(move || {
        let menu = menu::build(&app, &items).map_err(menu_error)?;
        app.set_menu(menu).map_err(menu_error)?;
        Ok(())
    })
    .await
}

/// Atalho que o macOS não entende é o motivo provável; o resto é falha da plataforma.
fn menu_error(error: tauri::Error) -> Error {
    let kind = match error {
        tauri::Error::Menu(_) => ErrorKind::InvalidInput,
        _ => ErrorKind::Other,
    };
    Error::new(kind, format!("Não foi possível montar o menu: {error}"))
}

#[tauri::command]
async fn recent_folders(app: AppHandle) -> Result<Vec<RecentFolderView>, Error> {
    blocking(move || Ok(app.state::<AppWorkspace>().recent_folders())).await
}

#[tauri::command]
async fn remove_recent_folder(app: AppHandle, path: PathBuf) -> Result<(), Error> {
    validate_path(&path)?;
    blocking(move || app.state::<AppWorkspace>().remove_recent_folder(&path)).await
}

#[tauri::command]
async fn save_session(app: AppHandle, session: Session) -> Result<(), Error> {
    for path in session.open_files.iter().chain(&session.active_file) {
        validate_path(path)?;
    }
    blocking(move || app.state::<AppWorkspace>().save_session(session)).await
}

/// Abre um shell na raiz do projeto (ou na pasta do usuário, sem projeto). A saída e o fim do
/// shell chegam por `on_event`.
#[tauri::command]
async fn terminal_create(
    app: AppHandle,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<TerminalInfo, Error> {
    blocking(move || {
        let cwd = match app.state::<AppWorkspace>().root() {
            Ok(root) => root,
            Err(_) => app
                .path()
                .home_dir()
                .map_err(|error| Error::new(ErrorKind::NotFound, error.to_string()))?,
        };
        app.state::<AppTerminals>()
            .create(&cwd, TerminalSize { cols, rows }, move |event| {
                // Só falha com a interface já fechada, quando não há mais quem avisar.
                let _ = on_event.send(event);
            })
    })
    .await
}

// Síncronos de propósito: rodam na thread principal, na ordem em que chegam, e só põem o pedido
// na fila do terminal, sem esperar o processo.
#[tauri::command]
fn terminal_write(app: AppHandle, id: u32, data: String) -> Result<(), Error> {
    app.state::<AppTerminals>().write(id, &data)
}

#[tauri::command]
fn terminal_resize(app: AppHandle, id: u32, cols: u16, rows: u16) -> Result<(), Error> {
    app.state::<AppTerminals>()
        .resize(id, TerminalSize { cols, rows })
}

#[tauri::command]
async fn terminal_close(app: AppHandle, id: u32) -> Result<(), Error> {
    blocking(move || app.state::<AppTerminals>().close(id)).await
}

#[tauri::command]
async fn pick_folder(window: Window) -> Result<Option<PathBuf>, Error> {
    pick(window, |dialog| dialog.blocking_pick_folder()).await
}

#[tauri::command]
async fn pick_file(window: Window) -> Result<Option<PathBuf>, Error> {
    pick(window, |dialog| dialog.blocking_pick_file()).await
}

#[tauri::command]
async fn pick_save_path(
    window: Window,
    directory: Option<PathBuf>,
    file_name: Option<String>,
) -> Result<Option<PathBuf>, Error> {
    if let Some(directory) = &directory {
        validate_path(directory)?;
    }
    if let Some(file_name) = &file_name {
        validate_name(file_name)?;
    }
    pick(window, move |mut dialog| {
        if let Some(directory) = directory {
            dialog = dialog.set_directory(directory);
        }
        if let Some(file_name) = file_name {
            dialog = dialog.set_file_name(file_name);
        }
        dialog.blocking_save_file()
    })
    .await
}

/// Mostra um diálogo nativo e devolve o caminho escolhido, ou `None` se o usuário cancelou.
async fn pick(
    window: Window,
    show: impl FnOnce(FileDialogBuilder<Wry>) -> Option<FilePath> + Send + 'static,
) -> Result<Option<PathBuf>, Error> {
    blocking(move || {
        let dialog = window.dialog().file();
        // Mesma regra do plugin: no Linux (GTK) o diálogo não aceita janela pai.
        #[cfg(any(windows, target_os = "macos"))]
        let dialog = dialog.set_parent(&window);
        Ok(show(dialog).and_then(|path| path.into_path().ok()))
    })
    .await
}

/// Desliga os atalhos de navegador do WebView2 (F5, Ctrl+R, Ctrl+P, Ctrl+F, Ctrl+J…). As teclas
/// continuam chegando à página, e os atalhos de edição (Ctrl+C/V/X/Z) continuam valendo.
#[cfg(windows)]
fn disable_browser_shortcuts(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    window.with_webview(|webview| {
        // Só falha num runtime do WebView2 anterior a 2021; aí os atalhos de navegador ficam.
        let _ = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.Settings())
                .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
                .and_then(|settings| settings.SetAreBrowserAcceleratorKeysEnabled(false))
        };
    })
}

fn on_menu_command(app: &AppHandle, id: &str) {
    if id == menu::QUIT_ITEM {
        // Fechar a janela passa pelo `onCloseRequested` da interface, que pergunta o que salvar.
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let _ = window.close();
        }
        return;
    }
    let _ = app.emit(MENU_COMMAND, id);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Explorer::new(LocalFileSystem))
        .manage(Editor::new(LocalFileSystem))
        .manage(Terminals::new(PortablePty, detect_default_shell()))
        .on_menu_event(|app, event| on_menu_command(app, event.id().as_ref()))
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(FileIndex::new(IgnoreWalker, move || {
                let _ = handle.emit(PROJECT_FILES_CHANGED, ());
            }));
            let handle = app.handle().clone();
            let watcher = NotifyWatcher::new(move |batch| {
                // Só falha com o app fechando, quando não há mais quem avisar.
                let _ = handle.emit(FS_CHANGED, &batch);
                let handle = handle.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    handle.state::<AppIndex>().update(&batch);
                });
            });
            let store = JsonStateStore::new(app.path().app_data_dir()?.join("state.json"));
            app.manage(Workspace::new(LocalFileSystem, watcher, store));
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                disable_browser_shortcuts(&window)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            create_file,
            create_dir,
            rename_entry,
            move_to_trash,
            delete_permanently,
            read_file,
            save_file,
            default_eol,
            open_folder,
            close_folder,
            recent_folders,
            remove_recent_folder,
            save_session,
            project_files,
            set_menu,
            terminal_create,
            terminal_write,
            terminal_resize,
            terminal_close,
            pick_folder,
            pick_file,
            pick_save_path,
        ])
        .build(tauri::generate_context!())
        .expect("falha ao iniciar o Dark Triad")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Nenhum shell (nem o que roda nele) sobrevive à IDE.
                app.state::<AppTerminals>().close_all();
            }
        });
}
