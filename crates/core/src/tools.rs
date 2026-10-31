//! Ferramentas externas (cmake, clangd, dotnet…): onde estão e se a versão serve.

use std::path::PathBuf;

use crate::ToolProbe;

/// Uma ferramenta que a IDE procura.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tool {
    pub program: &'static str,
    pub purpose: &'static str,
    /// Versão mínima, ex.: `"3.21"`. `None` quando qualquer versão serve.
    pub minimum: Option<&'static str>,
    /// O passo a passo manual.
    pub install: &'static str,
}

/// A tabela de ferramentas da spec do projeto.
pub const TOOLS: [Tool; 8] = [
    Tool {
        program: "cmake",
        purpose: "configurar e compilar C/C++",
        minimum: Some("3.21"),
        install: "Baixe de https://cmake.org/download/ e ponha a pasta bin no PATH.",
    },
    Tool {
        program: "ninja",
        purpose: "gerador de build",
        minimum: None,
        install: "Baixe de https://ninja-build.org/ e ponha o executável no PATH.",
    },
    Tool {
        program: "clangd",
        purpose: "erros e autocomplete C/C++",
        minimum: Some("17"),
        install: "Siga https://clangd.llvm.org/installation e ponha o clangd no PATH.",
    },
    Tool {
        program: "lldb-dap",
        purpose: "depurar C/C++",
        // A spec só recomenda a 21: as anteriores ainda depuram.
        minimum: None,
        install: "Vem com o LLVM (https://github.com/llvm/llvm-project/releases); no macOS, com \
                  as Command Line Tools (xcode-select --install).",
    },
    Tool {
        program: "gdb",
        purpose: "depurar C/C++ compilado com GCC",
        // shortcut: não confere se o gdb tem Python (modo DAP), só a versão; conferir ao ligar o depurador.
        minimum: Some("14"),
        install: "Instale o gdb pelo gerenciador de pacotes do sistema (ex.: apt-get install gdb).",
    },
    Tool {
        program: "dotnet",
        purpose: "compilar e rodar C#",
        minimum: Some("8"),
        install: "Instale o .NET SDK de https://dotnet.microsoft.com/download.",
    },
    Tool {
        program: "roslyn-language-server",
        purpose: "erros e autocomplete C#",
        minimum: None,
        install: "Com o runtime do .NET 10: dotnet tool install --global roslyn-language-server \
                  --prerelease.",
    },
    Tool {
        program: "netcoredbg",
        purpose: "depurar C#",
        minimum: None,
        install: "Baixe de https://github.com/Samsung/netcoredbg/releases e ponha a pasta no PATH.",
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolStatus {
    Present {
        path: PathBuf,
        version: Option<String>,
    },
    /// Encontrada, mas abaixo da versão mínima ou sem versão legível.
    Outdated {
        path: PathBuf,
        version: Option<String>,
    },
    Missing,
}

impl Tool {
    /// Vale a primeira encontrada que atende a versão mínima.
    pub fn check(&self, probe: &impl ToolProbe) -> ToolStatus {
        let mut outdated = None;
        for path in probe.find(self.program) {
            let version = probe
                .version_output(&path)
                .ok()
                .as_deref()
                .and_then(version_in)
                .map(str::to_owned);
            if self.accepts(version.as_deref()) {
                return ToolStatus::Present { path, version };
            }
            outdated.get_or_insert(ToolStatus::Outdated { path, version });
        }
        outdated.unwrap_or(ToolStatus::Missing)
    }

    fn accepts(&self, version: Option<&str>) -> bool {
        match (self.minimum, version) {
            (None, _) => true,
            (Some(minimum), Some(version)) => numbers(version) >= numbers(minimum),
            (Some(_), None) => false,
        }
    }
}

/// O primeiro número de versão do texto: `16.0.0` em `clangd version 16.0.0`.
fn version_in(output: &str) -> Option<&str> {
    output
        .split_whitespace()
        .find(|word| word.starts_with(|c: char| c.is_ascii_digit()))?
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .next()
}

fn numbers(version: &str) -> Vec<u32> {
    version
        .split('.')
        .map_while(|part| part.parse().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::io;
    use std::path::Path;

    use super::*;

    #[derive(Default)]
    struct FakeProbe {
        found: HashMap<&'static str, Vec<PathBuf>>,
        versions: HashMap<PathBuf, &'static str>,
    }

    impl FakeProbe {
        fn with(mut self, program: &'static str, path: &str, version: &'static str) -> Self {
            self.found.entry(program).or_default().push(path.into());
            self.versions.insert(path.into(), version);
            self
        }
    }

    impl ToolProbe for FakeProbe {
        fn find(&self, program: &str) -> Vec<PathBuf> {
            self.found.get(program).cloned().unwrap_or_default()
        }

        fn version_output(&self, path: &Path) -> io::Result<String> {
            self.versions
                .get(path)
                .map(|text| text.to_string())
                .ok_or_else(|| io::Error::other("sem saída"))
        }
    }

    fn tool(program: &str) -> Tool {
        *TOOLS.iter().find(|tool| tool.program == program).unwrap()
    }

    #[test]
    fn clangd_off_the_path_is_missing_with_purpose_and_install_steps() {
        let clangd = tool("clangd");
        assert_eq!(clangd.check(&FakeProbe::default()), ToolStatus::Missing);
        assert!(!clangd.purpose.is_empty());
        assert!(!clangd.install.is_empty());
        assert!(
            TOOLS
                .iter()
                .all(|tool| !tool.purpose.is_empty() && !tool.install.is_empty())
        );
    }

    #[test]
    fn clangd_16_is_outdated_with_minimum_17() {
        let probe = FakeProbe::default().with("clangd", "/fake/clangd", "clangd version 16.0.0\n");
        let clangd = tool("clangd");
        assert_eq!(
            clangd.check(&probe),
            ToolStatus::Outdated {
                path: "/fake/clangd".into(),
                version: Some("16.0.0".into()),
            }
        );
        assert_eq!(clangd.minimum, Some("17"));
    }

    #[test]
    fn the_first_candidate_with_the_minimum_version_wins() {
        let probe = FakeProbe::default()
            .with(
                "clangd",
                "/usr/bin/clangd",
                "Ubuntu clangd version 16.0.6 (1ubuntu1)",
            )
            .with("clangd", "/opt/llvm/clangd", "clangd version 18.1.3")
            .with("clangd", "/ide/tools/clangd", "clangd version 19.1.0");
        assert_eq!(
            tool("clangd").check(&probe),
            ToolStatus::Present {
                path: "/opt/llvm/clangd".into(),
                version: Some("18.1.3".into()),
            }
        );
    }

    #[test]
    fn minimum_compares_minor_versions_and_needs_a_readable_version() {
        let cmake = |output| {
            let probe = FakeProbe::default().with("cmake", "/bin/cmake", output);
            matches!(tool("cmake").check(&probe), ToolStatus::Present { .. })
        };
        assert!(cmake("cmake version 3.28.3"));
        assert!(cmake("cmake version 3.21.0-rc1"));
        assert!(!cmake("cmake version 3.20.6"));
        assert!(!cmake("cmake: comando quebrado"));

        let ninja = FakeProbe::default().with("ninja", "/bin/ninja", "1.11.1");
        assert_eq!(
            tool("ninja").check(&ninja),
            ToolStatus::Present {
                path: "/bin/ninja".into(),
                version: Some("1.11.1".into()),
            }
        );
    }
}
