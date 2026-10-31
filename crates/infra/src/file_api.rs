//! A File API do CMake no disco.

use std::fs;
use std::io;
use std::path::Path;

use darktriad_core::{CMakeTarget, FileApi, Result, file_api_executables, file_api_query};

pub struct LocalFileApi;

impl FileApi for LocalFileApi {
    fn write_query(&self, build_dir: &Path) -> io::Result<bool> {
        let query = file_api_query(build_dir);
        if query.exists() {
            return Ok(false);
        }
        if let Some(dir) = query.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&query, "")?;
        Ok(true)
    }

    fn executables(&self, build_dir: &Path) -> Result<Vec<CMakeTarget>> {
        let reply = build_dir.join(".cmake/api/v1/reply");
        // Sem a pasta de resposta, `file_api_executables` explica que é preciso configurar de novo.
        let files: Vec<String> = fs::read_dir(&reply)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .collect();
        file_api_executables(build_dir, &files, |name| {
            fs::read_to_string(reply.join(name))
        })
    }
}

#[cfg(test)]
mod tests {
    use darktriad_core::ErrorKind;

    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn query_is_created_once_with_its_folders() {
        let build = TempDir::new("file-api-query");
        let build = build.join("build/debug");

        assert!(LocalFileApi.write_query(&build).unwrap());
        assert!(file_api_query(&build).is_file());
        assert!(!LocalFileApi.write_query(&build).unwrap());
    }

    #[test]
    fn reply_gives_the_executables() {
        let build = TempDir::new("file-api-reply");
        let reply = build.join(".cmake/api/v1/reply");
        fs::create_dir_all(&reply).unwrap();
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/file-api/hello-cpp");
        for entry in fs::read_dir(fixture).unwrap() {
            let entry = entry.unwrap();
            fs::copy(entry.path(), reply.join(entry.file_name())).unwrap();
        }

        let names: Vec<String> = LocalFileApi
            .executables(&build)
            .unwrap()
            .into_iter()
            .map(|target| target.name)
            .collect();
        assert_eq!(names, ["app", "tool"]);
    }

    #[test]
    fn without_a_reply_asks_to_configure_again() {
        let build = TempDir::new("file-api-empty");
        let error = LocalFileApi.executables(&build).unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
    }
}
