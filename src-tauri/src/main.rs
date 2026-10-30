// Esconde o console extra no Windows em builds de release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Ponto de montagem: cria os adaptadores, injeta nos casos de uso e expõe comandos ao frontend.

use std::path::PathBuf;

use darktriad_core::{Entry, Explorer};
use darktriad_infra::LocalFileSystem;
use tauri::State;

// `async` faz o Tauri rodar o comando fora da thread de UI.
#[tauri::command]
async fn list_dir(
    path: PathBuf,
    explorer: State<'_, Explorer<LocalFileSystem>>,
) -> Result<Vec<Entry>, String> {
    explorer.list(&path).map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(Explorer::new(LocalFileSystem))
        .invoke_handler(tauri::generate_handler![list_dir])
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o Dark Triad");
}
