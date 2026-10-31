//! Projeto: o que a pasta aberta é (CMake ou .NET), os argumentos do CMake e a leitura da saída dele.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::{Error, ErrorKind, Platform, Result};

const EXPORT_COMPILE_COMMANDS: &str = "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectKind {
    CMake,
    CMakePresets,
    DotnetSolution,
    DotnetProjects,
    /// Sem projeto: só edição.
    EditOnly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedProject {
    pub kind: ProjectKind,
    pub warning: Option<&'static str>,
}

/// `files` são caminhos relativos à raiz: os itens da raiz e os `.csproj` até 2 níveis abaixo.
/// Caminhos mais fundos são ignorados.
pub fn detect_project(files: &[PathBuf]) -> DetectedProject {
    let at_root = |name: &str| files.iter().any(|file| file == Path::new(name));
    let has = |extension: &str, max_depth: usize| {
        files.iter().any(|file| {
            file.components().count() <= max_depth
                && file
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
        })
    };
    let cmake = at_root("CMakeLists.txt");
    let presets = at_root("CMakePresets.json") || at_root("CMakeUserPresets.json");
    let solution = has("sln", 1) || has("slnx", 1);
    let projects = has("csproj", 3);
    let kind = match () {
        _ if cmake && presets => ProjectKind::CMakePresets,
        _ if cmake => ProjectKind::CMake,
        _ if solution => ProjectKind::DotnetSolution,
        _ if projects => ProjectKind::DotnetProjects,
        _ => ProjectKind::EditOnly,
    };
    let warning = (cmake && (solution || projects)).then_some(
        "Também há um projeto .NET aqui. Nesta versão, abra a pasta dele separadamente.",
    );
    DetectedProject { kind, warning }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildConfig {
    Debug,
    Release,
}

impl BuildConfig {
    fn name(self) -> &'static str {
        match self {
            Self::Debug => "Debug",
            Self::Release => "Release",
        }
    }
}

/// `<raiz>/build/debug` ou `<raiz>/build/release`.
pub fn cmake_build_dir(root: &Path, config: BuildConfig) -> PathBuf {
    root.join("build").join(config.name().to_ascii_lowercase())
}

/// Argumentos do `cmake` para configurar um projeto sem presets.
pub fn cmake_configure_args(
    root: &Path,
    config: BuildConfig,
    has_ninja: bool,
    platform: Platform,
) -> Result<Vec<OsString>> {
    let generator = match (has_ninja, platform) {
        (true, _) => "Ninja",
        (false, Platform::Unix) => "Unix Makefiles",
        (false, Platform::Windows) => {
            return Err(Error::new(
                ErrorKind::NotFound,
                "Instale o Ninja para configurar o CMake: o gerador do Visual Studio não gera o \
                 compile_commands.json de que o clangd precisa.",
            ));
        }
    };
    Ok(vec![
        "-S".into(),
        root.into(),
        "-B".into(),
        cmake_build_dir(root, config).into(),
        "-G".into(),
        generator.into(),
        format!("-DCMAKE_BUILD_TYPE={}", config.name()).into(),
        EXPORT_COMPILE_COMMANDS.into(),
    ])
}

/// Argumentos do `cmake` para configurar com um preset de configuração.
pub fn cmake_preset_args(preset: &str) -> Vec<OsString> {
    vec![
        "--preset".into(),
        preset.into(),
        EXPORT_COMPILE_COMMANDS.into(),
    ]
}

/// O arquivo de consulta da File API, criado antes de configurar para o CMake gerar o modelo.
pub fn file_api_query(build_dir: &Path) -> PathBuf {
    build_dir.join(".cmake/api/v1/query/client-darktriad/codemodel-v2")
}

/// Um alvo executável do CMake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CMakeTarget {
    pub name: String,
    /// Caminho absoluto do programa.
    pub path: PathBuf,
}

