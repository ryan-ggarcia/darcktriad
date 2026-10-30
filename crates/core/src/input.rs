//! Validação do que chega da interface: a webview é a fronteira de confiança.

use std::path::{Component, Path};

use crate::{Error, ErrorKind, Result};

/// Todo caminho vindo da interface é absoluto e não tem `..`.
pub fn validate_path(path: &Path) -> Result<()> {
    if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            format!("Caminho inválido: {}", path.display()),
        ));
    }
    Ok(())
}

/// Nome de arquivo ou pasta digitado pelo usuário: um único item, não vazio.
pub fn validate_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "O nome não pode ser vazio nem conter / ou \\",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_path_accepts_only_absolute_paths_without_parent_components() {
        let base = std::env::temp_dir();

        assert!(validate_path(&base.join("app").join("main.cpp")).is_ok());
        assert!(validate_path(Path::new("app/main.cpp")).is_err());
        assert!(validate_path(Path::new("")).is_err());
        assert!(validate_path(&base.join("..").join("segredo")).is_err());
    }

    #[test]
    fn validate_name_rejects_empty_separators_and_dot_names() {
        for name in ["", "   ", "a/b", "a\\b", ".", ".."] {
            let error = validate_name(name).unwrap_err();
            assert_eq!(error.kind, ErrorKind::InvalidInput, "{name:?}");
        }
        assert!(validate_name("util.cpp").is_ok());
        assert!(validate_name(".gitignore").is_ok());
    }
}
