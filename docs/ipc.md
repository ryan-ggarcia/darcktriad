# Contrato IPC: núcleo ↔ interface (v0.4)

Tudo o que a interface pode pedir ao núcleo Rust para cumprir [editor.md](specs/editor.md), [explorador.md](specs/explorador.md) e [paleta-de-comandos.md](specs/paleta-de-comandos.md), [terminal.md](specs/terminal.md) e [projeto.md](specs/projeto.md) (parte CMake). A implementação está em `src-tauri/src/main.rs`.

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

interface TerminalInfo {
  id: number;
  name: string; // nome do shell para a lista: 'pwsh', 'powershell', 'bash', 'zsh'…
}

type TerminalEvent =
  | { kind: 'output'; data: string }        // texto com as sequências de escape intactas: passe direto ao xterm.js
  | { kind: 'exited'; code: number | null }; // o shell terminou; sempre o último evento do terminal

type ProjectKind = 'cmake' | 'cmakePresets' | 'dotnetSolution' | 'dotnetProjects' | 'editOnly';

type ProjectStatus =
  | { kind: 'idle' }                      // nada a configurar: sem projeto
  | { kind: 'configuring' }               // "CMake: configurando…" / ".NET: configurando…"
  | { kind: 'ready' }                     // configurado: `targets` vale
  | { kind: 'failed'; message: string };  // "CMake: erro (ver Saída)" / ".NET: erro (ver Saída)"; `message` já vem pronta

interface CMakeTarget {
  name: string; // 'app'
  path: Path;   // absoluto, pode ainda não existir antes de compilar. CMake: o executável; .NET: o TargetPath (o .dll)
}

interface Problem {
  file: Path;      // absoluto
  line: number;    // a partir de 1
  message: string; // a primeira linha do texto do erro
}

interface ProjectState {
  root: Path | null;          // null sem pasta aberta
  kind: ProjectKind;
  warning: string | null;     // ex.: "Também há um projeto .NET aqui…"
  configs: string[];          // CMake e .NET: ['Debug', 'Release']; com presets: os nomes do `cmake --list-presets`
  config: string | null;      // a configuração ativa
  status: ProjectStatus;
  buildDir: Path | null;      // CMake: a pasta de build da última configuração pronta; .NET: sempre null
  targets: CMakeTarget[];     // só executáveis; vazio enquanto configura ou com erro
  target: string | null;      // o nome do alvo ativo
  problems: Problem[];        // os erros da configuração atual (CMake, ou MSBuild/restore no .NET)
}

type ProjectEvent =
  | { kind: 'output'; line: string }          // uma linha da Saída, sem o fim de linha: canal CMake (kind cmake/cmakePresets) ou dotnet (dotnetSolution/dotnetProjects)
  | { kind: 'state'; state: ProjectState };  // o estado novo inteiro: substitua o anterior

type ToolStatus =
  | { kind: 'present'; path: Path; version: string | null }
  | { kind: 'outdated'; path: Path; version: string | null } // abaixo da versão mínima ou sem versão legível
  | { kind: 'missing' };

