//! Menu nativo, montado com a lista que a interface envia: o registro de comandos fica lá.

use serde::Deserialize;
use tauri::menu::{AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};

/// Id do "Sair" do menu do app no macOS. Ele fecha a janela em vez de encerrar o processo, para
/// a interface perguntar sobre arquivos não salvos (o Sair nativo encerra sem perguntar).
pub const QUIT_ITEM: &str = "darktriad.quit";

/// Item do menu como a interface o descreve (docs/ipc.md).
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MenuEntry {
    Command {
        id: String,
        label: String,
        accelerator: Option<String>,
        role: Option<EditRole>,
    },
    Submenu {
        label: String,
        items: Vec<MenuEntry>,
    },
    Separator,
}

/// Ações de edição que, no macOS, só chegam à webview pelo item nativo: sem ele, ⌘C, ⌘V e
/// companhia não fazem nada fora do que a página trata sozinha.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditRole {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
}

type Item = Box<dyn IsMenuItem<Wry>>;

pub fn build(app: &AppHandle, entries: &[MenuEntry]) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    if cfg!(target_os = "macos") {
        menu.append(&app_menu(app)?)?;
    }
    for entry in entries {
        menu.append(item(app, entry)?.as_ref())?;
    }
    Ok(menu)
}

/// O menu trata `&` como tecla de atalho sublinhada: `&&` mostra o `&` de caminhos como `C:\P&D`.
fn literal(label: &str) -> String {
    label.replace('&', "&&")
}

fn item(app: &AppHandle, entry: &MenuEntry) -> tauri::Result<Item> {
    Ok(match entry {
        MenuEntry::Command {
            id,
            label,
            accelerator,
            role,
        } => command(app, id, &literal(label), accelerator.as_deref(), *role)?,
        MenuEntry::Submenu { label, items } => {
            let submenu = Submenu::new(app, literal(label), true)?;
            for entry in items {
                submenu.append(item(app, entry)?.as_ref())?;
            }
            Box::new(submenu)
        }
        MenuEntry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
    })
}

fn command(
    app: &AppHandle,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
    role: Option<EditRole>,
) -> tauri::Result<Item> {
    if cfg!(target_os = "macos") {
        // A webview recebe a tecla antes do menu: o menu só age se a página não tratar o atalho.
        return Ok(match role {
            Some(role) => Box::new(native(app, role, label)?),
            None => Box::new(MenuItem::with_id(app, id, label, true, accelerator)?),
        });
    }
    // No Windows e no Linux o atalho aparece só como texto. Registrado, ele roubaria a tecla
    // da webview no GTK (Ctrl+C deixaria de copiar) e o despachante da interface deixaria de ser
    // o único a decidir o que cada tecla faz.
    let label = match accelerator {
        Some(accelerator) => format!("{label}\t{accelerator}"),
        None => label.to_owned(),
    };
    Ok(Box::new(MenuItem::with_id(
        app,
        id,
        label,
        true,
        None::<&str>,
    )?))
}

fn native(app: &AppHandle, role: EditRole, label: &str) -> tauri::Result<PredefinedMenuItem<Wry>> {
    let label = Some(label);
    match role {
        EditRole::Undo => PredefinedMenuItem::undo(app, label),
        EditRole::Redo => PredefinedMenuItem::redo(app, label),
        EditRole::Cut => PredefinedMenuItem::cut(app, label),
        EditRole::Copy => PredefinedMenuItem::copy(app, label),
        EditRole::Paste => PredefinedMenuItem::paste(app, label),
        EditRole::SelectAll => PredefinedMenuItem::select_all(app, label),
    }
}

/// O primeiro submenu do macOS, com o nome do app: Sobre (o painel nativo) e Sair (⌘Q).
/// Sem o "Fechar janela" do menu padrão, ⌘W fica livre para "Fechar editor".
fn app_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        ..AboutMetadata::default()
    };
    Submenu::with_items(
        app,
        &info.name,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&format!("Sobre o {}", info.name)), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                QUIT_ITEM,
                format!("Sair do {}", info.name),
                true,
                Some("Cmd+Q"),
            )?,
        ],
    )
}
