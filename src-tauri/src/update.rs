//! Atualização do app pelos releases do GitHub, com o updater oficial do Tauri, que confere a
//! assinatura. O contrato com a interface está em docs/ipc.md.

use std::sync::Mutex;
use std::time::Duration;

use darktriad_core::{Error, ErrorKind};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct UpdateState {
    found: Mutex<Option<Update>>,
    /// Só no Windows: baixada e conferida, esperando o `update_restart` rodar o instalador.
    downloaded: Mutex<Option<(Update, Vec<u8>)>>,
}

#[derive(Debug, Serialize)]
pub struct AvailableUpdate {
    version: String,
    notes: Option<String>,
}

#[derive(Serialize)]
pub struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Procura uma versão mais nova e guarda o que achou para o `update_install`.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<AvailableUpdate>, Error> {
    let handle = app.clone();
    let updater = app
        .updater_builder()
        .configure_client(|client| {
            client
                .connect_timeout(NETWORK_TIMEOUT)
                .read_timeout(NETWORK_TIMEOUT)
        })
        // No Windows o instalador encerra o app sem `RunEvent::Exit`. Este gancho substitui o do
        // plugin, que esconde a janela mesmo se o instalador não abrir.
        .on_before_exit(move || crate::stop_children(&handle))
        .build()
        .map_err(update_error)?;
    let update = updater.check().await.map_err(update_error)?;
    let available = update.as_ref().map(|update| AvailableUpdate {
        version: update.version.clone(),
        notes: update.body.clone(),
    });
    *app.state::<UpdateState>().found.lock().unwrap() = update;
    Ok(available)
}

/// Baixa e instala o que o `update_check` achou. No Windows só baixa e confere: o instalador
/// encerra o app na hora, então ele roda no `update_restart`.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    on_event: Channel<UpdateProgress>,
) -> Result<(), Error> {
    // `tauri dev` no macOS também diz `App`, mas não é um pacote instalado.
    let bundle = bundle_type().filter(|_| !tauri::is_dev());
    if !can_self_update(bundle, std::env::var_os("APPIMAGE").is_some()) {
        return Err(Error::new(
            ErrorKind::Other,
            "Esta cópia do Dark Triad não veio de um instalador oficial e não se atualiza sozinha. \
             Baixe a versão nova em https://github.com/ryan-ggarcia/darcktriad/releases/latest",
        ));
    }
    let state = app.state::<UpdateState>();
    // Sai do estado: um segundo pedido não baixa nem instala em paralelo.
    let update = state.found.lock().unwrap().take().ok_or_else(|| {
        Error::new(
            ErrorKind::NotFound,
            "Não há atualização pendente. Verifique de novo.",
        )
    })?;
    let mut downloaded = 0;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                // Só falha com a interface já fechada, quando não há mais quem avisar.
                let _ = on_event.send(UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(update_error)?;
    if cfg!(windows) {
        *state.downloaded.lock().unwrap() = Some((update, bytes));
        return Ok(());
    }
    // Escreve no disco e, no .deb e no .rpm, espera o usuário digitar a senha.
    crate::blocking(move || update.install(bytes).map_err(update_error)).await
}

/// Reinicia o app. No Windows, antes roda o instalador baixado, que encerra o app e o abre de novo.
#[tauri::command]
pub async fn update_restart(app: AppHandle) -> Result<(), Error> {
    let downloaded = app.state::<UpdateState>().downloaded.lock().unwrap().take();
    if let Some((update, bytes)) = downloaded {
        return crate::blocking(move || update.install(bytes).map_err(update_error)).await;
    }
    // Passa pelo `RunEvent::Exit`, que encerra os processos filhos.
    app.request_restart();
    Ok(())
}

/// O plugin trata qualquer cópia desconhecida do Linux como AppImage e grava o pacote por cima do
/// executável atual. O AppImage extraído diz `AppImage`, mas roda sem a variável `APPIMAGE`.
fn can_self_update(bundle: Option<BundleType>, running_as_appimage: bool) -> bool {
    match bundle {
        Some(BundleType::AppImage) => running_as_appimage,
        Some(_) => true,
        None => false,
    }
}

fn update_error(error: tauri_plugin_updater::Error) -> Error {
    use tauri_plugin_updater::Error as Updater;
    let message = match &error {
        Updater::Reqwest(_) | Updater::Network(_) => {
            "Não foi possível falar com o GitHub. Confira a conexão e tente de novo.".to_string()
        }
        Updater::ReleaseNotFound => {
            "Não foi possível ler os dados de atualização no GitHub.".to_string()
        }
        Updater::TargetNotFound(_) | Updater::TargetsNotFound(_) => {
            "A versão nova não tem instalador para este sistema.".to_string()
        }
        Updater::Minisign(_)
        | Updater::Base64(_)
        | Updater::SignatureUtf8(_)
        | Updater::SignedVersionMismatch { .. }
        | Updater::MissingSignedVersion => {
            "A assinatura da atualização não confere. Nada foi instalado.".to_string()
        }
        Updater::AuthenticationFailed
        | Updater::DebInstallFailed
        | Updater::PackageInstallFailed => {
            "A instalação do pacote foi cancelada ou falhou. Nada foi atualizado.".to_string()
        }
        other => format!("Não foi possível atualizar: {other}"),
    };
    Error::new(ErrorKind::Other, message)
}

#[cfg(test)]
mod tests {
    use tauri_plugin_updater::Error as Updater;

    use super::*;

    #[test]
    fn only_official_installers_update_themselves() {
        for bundle in [
            BundleType::Deb,
            BundleType::Rpm,
            BundleType::Msi,
            BundleType::Nsis,
            BundleType::App,
        ] {
            assert!(can_self_update(Some(bundle), false));
        }
        assert!(can_self_update(Some(BundleType::AppImage), true));
        assert!(!can_self_update(Some(BundleType::AppImage), false));
        assert!(!can_self_update(None, false));
        assert!(!can_self_update(None, true));
    }

    #[test]
    fn a_signature_problem_says_nothing_was_installed() {
        let error = update_error(Updater::SignedVersionMismatch {
            signed: "1.0.0".into(),
            announced: "2.0.0".into(),
        });
        assert_eq!(
            error.message,
            "A assinatura da atualização não confere. Nada foi instalado."
        );
    }
}
