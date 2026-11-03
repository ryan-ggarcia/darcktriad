// Esconde o console extra no Windows em builds de release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Ponto de montagem: cria os adaptadores, injeta nos casos de uso e expõe comandos ao frontend.
//! O contrato com a interface está em docs/ipc.md.

mod menu;
mod update;

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, mpsc};
use std::thread;

use darktriad_core::{
    Breakpoint, DebugEvent, DebugLaunch, DebugSessions, Editor, Entry, Eol, Error, ErrorKind,
    Explorer, FileContent, FileIndex, Language, LanguageEvent, LanguageServers, OpenedFolder,
    Project, ProjectEvent, ProjectFiles, ProjectState, RecentFolderView, Session, TerminalEvent,
    TerminalInfo, TerminalSize, Terminals, ToolCheck, Workspace, check_tools, validate_name,
    validate_path,
};
use darktriad_infra::{
    IgnoreWalker, JsonStateStore, LocalFileApi, LocalFileSystem, NotifyWatcher, PortablePty,
    StdProcessRunner, StdServerSpawner, SystemToolProbe, detect_default_shell,
};
use menu::MenuEntry;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Window, Wry};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};

type AppExplorer = Explorer<LocalFileSystem>;
type AppEditor = Editor<LocalFileSystem>;
type AppWorkspace = Workspace<LocalFileSystem, NotifyWatcher, JsonStateStore>;
type AppIndex = FileIndex<IgnoreWalker>;
type AppTerminals = Arc<Terminals<PortablePty>>;
type AppProject = Arc<Project<LocalFileSystem, StdProcessRunner, LocalFileApi, SystemToolProbe>>;
type AppLanguages = Arc<LanguageServers<StdServerSpawner, SystemToolProbe>>;
type AppDebug = Arc<DebugSessions<StdServerSpawner, SystemToolProbe, PortablePty>>;

const MAIN_WINDOW: &str = "main";
/// Evento com as mudanças no disco dentro da pasta aberta.
const FS_CHANGED: &str = "fs-changed";
/// Evento sem dados: a lista do Abrir rápido mudou (`project_files` devolve a nova).
const PROJECT_FILES_CHANGED: &str = "project-files-changed";
/// Evento com o id do comando escolhido no menu nativo.
const MENU_COMMAND: &str = "menu-command";
/// Evento do projeto: uma linha do canal CMake ou o estado novo.
const PROJECT_EVENT: &str = "project-event";

/// Entrega a `apply`, numa thread só e na ordem, o que for enviado. Se vários chegam enquanto
/// `apply` trabalha, só o último é aplicado.
fn latest_in_order<T: Send + 'static>(apply: impl Fn(T) + Send + 'static) -> mpsc::Sender<T> {
    let (sender, received) = mpsc::channel();
    thread::spawn(move || {
        while let Ok(first) = received.recv() {
            apply(received.try_iter().last().unwrap_or(first));
        }
    });
    sender
}

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
    let (opened, job, choice) = blocking(move || {
        // Os servidores de linguagem e a depuração eram da pasta anterior.
        worker.state::<AppLanguages>().stop_all();
        worker.state::<AppDebug>().stop();
        let workspace = worker.state::<AppWorkspace>();
        let opened = workspace.open(&path)?;
        let job = worker.state::<AppIndex>().start(&path);
        Ok((opened, job, workspace.project_choice()))
    })
    .await?;
    // A pasta abre sem esperar o índice nem o CMake: os dois avisam quando terminam.
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || worker.state::<AppIndex>().run(job));
    let root = opened.path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Outra pasta pode ter sido aberta enquanto esta thread esperava a vez.
        if app
            .state::<AppWorkspace>()
            .root()
            .is_ok_and(|open| open == root)
        {
            app.state::<AppProject>().open(&root, choice);
        }
    });
    Ok(opened)
}

