use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::{Error, ErrorKind, FileStore, Result};

/// Acima deste tamanho o editor não carrega o arquivo.
pub const MAX_EDITABLE_SIZE: u64 = 50 * 1024 * 1024;
/// Um byte NUL neste começo do arquivo o classifica como binário.
const BINARY_SNIFF_LEN: usize = 8 * 1024;
const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
}

impl Eol {
    /// Padrão para arquivo novo: CRLF no Windows, LF no macOS e no Linux.
    pub fn system_default() -> Self {
        if cfg!(windows) { Self::Crlf } else { Self::Lf }
    }

    /// O fim de linha mais usado no texto; sem nenhuma quebra de linha, o padrão do sistema.
    fn detect(text: &str) -> Self {
        let crlf = text.matches("\r\n").count();
        let lf = text.matches('\n').count() - crlf;
        match (crlf, lf) {
            (0, 0) => Self::system_default(),
            _ if crlf > lf => Self::Crlf,
            _ => Self::Lf,
        }
    }

    fn apply(self, text: &str) -> String {
        let lf = text.replace("\r\n", "\n");
        match self {
            Self::Lf => lf,
            Self::Crlf => lf.replace('\n', "\r\n"),
        }
    }
}

/// O que o editor recebe ao abrir um arquivo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FileContent {
    /// Texto sem o BOM. Se não for UTF-8 válido, vem `read_only` e com caracteres de substituição.
    Text {
        content: String,
        eol: Eol,
        bom: bool,
        read_only: bool,
        version: String,
    },
    Binary,
    TooLarge {
        size: u64,
    },
}

/// Caso de uso: abrir e salvar arquivos do editor.
pub struct Editor<S> {
    store: S,
    temp_files: AtomicU64,
}

impl<S: FileStore> Editor<S> {
    pub fn new(store: S) -> Self {
        Self {
            store,
            temp_files: AtomicU64::new(0),
        }
    }

    pub fn read(&self, path: &Path) -> Result<FileContent> {
        let stat = self.store.stat(path)?.ok_or_else(|| not_found(path))?;
        if stat.size > MAX_EDITABLE_SIZE {
            return Ok(FileContent::TooLarge { size: stat.size });
        }
        Ok(decode(self.store.read(path)?, stat.version))
    }

    /// Grava num temporário da mesma pasta e renomeia por cima; devolve a nova versão.
    /// `expected_version` é a versão da última leitura; `None` grava sem conferir.
    /// Arquivo que sumiu do disco é recriado.
    pub fn save(
        &self,
        path: &Path,
        text: &str,
        eol: Eol,
        bom: bool,
        expected_version: Option<&str>,
    ) -> Result<String> {
        if let Some(current) = self.store.stat(path)? {
            if expected_version.is_some_and(|expected| expected != current.version) {
                return Err(Error::new(
                    ErrorKind::Conflict,
                    "O arquivo mudou no disco depois da última leitura",
                ));
            }
            self.ensure_editable(path, current.size)?;
        }

        let temp = self.temp_path(path)?;
        let written = self
            .store
            .write(&temp, &encode(text, eol, bom))
            .and_then(|()| self.store.replace(&temp, path));
        if let Err(error) = written {
            // O original não foi tocado; falta só apagar o temporário.
            let _ = self.store.remove(&temp);
            return Err(error.into());
        }

        let saved = self.store.stat(path)?.ok_or_else(|| not_found(path))?;
        Ok(saved.version)
    }

    /// Só grava por cima do que abriria editável, para não corromper binários e outras codificações.
    fn ensure_editable(&self, path: &Path, size: u64) -> Result<()> {
        if size > MAX_EDITABLE_SIZE || !is_editable(&self.store.read(path)?) {
            return Err(Error::new(
                ErrorKind::ReadOnly,
                "O editor não grava por cima deste arquivo: ele é binário, grande demais ou não está em UTF-8",
            ));
        }
        Ok(())
    }

    /// Na mesma pasta do destino, para o rename final ser atômico; único por gravação.
    fn temp_path(&self, path: &Path) -> Result<PathBuf> {
        let name = path.file_name().ok_or_else(|| {
            Error::new(
                ErrorKind::InvalidInput,
                format!("Caminho sem nome de arquivo: {}", path.display()),
            )
        })?;
        let serial = self.temp_files.fetch_add(1, Ordering::Relaxed);
        Ok(path.with_file_name(format!(
            ".{}.{}-{serial}.tmp",
            name.to_string_lossy(),
            std::process::id()
        )))
    }
}

fn not_found(path: &Path) -> Error {
    Error::new(
        ErrorKind::NotFound,
        format!("Arquivo não encontrado: {}", path.display()),
    )
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_SNIFF_LEN)].contains(&0)
}

