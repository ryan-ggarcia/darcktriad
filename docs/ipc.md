# Contrato IPC: núcleo ↔ interface (v0.2)

Tudo o que a interface pode pedir ao núcleo Rust para cumprir [editor.md](specs/editor.md), [explorador.md](specs/explorador.md) e [paleta-de-comandos.md](specs/paleta-de-comandos.md). A implementação está em `src-tauri/src/main.rs`.

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

interface ProjectFiles {
  root: Path | null;  // pasta a que `files` se refere; null sem pasta aberta
  files: string[];    // arquivos relativos a `root`, com o separador do sistema, em ordem de caminho
  indexing: boolean;  // verdadeiro: o índice ainda está sendo montado e `files` é parcial
}

// `label` é texto literal: o núcleo escapa `&` (não há tecla de atalho sublinhada nos rótulos).
type MenuEntry =
  | { kind: 'command'; id: string; label: string; accelerator?: string | null; role?: EditRole | null }
  | { kind: 'submenu'; label: string; items: MenuEntry[] }
  | { kind: 'separator' };

/** Ação de edição nativa; só faz diferença no macOS (ver `set_menu`). */
type EditRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';
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
- `open_folder` também começa a montar, em segundo plano, o índice do Abrir rápido (`project_files`). A resposta não espera o índice.
- `open_folder` pode demorar no Linux em pastas enormes, porque o observador percorre a árvore. Chame `list_dir` da raiz em paralelo para mostrar a árvore sem esperar.
- `close_folder` para de observar e esvazia o índice do Abrir rápido. Chame `save_session` antes.
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

### Abrir rápido (Ctrl+P)

| Comando | Parâmetros | Retorno | Erros |
|---|---|---|---|
| `project_files` | — | `ProjectFiles` | — |

- O índice segue as regras do VS Code:
  - respeita o `.gitignore` e o `.ignore` de cada pasta dentro da pasta aberta, mesmo sem repositório git;
  - não usa o `.gitignore` global nem os de pastas acima da aberta;
  - deixa de fora os itens escondidos do explorador (`.git` etc.), mas mantém os nomes com ponto (`.gitignore`, `.clang-format`);
  - não segue links simbólicos; um link para arquivo entra como arquivo.
