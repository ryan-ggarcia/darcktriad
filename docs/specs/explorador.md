# Explorador de arquivos

Status: **MVP (v0.1)** · Depende de: [editor.md](editor.md) · Hoje: existe só `list_dir` (lista uma pasta, com as pastas primeiro)

## Problema do usuário

Quero abrir a pasta do meu projeto e ver os arquivos em árvore. Quero criar, renomear e excluir arquivos sem sair da IDE, e ver as mudanças feitas por fora (git, build) sem apertar "atualizar".

## O que as IDEs de referência fazem

- **VS Code:**
  - O Explorador mostra a pasta aberta em árvore.
  - Cria, renomeia e exclui arquivos e pastas, e move itens arrastando.
  - Aceita seleção múltipla com Ctrl/Shift.
  - Arquivos arrastados de fora são copiados.

  [User Interface: Explorer](https://code.visualstudio.com/docs/getstarted/userinterface)
- **VS Code:**
  - `files.exclude` esconde itens do Explorador. O padrão esconde `**/.git`, `**/.svn`, `**/.hg`, `**/.jj`, `**/.DS_Store` e `**/Thumbs.db`.
  - Também pode esconder o que está no `.gitignore` (`explorer.excludeGitIgnore`, desligado por padrão).

  Fontes: [User Interface](https://code.visualstudio.com/docs/getstarted/userinterface) e [files.contribution.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/files/browser/files.contribution.ts) (MIT).
- **VS Code**, atalhos do Explorador (com foco nele):
  - F2 renomeia (Enter no macOS);
  - Delete move para a lixeira (⌘⌫ no macOS);
  - Shift+Delete exclui de vez;
  - Ctrl+C/X/V copia, recorta e cola arquivos;
  - Enter abre o item.

  Fontes: [fileActions.contribution.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/files/browser/fileActions.contribution.ts) e [listCommands.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/actions/listCommands.ts) (MIT).
- **CLion:**
  - A janela Project (Alt+1) mostra o projeto em visões diferentes ("Project", "Project Files", "Open Files").
  - Marca pastas excluídas com ícone próprio.
  - Agrupa bibliotecas externas.
  - Pode selecionar sozinha o arquivo aberto ("Always Select Opened File").

  [Project tool window](https://www.jetbrains.com/help/clion/project-tool-window.html)
- **Visual Studio:**
  - O Gerenciador de Soluções (Ctrl+Alt+L) mostra solução, projetos, dependências e arquivos.
  - Alterna entre a visão de solução e a visão de pastas.
  - Tem "Mostrar todos os arquivos" e "Sincronizar com documento ativo".

  [Solution Explorer](https://learn.microsoft.com/en-us/visualstudio/ide/use-solution-explorer)

**Decisão:** a visão por solução ou alvos (Visual Studio, CLion) mistura o que está no disco com o que está no build. Para "simples e claro", o explorador mostra **só o disco**, como o VS Code. Projetos e alvos aparecem na barra de status ([projeto.md](projeto.md)).

## Comportamento esperado no Dark Triad

**Abrir pasta**

1. Há três caminhos: Ctrl+K Ctrl+O (Windows/Linux), ⌘O no macOS (diálogo que aceita arquivo ou pasta) e o botão **Abrir pasta** na tela inicial. O diálogo usado é o nativo.
2. A IDE abre uma pasta por janela. Abrir outra pasta substitui a atual, depois de perguntar sobre arquivos não salvos ([editor.md](editor.md)).
3. **Tela inicial** (sem pasta aberta):
   - botões **Abrir pasta** e **Abrir arquivo**, com o atalho escrito ao lado;
   - lista das 10 pastas recentes;
   - um clique numa pasta recente abre a pasta;
   - uma pasta recente que não existe mais aparece riscada e sai da lista ao ser clicada.
4. Ao iniciar, a IDE reabre a última pasta usada, se ela ainda existir.
5. **Fechar pasta** (Ctrl+K F) volta para a tela inicial.

**Árvore**

1. A raiz é a pasta aberta, com o nome em destaque no topo do painel.
2. **Carregamento sob demanda:** só lê uma pasta quando ela é expandida. A ordem é a que já existe no núcleo: pastas primeiro, depois arquivos, cada grupo em ordem alfabética sem diferenciar maiúsculas.
3. **Itens escondidos:** `.git`, `.svn`, `.hg`, `.jj`, `.DS_Store` e `Thumbs.db` (o mesmo padrão do VS Code). Todo o resto aparece, inclusive `build/`, `bin/`, `obj/` e o que está no `.gitignore`, porque "sumir" com arquivos confunde.
4. **Lista virtualizada:** só desenha as linhas visíveis. Uma pasta com milhares de itens não trava a interface.
5. **Ícones:** só pasta aberta, pasta fechada e arquivo. Mais um ícone simples para `.c`, `.cpp`/`.h`, `.cs`, `CMakeLists.txt` e `.csproj`/`.sln`.
6. **Links simbólicos:** aparecem como o tipo do alvo (pasta ou arquivo), com um pequeno indicador "↗". O observador de mudanças **não** segue links simbólicos, para não cair em ciclos.
7. **Erro ao ler uma pasta** (ex.: sem permissão): o nó mostra "Sem permissão para ler" em vez dos filhos. Nada mais é afetado.

**Mouse e teclado** (acessibilidade: tudo funciona sem mouse)

1. Um clique num arquivo abre o arquivo numa aba ([editor.md](editor.md)). Um clique numa pasta expande ou recolhe.
2. Setas ↑/↓ movem a seleção.
3. → expande a pasta (ou desce para o primeiro filho). ← recolhe a pasta (ou sobe para a pasta pai).
4. Enter abre o item (no macOS, ⌘↓).
5. Digitar letras com o foco na árvore pula para o próximo item visível que começa com elas.

**Operações**

1. **Onde estão:**
   - quatro botões no topo do painel, cada um com dica que inclui o atalho: **Novo arquivo**, **Nova pasta**, **Atualizar**, **Recolher tudo**;
   - menu de contexto (botão direito) com: Novo arquivo, Nova pasta, Renomear, Excluir, Copiar caminho, Copiar caminho relativo.
2. **Novo arquivo e nova pasta:**
   - Criam o item dentro da pasta selecionada (ou na pasta do arquivo selecionado), com o nome editado em linha.
   - Enter confirma; Esc cancela.
   - O nome não pode ser vazio, conter `/` ou `\` nem repetir um item da mesma pasta. Se repetir, aparece a mensagem "Já existe X nesta pasta" e nada é criado.
   - Um arquivo novo abre automaticamente no editor.
3. **Renomear** (F2; Enter no macOS):
   - Edição em linha, com as mesmas validações.
   - As abas abertas do item (ou de arquivos dentro da pasta renomeada) passam a apontar para o novo caminho e mantêm alterações não salvas.
4. **Excluir** (Delete; ⌘⌫ no macOS):
   - Pede confirmação ("Mover X para a lixeira?") e move para a **lixeira do sistema**.
   - Se a lixeira não estiver disponível, a pergunta muda para "Excluir X permanentemente? Não dá para desfazer."
   - Abas abertas de arquivos excluídos seguem a regra "(excluído)" do [editor.md](editor.md).
5. **Mudanças externas:**
   - A IDE observa a pasta com `notify`, recursivamente, ignorando os itens escondidos.
   - Criar, excluir ou renomear algo por fora aparece na árvore em até 1 s, preservando o que está expandido e selecionado.
   - Os eventos são agrupados em lotes, para que um build que gera mil arquivos não congele a árvore.
   - Se o observador não puder ser criado (ex.: limite de inotify no Linux), aparece uma faixa fixa: "Mudanças externas não são detectadas automaticamente: use Atualizar."

## Atalhos (padrão do VS Code)

| Ação no Dark Triad | Windows | Linux | macOS | Comando VS Code e fonte |
|---|---|---|---|---|
| Arquivo: Abrir pasta | Ctrl+K Ctrl+O | Ctrl+K Ctrl+O | ⌘O (Abrir…, arquivo ou pasta) | `workbench.action.files.openFolder` / mac `workbench.action.files.openFileFolder` ([workspaceActions.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/actions/workspaceActions.ts), MIT) |
| Arquivo: Fechar pasta | Ctrl+K F | Ctrl+K F | ⌘K F | `workbench.action.closeFolder` ([default keybindings](https://code.visualstudio.com/docs/reference/default-keybindings)) |
| Ver: Mostrar Explorador | Ctrl+Shift+E | Ctrl+Shift+E | ⇧⌘E | `workbench.view.explorer` ([default keybindings](https://code.visualstudio.com/docs/reference/default-keybindings)) |
| Ver: Mostrar/ocultar barra lateral | Ctrl+B | Ctrl+B | ⌘B | `workbench.action.toggleSidebarVisibility` ([default keybindings](https://code.visualstudio.com/docs/reference/default-keybindings)) |
| Explorador: Abrir item selecionado | Enter | Enter | ⌘↓ | `list.select` ([listCommands.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/actions/listCommands.ts), MIT) |
| Explorador: Renomear | F2 | F2 | Enter | `renameFile` ([fileActions.contribution.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/files/browser/fileActions.contribution.ts), MIT) |
| Explorador: Mover para a lixeira | Delete | Delete | ⌘⌫ | `moveFileToTrash` (idem) |

Os atalhos "Explorador:" só valem com o foco na árvore. Fora dela, F2 e Delete continuam sendo do editor.

## Critérios de aceite

1. **[auto]** (já existe) `Explorer::list` devolve as pastas primeiro e depois os arquivos, em ordem alfabética sem diferenciar maiúsculas.
2. **[auto]** `Explorer::list` não devolve `.git`, `.svn`, `.hg`, `.jj`, `.DS_Store` nem `Thumbs.db`, e devolve `build/` e `.gitignore`.
3. **[auto]** Criar um item com um nome que já existe na pasta devolve um erro de "já existe" e não altera o disco. O mesmo vale para nome vazio ou com `/` ou `\`.
4. **[auto]** Renomear `src/a.cpp` para `src/b.cpp` move o arquivo, e o caminho de uma aba aberta de `a.cpp` passa a ser `b.cpp`, com as alterações não salvas mantidas. Teste de unidade com sistema de arquivos falso e estado de abas.
5. **[manual]** Ctrl+K Ctrl+O (⌘O no mac) e escolha `hello-cpp`. Esperado: a árvore mostra `app/`, `core/`, `tool/` e `CMakeLists.txt`, nesta ordem, sem `.git/`.
6. **[manual]** Feche e reabra a IDE. Esperado: `hello-cpp` reabre sozinha. Ctrl+K F volta para a tela inicial, e `hello-cpp` aparece no topo dos recentes.
7. **[manual]** Usando só o teclado: Ctrl+Shift+E foca a árvore; ↓ até `app/`; → expande; ↓ até `main.cpp`; Enter abre no editor. ← sobe para `app/`, e ← de novo recolhe a pasta.
8. **[manual]** Selecione `app/`, clique em **Novo arquivo**, digite `util.cpp` e Enter. Esperado: `app/util.cpp` existe no disco e está aberto no editor. Repita com o mesmo nome. Esperado: a mensagem "Já existe util.cpp nesta pasta" e nada é criado.
9. **[manual]** Selecione `util.cpp` e pressione F2 (Enter no mac); renomeie para `helper.cpp`. Esperado: a aba muda de nome. Delete (⌘⌫ no mac) e confirme. Esperado: o arquivo vai para a Lixeira do Windows, para a Lixeira do macOS ou para a lixeira do ambiente Linux, e pode ser restaurado de lá.
10. **[manual]** Com `app/` expandida, rode no terminal do sistema `touch app/novo.cpp && rm app/main.cpp` (no Windows, use os comandos equivalentes do PowerShell). Esperado: em até 1 s, `novo.cpp` aparece, `main.cpp` some, e `app/` continua expandida.
11. **[manual]** Rode um build do `hello-cpp` por fora (`cmake -S . -B build && cmake --build build`). Esperado: `build/` aparece na árvore, e a interface continua respondendo durante o build: a árvore rola e o editor aceita digitação.
12. **[manual]** No Linux, abra uma pasta sem permissão de leitura dentro do projeto (`chmod 000 privado`). Esperado: o nó mostra "Sem permissão para ler" e o resto da árvore funciona.
13. **[auto/perf]** Expandir a pasta de 5.000 arquivos do projeto `grande` mostra os itens em < 300 ms, e rolar a lista não perde quadros visíveis (meta no README).

## O que fica de fora

- **Arrastar e soltar para mover, copiar/recortar/colar arquivos e seleção múltipla:** depois.
- **Revelar automaticamente o arquivo ativo na árvore, e "Revelar no Explorer/Finder":** depois.
- **Esconder ou esmaecer o que está no `.gitignore`, e configurar exclusões:** depois.
- **Visão por solução/alvos (estilo Visual Studio/CLion):** fora. A barra de status mostra projeto e alvo.
- **Vários projetos raiz na mesma janela (multi-root):** fora.
- **Decorações do Git (modificado, novo):** depois, junto com o Git.
- **Filtro/busca dentro da árvore:** fora. O Ctrl+P cobre esse caso.

## Notas para implementação

- **Porta `FileSystem` no núcleo:**
  - Hoje ela só tem `read_dir`.
  - Criar, renomear, mover para a lixeira e observar mudanças entram como portas pequenas e separadas (princípio I do docs/STACK.md), com adaptadores no `infra`.
- **Lixeira:**
  - Exige um crate novo; `trash` é a opção conhecida.
  - Justificar a dependência no PR, como pede o frontend.md.
- **Itens escondidos:** o filtro é uma lista fixa no núcleo, testável sem disco.
