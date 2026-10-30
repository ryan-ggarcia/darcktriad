# Dark Triad

IDE para C, C++ e C#. Stack e regras em [docs/STACK.md](docs/STACK.md).

## Desenvolvimento

Requisitos: Rust (rustup), Node.js e os [pré-requisitos do Tauri](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev      # abre a IDE em modo desenvolvimento
cargo test --workspace # testes
npm run tauri build    # gera os instaladores do seu sistema
```

## Release

1. Atualize `version` em `src-tauri/Cargo.toml` (ex.: `0.2.0`).
2. Crie e envie a tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. O GitHub Actions gera um release em rascunho com os instaladores de Windows, macOS e Linux.
4. O QA testa os instaladores e publica o release.
