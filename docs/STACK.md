# Dark Triad — Stack e regras

IDE para C, C++ e C#. Windows, macOS e Linux.

## Stack aprovada

| Camada | Escolha |
|---|---|
| App | Tauri 2 (núcleo em Rust) |
| Editor | Monaco, com atalhos do VS Code |
| Interface | Angular (TypeScript, componentes standalone, signals, zoneless) |
| C / C++ | clangd (LSP) + CMake + `compile_commands.json` |
| C# | Roslyn Language Server + `dotnet` / MSBuild |
| Depuração | DAP: lldb-dap / GDB (C/C++), netcoredbg (C#) |
| Terminal | xterm.js + portable-pty |
| Busca / arquivos | crates `ignore` + `grep` (ripgrep) e `notify` |
| Testes | `cargo test` e `ng test` |
| Release | GitHub Actions + `tauri-action`: tag `vX.Y.Z` → GitHub Release com `.msi/.exe`, `.dmg`, `.AppImage/.deb` |

Proibido: componentes com licença restrita a produtos Microsoft/JetBrains (vsdbg, cpptools, C# Dev Kit) e qualquer material obtido por descompilação de produtos proprietários.

## Regras de código

- **Clean code:** nomes que dizem o que a coisa faz, funções pequenas com uma responsabilidade, sem código morto, sem comentário que repete o código.
- **SOLID:**
  - S — cada classe/struct tem um motivo para mudar.
  - O — nova linguagem, depurador ou sistema de build entra como novo adaptador, sem editar o núcleo.
  - L — todo adaptador cumpre o contrato da sua interface (trait) sem casos especiais.
  - I — interfaces pequenas e focadas (ex.: `Completion` separado de `Diagnostics`).
  - D — o núcleo depende de interfaces (traits); implementações concretas são injetadas na inicialização.
- **Orientação a objetos:** no Rust, objetos são `struct` + `impl`, interfaces são `trait`, polimorfismo via `dyn Trait` / genéricos, e composição no lugar de herança. No TypeScript, classes e interfaces.
- **Sem travamentos:** nada bloqueia a thread de UI; todo I/O e processo externo é assíncrono; a queda de um servidor de linguagem não derruba a IDE.