/// Os alvos executáveis da resposta da File API (`<build>/.cmake/api/v1/reply/`).
/// `reply_files` são os nomes dos arquivos dessa pasta, e `read` lê um deles pelo nome.
pub fn file_api_executables(
    build_dir: &Path,
    reply_files: &[String],
    read: impl Fn(&str) -> io::Result<String>,
) -> Result<Vec<CMakeTarget>> {
    // O índice atual é o de maior nome (cmake-file-api(7)).
    let index = reply_files
        .iter()
        .filter(|name| name.starts_with("index-") && name.ends_with(".json"))
        .max()
        .ok_or_else(no_model)?;
    let index = read_json(&read, index)?;
    let codemodel = read_json(
        &read,
        json_file(&index["reply"]["client-darktriad"]["codemodel-v2"])?,
    )?;
    // Ninja e Makefiles geram uma configuração só.
    let targets = codemodel["configurations"][0]["targets"]
        .as_array()
        .ok_or_else(no_model)?;
    let mut executables = Vec::new();
    for target in targets {
        let target = read_json(&read, json_file(target)?)?;
        if target["type"] != "EXECUTABLE" {
            continue;
        }
        let (Some(name), Some(name_on_disk)) =
            (target["name"].as_str(), target["nameOnDisk"].as_str())
        else {
            return Err(no_model());
        };
        // Os artefatos podem trazer também o .pdb: o programa é o que tem o nome de `nameOnDisk`.
        let program = target["artifacts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|artifact| artifact["path"].as_str())
            .find(|path| Path::new(path).file_name() == Some(OsStr::new(name_on_disk)))
            .ok_or_else(no_model)?;
        executables.push(CMakeTarget {
            name: name.to_owned(),
            // Relativo à pasta de build, ou absoluto se estiver fora dela (o `join` mantém).
            path: build_dir.join(program),
        });
    }
    Ok(executables)
}

fn json_file(object: &Value) -> Result<&str> {
    object["jsonFile"].as_str().ok_or_else(no_model)
}

fn read_json(read: &impl Fn(&str) -> io::Result<String>, name: &str) -> Result<Value> {
    serde_json::from_str(&read(name)?).map_err(|error| {
        Error::new(
            ErrorKind::Other,
            format!("Resposta da File API ilegível ({name}): {error}"),
        )
    })
}

fn no_model() -> Error {
    Error::new(
        ErrorKind::NotFound,
        "O CMake não gerou o modelo do projeto: configure de novo.",
    )
}

/// Os nomes dos presets na saída de `cmake --list-presets`.
// O cmake(1) não documenta a saída; o formato é o de PrintPresets em Source/cmCMakePresetsGraph.cxx.
pub fn parse_preset_names(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| line.strip_prefix("  \"")?.split_once('"'))
        .map(|(name, _)| name.to_owned())
        .collect()
}

/// A pasta da linha `-- Build files have been written to: <pasta>`.
pub fn parse_build_dir(line: &str) -> Option<PathBuf> {
    line.trim_end()
        .strip_prefix("-- Build files have been written to: ")
        .map(PathBuf::from)
}

/// Um erro do CMake com o arquivo e a linha, para o painel Problemas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CMakeProblem {
    /// Como o CMake escreveu: relativo à raiz do projeto ou absoluto.
    pub file: PathBuf,
    pub line: u32,
}