fn is_editable(bytes: &[u8]) -> bool {
    let body = bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes);
    !is_binary(bytes) && std::str::from_utf8(body).is_ok()
}

fn decode(mut bytes: Vec<u8>, version: String) -> FileContent {
    if is_binary(&bytes) {
        return FileContent::Binary;
    }
    let bom = bytes.starts_with(UTF8_BOM);
    if bom {
        bytes.drain(..UTF8_BOM.len());
    }
    let (content, read_only) = match String::from_utf8(bytes) {
        Ok(text) => (text, false),
        Err(error) => (String::from_utf8_lossy(error.as_bytes()).into_owned(), true),
    };
    FileContent::Text {
        eol: Eol::detect(&content),
        content,
        bom,
        read_only,
        version,
    }
}

fn encode(text: &str, eol: Eol, bom: bool) -> Vec<u8> {
    let bom: &[u8] = if bom { UTF8_BOM } else { &[] };
    [bom, eol.apply(text).as_bytes()].concat()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use crate::FileStat;

    /// Disco em memória; cada escrita gera uma versão nova.
    #[derive(Default)]
    struct FakeStore {
        files: Mutex<BTreeMap<PathBuf, (Vec<u8>, u64)>>,
        last_version: AtomicU64,
        reads: AtomicUsize,
        fail_writes: bool,
    }

    impl FakeStore {
        fn with_file(path: &str, bytes: &[u8]) -> Self {
            let store = Self::default();
            store.put(Path::new(path), bytes.to_vec());
            store
        }

        fn put(&self, path: &Path, bytes: Vec<u8>) {
            let version = self.last_version.fetch_add(1, Ordering::Relaxed) + 1;
            self.files
                .lock()
                .unwrap()
                .insert(path.into(), (bytes, version));
        }

        fn bytes(&self, path: &str) -> Vec<u8> {
            self.files.lock().unwrap()[Path::new(path)].0.clone()
        }

        fn paths(&self) -> Vec<PathBuf> {
            self.files.lock().unwrap().keys().cloned().collect()
        }
    }

    impl FileStore for FakeStore {
        fn stat(&self, path: &Path) -> io::Result<Option<FileStat>> {
            let files = self.files.lock().unwrap();
            Ok(files.get(path).map(|(bytes, version)| FileStat {
                size: bytes.len() as u64,
                version: version.to_string(),
            }))
        }

        fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
            self.reads.fetch_add(1, Ordering::Relaxed);
            let files = self.files.lock().unwrap();
            let (bytes, _) = files.get(path).ok_or(io::ErrorKind::NotFound)?;
            Ok(bytes.clone())
        }

        fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
            if self.fail_writes {
                self.put(path, bytes[..bytes.len() / 2].to_vec());
                return Err(io::Error::other("disco cheio"));
            }
            self.put(path, bytes.to_vec());
            Ok(())
        }

        fn replace(&self, from: &Path, to: &Path) -> io::Result<()> {
            let (bytes, _) = self
                .files
                .lock()
                .unwrap()
                .remove(from)
                .ok_or(io::ErrorKind::NotFound)?;
            self.put(to, bytes);
            Ok(())
        }

        fn remove(&self, path: &Path) -> io::Result<()> {
            let removed = self.files.lock().unwrap().remove(path);
            removed.map(drop).ok_or(io::ErrorKind::NotFound.into())
        }
    }

    const MAIN: &str = "proj/main.cpp";

    fn read_text(editor: &Editor<FakeStore>) -> (String, Eol, bool, bool, String) {
        match editor.read(Path::new(MAIN)).unwrap() {
            FileContent::Text {
                content,
                eol,
                bom,
                read_only,
                version,
            } => (content, eol, bom, read_only, version),
            other => panic!("esperava texto, veio {other:?}"),
        }
    }

    #[test]
    fn nul_byte_in_first_8_kb_is_binary_and_content_is_not_loaded() {
        let mut late_nul = vec![b'a'; BINARY_SNIFF_LEN];
        late_nul.push(0);

        let binary = Editor::new(FakeStore::with_file(MAIN, b"ELF\0\x01"));
        let text = Editor::new(FakeStore::with_file(MAIN, &late_nul));

        assert_eq!(binary.read(Path::new(MAIN)).unwrap(), FileContent::Binary);
        assert!(matches!(
            text.read(Path::new(MAIN)).unwrap(),
            FileContent::Text { .. }
        ));
    }

    #[test]
    fn file_over_50_mb_is_too_large_and_is_not_read() {
        let size = MAX_EDITABLE_SIZE + 1;
        let editor = Editor::new(FakeStore::with_file(MAIN, &vec![b'a'; size as usize]));

        assert_eq!(
            editor.read(Path::new(MAIN)).unwrap(),
            FileContent::TooLarge { size }
        );
        assert_eq!(editor.store.reads.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn invalid_utf8_opens_read_only_and_saving_over_it_is_refused() {
        let latin1 = b"caf\xE9\n".to_vec();
        let editor = Editor::new(FakeStore::with_file(MAIN, &latin1));

        let (content, _, _, read_only, version) = read_text(&editor);
        let error = editor
            .save(Path::new(MAIN), "café\n", Eol::Lf, false, Some(&version))
            .unwrap_err();

        assert!(read_only);
        assert_eq!(content, "caf\u{FFFD}\n");
        assert_eq!(error.kind, ErrorKind::ReadOnly);
        assert_eq!(editor.store.bytes(MAIN), latin1);
    }

    #[test]
    fn saving_keeps_the_line_ending_the_file_had() {
        for (original, eol, edited) in [
            ("a\r\nb\r\n", Eol::Crlf, "a\r\nb\nnova\n"),
            ("a\nb\n", Eol::Lf, "a\nb\r\nnova\n"),
        ] {
            let editor = Editor::new(FakeStore::with_file(MAIN, original.as_bytes()));
            let (_, detected, _, _, version) = read_text(&editor);

            editor
                .save(Path::new(MAIN), edited, detected, false, Some(&version))
                .unwrap();

            assert_eq!(detected, eol);
            let expected = "a\nb\nnova\n".replace('\n', eol_text(eol));
            assert_eq!(editor.store.bytes(MAIN), expected.as_bytes());
        }
    }

    fn eol_text(eol: Eol) -> &'static str {
        match eol {
            Eol::Lf => "\n",
            Eol::Crlf => "\r\n",
        }
    }

    #[test]
    fn utf8_bom_is_hidden_from_the_editor_and_restored_on_save() {
        let editor = Editor::new(FakeStore::with_file(MAIN, b"\xEF\xBB\xBFint x;\n"));

        let (content, eol, bom, _, version) = read_text(&editor);
        editor
            .save(Path::new(MAIN), "int y;\n", eol, bom, Some(&version))
            .unwrap();

        assert!(bom);
        assert_eq!(content, "int x;\n");
        assert_eq!(editor.store.bytes(MAIN), b"\xEF\xBB\xBFint y;\n");
    }

    #[test]
    fn failure_in_the_middle_of_the_write_keeps_the_original_intact() {
        let editor = Editor::new(FakeStore {
            fail_writes: true,
            ..FakeStore::with_file(MAIN, b"original\n")
        });

        let error = editor
            .save(Path::new(MAIN), "novo conteúdo\n", Eol::Lf, false, None)
            .unwrap_err();

        assert_eq!(error.message, "disco cheio");
        assert_eq!(editor.store.bytes(MAIN), b"original\n");
        assert_eq!(editor.store.paths(), [PathBuf::from(MAIN)]);
    }

    #[test]
    fn save_writes_through_a_temporary_file_in_the_same_folder() {
        let editor = Editor::new(FakeStore::with_file(MAIN, b"x\n"));

        let temp = editor.temp_path(Path::new(MAIN)).unwrap();
        editor
            .save(Path::new(MAIN), "y\n", Eol::Lf, false, None)
            .unwrap();

        assert_eq!(temp.parent(), Path::new(MAIN).parent());
        assert_ne!(temp, editor.temp_path(Path::new(MAIN)).unwrap());
        assert_eq!(editor.store.paths(), [PathBuf::from(MAIN)]);
    }

    #[test]
    fn newer_version_on_disk_is_a_conflict_and_nothing_is_written() {
        let editor = Editor::new(FakeStore::with_file(MAIN, b"v1\n"));
        let (_, _, _, _, version) = read_text(&editor);
        editor.store.put(Path::new(MAIN), b"v2 de fora\n".to_vec());

        let error = editor
            .save(Path::new(MAIN), "minha\n", Eol::Lf, false, Some(&version))
            .unwrap_err();

        assert_eq!(error.kind, ErrorKind::Conflict);
        assert_eq!(editor.store.bytes(MAIN), b"v2 de fora\n");
    }

    #[test]
    fn save_returns_the_version_a_new_read_reports_and_recreates_deleted_files() {
        let editor = Editor::new(FakeStore::default());

        let saved = editor
            .save(
                Path::new(MAIN),
                "x\n",
                Eol::Lf,
                false,
                Some("versão antiga"),
            )
            .unwrap();

        let (_, _, _, _, version) = read_text(&editor);
        assert_eq!(saved, version);
    }

    #[test]
    fn text_without_line_breaks_uses_the_system_default() {
        assert_eq!(Eol::detect("int x;"), Eol::system_default());
        assert_eq!(Eol::detect("a\r\nb\r\nc\n"), Eol::Crlf);
    }
}
