# Projeto: CMake e .NET, configuração, alvo e ferramentas

Status: **MVP (v0.3)** · Depende de: [explorador.md](explorador.md), [paleta-de-comandos.md](paleta-de-comandos.md) · Usado por: [linguagem.md](linguagem.md), [compilar-e-executar.md](compilar-e-executar.md), [depuracao.md](depuracao.md)

## Problema do usuário

Abro a pasta do projeto e quero que a IDE entenda sozinha o que é aquilo (CMake ou .NET), qual programa vai rodar e se estou em Debug ou Release. Se faltar alguma ferramenta (cmake, clangd, dotnet…), quero saber **qual**, **para quê** e **como instalar**, em vez de "nada funciona".

## O que as IDEs de referência fazem

- **CLion**, perfis do CMake:
  - Um perfil junta toolchain, tipo de build, gerador e opções. O tipo de build padrão é Debug.
  - Usa o gerador Ninja quando dá (toolchain local, CMake ≥ 3.20); senão, Makefiles.
  - Lê `CMakePresets.json`, mas os perfis vindos de presets começam desligados.
  - O perfil ativo é escolhido num seletor na barra de ferramentas.

  [CMake profiles](https://www.jetbrains.com/help/clion/cmake-profile.html)
- **CLion**, ao carregar um projeto CMake:
  - Cria uma configuração de execução por alvo.
  - Compila em `cmake-build-debug` / `cmake-build-release`.
  - Abre a janela do CMake sozinha só quando o carregamento falha.

  [Quick CMake tutorial](https://www.jetbrains.com/help/clion/quick-cmake-tutorial.html)
- **Visual Studio:**
  - Integra `CMakePresets.json`.
  - Os exemplos usam o gerador Ninja e a pasta de build `${sourceDir}/out/build/${presetName}`.
  - Sem arquivo de presets, usa presets padrão.

  [CMake presets in Visual Studio](https://learn.microsoft.com/en-us/cpp/build/cmake-presets-vs)
- **CMake:**
  - `CMAKE_EXPORT_COMPILE_COMMANDS`, que gera o `compile_commands.json` de que o clangd precisa, **só funciona com geradores Makefile e Ninja**. Os geradores do Visual Studio ignoram a opção.

    [CMAKE_EXPORT_COMPILE_COMMANDS](https://cmake.org/cmake/help/latest/variable/CMAKE_EXPORT_COMPILE_COMMANDS.html)
  - A File API devolve o modelo do projeto:
    - o cliente cria `<build>/.cmake/api/v1/query/client-<nome>/codemodel-v2`;
    - a resposta fica em `<build>/.cmake/api/v1/reply/`;
    - cada alvo tem `type` (ex.: `EXECUTABLE`) e `artifacts[].path`.

    [cmake-file-api(7)](https://cmake.org/cmake/help/latest/manual/cmake-file-api.7.html)
  - Presets ficam em `CMakePresets.json` / `CMakeUserPresets.json` e são usados com `cmake --preset <nome>`. `binaryDir` define a pasta de build. `cmake --list-presets` lista os presets.

    [cmake-presets(7)](https://cmake.org/cmake/help/latest/manual/cmake-presets.7.html), [cmake(1)](https://cmake.org/cmake/help/latest/manual/cmake.1.html)
- **clangd:**
  - Procura `compile_commands.json` nas pastas pai do arquivo e em subpastas `build/`.
  - A opção `--compile-commands-dir` indica outra pasta.

  [clangd: project setup](https://clangd.llvm.org/installation), [ClangdMain.cpp](https://github.com/llvm/llvm-project/blob/main/clang-tools-extra/clangd/tool/ClangdMain.cpp) (Apache 2.0 com exceção LLVM)
- **MSVC fora do Visual Studio:**
  - O compilador precisa do ambiente criado por `vcvarsall.bat`.
  - A instalação é localizada com `vswhere.exe` (licença MIT), que fica em `%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\`.

  [Use the MSVC toolset from the command line](https://learn.microsoft.com/en-us/cpp/build/building-on-the-command-line), [vswhere](https://github.com/microsoft/vswhere)
- **.NET:** desde o SDK 8, `--getProperty:<Nome>` lê propriedades do MSBuild pela linha de comando (ex.: `OutputType`, `TargetPath`), sem montar a build. [What's new in the .NET 8 SDK](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-8/sdk)
- **Roslyn Language Server:**
  - É distribuído pela Microsoft como ferramenta .NET `roslyn-language-server` (MIT), só em versão prévia.
  - Exige o runtime do .NET 10.
  - Aceita `--stdio` e `--autoLoadProjects`.

  [NuGet: roslyn-language-server](https://www.nuget.org/packages/roslyn-language-server)

## Comportamento esperado no Dark Triad

### Detecção (ao abrir a pasta)

Função pura no núcleo: recebe os nomes da raiz (e, para `.csproj`, até 2 níveis abaixo) e devolve o tipo.

| Encontrado | Tipo |
|---|---|
| `CMakeLists.txt` na raiz e `CMakePresets.json` ou `CMakeUserPresets.json` | CMake com presets |
| `CMakeLists.txt` na raiz, sem presets | CMake |
| `*.sln` ou `*.slnx` na raiz | .NET (solução) |
| `*.csproj` na raiz ou até 2 níveis abaixo | .NET (projetos) |
| Nada disso | Sem projeto: só edição |

1. **CMake e .NET juntos:** vale o CMake, e aparece o aviso "Também há um projeto .NET aqui. Nesta versão, abra a pasta dele separadamente."
2. **Sem projeto:** a barra de status mostra "Sem projeto (só edição)". A dica explica que compilar exige `CMakeLists.txt` ou `.csproj`.

### Barra de status (esquerda)

`[CMake]` `[Debug ▾]` `[▶ app ▾]`

1. O que mostra: o tipo do projeto, a configuração ativa e o alvo executável ativo.
2. Clicar em configuração ou alvo abre uma lista para escolher (os mesmos comandos estão na paleta).
3. A escolha fica salva por pasta, na pasta de dados do app.

### CMake sem presets

1. **Configurações:** Debug e Release.
2. **Pasta de build:** `<raiz>/build/debug` ou `<raiz>/build/release`.
3. **Antes de configurar:** cria o arquivo de consulta da File API: `<build>/.cmake/api/v1/query/client-darktriad/codemodel-v2`.
4. **Configurar:**

   ```
   cmake -S <raiz> -B <build> -G Ninja -DCMAKE_BUILD_TYPE=<Debug|Release> -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
   ```

   Sem Ninja:
   - no Linux e no macOS, usa `-G "Unix Makefiles"`;
   - no Windows, mostra erro com instrução: o gerador do Visual Studio não gera `compile_commands.json`.

### CMake com presets

1. **Configurações:** os presets de configuração não ocultos, lidos de `cmake --list-presets`. A IDE não interpreta o JSON (`include`, `condition`) por conta própria.
2. **Configurar:** `cmake --preset <nome> -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`.
3. **Pasta de build:** vem da linha `-- Build files have been written to: <pasta>` da saída do CMake.
   - Na primeira vez, cria a consulta da File API nessa pasta e configura de novo. A segunda passada é rápida, porque o cache já existe.
   - O `binaryDir` do usuário não é alterado.

### CMake: depois de configurar (com ou sem presets)

1. **Alvos:**
   - Lê a resposta da File API.
   - Os alvos executáveis (`type == EXECUTABLE`) entram no seletor, com o caminho absoluto do executável.
   - Bibliotecas e alvos utilitários não aparecem.
2. **Quando configura:**
   - ao abrir a pasta;
   - ao trocar de configuração;
   - pelo comando **Projeto: Reconfigurar CMake**;
   - ao salvar `CMakeLists.txt`, `*.cmake`, `CMakePresets.json` ou `CMakeUserPresets.json`. Esperar 1 s depois do último salvamento, para não configurar a cada Ctrl+S seguido.
3. **Andamento:**
   - A barra de status mostra "CMake: configurando…".
   - A saída vai ao vivo para o canal **CMake** do painel Saída.
4. **Erro:**
   - A barra de status mostra "CMake: erro (ver Saída)" e o painel Saída abre.
   - Linhas no formato `CMake Error at <arquivo>:<linha>` viram itens do painel Problemas, com clique que leva à linha.
5. Só há uma configuração por vez. Pedir outra durante uma em andamento cancela a atual e começa de novo.

### Ambiente do compilador no Windows

1. Se já existe compilador no `PATH` (`cl`, `clang`, `gcc`) ou `CC`/`CXX` estão definidos, o `PATH` vale como está: o que o usuário configurou ganha.
2. Senão:
   - localiza o Visual Studio / Build Tools com `vswhere`;
   - roda `VC\Auxiliary\Build\vcvarsall.bat` (com `x64`, ou `arm64` em máquina ARM);
   - captura as variáveis de ambiente resultantes, uma vez por sessão;
   - usa esse ambiente em `cmake`, `ninja`, `clangd` e no depurador.
3. Nada encontrado: "Nenhum compilador C/C++ encontrado." Em seguida, a instrução de instalar o Visual Studio Build Tools (com "C++ CMake tools for Windows", que inclui CMake e Ninja) ou o LLVM.

### .NET

1. **Configurações:** Debug e Release (`-c`).
2. **Ao abrir:**
   - roda `dotnet restore <sln|csproj>` em segundo plano, com saída no canal **dotnet**. Sem isso, o servidor de linguagem não resolve pacotes;
   - lista os projetos: `dotnet sln <sln> list` para soluções, ou os `.csproj` encontrados;
   - lê `OutputType`, `TargetPath` e `TargetFrameworks` de cada projeto com `dotnet msbuild <proj> -getProperty:...`.
3. **Alvos:** projetos com `OutputType` igual a `Exe` ou `WinExe`.
4. **Vários frameworks-alvo:** usa o primeiro da lista.

### Ferramentas

**O que a IDE procura**

| Ferramenta | Para quê | Onde procura (além do `PATH`) | Versão mínima | Como instalar (mostrado ao usuário) |
|---|---|---|---|---|
| `cmake` | configurar e compilar C/C++ | ambiente do vcvars (Windows) | 3.21 | link para cmake.org/download |
| `ninja` | gerador de build | ambiente do vcvars (Windows) | n/a | link para ninja-build.org |
| `clangd` | erros e autocomplete C/C++ | Windows: `C:\Program Files\LLVM\bin`. macOS: `xcrun --find clangd`, `/opt/homebrew/opt/llvm/bin`, `/usr/local/opt/llvm/bin`. Linux: `clangd-<N>` de maior versão | 17 | link para clangd.llvm.org/installation |
| `lldb-dap` | depurar C/C++ | os mesmos lugares do clangd; macOS também `xcrun --find lldb-dap`; Linux também `lldb-dap-<N>` | 21 (recomendado) | link para releases do LLVM |
| `gdb` | depurar C/C++ compilado com GCC | n/a | 14, com Python (modo DAP) | gerenciador de pacotes do sistema / MSYS2 |
| `dotnet` | compilar e rodar C# | `DOTNET_ROOT` | SDK 8 | link para dot.net |
| `roslyn-language-server` | erros e autocomplete C# | `~/.dotnet/tools` | n/a (exige runtime .NET 10) | comando exibido: `dotnet tool install --global roslyn-language-server --prerelease` |
| `netcoredbg` | depurar C# | n/a | n/a | link para github.com/Samsung/netcoredbg/releases |

**Como a IDE avisa**

1. **Ajuda: Verificar ferramentas** abre uma aba com uma linha por ferramenta:
   - ✓ com caminho e versão; ou
   - ✗ com "para quê" e "como instalar".

   Há um botão **Verificar de novo**.
2. Quando uma ação precisa de uma ferramenta que falta, ela não tenta rodar. Aparece uma mensagem direta, ex.: "Para mostrar erros em C++ é preciso o clangd 17 ou mais novo. [Como instalar]".
3. A IDE **não baixa nem instala nada sozinha** no MVP (ver README).

## Atalhos (padrão do VS Code)

O VS Code não tem atalhos padrão para escolher configuração, alvo ou reconfigurar o CMake. Esses comandos ficam **sem atalho**, acessíveis pela barra de status e pela paleta (Ctrl+Shift+P / ⇧⌘P, [Default keyboard shortcuts](https://code.visualstudio.com/docs/reference/default-keybindings)).

| Comando no Dark Triad | Atalho |
|---|---|
| Projeto: Selecionar configuração | nenhum (paleta / barra de status) |
| Projeto: Selecionar alvo | nenhum (paleta / barra de status) |
| Projeto: Reconfigurar CMake | nenhum (paleta) |
| Ajuda: Verificar ferramentas | nenhum (paleta / menu Ajuda) |

## Critérios de aceite

1. **[auto]** A detecção sobre os projetos de exemplo devolve:
   - `hello-cpp` → CMake;
   - `hello-cpp-presets` → CMake com presets;
   - `hello-cs` → .NET (projetos);
   - pasta com `CMakeLists.txt` e `x.csproj` → CMake com aviso;
   - pasta vazia → sem projeto.
2. **[auto]** Para CMake sem presets em Debug, os argumentos montados são exatamente `-S <raiz> -B <raiz>/build/debug -G Ninja -DCMAKE_BUILD_TYPE=Debug -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`. Sem Ninja no Linux, o gerador vira `Unix Makefiles`.
3. **[auto]** A leitura de uma resposta da File API gravada como fixture (gerada uma vez com o `hello-cpp`) devolve os alvos `app` e `tool`, com caminhos absolutos, e não devolve `core`.
4. **[auto]** As funções de leitura da saída do CMake:
   - a saída de `cmake --list-presets` do `hello-cpp-presets` vira `["debug", "release"]`;
   - a linha `-- Build files have been written to: C:/x/out/build/debug` devolve essa pasta;
   - `CMake Error at CMakeLists.txt:7 (add_executable):` vira um problema em `CMakeLists.txt`, linha 7.
5. **[auto]** Com um `PATH` falso sem `clangd`, a verificação de ferramentas marca o clangd como ausente, com texto de "para quê" e "como instalar" não vazios. Com um `clangd` falso que responde `clangd version 16.0.0`, marca como "versão antiga (mínimo 17)".
6. **[manual]** Abra `hello-cpp`. Esperado: em até 10 s (máquina de CI), a barra de status mostra `CMake · Debug · ▶ app`. `build/debug/compile_commands.json` existe, e o canal CMake da Saída mostra o log.
7. **[manual]** Troque para Release. Esperado: `build/release/` é criado e configurado. Feche e reabra a IDE. Esperado: Release e o alvo escolhido continuam selecionados.
8. **[manual]** No seletor de alvo do `hello-cpp`, aparecem só `app` e `tool`.
9. **[manual]** Abra `hello-cpp-presets`. Esperado: o seletor de configuração mostra `debug` e `release`, e a pasta de build é a definida no `binaryDir` do preset, não `build/debug`.
10. **[manual]** Em `CMakeLists.txt`, troque `add_executable` por `add_executabl` e salve. Esperado: em até 3 s, a barra mostra "CMake: erro", e o painel Problemas tem um item na linha certa, que leva até ela ao clicar. Corrija e salve. Esperado: o erro some.
11. **[manual]** Durante a configuração do item 6, digite no editor e role o explorador. Esperado: nenhum atraso perceptível.
12. **[manual]** Abra `hello-cs`. Esperado: a barra mostra `.NET · Debug · ▶ hello-cs`, e o canal dotnet da Saída mostra o `dotnet restore`.
13. **[manual, Windows]** Numa máquina com Visual Studio Build Tools (C++ e CMake tools) e sem compilador no `PATH`, abra a IDE pelo menu Iniciar e abra `hello-cpp`. Esperado: a configuração usa MSVC (o log do CMake mostra "The CXX compiler identification is MSVC").
14. **[manual]** Remova o clangd do `PATH` e rode **Ajuda: Verificar ferramentas**. Esperado: clangd com ✗ e instrução de instalação, e as demais ferramentas com ✓, caminho e versão.

## O que fica de fora

- **Escolher toolchain/compilador pela interface** (estilo "kits" ou toolchains do CLion): depois. No MVP vale o `PATH`, ou o vcvars no Windows.
- **Configurações RelWithDebInfo/MinSizeRel e argumentos extras do CMake:** depois. Quem precisa usa presets.
- **Presets de build, teste e workflow:** depois. O MVP usa só os presets de configuração e compila pela pasta de build.
- **Editor do cache do CMake:** fora.
- **Perfis de `launchSettings.json` e vários projetos de inicialização no .NET:** depois.
- **Escolher o framework-alvo:** depois. O MVP usa o primeiro.
- **Projetos `.vcxproj`, Makefile puro, Meson e Bazel:** fora (README).
- **Baixar e instalar ferramentas automaticamente:** depois (README).
- **Compilação cruzada, embarcados, WSL e contêineres:** fora.
