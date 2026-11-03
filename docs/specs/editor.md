# Editor e abas

Status: **MVP (v0.1)** · Depende de: nada · Usado por: todas as outras specs

## Problema do usuário

Quero abrir arquivos de código, editar com conforto e salvar sem medo de perder trabalho. Também quero alternar entre vários arquivos abertos sem me perder, e sem a IDE travar com arquivos grandes.

## O que as IDEs de referência fazem

- **VS Code:**
  - Abre arquivos em abas.
  - Um clique simples no explorador abre uma aba de pré-visualização (em itálico), que é reaproveitada até o usuário editar o arquivo ou dar duplo clique.
  - Abas podem ser reordenadas arrastando.

  [User Interface](https://code.visualstudio.com/docs/getstarted/userinterface)
- **VS Code:**
  - Por padrão não salva sozinho: o usuário salva com Ctrl+S. `files.autoSave` tem o padrão `off` no desktop.
  - O "hot exit" lembra alterações não salvas ao fechar.
  - A codificação do arquivo aparece na barra de status e pode ser trocada por ali.

  Fontes: [Basic editing](https://code.visualstudio.com/docs/editing/codebasics) e o padrão em [files.contribution.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/files/browser/files.contribution.ts) (MIT).
- **VS Code:** localizar/substituir no arquivo (diferenciar maiúsculas, palavra inteira, expressão regular) e multicursor (Alt+clique, Ctrl+D). [Basic editing](https://code.visualstudio.com/docs/editing/codebasics)
- **CLion:**
  - Salva automaticamente por padrão: ao compilar, rodar, depurar, fechar arquivo ou projeto e ao sair.
  - Pode também salvar ao perder o foco ou após um tempo ocioso.

  [Save and revert changes](https://www.jetbrains.com/help/clion/saving-and-reverting-changes.html)
- **CLion:**
  - Limita o número de abas abertas (padrão de 10) e fecha as mais antigas.
  - Permite fixar (pin) abas.
  - A aba de pré-visualização é opcional.
  - Ctrl+F4 fecha a aba, e o clique do meio também.

  [Editor tabs](https://www.jetbrains.com/help/clion/managing-editor-tabs.html)
- **Monaco** (licença MIT): é o editor do VS Code como biblioteca. Já traz localizar/substituir, multicursor, dobra de código, comentar linha, desfazer/refazer e os atalhos de edição do VS Code. [monaco-editor](https://github.com/microsoft/monaco-editor)

## Comportamento esperado no Dark Triad

**Abrir**

1. O arquivo abre por estes caminhos: clique no explorador, Ctrl+P, Ctrl+O, ir para definição, clique num erro do painel Problemas ou da Saída.
2. Se o arquivo já está aberto, a IDE ativa a aba existente e não cria outra.
3. Toda aba é fixa: não há aba de pré-visualização no MVP (ver README).
4. A aba mostra o nome do arquivo. Se dois arquivos abertos têm o mesmo nome, a aba mostra também a pasta pai (ex.: `main.cpp · app`). A dica da aba mostra o caminho completo.
5. **Arquivos que não abrem no editor:**
   - Binário (há byte NUL nos primeiros 8 KB): a aba mostra "Arquivo binário: não exibido no editor" e não carrega o conteúdo.
   - Maior que 50 MB: mostra "Arquivo grande demais para o editor (N MB)" e não carrega.
   - Não é UTF-8 válido: abre **somente leitura**, com uma faixa "Codificação não suportada nesta versão: somente leitura". Isso evita corromper o arquivo ao salvar.
6. O destaque de sintaxe vem do Monaco, escolhido pela extensão:
   - C: `.c`
   - C++: `.cpp .cc .cxx .h .hpp .hh .hxx .inl`
   - C#: `.cs`
   - qualquer outra extensão: texto puro.

   `.h` usa C++, porque cobre os dois casos.
7. A barra de status mostra a linha e a coluna, a linguagem, `UTF-8` e o fim de linha (`LF`/`CRLF`).

**Editar**

1. Usamos tudo o que o Monaco já faz, sem código próprio: localizar/substituir, multicursor, dobra, comentar linha, desfazer/refazer, mover linha (Alt+↑/↓).
2. O fim de linha existente é preservado. Arquivo novo usa o padrão do sistema: `CRLF` no Windows, `LF` no macOS e no Linux.
3. O BOM UTF-8 é preservado se o arquivo já tinha.

**Salvar**

1. Ctrl+S salva o arquivo ativo; Salvar Tudo salva todos os modificados.
2. Uma aba com alterações não salvas mostra um ponto (●) no lugar do X. A dica diz "Alterações não salvas".
3. Ctrl+N cria um arquivo sem título ("Sem título-1"). Ao salvar, abre o diálogo nativo de "Salvar como".
4. A escrita é atômica: grava num arquivo temporário na mesma pasta e depois renomeia. Assim uma queda no meio não deixa o arquivo pela metade.
5. Se a gravação falhar (sem permissão, disco cheio), aparece uma mensagem com o motivo. A aba continua modificada e nada é perdido.
6. Não há salvamento automático. Exceção: compilar, executar e depurar salvam todos os arquivos modificados antes de começar (ver [compilar-e-executar.md](compilar-e-executar.md)).

**Mudanças feitas fora da IDE** (o arquivo aberto é observado com `notify`)

1. Aba sem alterações: o conteúdo recarrega sozinho, mantendo a posição do cursor e da rolagem quando possível.
2. Aba com alterações: aparece a faixa "Este arquivo mudou no disco", com os botões **Recarregar do disco** e **Manter minha versão**. Nada é sobrescrito sem escolha do usuário.
3. Arquivo excluído no disco: a aba fica marcada "(excluído)" e mantém o conteúdo. Salvar recria o arquivo.
4. Ao salvar, se o disco tem uma versão mais nova que a da última leitura, a IDE pergunta: **Sobrescrever** ou **Cancelar**.

**Fechar**

1. Fechar uma aba modificada pergunta: **Salvar**, **Não salvar** ou **Cancelar**.
2. Fechar a janela com abas modificadas faz a mesma pergunta, uma vez, listando os arquivos.
3. Ao fechar uma aba, a IDE ativa a aba usada antes dela, não a vizinha.
4. Clique do meio na aba fecha a aba.

**Trocar de aba**

1. Ctrl+PageDown/PageUp troca de aba pela posição.
2. Ctrl+Tab abre uma lista das abas por uso recente. Com Ctrl segurado, cada Tab avança na lista; soltar o Ctrl abre a aba escolhida.
3. Alt+1 a Alt+9 (⌃1 a ⌃9 no macOS) abrem a aba pela posição, com o foco no editor, inclusive a partir do terminal. Sem aba nessa posição, nada acontece.

**Restaurar**

Ao reabrir a pasta, as abas que estavam abertas voltam, na mesma ordem e com a mesma aba ativa. O conteúdo vem do disco: alterações não salvas não são guardadas no MVP.

## Atalhos (padrão do VS Code)

Fonte: [Default keyboard shortcuts](https://code.visualstudio.com/docs/reference/default-keybindings), salvo indicação na linha.

| Ação no Dark Triad | Windows | Linux | macOS | Comando VS Code |
|---|---|---|---|---|
| Arquivo: Novo arquivo | Ctrl+N | Ctrl+N | ⌘N | `workbench.action.files.newUntitledFile` |
| Arquivo: Abrir arquivo | Ctrl+O | Ctrl+O | ⌘O (abre arquivo ou pasta) | `workbench.action.files.openFile`; no mac, `workbench.action.files.openFileFolder` ([workspaceActions.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/actions/workspaceActions.ts), MIT) |
| Arquivo: Salvar | Ctrl+S | Ctrl+S | ⌘S | `workbench.action.files.save` |
| Arquivo: Salvar como | Ctrl+Shift+S | Ctrl+Shift+S | ⇧⌘S | `workbench.action.files.saveAs` |
| Arquivo: Salvar tudo | Ctrl+K S | sem atalho padrão | ⌥⌘S | `saveAll` |
| Ver: Fechar editor | Ctrl+F4 ou Ctrl+W | Ctrl+W | ⌘W | `workbench.action.closeActiveEditor` ([editorCommands.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editorCommands.ts), MIT) |
| Ver: Fechar todos os editores | Ctrl+K Ctrl+W | Ctrl+K Ctrl+W | ⌘K ⌘W | `workbench.action.closeAllEditors` |
| Ver: Próximo editor | Ctrl+PageDown | Ctrl+PageDown | ⌥⌘→ ou ⇧⌘] | `workbench.action.nextEditor` ([editorActions.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editorActions.ts), MIT) |
| Ver: Editor anterior | Ctrl+PageUp | Ctrl+PageUp | ⌥⌘← ou ⇧⌘[ | `workbench.action.previousEditor` (idem) |
| Ver: Abrir a aba 1 a 9 | Alt+1 a Alt+9 | Alt+1 a Alt+9 | ⌃1 a ⌃9 | `workbench.action.openEditorAtIndex1` a `9` |
| Ver: Alternar entre editores recentes | Ctrl+Tab | Ctrl+Tab | ⌃Tab | `workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup` |
| Editar: Localizar | Ctrl+F | Ctrl+F | ⌘F | `actions.find` |
| Editar: Substituir | Ctrl+H | Ctrl+H | ⌥⌘F | `editor.action.startFindReplaceAction` |
| Editar: Desfazer / Refazer | Ctrl+Z / Ctrl+Y | Ctrl+Z / Ctrl+Y | ⌘Z / ⇧⌘Z | `undo` / `redo` |
| Editar: Comentar linha | Ctrl+/ | Ctrl+/ | ⌘/ | `editor.action.commentLine` |
| Editar: Dobrar / Desdobrar região | Ctrl+Shift+[ / Ctrl+Shift+] | Ctrl+Shift+[ / Ctrl+Shift+] | ⌥⌘[ / ⌥⌘] | `editor.fold` / `editor.unfold` |

As linhas de Editar já vêm do Monaco. O trabalho é só garantir que nenhum atalho global as intercepte.

## Critérios de aceite

Legenda: **[auto]** = teste automatizado (`cargo test` para o núcleo Rust, `ng test` para a interface); **[manual]** = passos para o QA.

1. **[auto]** Abrir `hello-cpp/app/main.cpp` duas vezes resulta em uma única aba, e a aba fica ativa.
2. **[manual]** Abra o mesmo nome de arquivo em duas pastas (`app/main.cpp` e `tool/main.cpp`). Esperado: as abas mostram `main.cpp · app` e `main.cpp · tool`.
3. **[manual]** Edite um arquivo. Esperado: aparece ● na aba. Pressione Ctrl+S (⌘S no mac). Esperado: o ● some e o conteúdo no disco é igual ao do editor.
4. **[auto]** A gravação usa arquivo temporário e depois renomeia. Num teste com sistema de arquivos falso que falha no meio da escrita, o arquivo original fica intacto e o erro é devolvido.
5. **[auto]** Um arquivo com fins de linha `CRLF`, editado e salvo, continua com `CRLF` em todas as linhas. O mesmo vale para `LF`.
6. **[auto]** Um arquivo com bytes inválidos em UTF-8 (ex.: Latin-1 com `é` = `0xE9`) abre como somente leitura. A tentativa de salvar é recusada, e os bytes no disco não mudam.
7. **[auto]** Um arquivo com byte NUL nos primeiros 8 KB é classificado como binário e não é carregado no editor. O mesmo vale para um arquivo maior que 50 MB.
8. **[manual]** Feche uma aba modificada. Esperado: aparecem as opções Salvar, Não salvar e Cancelar. Cancelar mantém a aba; Não salvar fecha sem gravar; Salvar grava e fecha.
9. **[manual]** Com duas abas modificadas, feche a janela. Esperado: uma única pergunta, que lista os dois arquivos.
10. **[manual]** Com um arquivo aberto e sem alterações, mude-o por fora (ex.: `echo // x >> main.cpp`). Esperado: o editor mostra a nova linha em até 2 s, sem pergunta.
11. **[manual]** Repita o passo anterior com o arquivo modificado na IDE. Esperado: aparece a faixa "Este arquivo mudou no disco". **Manter minha versão** preserva o texto da IDE; **Recarregar do disco** descarta as alterações locais.
12. **[manual]** Exclua por fora um arquivo aberto. Esperado: a aba mostra "(excluído)" e o texto permanece. Ctrl+S recria o arquivo.
13. **[manual]** Ctrl+N, digite algo, Ctrl+S. Esperado: abre o diálogo nativo "Salvar como", e depois a aba passa a ter o nome escolhido.
14. **[manual]** Cada atalho da tabela acima faz o que diz nos três sistemas. No Windows, Ctrl+W e Ctrl+F4 fecham a aba, **não a janela**. No macOS, ⌘W fecha a aba, não a janela.
15. **[manual]** Com cinco abas abertas, use-as na ordem 1, 3, 5. Pressione Ctrl+Tab e solte. Esperado: ativa a aba 3 (a anterior por uso). Ctrl+PageDown na aba 5 vai para a aba 1 (dá a volta).
16. **[manual]** Feche e reabra a IDE. Esperado: as abas abertas voltam na mesma ordem, com a mesma aba ativa.
17. **[auto/perf]** Abrir o arquivo de 10.000 linhas do projeto `grande` mostra o texto em < 300 ms. Digitar nele tem p95 < 50 ms da tecla até a tela atualizar. A meta está no README.

## O que fica de fora

- **Abas de pré-visualização:** depois, se o usuário quiser (ver decisão no README).
- **Abas fixadas e limite de abas:** depois.
- **Reabrir aba fechada (Ctrl+Shift+T):** depois.
- **Dividir editor e grupos de editores:** depois.
- **Salvamento automático e hot exit:** depois.
- **Abrir e salvar em outras codificações (Latin-1, UTF-16):** depois. No MVP, somente leitura.
- **Comparar arquivos (diff):** depois, junto com o Git.
- **Arrastar arquivos de fora para dentro do editor:** depois.
- **Minimapa, breadcrumbs, modo zen:** fora do escopo desta spec. O minimapa segue o padrão do Monaco.

## Riscos para a implementação

- **No macOS**, o menu padrão do app associa ⌘W a "fechar janela". O menu precisa ser montado pela IDE (ver [paleta-de-comandos.md](paleta-de-comandos.md)) para ⌘W fechar a aba.
- **No Windows**, o WebView2 tem atalhos próprios do navegador, como Ctrl+F (localizar na página) e Ctrl+P (imprimir). Eles precisam ser desligados (ver [paleta-de-comandos.md](paleta-de-comandos.md)).