/// Lê `CMake Error at <arquivo>:<linha> (<comando>):` ou `CMake Error at <arquivo>:<linha>:`.
pub fn parse_cmake_error(line: &str) -> Option<CMakeProblem> {
    let place = line
        .trim_end()
        .strip_prefix("CMake Error at ")?
        .strip_suffix(':')?;
    // Corta o comando pelo fim: a pasta também pode ter parênteses ("Program Files (x86)").
    let place = match place.strip_suffix(')') {
        Some(rest) => rest.rsplit_once(" (")?.0,
        None => place,
    };
    let (file, line) = place.rsplit_once(':')?;
    Some(CMakeProblem {
        file: file.into(),
        line: line.parse().ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALSO_DOTNET: &str =
        "Também há um projeto .NET aqui. Nesta versão, abra a pasta dele separadamente.";

    /// Os arquivos de uma fixture, relativos à raiz dela.
    fn files_of(fixture: &str) -> Vec<PathBuf> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures")
            .join(fixture);
        let mut files = Vec::new();
        collect(&root, Path::new(""), &mut files);
        files
    }

    fn collect(dir: &Path, relative: &Path, files: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = relative.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                collect(&entry.path(), &path, files);
            }
            files.push(path);
        }
    }

    fn paths(names: &[&str]) -> Vec<PathBuf> {
        names.iter().map(PathBuf::from).collect()
    }

    fn detected(kind: ProjectKind, warning: Option<&'static str>) -> DetectedProject {
        DetectedProject { kind, warning }
    }

    #[test]
    fn detects_the_example_projects() {
        assert_eq!(
            detect_project(&files_of("hello-cpp")),
            detected(ProjectKind::CMake, None)
        );
        assert_eq!(
            detect_project(&files_of("hello-cpp-presets")),
            detected(ProjectKind::CMakePresets, None)
        );
        assert_eq!(
            detect_project(&files_of("hello-cs")),
            detected(ProjectKind::DotnetProjects, None)
        );
    }

    #[test]
    fn cmake_wins_over_dotnet_with_a_warning() {
        assert_eq!(
            detect_project(&paths(&["CMakeLists.txt", "x.csproj"])),
            detected(ProjectKind::CMake, Some(ALSO_DOTNET))
        );
        assert_eq!(
            detect_project(&paths(&[
                "CMakeLists.txt",
                "CMakeUserPresets.json",
                "a.slnx"
            ])),
            detected(ProjectKind::CMakePresets, Some(ALSO_DOTNET))
        );
    }

    #[test]
    fn empty_folder_is_edit_only() {
        assert_eq!(detect_project(&[]), detected(ProjectKind::EditOnly, None));
    }

    #[test]
    fn solutions_count_only_at_the_root_and_projects_up_to_two_levels_below() {
        let kind = |names: &[&str]| detect_project(&paths(names)).kind;
        assert_eq!(
            kind(&["App.SLN", "src/a/a.csproj"]),
            ProjectKind::DotnetSolution
        );
        assert_eq!(kind(&["src/a/a.csproj"]), ProjectKind::DotnetProjects);
        assert_eq!(kind(&["src/a/b/b.csproj"]), ProjectKind::EditOnly);
        assert_eq!(kind(&["src/a.sln"]), ProjectKind::EditOnly);
        assert_eq!(kind(&["src/CMakeLists.txt"]), ProjectKind::EditOnly);
    }

    #[test]
    fn configure_args_are_exact_for_debug_and_release() {
        let root = Path::new("/proj");
        let args = |config| cmake_configure_args(root, config, true, Platform::Unix).unwrap();
        let expected = |build: &str, config: &str| -> Vec<OsString> {
            vec![
                "-S".into(),
                root.into(),
                "-B".into(),
                root.join("build").join(build).into(),
                "-G".into(),
                "Ninja".into(),
                format!("-DCMAKE_BUILD_TYPE={config}").into(),
                "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON".into(),
            ]
        };
        assert_eq!(args(BuildConfig::Debug), expected("debug", "Debug"));
        assert_eq!(args(BuildConfig::Release), expected("release", "Release"));
    }

    #[test]
    fn without_ninja_unix_uses_makefiles_and_windows_explains() {
        let root = Path::new("/proj");
        let unix = cmake_configure_args(root, BuildConfig::Debug, false, Platform::Unix).unwrap();
        assert_eq!(unix[4..6], ["-G", "Unix Makefiles"]);

        let error =
            cmake_configure_args(root, BuildConfig::Debug, false, Platform::Windows).unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert!(error.message.contains("Ninja"));
        assert!(error.message.contains("compile_commands.json"));
    }

    #[test]
    fn preset_args_and_file_api_query() {
        assert_eq!(
            cmake_preset_args("debug"),
            ["--preset", "debug", "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON"]
        );
        assert_eq!(
            file_api_query(Path::new("/proj/build/debug")),
            Path::new("/proj/build/debug/.cmake/api/v1/query/client-darktriad/codemodel-v2")
        );
    }

    #[test]
    fn preset_names_come_from_list_presets() {
        // Saída real do cmake 4.4.4 em tests/fixtures/hello-cpp-presets.
        let output =
            "Available configure presets:\n\n  \"debug\"   - Debug\n  \"release\" - Release\n";
        assert_eq!(parse_preset_names(output), ["debug", "release"]);
        assert_eq!(
            parse_preset_names(&output.replace('\n', "\r\n")),
            ["debug", "release"]
        );
        assert!(parse_preset_names("").is_empty());
    }

    /// Resposta gerada uma vez pelo cmake 4.4.4 com o hello-cpp (Ninja, Debug); os caminhos da
    /// máquina foram trocados por `/projeto/hello-cpp`.
    fn file_api_fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/file-api/hello-cpp")
    }

    fn reply_files_of(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect()
    }

    #[test]
    fn file_api_reply_gives_the_executables_with_absolute_paths() {
        let reply = file_api_fixture();
        // Um índice antigo que não existe mais: só o de maior nome é lido.
        let mut files = reply_files_of(&reply);
        files.push("index-2000-01-01T00-00-00-0000.json".into());
        let build = Path::new("/proj/build/debug");
        let targets = file_api_executables(build, &files, |name| {
            std::fs::read_to_string(reply.join(name))
        })
        .unwrap();
        let target = |name: &str| CMakeTarget {
            name: name.into(),
            path: build.join(name),
        };
        assert_eq!(targets, [target("app"), target("tool")]);
    }

    #[test]
    fn the_program_is_the_artifact_with_the_name_on_disk() {
        let reply = file_api_fixture();
        // Com o MSVC, o .pdb também é artefato do executável.
        let read = |name: &str| {
            let text = std::fs::read_to_string(reply.join(name))?;
            if !name.starts_with("target-app-") {
                return Ok(text);
            }
            let mut target: Value = serde_json::from_str(&text).unwrap();
            let artifacts = target["artifacts"].as_array_mut().unwrap();
            artifacts.insert(0, serde_json::json!({ "path": "app.pdb" }));
            Ok(target.to_string())
        };
        let build = Path::new("/b");
        let targets = file_api_executables(build, &reply_files_of(&reply), read).unwrap();
        assert_eq!(targets[0].path, build.join("app"));
    }

    #[test]
    fn file_api_without_a_reply_asks_to_configure_again() {
        let error =
            file_api_executables(Path::new("/b"), &["x.json".into()], |_| Ok(String::new()))
                .unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
    }

    #[test]
    fn build_dir_comes_from_the_written_to_line() {
        assert_eq!(
            parse_build_dir("-- Build files have been written to: C:/x/out/build/debug\r"),
            Some(PathBuf::from("C:/x/out/build/debug"))
        );
        assert_eq!(parse_build_dir("-- Configuring done (0.1s)"), None);
    }

    #[test]
    fn cmake_errors_become_problems_with_file_and_line() {
        let problem = |file: &str, line| {
            Some(CMakeProblem {
                file: file.into(),
                line,
            })
        };
        assert_eq!(
            parse_cmake_error("CMake Error at CMakeLists.txt:7 (add_executable):"),
            problem("CMakeLists.txt", 7)
        );
        assert_eq!(
            parse_cmake_error("CMake Error at CMakeLists.txt:3:"),
            problem("CMakeLists.txt", 3)
        );
        assert_eq!(
            parse_cmake_error("CMake Error at C:/Program Files (x86)/x.cmake:12 (include):"),
            problem("C:/Program Files (x86)/x.cmake", 12)
        );
        assert_eq!(
            parse_cmake_error("CMake Error at C:/Program Files (x86)/x.cmake:12:"),
            problem("C:/Program Files (x86)/x.cmake", 12)
        );
        assert_eq!(
            parse_cmake_error("CMake Warning at CMakeLists.txt:7:"),
            None
        );
        assert_eq!(
            parse_cmake_error("  Unknown CMake command \"add_executabl\"."),
            None
        );
    }
}
