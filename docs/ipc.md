# Contrato IPC: núcleo ↔ interface (v0.1)

Tudo o que a interface pode pedir ao núcleo Rust para cumprir [editor.md](specs/editor.md) e [explorador.md](specs/explorador.md). A implementação está em `src-tauri/src/main.rs`.

- **Comandos:** `invoke<T>('nome', { ...parâmetros })`, de `@tauri-apps/api/core`. Todos são assíncronos e rodam fora da thread de UI.
- **Eventos:** `listen<T>('nome', handler)`, de `@tauri-apps/api/event`.
- **Nomes:** parâmetros e campos chegam em camelCase, como nesta página.
- **Caminhos:** strings absolutas no formato do sistema (`C:\proj\app\main.cpp` no Windows, `/home/x/proj/app/main.cpp` no Linux e no macOS). O núcleo recusa caminho relativo ou com `..`. Use os caminhos que o próprio núcleo devolveu (`Entry.path`, `pickFolder` etc.) em vez de montá-los à mão.

## Tipos

```ts
type Path = string;

/** Rejeição de todos os comandos. `message` já vem pronta para mostrar ao usuário. */
interface AppError {
  kind: ErrorKind;
  message: string;
}

type ErrorKind =
  | 'notFound'          // o item não existe
  | 'alreadyExists'     // já existe item com esse nome na pasta
  | 'permissionDenied'  // sem permissão (inclui arquivo somente leitura ao salvar)
  | 'invalidInput'      // caminho ou nome inválido, fora da pasta aberta, ou nenhuma pasta aberta
  | 'conflict'          // o arquivo mudou no disco depois da última leitura
  | 'readOnly'          // o editor não grava por cima deste arquivo (binário, > 50 MB ou não UTF-8)
  | 'trashFailed'       // a lixeira recusou o item
  | 'other';            // demais falhas de disco (ex.: disco cheio); `message` diz o motivo

interface Entry {
  name: string;
  path: Path;
  isDir: boolean;      // para link simbólico, o tipo do alvo; link quebrado vem como arquivo
  isSymlink: boolean;  // mostrar o indicador "↗"
}

type Eol = 'lf' | 'crlf';

type FileContent =
  | {
      kind: 'text';
      content: string;   // sem o BOM
      eol: Eol;          // o fim de linha predominante; sem quebra de linha, o padrão do sistema
      bom: boolean;      // o arquivo tinha BOM UTF-8
      readOnly: boolean; // não é UTF-8 válido: `content` vem com � no lugar dos bytes inválidos
      version: string;   // opaca: só compare por igualdade
    }
  | { kind: 'binary' }                  // byte NUL nos primeiros 8 KB; conteúdo não carregado
  | { kind: 'tooLarge'; size: number }; // > 50 MB (52.428.800 bytes); `size` em bytes

interface Session {
  openFiles: Path[];        // na ordem das abas
  activeFile: Path | null;
}

interface OpenedFolder {
  path: Path;
  session: Session;          // abas salvas para esta pasta (vazia na primeira vez)
  watchError: string | null; // não nulo: mudanças externas não serão detectadas
}

interface RecentFolder {
  path: Path;
  exists: boolean; // falso: mostrar riscada
}

interface ChangeBatch {
  paths: Path[];   // itens criados, alterados, removidos ou renomeados (origem e destino), sem repetição
  rescan: boolean; // eventos podem ter se perdido: recarregue tudo o que está visível
}
```

Se um parâmetro vier com o tipo errado (ex.: `eol: 'cr'`), o Tauri rejeita com uma **string**, não com `AppError`. Trate os dois casos no tratador de erros.

## Comandos

### Pasta, recentes e sessão

| Comando | Parâmetros | Retorno | Erros |
|---|---|---|---|
| `open_folder` | `{ path: Path }` | `OpenedFolder` | `invalidInput`; `notFound` (não existe ou não é pasta) |
| `close_folder` | — | `void` | — |
| `recent_folders` | — | `RecentFolder[]` | — |
| `remove_recent_folder` | `{ path: Path }` | `void` | `invalidInput`; `other` (falha ao gravar o estado) |
| `save_session` | `{ session: Session }` | `void` | `invalidInput` (nenhuma pasta aberta ou caminho inválido); `other` |

- `open_folder` passa a observar a pasta (evento `fs-changed`), substitui a pasta anterior e põe esta no topo das recentes. Se `watchError` não for nulo, mostre a faixa fixa "Mudanças externas não são detectadas automaticamente: use Atualizar." A pasta abre mesmo assim.
- `open_folder` pode demorar no Linux em pastas enormes, porque o observador percorre a árvore. Chame `list_dir` da raiz em paralelo para mostrar a árvore sem esperar.
- `close_folder` para de observar. Chame `save_session` antes.
- `recent_folders` vem da mais recente para a mais antiga, no máximo 10. A primeira é a última pasta usada.
- `save_session` grava as abas da pasta aberta, na pasta de dados do app. Chame sempre que a lista, a ordem ou a aba ativa mudarem, e antes de fechar a pasta ou a janela. Abas sem título não entram.