#[tauri::command]
async fn close_folder(app: AppHandle) -> Result<(), Error> {
    blocking(move || {
        app.state::<AppWorkspace>().close();
        app.state::<AppIndex>().clear();
        app.state::<AppProject>().close();
        app.state::<AppLanguages>().stop_all();
        app.state::<AppDebug>().stop();
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

#[tauri::command]
async fn save_breakpoints(app: AppHandle, breakpoints: Vec<Breakpoint>) -> Result<(), Error> {
    for breakpoint in &breakpoints {
        validate_path(&breakpoint.file)?;
        if breakpoint.line == 0 {
            return Err(Error::new(
                ErrorKind::InvalidInput,
                "As linhas começam em 1",
            ));
        }
    }
    blocking(move || app.state::<AppWorkspace>().save_breakpoints(breakpoints)).await
}

#[tauri::command]
async fn project_state(app: AppHandle) -> Result<ProjectState, Error> {
    blocking(move || Ok(app.state::<AppProject>().state())).await
}

/// Troca a configuração, guarda a escolha da pasta e configura. Responde quando a configuração
/// termina; o resultado chega pelo estado.
#[tauri::command]
async fn project_select_config(app: AppHandle, config: String) -> Result<(), Error> {
    blocking(move || {
        let project = app.state::<AppProject>();
        project.select_config(&config)?;
        save_project_choice(&app)?;
        project.configure()
    })
    .await
}

#[tauri::command]
async fn project_select_target(app: AppHandle, target: String) -> Result<(), Error> {
    blocking(move || {
        app.state::<AppProject>().select_target(&target)?;
        save_project_choice(&app)
    })
    .await
}

#[tauri::command]
async fn project_reconfigure(app: AppHandle) -> Result<(), Error> {
    blocking(move || app.state::<AppProject>().configure()).await
}

/// Compila todos os alvos (configura antes, se preciso). Responde quando termina; a saída e o
/// resultado chegam por `project-event`.
#[tauri::command]
async fn project_build(app: AppHandle) -> Result<(), Error> {
    blocking(move || app.state::<AppProject>().build()).await
}

#[tauri::command]
async fn project_build_cancel(app: AppHandle) {
    app.state::<AppProject>().cancel_build();
}

/// Compila o alvo ativo e o roda num terminal novo. `None` se a compilação não deu certo.
#[tauri::command]
async fn project_run(
    app: AppHandle,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<Option<TerminalInfo>, Error> {
    blocking(move || {
        let Some(command) = app.state::<AppProject>().build_for_run()? else {
            return Ok(None);
        };
        let size = TerminalSize { cols, rows };
        app.state::<AppTerminals>()
            .run(
                command.name,
                &command.program,
                &command.args,
                &command.cwd,
                size,
                move |event| {
                    // Só falha com a interface já fechada, quando não há mais quem avisar.
                    let _ = on_event.send(event);
                },
            )
            .map(Some)
    })
    .await
}

fn save_project_choice(app: &AppHandle) -> Result<(), Error> {
    let choice = app.state::<AppProject>().choice();
    app.state::<AppWorkspace>().save_project_choice(choice)
}

#[tauri::command]
async fn tools_check(app: AppHandle) -> Result<Vec<ToolCheck>, Error> {
    blocking(move || Ok(check_tools(&tool_probe(&app)?))).await
}

/// Lê o `PATH` a cada chamada: "Verificar de novo" acha o que foi instalado com a IDE aberta só
/// se o PATH da IDE já o incluía.
fn tool_probe(app: &AppHandle) -> Result<SystemToolProbe, Error> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| Error::new(ErrorKind::NotFound, error.to_string()))?;
    Ok(SystemToolProbe::new(data.join("tools")))
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

/// Inicia o servidor da linguagem (`cpp` ou `csharp`) para o projeto aberto, no lugar do que já
/// estivesse rodando. Estado, mensagens do LSP e log chegam por `on_event`.
#[tauri::command]
async fn language_start(
    app: AppHandle,
    language: Language,
    on_event: Channel<LanguageEvent>,
) -> Result<(), Error> {
    blocking(move || {
        let project = app.state::<AppProject>().state();
        app.state::<AppLanguages>()
            .start(language, &project, move |event| {
                // Só falha com a interface já fechada, quando não há mais quem avisar.
                let _ = on_event.send(event);
            })
    })
    .await
}

// Síncrono de propósito, como o `terminal_write`: as mensagens chegam ao servidor na ordem em que
// foram enviadas, e o comando só põe a mensagem na fila.
#[tauri::command]
fn language_send(app: AppHandle, language: Language, message: String) -> Result<(), Error> {
    app.state::<AppLanguages>().send(language, &message)
}

#[tauri::command]
async fn language_restart(app: AppHandle, language: Language) -> Result<(), Error> {
    blocking(move || app.state::<AppLanguages>().restart(language)).await
}

#[tauri::command]
async fn language_stop(app: AppHandle, language: Language) -> Result<(), Error> {
    blocking(move || app.state::<AppLanguages>().stop(language)).await
}

/// Compila o alvo ativo e inicia o depurador dele. `None` se a compilação não deu certo. As
/// mensagens do DAP, o log e o fim chegam por `on_event`.
#[tauri::command]
async fn debug_start(
    app: AppHandle,
    on_event: Channel<DebugEvent>,
) -> Result<Option<DebugLaunch>, Error> {
    blocking(move || {
        let Some(command) = app.state::<AppProject>().build_for_run()? else {
            return Ok(None);
        };
        app.state::<AppDebug>()
            .start(&command.target, &command.cwd, move |event| {
                // Só falha com a interface já fechada, quando não há mais quem avisar.
                let _ = on_event.send(event);
            })
            .map(Some)
    })
    .await
}

// Síncrono de propósito, como o `language_send`.
#[tauri::command]
fn debug_send(app: AppHandle, message: String) -> Result<(), Error> {
    app.state::<AppDebug>().send(&message)
}

/// O pedido reverso `runInTerminal` do adaptador: roda `args` no terminal `🐞 <alvo>`.
#[tauri::command]
async fn debug_run_in_terminal(
    app: AppHandle,
    args: Vec<String>,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<TerminalInfo, Error> {
    validate_path(&cwd)?;
    blocking(move || {
        let args: Vec<OsString> = args.into_iter().map(OsString::from).collect();
        app.state::<AppDebug>().run_in_terminal(
            &args,
            &cwd,
            TerminalSize { cols, rows },
            move |event| {
                let _ = on_event.send(event);
            },
        )
    })
    .await
}

#[tauri::command]
async fn debug_stop(app: AppHandle) -> Result<(), Error> {
    blocking(move || {
        app.state::<AppDebug>().stop();
        Ok(())
    })
    .await
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

/// Nenhum shell (nem o que roda nele), programa, compilação ou servidor de linguagem sobrevive à
/// IDE.
fn stop_children(app: &AppHandle) {
    app.state::<AppDebug>().stop();
    app.state::<AppTerminals>().close_all();
    app.state::<AppProject>().close();
    app.state::<AppLanguages>().stop_all();
}

fn main() {
    // Antes de tudo: o resto do app (processos, terminal, busca de ferramentas) herda este PATH.
    #[cfg(target_os = "macos")]
    darktriad_infra::use_login_shell_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Explorer::new(LocalFileSystem))
        .manage(Editor::new(LocalFileSystem))
        .manage(update::UpdateState::default())
        .on_menu_event(|app, event| on_menu_command(app, event.id().as_ref()))
        .setup(|app| {
            let tools_dir = app.path().app_data_dir()?.join("tools");
            let terminals = Arc::new(Terminals::new(PortablePty, detect_default_shell()));
            app.manage::<AppTerminals>(Arc::clone(&terminals));
            // Sem a pasta no cache, os temporários vão para a do sistema, como antes.
            let servers_temp = app.path().app_cache_dir()?.join("servers");
            let app_temp_spawner =
                || StdServerSpawner::with_temp_dir(servers_temp.clone()).unwrap_or_default();
            app.manage::<AppDebug>(Arc::new(DebugSessions::new(
                StdServerSpawner::default(),
                app_temp_spawner(),
                SystemToolProbe::new(tools_dir.clone()),
                terminals,
            )));
            app.manage::<AppLanguages>(Arc::new(LanguageServers::new(
                app_temp_spawner(),
                SystemToolProbe::new(tools_dir.clone()),
            )));
            let handle = app.handle().clone();
            app.manage(FileIndex::new(IgnoreWalker, move || {
                let _ = handle.emit(PROJECT_FILES_CHANGED, ());
            }));
            let handle = app.handle().clone();
            // O clangd segue a pasta de build ativa, fora do lock do projeto e na ordem dos estados:
            // trocar Debug/Release duas vezes rápido termina na última escolha.
            let follow = latest_in_order(move |state: ProjectState| {
                handle.state::<AppLanguages>().project_changed(&state);
            });
            let handle = app.handle().clone();
            let project = Project::new(
                LocalFileSystem,
                StdProcessRunner,
                LocalFileApi,
                SystemToolProbe::new(tools_dir),
                move |event| {
                    if let ProjectEvent::State { state } = &event {
                        // Só falha com o app fechando.
                        let _ = follow.send(state.clone());
                    }
                    let _ = handle.emit(PROJECT_EVENT, &event);
                },
            );
            app.manage::<AppProject>(Arc::new(project));
            let handle = app.handle().clone();
            let watcher = NotifyWatcher::new(move |batch| {
                // Só falha com o app fechando, quando não há mais quem avisar.
                let _ = handle.emit(FS_CHANGED, &batch);
                let handle = handle.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    handle.state::<AppProject>().files_changed(&batch.paths);
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
            save_breakpoints,
            project_files,
            set_menu,
            terminal_create,
            terminal_write,
            terminal_resize,
            terminal_close,
            project_state,
            project_select_config,
            project_select_target,
            project_reconfigure,
            project_build,
            project_build_cancel,
            project_run,
            tools_check,
            language_start,
            language_send,
            language_restart,
            language_stop,
            debug_start,
            debug_send,
            debug_run_in_terminal,
            debug_stop,
            pick_folder,
            pick_file,
            pick_save_path,
            update::update_check,
            update::update_install,
            update::update_restart,
        ])
        .build(tauri::generate_context!())
        .expect("falha ao iniciar o Dark Triad")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_children(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn latest_in_order_applies_in_order_and_ends_with_the_last() {
        let applied = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&applied);
        let send = latest_in_order(move |value: u32| {
            thread::sleep(Duration::from_millis(1));
            sink.lock().unwrap().push(value);
        });
        for value in 0..200 {
            send.send(value).unwrap();
        }
        let start = Instant::now();
        while applied.lock().unwrap().last() != Some(&199) {
            assert!(start.elapsed() < Duration::from_secs(5), "{applied:?}");
            thread::sleep(Duration::from_millis(5));
        }
        let applied = applied.lock().unwrap();
        assert!(applied.is_sorted(), "{applied:?}");
    }
}
