use std::io;

use serde::Serialize;

/// Categoria do erro, para a interface decidir o que mostrar ou perguntar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    NotFound,
    AlreadyExists,
    PermissionDenied,
    InvalidInput,
    /// O arquivo mudou no disco depois da última leitura.
    Conflict,
    /// O editor não grava por cima deste arquivo (binário, grande demais ou codificação não suportada).
    ReadOnly,
    /// A lixeira do sistema recusou o item; a interface pode oferecer a exclusão permanente.
    TrashFailed,
    Other,
}

/// Erro devolvido pelos casos de uso e, sem conversão, pelos comandos Tauri.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        let kind = match error.kind() {
            io::ErrorKind::NotFound => ErrorKind::NotFound,
            io::ErrorKind::AlreadyExists => ErrorKind::AlreadyExists,
            io::ErrorKind::PermissionDenied => ErrorKind::PermissionDenied,
            io::ErrorKind::InvalidInput | io::ErrorKind::InvalidFilename => ErrorKind::InvalidInput,
            _ => ErrorKind::Other,
        };
        Self::new(kind, error.to_string())
    }
}