### Explorador

| Comando | Parâmetros | Retorno | Erros |
|---|---|---|---|
| `list_dir` | `{ path: Path }` | `Entry[]` | `invalidInput`, `notFound`, `permissionDenied`, `other` |
| `create_file` | `{ parent: Path, name: string }` | `Path` do arquivo criado | `invalidInput`, `alreadyExists`, `permissionDenied`, `other` |
| `create_dir` | `{ parent: Path, name: string }` | `Path` da pasta criada | idem |
| `rename_entry` | `{ path: Path, newName: string }` | `Path` novo | idem, mais `notFound` |
| `move_to_trash` | `{ path: Path }` | `void` | `invalidInput`, `notFound`, `trashFailed` |
| `delete_permanently` | `{ path: Path }` | `void` | `invalidInput`, `notFound`, `permissionDenied`, `other` |

- `list_dir` já vem sem `.git`, `.svn`, `.hg`, `.jj`, `.DS_Store` e `Thumbs.db`, com as pastas primeiro e cada grupo em ordem alfabética sem diferenciar maiúsculas. Com `permissionDenied`, o nó mostra "Sem permissão para ler".
- As operações que alteram o disco só valem **dentro da pasta aberta**. A própria raiz não pode ser renomeada nem excluída. Sem pasta aberta, elas devolvem `invalidInput`.
- **Nome** (`name`, `newName`): não pode ser vazio, só espaços, `.`, `..`, nem conter `/` ou `\`. Nada é criado nem renomeado quando o nome é inválido ou já existe.
- `alreadyExists` já vem com a mensagem "Já existe X nesta pasta". Mostre `message`.
- `rename_entry` nunca sobrescreve outro item. Trocar só maiúsculas (`main.cpp` → `Main.cpp`) funciona no Windows. A interface atualiza as abas: toda aba cujo caminho é o antigo, ou começa com o antigo seguido de separador (`\` no Windows, `/` nos outros), passa a usar o novo prefixo e mantém as alterações não salvas.
- **Excluir:** pergunte "Mover X para a lixeira?" e chame `move_to_trash`. Com `trashFailed`, pergunte "Excluir X permanentemente? Não dá para desfazer." e, se o usuário confirmar, chame `delete_permanently`. Link simbólico: os dois apagam o link, nunca o alvo.
- **Copiar caminho:** `Entry.path`. **Copiar caminho relativo:** `path.slice(raiz.length + 1)`. Os dois ficam na interface (`navigator.clipboard`).

### Editor

| Comando | Parâmetros | Retorno | Erros |
|---|---|---|---|
| `read_file` | `{ path: Path }` | `FileContent` | `invalidInput`, `notFound`, `permissionDenied`, `other` |
| `save_file` | `{ path: Path, content: string, eol: Eol, bom: boolean, expectedVersion: string \| null }` | `string`: a nova versão | `invalidInput`, `conflict`, `readOnly`, `permissionDenied`, `notFound`, `other` |
| `default_eol` | — | `Eol` | — |

- `read_file` aceita qualquer arquivo do disco, não só os da pasta aberta (Ctrl+O, ir para definição).
  - `binary`: a aba mostra "Arquivo binário: não exibido no editor".
  - `tooLarge`: a aba mostra "Arquivo grande demais para o editor (N MB)", com N = `size / 1048576`.
  - `text` com `readOnly`: o editor fica somente leitura, com a faixa "Codificação não suportada nesta versão: somente leitura".
  - Guarde `version`, `eol` e `bom` na aba. A barra de status mostra `eol` (`LF`/`CRLF`). No Monaco, ajuste o modelo com `setEOL` para o mesmo fim de linha.
- `save_file` grava num arquivo temporário da mesma pasta e renomeia por cima. Uma queda no meio não deixa o arquivo pela metade, e uma falha deixa o original intacto.
  - O núcleo converte todas as quebras de `content` para `eol` e põe o BOM se `bom` for `true`. Envie o `eol` e o `bom` que vieram do `read_file`.
  - `expectedVersion`: a `version` da última leitura ou do último salvamento. Se o disco tiver outra versão, a resposta é `conflict` e nada é gravado. Pergunte **Sobrescrever** ou **Cancelar**. Sobrescrever chama de novo com `expectedVersion: null`.
  - Arquivo que sumiu do disco é recriado sem `conflict`. Isso atende a aba "(excluído)" que salva de novo.
  - `readOnly`: o arquivo no disco é binário, maior que 50 MB ou não UTF-8, e nada é gravado.
  - `permissionDenied`, `notFound` (a pasta pai sumiu) ou `other` (ex.: disco cheio): mostre `message`. A aba continua modificada.
  - Em caso de sucesso, guarde a versão devolvida na aba e tire o ●.
  - Não chame `save_file` duas vezes em paralelo para o mesmo arquivo: a segunda chamada recebe `conflict`. Espere a primeira terminar.
  - Link simbólico: grava no alvo e mantém o link. As permissões do arquivo (ex.: `+x` no Linux e no macOS) são preservadas.
- `default_eol`: o fim de linha de um arquivo novo. `crlf` no Windows, `lf` no macOS e no Linux.

### Diálogos nativos

| Comando | Parâmetros | Retorno | Erros |
|---|---|---|---|
| `pick_folder` | — | `Path \| null` | — |
| `pick_file` | — | `Path \| null` | — |
| `pick_save_path` | `{ directory?: Path \| null, fileName?: string \| null }` | `Path \| null` | `invalidInput` |

- `null` significa que o usuário cancelou.
- O diálogo de salvar já pergunta se o usuário quer substituir um arquivo existente. Depois dele, chame `save_file` com `expectedVersion: null`.
- **Ctrl+N → Ctrl+S:** chame `pick_save_path({ directory: raiz, fileName: 'Sem título-1' })`, depois `save_file` com `eol: await invoke('default_eol')` e `bom: false`. A aba passa a usar o caminho escolhido.
- **Salvar como:** `pick_save_path({ directory: pasta do arquivo, fileName: nome atual })`.

## Eventos

### `fs-changed`

Payload: `ChangeBatch`. Chega em lotes de cerca de 200 ms para toda mudança dentro da pasta aberta, menos acessos (leituras) e menos o que está dentro dos itens escondidos (`.git` etc.). Os links simbólicos não são seguidos.

O que a interface faz com o lote:

1. **Árvore:** para cada caminho, recarregue com `list_dir` a pasta pai, se estiver expandida, e o próprio caminho, se for uma pasta expandida. Preserve o que está expandido e selecionado. Os caminhos podem incluir temporários de salvamento (`.nome.<pid>-<n>.tmp`) que já sumiram: recarregar a pasta pai resolve.
2. **Abas:** para cada caminho com aba aberta, chame `read_file`:
   - `notFound`: marque a aba "(excluído)" e mantenha o texto;
   - mesma `version` da aba: ignore (é o eco do próprio salvamento);
   - aba sem alterações: recarregue o conteúdo, mantendo cursor e rolagem;
   - aba com alterações: mostre a faixa "Este arquivo mudou no disco", com **Recarregar do disco** e **Manter minha versão**. Manter não muda a `version` da aba, e o próximo salvamento cai em `conflict`.
3. **`rescan: true`:** recarregue todas as pastas expandidas e confira todas as abas como no item 2.

## Fluxos

- **Ao iniciar:** chame `recent_folders()`. Se a primeira tem `exists: true`, chame `open_folder`. Se não, mostre a tela inicial. Clicar numa recente riscada chama `remove_recent_folder`.
- **Restaurar abas:** depois de `open_folder`, chame `read_file` para cada caminho de `session.openFiles`, na ordem. Pule os que devolverem `notFound` e ative `session.activeFile`. O conteúdo vem do disco: alterações não salvas não são guardadas no MVP.
- **Abrir pasta / abrir arquivo:** `pick_folder` → `open_folder`; `pick_file` → `read_file`.
- **Fechar a janela:** use `getCurrentWindow().onCloseRequested(...)` de `@tauri-apps/api/window`. Com abas modificadas, chame `event.preventDefault()`, faça a pergunta única e, no fim, chame `save_session` e `getCurrentWindow().destroy()`. A permissão `core:window:allow-destroy` já está liberada. Sem `preventDefault`, a janela fecha sozinha.

## Limites conhecidos

- Só a pasta aberta é observada. Um arquivo aberto de fora dela (ou sem pasta aberta) não recarrega sozinho quando muda no disco. A checagem de `conflict` ao salvar continua protegendo os dados.
- No macOS, os caminhos do `fs-changed` vêm canônicos. Se o caminho da pasta aberta passar por um link simbólico (ex.: `/tmp` → `/private/tmp`), eles não vão bater com os da árvore.
- O diálogo nativo não oferece "arquivo ou pasta" num só diálogo. No macOS, ⌘O precisa escolher entre `pick_folder` e `pick_file`.
