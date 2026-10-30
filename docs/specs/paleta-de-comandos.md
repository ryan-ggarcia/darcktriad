# Paleta de comandos, abrir rápido e atalhos globais

Status: **MVP (v0.2)** · Depende de: [editor.md](editor.md), [explorador.md](explorador.md) · Usado por: todas as specs (todo comando é registrado aqui)

## Problema do usuário

No IntelliJ/CLion é difícil saber o que cada coisa faz e onde fica. Quero digitar o que quero fazer e ver o comando com o nome claro e o atalho. Quero abrir qualquer arquivo pelo nome. E quero os mesmos atalhos do VS Code, sem o navegador embutido "roubar" teclas.

## O que as IDEs de referência fazem

- **VS Code:**
  - A Paleta de Comandos (Ctrl+Shift+P ou F1) dá acesso a todos os comandos.
  - O Quick Open (Ctrl+P) abre arquivos pelo nome.
  - No Quick Open, o prefixo `>` lista comandos e `?` mostra os outros prefixos.

  [User Interface](https://code.visualstudio.com/docs/getstarted/userinterface), [Code Navigation](https://code.visualstudio.com/docs/editing/editingevolved)
- **VS Code:** Ctrl+G vai para uma linha. Ctrl+Tab lista os editores abertos por uso recente. [Default keyboard shortcuts](https://code.visualstudio.com/docs/reference/default-keybindings), [Code Navigation](https://code.visualstudio.com/docs/editing/editingevolved)
- **VS Code:**
  - Atalhos em duas etapas (acordes, ex.: Ctrl+K e depois Ctrl+O) fazem parte do padrão.
  - Uma regra de atalho pode valer só em certo contexto (cláusula `when`), ex.: F5 inicia a depuração só quando não há depuração ativa.

  [Keyboard shortcuts](https://code.visualstudio.com/docs/configure/keybindings)
- **CLion:**
  - "Search Everywhere" (Shift duas vezes) busca arquivos, classes, símbolos e ações.
  - "Find Action" (Ctrl+Shift+A) acha qualquer ação pelo nome, inclusive as sem menu ou atalho.
  - Ctrl+Shift+N acha arquivos.

  [Search Everywhere](https://www.jetbrains.com/help/clion/searching-everywhere.html)
- **Visual Studio:** a busca "All-In-One" separa a busca de recursos da IDE (Ctrl+Q) da busca de código (Ctrl+T). [Visual Studio search](https://learn.microsoft.com/en-us/visualstudio/ide/visual-studio-search)
- **WebView2** (Windows): por padrão, o webview responde a atalhos de navegador (imprimir, localizar na página, recarregar etc.).
  - A configuração `AreBrowserAcceleratorKeysEnabled` desliga esses atalhos.
  - O Wry, usado pelo Tauri, expõe essa opção desde a 0.23.2.

  [Wry 0.23.2](https://v2.tauri.app/release/wry/v0.23.2/), [ICoreWebView2Settings3](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2settings3)

## Comportamento esperado no Dark Triad

**Registro único de comandos (base de tudo)**

1. **O que é um comando:** cada ação da IDE tem um registro com:
   - id;
   - nome em pt-BR no formato `Categoria: Ação`, ex.: `Arquivo: Salvar` ou `Depuração: Passar por cima`;
   - atalho por sistema;
   - condição de disponibilidade, ex.: "há depuração pausada".
2. **Uma fonte só:** menu, botões, paleta e teclado chamam o **mesmo** registro. Não existe ação que só exista num botão. Assim, tudo aparece na paleta.
3. **Dicas:** todo botão da interface tem dica com o nome do comando e o atalho, ex.: "Compilar (Ctrl+Shift+B)".

**Paleta de comandos** (Ctrl+Shift+P ou F1)

1. Abre uma caixa no topo da janela, com foco no campo de texto.
2. **A lista:**
   - Mostra os comandos disponíveis agora, cada um com o atalho alinhado à direita.
   - Os indisponíveis no contexto atual não aparecem.
   - Com o campo vazio, os 5 comandos usados mais recentemente vêm primeiro (seção "Usados recentemente"), depois os demais em ordem alfabética.
3. **Filtro:**
   - Aproximado: as letras digitadas precisam aparecer em ordem, sem diferenciar maiúsculas nem acentos ("slvtd" acha "Arquivo: Salvar tudo").
   - As letras encontradas aparecem em destaque.
4. **Teclas:** ↑/↓ escolhem, Enter executa, Esc fecha e devolve o foco para onde estava.

**Abrir rápido** (Ctrl+P)

1. **Lista de arquivos:**
   - Mostra os arquivos do projeto por nome, com o caminho relativo em cinza ao lado.
   - Com o campo vazio, mostra os arquivos abertos recentemente.
2. **Índice:**
   - Feito em segundo plano com o crate `ignore`.
   - Respeita `.gitignore`/`.ignore` e os itens escondidos do explorador.
   - Atualizado pelos mesmos eventos de `notify`.
   - Enquanto não termina, a lista mostra o que já foi achado e o texto "Indexando…".
3. **Filtro e ordem:**
   - O filtro é o mesmo da paleta.
   - Acertos no nome do arquivo valem mais que acertos no caminho.
   - A lista mostra no máximo 200 resultados.
4. **Prefixos** (no mesmo campo):
   - `>` vira a paleta de comandos;
   - `:` vira "ir para linha".
5. Enter abre o arquivo ([editor.md](editor.md)).

**Ir para linha** (Ctrl+G)

1. Abre a mesma caixa com `:` já digitado.
2. Aceita `linha` ou `linha:coluna`.
3. Enter move o cursor e centraliza a linha. Valores fora do arquivo vão para a última linha.

**Menu principal**

1. É um menu nativo nos três sistemas, gerado a partir do registro de comandos, com o atalho de cada item. Os menus são:
   - **Arquivo:** Novo arquivo, Abrir arquivo, Abrir pasta, Pastas recentes, Salvar, Salvar como, Salvar tudo, Fechar editor, Fechar pasta, Sair.
   - **Editar:** Desfazer, Refazer, Recortar, Copiar, Colar, Localizar, Substituir, Comentar linha.
   - **Ver:** Paleta de comandos, Abrir rápido, Explorador, Executar e Depurar, Problemas, Saída, Terminal, Mostrar/ocultar barra lateral.
   - **Executar:** Compilar, Executar sem depurar, Iniciar depuração, Parar, Alternar ponto de parada.
   - **Ajuda:** Atalhos de teclado (abre a paleta listando todos os comandos com atalho), Verificar e instalar ferramentas ([ferramentas.md](ferramentas.md)), Sobre.
2. No macOS, o menu do app tem Sobre e Sair (⌘Q), e ⌘W é "Fechar editor", não "fechar janela".

**Teclado global**

1. **Despachante único:** um só ponto decide o que cada tecla faz, consultando o registro e o contexto (foco no editor, no explorador, no terminal; depuração ativa ou não).
2. **Acordes** (ex.: Ctrl+K Ctrl+O):
   - Depois da primeira tecla, a barra de status mostra "(Ctrl+K) pressionado. Aguardando a segunda tecla…".
   - Esc ou uma tecla sem significado cancelam e mostram "A combinação não é um comando".
3. **Atalhos de navegador desligados:** no Windows e no Linux, o webview não pode reagir a F5 (recarregar), Ctrl+R, Ctrl+P (imprimir), Ctrl+F (localizar na página), Ctrl+J, Ctrl+U nem Ctrl+Shift+I (ferramentas de desenvolvedor, nos builds de release). O mesmo vale para ⌘R e ⌘P no macOS.
4. **Atalhos do editor:** os do Monaco continuam valendo dentro do editor. O F1 do Monaco (paleta interna dele) é substituído pela paleta da IDE.

## Atalhos (padrão do VS Code)

Fonte: [Default keyboard shortcuts](https://code.visualstudio.com/docs/reference/default-keybindings).

| Ação no Dark Triad | Windows | Linux | macOS | Comando VS Code |
|---|---|---|---|---|
| Ver: Paleta de comandos | Ctrl+Shift+P ou F1 | Ctrl+Shift+P ou F1 | ⇧⌘P ou F1 | `workbench.action.showCommands` |
| Ver: Abrir rápido (ir para arquivo) | Ctrl+P | Ctrl+P | ⌘P | `workbench.action.quickOpen` |
| Ir: Ir para linha | Ctrl+G | Ctrl+G | ⌃G | `workbench.action.gotoLine` |
| Arquivo: Sair | sem atalho (Alt+F4 do sistema fecha a janela) | Ctrl+Q | ⌘Q | `workbench.action.quit` ([desktop.contribution.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/electron-browser/desktop.contribution.ts), MIT: atalho só em macOS e Linux) |

## Critérios de aceite

1. **[auto]** O registro rejeita dois comandos com o mesmo atalho e a mesma condição, com um erro que nomeia os dois. Teste roda no `ng test` com o registro real, para pegar conflitos novos de qualquer spec.
2. **[auto]** Todo comando registrado tem um nome no formato `Categoria: Ação`, em pt-BR e sem texto vazio. Teste percorre o registro inteiro.
3. **[auto]** O filtro aproximado acha "Arquivo: Salvar tudo" com `slvtd` e com `SALVAR TUDO`, e acha "Depuração: Passar por cima" com `depuracao` (sem acento). Não acha nada com `xyz`.
4. **[auto]** O índice do Ctrl+P sobre o `hello-cpp` com um `.gitignore` contendo `build/` não lista nada de `build/`. Com o `.gitignore` removido, lista.
5. **[manual]** Ctrl+Shift+P (⇧⌘P), digite `salvar`. Esperado: aparecem "Arquivo: Salvar", "Arquivo: Salvar como" e "Arquivo: Salvar tudo", cada um com o seu atalho à direita. Enter em "Arquivo: Salvar" salva o arquivo ativo.
6. **[manual]** Com a depuração parada, abra a paleta e digite `passar`. Esperado: "Depuração: Passar por cima" **não** aparece. Com a depuração pausada num ponto de parada, aparece.
7. **[manual]** Ctrl+P, digite `mcpp`. Esperado: `main.cpp` aparece com `app/` em cinza ao lado. Enter abre o arquivo. Ctrl+P com o campo vazio mostra `main.cpp` entre os recentes.
8. **[manual]** Ctrl+P, digite `>` e depois `terminal`. Esperado: a lista vira de comandos e mostra "Ver: Terminal". Apague o `>`. Esperado: volta a listar arquivos.
9. **[manual]** Num arquivo de 100 linhas, Ctrl+G, digite `50` e Enter. Esperado: o cursor vai para a linha 50, centralizada. Ctrl+G com `9999` vai para a linha 100. Ctrl+G com `20:5` vai para a linha 20, coluna 5.
10. **[manual]** Pressione Ctrl+K. Esperado: a barra de status mostra que espera a segunda tecla. Pressione Esc. Esperado: a espera é cancelada. Ctrl+K Ctrl+O abre o diálogo de pasta.
11. **[manual]** No Windows e no Linux, com o foco no editor e depois no explorador, pressione F5, Ctrl+R, Ctrl+P, Ctrl+F e Ctrl+J. Esperado: nada de navegador acontece. A página não recarrega e não abre impressão, busca de página nem downloads. Ctrl+P abre o Abrir rápido; Ctrl+F abre o localizar do editor; F5 inicia a depuração ([depuracao.md](depuracao.md)).
12. **[manual]** Passe o mouse em cada botão visível da janela. Esperado: todos mostram uma dica com nome e, quando houver, atalho.
13. **[manual]** No macOS, o menu do app tem "Sobre" e "Sair"; ⌘W fecha a aba ativa e não a janela; ⌘Q fecha a IDE, perguntando sobre arquivos não salvos.
14. **[auto/perf]** No projeto `grande` com 50.000 arquivos: a primeira lista do Ctrl+P sai em < 500 ms, e cada tecla filtra em < 100 ms (meta no README).

## O que fica de fora

- **Atalhos personalizados e editor de atalhos (Ctrl+K Ctrl+S):** depois. No MVP, "Ajuda: Atalhos de teclado" é só a lista.
- **Prefixos `@` (símbolo no arquivo) e `#` (símbolo no projeto):** depois, junto com os símbolos do LSP ([linguagem.md](linguagem.md)).
- **Abrir o resultado do Ctrl+P ao lado (Ctrl+Enter):** depois, junto com a divisão do editor.
- **Busca de texto em todos os arquivos (Ctrl+Shift+F):** depois (README).
- **Mapas de teclas de outras IDEs (CLion, Visual Studio):** fora. O pedido é atalhos iguais aos do VS Code.