- O índice é atualizado pelos mesmos lotes do `fs-changed`. Mudar um `.gitignore` ou `.ignore` relê a pasta dele.
- **Caminho absoluto de um item:** `root` + separador + item, sem repetir o separador se `root` já terminar nele (raiz do disco, `C:\`). O separador é o de `separatorOf(root)`. Use-o para `read_file` e para as abas.
- **Fluxo:**
  - Ao abrir o Ctrl+P, chame `project_files`.
  - Se `root` não for a pasta aberta agora, descarte a resposta.
  - Com `indexing: true`, mostre o que veio e o texto "Indexando…".
  - Enquanto a caixa estiver aberta, chame de novo a cada `project-files-changed`. O evento chega a cada ~250 ms durante a montagem e uma vez quando ela termina (`indexing: false`).
  - Depois disso, o evento só chega quando a lista muda (arquivo criado, removido ou renomeado). Salvar um arquivo não dispara o evento.
- Com 50.000 arquivos, a resposta tem cerca de 1,5 MB. Guarde a última lista e só peça de novo quando chegar `project-files-changed`.

### Menu nativo

| Comando | Parâmetros | Retorno | Erros |
|---|---|---|---|
| `set_menu` | `{ items: MenuEntry[] }` | `void` | `invalidInput` (atalho que o macOS não entende); `other` |

- Troca o menu inteiro da janela. O nível de cima são os submenus da barra (Arquivo, Editar…). Chame ao iniciar e de novo sempre que um rótulo, um atalho ou a lista de pastas recentes mudar. "Pastas recentes" é um `submenu` com um `command` por pasta, com o id que a interface quiser.
- Clicar num `command` emite `menu-command` com o `id` dele. A interface executa o comando pelo registro, conferindo se ele está disponível agora.
- `accelerator`: o atalho no formato do Tauri, já o do sistema em que a interface roda: `Ctrl+Shift+P`, `F1`, `Ctrl+K Ctrl+O` no Windows e no Linux; `Cmd+Shift+P`, `Ctrl+G` no macOS. Sem atalho: omita ou mande `null`.
- **Windows e Linux:** o atalho aparece no menu só como texto, depois de uma tabulação. A tecla continua indo só para a página, e o despachante da interface é o único que a trata. Registrado no menu, o atalho roubaria a tecla da webview no Linux.
- **macOS:**
  - O atalho é registrado no menu. A página recebe a tecla antes do menu: chame `preventDefault()` em todo atalho que o despachante tratar, senão o menu também age.
  - O núcleo põe antes dos itens da interface o menu do app, com "Sobre o Dark Triad" (painel nativo) e "Sair do Dark Triad" (⌘Q). Esse Sair fecha a janela pelo mesmo caminho do botão fechar (`onCloseRequested`), que pergunta sobre arquivos não salvos. Não mande "Arquivo: Sair" no macOS.
  - O menu não tem "Fechar janela", então ⌘W fica livre para "Fechar editor". Até o primeiro `set_menu`, vale o menu padrão do Tauri.
  - Itens com `role` viram os itens nativos de edição, com o rótulo enviado e o atalho padrão do sistema. Mande Desfazer, Refazer, Recortar, Copiar, Colar e Selecionar tudo com `role`: sem eles, ⌘C, ⌘V e companhia não chegam aos campos de texto da página. Clicar num item com `role` faz a ação nativa e não emite `menu-command`. Fora do macOS, `role` é ignorado e o item é um `command` comum.

### Teclado

- **Windows:** o núcleo desliga os atalhos de navegador do WebView2 (`AreBrowserAcceleratorKeysEnabled`): F5, Ctrl+R, Ctrl+P, Ctrl+F e Ctrl+J não fazem nada sozinhos. Todas essas teclas continuam chegando à página como `keydown`, e Ctrl+A/C/V/X/Z/Y continuam editando o texto.
- **Linux:** o WebKitGTK não tem atalhos de navegador próprios (recarregar, imprimir e localizar são do navegador que o usa). O inspetor só existe com as ferramentas de desenvolvedor ligadas.
- **Ferramentas de desenvolvedor:** ligadas só no build de depuração, nos três sistemas. No build de release não existem.

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

O índice do Abrir rápido se atualiza sozinho com esses lotes; a interface não precisa repassá-los.

### `project-files-changed`

Sem payload (`null`). A lista de `project_files` mudou ou terminou de ser montada. Veja o fluxo em [Abrir rápido](#abrir-rápido-ctrlp).

### `menu-command`

Payload: `string`, o `id` do item clicado no menu nativo (`set_menu`).

## Fluxos

- **Ao iniciar:** chame `recent_folders()`. Se a primeira tem `exists: true`, chame `open_folder`. Se não, mostre a tela inicial. Clicar numa recente riscada chama `remove_recent_folder`.
- **Restaurar abas:** depois de `open_folder`, chame `read_file` para cada caminho de `session.openFiles`, na ordem. Pule os que devolverem `notFound` e ative `session.activeFile`. O conteúdo vem do disco: alterações não salvas não são guardadas no MVP.
- **Abrir pasta / abrir arquivo:** `pick_folder` → `open_folder`; `pick_file` → `read_file`.
- **Fechar a janela:** use `getCurrentWindow().onCloseRequested(...)` de `@tauri-apps/api/window`. Com abas modificadas, chame `event.preventDefault()`, faça a pergunta única e, no fim, chame `save_session` e `getCurrentWindow().destroy()`. A permissão `core:window:allow-destroy` já está liberada. Sem `preventDefault`, a janela fecha sozinha.

## Limites conhecidos

- Só a pasta aberta é observada. Um arquivo aberto de fora dela (ou sem pasta aberta) não recarrega sozinho quando muda no disco. A checagem de `conflict` ao salvar continua protegendo os dados.
- No macOS, os caminhos do `fs-changed` vêm canônicos. Se o caminho da pasta aberta passar por um link simbólico (ex.: `/tmp` → `/private/tmp`), eles não vão bater com os da árvore.
- O diálogo nativo não oferece "arquivo ou pasta" num só diálogo. No macOS, ⌘O precisa escolher entre `pick_folder` e `pick_file`.
- Abrir rápido:
  - Arquivos cujo nome não é UTF-8 válido não entram na lista.
  - Com `watchError`, o índice não acompanha as mudanças até a pasta ser aberta de novo.
  - Mudanças no `.git/info/exclude` só valem depois de reabrir a pasta, porque o observador ignora `.git`.
- Menu no Linux: o texto do atalho fica alinhado pela tabulação, não à direita como no Windows.
