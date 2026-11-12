# Dark Triad

IDE para C, C++ e C#. Stack e regras em [docs/STACK.md](docs/STACK.md).

## Desenvolvimento

Requisitos: Rust (rustup), Node.js e os [pré-requisitos do Tauri](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev      # abre a IDE em modo desenvolvimento
cargo test --workspace # testes do núcleo
npm test               # testes da interface
npm run tauri build    # gera os instaladores do seu sistema
```

## Release

1. Atualize `version` em `src-tauri/Cargo.toml` (ex.: `0.2.0`), faça o commit e o push, e espere o CI ficar verde.
2. Crie e envie a tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. O workflow Release gera um rascunho com os instaladores de Windows, macOS e Linux e o `latest.json`.
4. Só depois de o run da Release terminar verde, publique o rascunho marcado como Latest e confira se "Notas da atualização" (`release-notes.yml`) ficou verde. A IDE procura a versão nova na release Latest: publique sempre da mais antiga para a mais nova. Detalhes em [docs/RISCOS.md](docs/RISCOS.md) › Atualização automática.