interface ToolCheck {
  program: string;        // 'cmake', 'clangd'…
  purpose: string;        // "para quê"
  minimum: string | null; // versão mínima
  install: string;        // o passo a passo manual
  status: ToolStatus;
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

### Terminal

| Comando | Parâmetros | Retorno | Erros |
|---|---|---|---|
| `terminal_create` | `{ cols: number, rows: number, onEvent: Channel<TerminalEvent> }` | `TerminalInfo` | `invalidInput` (`cols` ou `rows` zero); `notFound` ou `other` (o shell não iniciou) |
| `terminal_write` | `{ id: number, data: string }` | `void` | `notFound` (terminal fechado); `other` (o shell já terminou) |
| `terminal_resize` | `{ id: number, cols: number, rows: number }` | `void` | `invalidInput`, `notFound`; `other` (o shell já terminou) |
| `terminal_close` | `{ id: number }` | `void` | `notFound` |

- **Criar:** `onEvent` é um `Channel` de `@tauri-apps/api/core` (`const onEvent = new Channel<TerminalEvent>(); onEvent.onmessage = …`). Crie o canal e trate as mensagens antes de chamar `terminal_create`: a primeira saída pode chegar antes da resposta.
- **Shell e pasta:**
  - O shell é o padrão do sistema (Windows: `pwsh` se estiver no PATH, senão `powershell.exe`; macOS e Linux: `$SHELL`, ou `/bin/sh`).
  - Começa na raiz da pasta aberta, ou na pasta do usuário sem pasta aberta.
  - O ambiente é o da IDE, com `TERM=xterm-256color` e `COLORTERM=truecolor`.
- **Falha ao iniciar:** a `message` já diz qual shell foi tentado ("Não foi possível iniciar o terminal com /bin/zsh: …"). Mostre-a no lugar do terminal. A IDE segue normal.
- **Saída:**
  - Chega em lotes, no máximo um a cada ~16 ms. Chame `term.write(data)` a cada `output`.
  - Os caracteres UTF-8 nunca chegam partidos entre dois lotes.
  - O limite de 10.000 linhas de histórico fica no xterm.js (`scrollback: 10000`).
- **Teclado:** mande o `onData` do xterm.js para `terminal_write` sem mexer (Enter é `\r`, Ctrl+C é `\x03`). Colar também vai por `terminal_write`. As teclas que vão para a IDE (spec do terminal) são filtradas na interface, antes do xterm.js.
- **Ordem:** as escritas chegam ao processo na ordem em que `terminal_write` foi chamado, e `terminal_resize` segue a mesma fila: o último tamanho pedido é o que fica. Os dois só enfileiram e respondem na hora, mesmo quando o programa não lê a entrada (ex.: colar 1 MiB). Não é preciso esperar uma chamada para fazer a próxima.
- **Respostas do terminal (Windows):** o ConPTY pede a posição do cursor (`ESC[6n`) assim que o shell abre e não mostra nada até receber a resposta (`ESC[linha;colunaR`). O xterm.js responde sozinho pelo `onData`, que já vai para `terminal_write`; não filtre essas respostas. Sem isso o terminal fica em branco.
- **Tamanho:** chame `terminal_resize` sempre que o painel mudar de tamanho (ex.: com o `FitAddon`). O programa que roda no terminal recebe o tamanho novo.
- **Fim do shell:** com `exited`, escreva "Processo encerrado com código N" (sem o número quando `code` é `null`). Mantenha o terminal na lista para leitura. Não há mais saída depois de `exited`, e `terminal_write` e `terminal_resize` passam a dar `other`.
- **Fechar:** `terminal_close` encerra o shell e o que roda nele. Chame também para um terminal cujo shell já terminou, para liberá-lo. Depois do `close` ainda chega o `exited`; ignore-o.
- **Fechar a IDE:** o núcleo encerra todos os terminais sozinho. A interface não precisa fechar um por um.

### Projeto (CMake e .NET)

| Comando | Parâmetros | Retorno | Erros |
|---|---|---|---|
| `project_state` | — | `ProjectState` | — |
| `project_select_config` | `{ config: string }` | `void` | `invalidInput` (fora de `configs`); `other` (falha ao gravar a escolha) |
| `project_select_target` | `{ target: string }` | `void` | `invalidInput` (fora de `targets`); `other` |
| `project_reconfigure` | — | `void` | `invalidInput` (a pasta aberta não tem projeto CMake nem .NET) |

- **Ao abrir a pasta:** `open_folder` detecta o projeto e, se for CMake ou .NET, começa a configurar em segundo plano, sem atrasar a resposta. Acompanhe pelo evento `project-event`. Ao iniciar a interface, ou ao abrir a pasta, chame `project_state` uma vez para ter o estado inicial.
- **Barra de status:** `kind` (`cmake`/`cmakePresets` → "CMake"; `dotnetSolution`/`dotnetProjects` → ".NET"), `config` e `target`. Com `status.kind === 'configuring'`, mostre "CMake: configurando…" (ou ".NET: configurando…"). Com `failed`, mostre "CMake: erro (ver Saída)" (ou ".NET: erro (ver Saída)") e abra o painel Saída no canal do projeto. Com `kind: 'editOnly'`, "Sem projeto (só edição)". Com `warning`, mostre o aviso uma vez.
- **Configurações:**
  - Sem presets: `Debug` e `Release`, com build em `<raiz>/build/debug` ou `<raiz>/build/release`.
  - Com presets: `configs` só chega depois da primeira configuração (vem do `cmake --list-presets`). A pasta de build é a do `binaryDir` do preset.
  - .NET: `Debug` e `Release`. Trocar relê os alvos.
- **.NET:** configurar é rodar `dotnet restore` (a solução da raiz, ou cada `.csproj`), listar os projetos (`dotnet sln <sln> list`) e ler `OutputType`, `TargetPath` e `TargetFrameworks` de cada um com `dotnet msbuild -getProperty`. Os alvos são os projetos `Exe`/`WinExe`, com o nome do `.csproj` sem extensão e o `TargetPath` (o `.dll`, que roda com `dotnet <dll>`). Com vários frameworks-alvo, vale o primeiro. Salvar arquivos do projeto não reconfigura: use `project_reconfigure`. Os `dotnet` que a IDE roda têm `DOTNET_CLI_TELEMETRY_OPTOUT=1` e `DOTNET_NOLOGO=1`.
- **Selecionar configuração:** `project_select_config` guarda a escolha da pasta e configura de novo. Responde quando a configuração termina; o resultado (pronto ou erro) vem no estado, não como erro do comando.
- **Selecionar alvo:** `project_select_target` só aceita um nome de `targets` e guarda a escolha. Não configura.
- **Escolha guardada:** a configuração e o alvo ficam salvos por pasta, na pasta de dados do app. Ao reabrir, valem se ainda existirem; senão, o primeiro da lista.
- **Uma configuração por vez:** pedir outra (trocar configuração, reconfigurar ou salvar um arquivo do CMake) durante uma em andamento cancela a atual. O cmake/dotnet e o que ele iniciou morrem antes de a nova começar, e nada da antiga chega depois do aviso da nova.
- **Reconfigurar ao salvar:** salvar `CMakeLists.txt`, `*.cmake`, `CMakePresets.json` ou `CMakeUserPresets.json` dentro da pasta aberta reconfigura 1 s depois do último salvamento. O que o próprio CMake grava nas pastas de build não conta. A interface não precisa fazer nada.
- **Canal da Saída:** o evento não diz o canal: ele é o do `kind` do estado (CMake ou dotnet). Um estado novo sempre chega antes das linhas da configuração dele. Cada `output` é uma linha. A primeira de cada execução é o comando, começando com `> `. No .NET, só o `dotnet restore` vai ao vivo; a lista de projetos e a leitura das propriedades só aparecem se derem erro. Limpe o canal quando quiser (ex.: a cada `configuring`); o núcleo não guarda o histórico.
- **Problemas:** cada linha `CMake Error at <arquivo>:<linha>` (CMake) ou `<arquivo>(<linha>,<coluna>): error <CÓDIGO>: <texto>` (MSBuild/restore, quando o dotnet falha) vira um item de `problems`, com o arquivo absoluto. Clicar abre o arquivo na linha (`read_file`). A lista é zerada a cada configuração, então o erro some quando a configuração seguinte passa.
- **Fechar a pasta ou a IDE:** a configuração em andamento é cancelada, e o cmake/dotnet não sobrevive.

### Ferramentas

| Comando | Parâmetros | Retorno | Erros |
|---|---|---|---|
| `tools_check` | — | `ToolCheck[]` | `notFound` (sem pasta de dados do app) |

- Uma linha por ferramenta, na ordem da tabela de [projeto.md](specs/projeto.md): `cmake`, `ninja`, `clangd`, `lldb-dap`, `gdb`, `dotnet`, `roslyn-language-server`, `netcoredbg`.
- **Onde procura:** `PATH`, depois os caminhos conhecidos, depois `<dados do app>/tools/`. Vale a primeira que atende a versão mínima.
  - Linux: `clangd-<N>` e `lldb-dap-<N>` do `PATH`, da maior versão para a menor.
  - macOS: `xcrun --find` (só com as Command Line Tools instaladas), `/opt/homebrew/opt/llvm/bin` e `/usr/local/opt/llvm/bin`.
  - `dotnet`: `DOTNET_ROOT` e `~/.dotnet`. `roslyn-language-server`: `~/.dotnet/tools`.
- `present`: ✓ com `path` e `version`. `outdated`: "versão antiga (mínimo `minimum`)". `missing`: ✗ com `purpose` e `install`.
- Cada chamada roda `--version` de cada ferramenta encontrada (até 5 s cada). "Verificar de novo" é chamar de novo.

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

### `project-event`

Payload: `ProjectEvent`. As linhas da Saída do projeto (`output`, canal CMake ou dotnet) e cada mudança do projeto (`state`), na ordem em que acontecem. Veja [Projeto (CMake e .NET)](#projeto-cmake-e-net).

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
- Projeto:
  - .NET: salvar `.csproj`/`.sln` não reconfigura (use `project_reconfigure`), e erros de restore sem linha e coluna (ex.: `NU1101`) só aparecem na Saída.
  - Windows: o ambiente do vcvars ainda não é aplicado (o compilador precisa estar no `PATH`), a busca de ferramentas não olha `C:\Program Files\LLVM\bin`, e cancelar a configuração mata o cmake mas não os processos que ele iniciou.
  - No macOS, a reconfiguração ao salvar depende dos caminhos do `fs-changed`, que vêm canônicos (veja abaixo).
  - O `PATH` usado para achar o cmake e as ferramentas é o da IDE. No macOS, aberta pelo Finder, ela não tem o `PATH` do `~/.zprofile` (Homebrew).
- Terminal:
  - O ambiente do MSVC no Windows ainda não é aplicado; ele chega com [projeto.md](specs/projeto.md).
  - No macOS e no Linux, fechar o terminal manda SIGHUP a todos os processos da sessão do shell (o shell e o que ele iniciou, em primeiro ou segundo plano). Se o shell não sair em 0,5 s, todos eles levam SIGKILL. Um programa que ignora o SIGHUP (ex.: `nohup … &`) continua rodando se o shell saiu com o SIGHUP, porque depois disso o núcleo não manda mais sinais (o PID do shell pode ser de outro processo). Programas que saíram da sessão (`setsid`, daemons) também continuam.
  - No macOS o shell não é de login: quem abre a IDE pelo Finder não tem no terminal o PATH do `~/.zprofile` (Homebrew, CMake, dotnet).
