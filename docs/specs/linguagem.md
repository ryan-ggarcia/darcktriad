# Linguagem: erros, autocomplete, hover e ir para definição

Status: **MVP (v0.4)** · Depende de: [editor.md](editor.md), [projeto.md](projeto.md) · Usado por: [compilar-e-executar.md](compilar-e-executar.md) (painel Problemas)

## Problema do usuário

Enquanto digito C, C++ ou C#, quero:

- ver os erros na hora;
- receber sugestões de nomes e membros;
- ver a assinatura da função que estou chamando;
- pular para onde algo foi definido.

Tudo isso sem a digitação engasgar e sem a IDE morrer quando o analisador trava.

## O que as IDEs de referência fazem

- **Visual Studio**, IntelliSense:
  - lista de membros após `.` ou `::`, com filtro por letras iniciais e por "camel case";
  - Parameter Info (Ctrl+Shift+Space) com o parâmetro atual em negrito;
  - Quick Info (Ctrl+K, Ctrl+I) com a declaração completa;
  - Complete Word (Ctrl+Space).

  [Using IntelliSense](https://learn.microsoft.com/en-us/visualstudio/ide/using-intellisense)
- **Visual Studio**, lista de erros:
  - junta erros de **build** e de **IntelliSense**;
  - filtra por documento, projeto ou solução;
  - duplo clique leva à linha.

  [Error List](https://learn.microsoft.com/en-us/visualstudio/ide/error-list-window)
- **CLion:**
  - Mostra o autocomplete sozinho ao digitar; Ctrl+Space chama manualmente.
  - Ctrl+P mostra os parâmetros; Ctrl+Q, a documentação.

  [Code completion](https://www.jetbrains.com/help/clion/auto-completing-code.html)
- **CLion:**
  - A janela Problems tem uma aba do arquivo atual e outra do projeto inteiro (inclusive erros de build e de configuração).
  - F4 ou duplo clique leva ao problema.

  [Problems tool window](https://www.jetbrains.com/help/clion/problems-tool-window.html)
- **VS Code:**
  - F12 ou Ctrl+clique vai para a definição.
  - Alt+← / Alt+→ volta e avança entre locais visitados.
  - Ctrl+Shift+M abre o painel Problemas; F8 / Shift+F8 percorrem os problemas.

  [Code Navigation](https://code.visualstudio.com/docs/editing/editingevolved), [Default keyboard shortcuts](https://code.visualstudio.com/docs/reference/default-keybindings)
- **clangd** (Apache 2.0 com exceção LLVM):
  - Indexa o projeto em segundo plano por padrão (`--background-index`, ligado).
  - Lê `compile_commands.json` da pasta dada em `--compile-commands-dir`.

  [ClangdMain.cpp](https://github.com/llvm/llvm-project/blob/main/clang-tools-extra/clangd/tool/ClangdMain.cpp), [clangd: project setup](https://clangd.llvm.org/installation)
- **Roslyn Language Server** (MIT): `roslyn-language-server --stdio --autoLoadProjects` descobre e carrega os projetos da pasta (até 500 por padrão). [NuGet: roslyn-language-server](https://www.nuget.org/packages/roslyn-language-server)
- **Protocolo:** o Language Server Protocol 3.17 define as mensagens usadas aqui:
  - `publishDiagnostics` (erros);
  - `completion` (sugestões);
  - `signatureHelp` (assinatura da função);
  - `hover`;
  - `definition`;
  - `$/progress` (andamento);
  - `$/cancelRequest` (cancelar pedido).

  [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)

## Comportamento esperado no Dark Triad

### Servidores

1. **clangd** (C e C++):
   - Inicia ao abrir o primeiro arquivo C/C++ da pasta.
   - Argumento: `--compile-commands-dir=<pasta de build ativa>` ([projeto.md](projeto.md)). Pasta sem projeto: sem o argumento, e o clangd usa flags padrão.
   - No Windows, recebe o ambiente do MSVC quando ele está em uso.
   - Trocar a configuração (Debug/Release) reinicia o clangd com a nova pasta.
2. **Roslyn** (C#):
   - Inicia ao abrir o primeiro `.cs` de uma pasta .NET, com `roslyn-language-server --stdio --autoLoadProjects`.
   - `.cs` fora de projeto .NET: sem servidor. A barra de status mostra "C#: sem projeto". A dica explica que é preciso abrir a pasta de um `.csproj`/`.sln`.
3. **Isolamento:**
   - Cada servidor é um processo separado, falando por stdio, e nunca roda na thread da interface.
   - O log (stderr) vai para um canal próprio no painel Saída: **clangd** ou **C#**.
4. **Barra de status (direita):** um item por servidor ativo, com o estado:
   - `C++: iniciando…`;
   - `C++: indexando 45%` (vem do `$/progress`);
   - `C++: pronto`;
   - `C++: parado`, com o botão **Reiniciar**.
5. **Queda do servidor:**
   - Reinicia sozinho até 3 vezes em 5 minutos.
   - Na 4ª queda, fica parado e mostra "O clangd parou várias vezes. Veja o canal clangd na Saída." com o botão **Reiniciar**.
   - A IDE e o editor seguem funcionando sem os recursos de linguagem.

### Recursos (do LSP para o Monaco)

1. **Sincronização:** abrir, alterar (de forma incremental), salvar e fechar arquivos é avisado ao servidor.
2. **Erros e avisos:**
   - Sublinhado ondulado vermelho (erro), amarelo (aviso) ou azul (informação).
   - Passar o mouse mostra a mensagem e a origem (`clangd`, `C#`).
3. **Autocomplete:**
   - Abre sozinho nos caracteres de gatilho que o servidor informa (ex.: `.`, `->`, `::`) e ao digitar um identificador. Ctrl+Space abre manualmente.
   - Cada item mostra ícone do tipo (função, variável, classe…) e detalhe (tipo/assinatura).
   - Enter ou Tab inserem. Trechos com marcadores (snippets) funcionam.
   - A documentação do item vem sob demanda (`completionItem/resolve`).
4. **Dicas de parâmetros:** abrem em `(` e `,`, ou com Ctrl+Shift+Space. Mostram a assinatura com o parâmetro atual em destaque; ↑/↓ alternam entre sobrecargas.
5. **Hover:** passar o mouse (ou Ctrl+K Ctrl+I) mostra o tipo/declaração e o comentário de documentação.
6. **Ir para definição:**
   - F12 ou Ctrl+clique (⌘+clique no mac).
   - Com um resultado, abre o arquivo e posiciona o cursor. Com vários, mostra uma lista para escolher.
   - Arquivos **fora da pasta do projeto** (cabeçalhos do sistema, SDK) abrem **somente leitura**, com a faixa "Fora do projeto: somente leitura", para ninguém editar `<vector>` por engano.
7. **Voltar e avançar:**
   - Alt+← / Alt+→ percorrem o histórico de saltos: definição, Ctrl+P, Ctrl+G, clique em problema.
   - O histórico guarda 50 posições.
8. **Respostas atrasadas e cancelamento:**
   - Um pedido que ficou velho (ex.: autocomplete superado por nova digitação) é cancelado com `$/cancelRequest`.
   - Respostas que chegam depois de o cursor mudar de lugar são descartadas.

### Painel Problemas (Ctrl+Shift+M)

1. **Fontes:**
   - erros e avisos de todos os servidores, para os arquivos que eles reportam;
   - erros de build ([compilar-e-executar.md](compilar-e-executar.md));
   - erros do CMake ([projeto.md](projeto.md)).
2. **Organização:**
   - Agrupado por arquivo; dentro do arquivo, ordenado por gravidade e linha.
   - Cada item mostra ícone, mensagem, origem e `linha:coluna`. Clique abre o arquivo na posição.
   - Cada fonte substitui só os seus próprios itens: um build novo não apaga os erros do clangd, e vice-versa.
3. **Barra de status:** mostra o contador `⊗ 2  ⚠ 1`; clicar abre o painel.
4. **F8 / Shift+F8:** vão para o próximo e o anterior problema, passando de arquivo em arquivo.

## Atalhos (padrão do VS Code)

Fonte: [Default keyboard shortcuts](https://code.visualstudio.com/docs/reference/default-keybindings), salvo indicação.

| Ação no Dark Triad | Windows | Linux | macOS | Comando VS Code |
|---|---|---|---|---|
| Editar: Mostrar sugestões | Ctrl+Space | Ctrl+Space | ⌃Space | `editor.action.triggerSuggest` |
| Editar: Mostrar dicas de parâmetros | Ctrl+Shift+Space | Ctrl+Shift+Space | ⇧⌘Space | `editor.action.triggerParameterHints` |
| Editar: Mostrar hover | Ctrl+K Ctrl+I | Ctrl+K Ctrl+I | ⌘K ⌘I | `editor.action.showHover` |
| Ir: Ir para definição | F12 / Ctrl+clique | F12 / Ctrl+clique | F12 / ⌘+clique | `editor.action.revealDefinition` ([Code Navigation](https://code.visualstudio.com/docs/editing/editingevolved)) |
| Editar: Formatar documento | Shift+Alt+F | Ctrl+Shift+I ou Shift+Alt+F | ⇧⌥F | `editor.action.formatDocument` |
| Editar: Formatar seleção | Ctrl+K Ctrl+F | Ctrl+K Ctrl+F | ⌘K ⌘F | `editor.action.formatSelection` |
| Ir: Voltar | Alt+← | Ctrl+Alt+- | ⌃- | `workbench.action.navigateBack` |
| Ir: Avançar | Alt+→ | Ctrl+Shift+- | ⌃⇧- | `workbench.action.navigateForward` |
| Ver: Problemas | Ctrl+Shift+M | Ctrl+Shift+M | ⇧⌘M | `workbench.actions.view.problems` |
| Ir: Próximo problema | F8 | F8 | F8 | `editor.action.marker.nextInFiles` |
| Ir: Problema anterior | Shift+F8 | Shift+F8 | ⇧F8 | `editor.action.marker.prevInFiles` |
| Linguagem: Reiniciar servidor C/C++ | nenhum | nenhum | nenhum | (paleta) |
| Linguagem: Reiniciar servidor C# | nenhum | nenhum | nenhum | (paleta) |

## Critérios de aceite

1. **[auto]** A conversão de `Diagnostic` do LSP para marcador do Monaco mapeia a gravidade (1→erro, 2→aviso, 3/4→informação) e converte linhas e colunas de base 0 para base 1. Teste no `ng test`.
2. **[auto]** O repositório de problemas, com itens de `clangd` e `build` para o mesmo arquivo:
   - substituir os itens de `build` mantém os de `clangd`;
   - a ordem é gravidade e depois linha.
3. **[auto]** A política de reinício com um servidor falso que cai 4 vezes em 5 minutos reinicia 3 vezes e termina no estado "parado". Se as quedas tiverem mais de 5 minutos entre si, reinicia sempre.
4. **[auto, integração]** No CI com clangd instalado:
   - inicia o clangd sobre o `hello-cpp` configurado;
   - abre um arquivo com `int x = "a";`;
   - recebe `publishDiagnostics` com 1 erro na linha certa em menos de 10 s.

   O mesmo teste com o Roslyn sobre o `hello-cs` recebe o erro `CS0029`.
5. **[manual]** Em `hello-cpp/app/main.cpp`, digite `int x = "a";`. Esperado: em até 2 s aparece o sublinhado vermelho; o mouse em cima mostra a mensagem; o painel Problemas e a barra de status (`⊗ 1`) mostram o erro. Apague a linha. Esperado: tudo some.
6. **[manual]** Com `#include <string>`, digite `std::str`. Esperado: em até 1 s (índice já pronto), a lista mostra `string`; Enter insere. Digite `s.` numa variável `std::string s`. Esperado: aparecem membros como `size` e `append`.
7. **[manual]** Digite a chamada de uma função de `core` com dois parâmetros, ex.: `soma(`. Esperado: aparece a assinatura com o 1º parâmetro em destaque; após `,`, o 2º parâmetro fica em destaque.
8. **[manual]** F12 numa chamada de função de `core`. Esperado: abre o arquivo de `core` na definição. Alt+← (⌃- no mac) volta para a chamada. Ctrl+clique (⌘+clique) faz o mesmo que F12.
9. **[manual]** F12 em `std::string`. Esperado: abre o cabeçalho do sistema com a faixa "Fora do projeto: somente leitura", e digitar nele não altera o texto.
10. **[manual]** Em `hello-cs/Program.cs`, digite `Console.`. Esperado: a lista mostra `WriteLine`. Digite `int x = "a";`. Esperado: sublinhado com o código `CS0029`. F12 em `Console` abre a definição (metadados, somente leitura) ou mostra "Definição não disponível". Nunca trava.
11. **[manual]** Encerre o processo `clangd` pelo gerenciador de tarefas / `kill`. Esperado: a barra mostra o reinício e volta para `C++: pronto`; os sublinhados voltam. O editor não congelou em nenhum momento.
12. **[manual]** Com erros em dois arquivos, F8 percorre os erros de um arquivo e depois os do outro; Shift+F8 percorre no sentido contrário. Ctrl+Shift+M abre o painel, e clicar num item leva até ele.
13. **[manual]** Na primeira abertura do `hello-cpp`, a barra de status mostra `C++: indexando …%` e depois `C++: pronto`.
14. **[manual]** Troque a configuração para Release. Esperado: o canal clangd da Saída mostra o reinício com `--compile-commands-dir` apontando para a pasta de Release.
15. **[auto/perf]** No arquivo de 10.000 linhas do `grande`, com o clangd ativo, a digitação tem p95 < 50 ms (meta no README).

## Formatar

1. **Quem formata é o servidor da linguagem:** o clangd segue o `.clang-format` do projeto, e o Roslyn, o `.editorconfig`. A IDE só manda o arquivo e as opções de recuo do editor.
2. **O resultado fica no buffer:** o arquivo aparece como não salvo, e um Ctrl+Z desfaz a formatação inteira.
3. **Sem servidor pronto para o arquivo:** a barra de status avisa, em vez de o atalho parecer quebrado.
4. **Formatar seleção sem nada selecionado** vale para a linha do cursor. O clang-format também corrige o recuo das linhas seguintes do mesmo bloco; o que vem antes não muda.

5. **Formatar ao salvar:** opção na engrenagem e na paleta, desligada por padrão, porque reformatar muda linhas que a pessoa não tocou. Ligada, vale para qualquer salvamento, inclusive o Ctrl+S num arquivo sem alterações. Se nada mudar, o arquivo não é gravado.
6. **Formatar nunca impede de salvar:** sem servidor pronto, com erro no servidor ou com texto digitado durante a espera, o arquivo é gravado como está. O servidor tem 3 segundos para responder; depois disso, a barra de status avisa que o arquivo foi salvo sem formatar.

## O que fica de fora

- **Localizar referências (Shift+F12) e renomear símbolo (F2):** depois (README).
- **Formatar ao digitar:** depois.
- **Correções rápidas e code actions (Ctrl+.):** depois.
- **Símbolos do arquivo (Ctrl+Shift+O) e do projeto (Ctrl+T), e "espiar" definição (Alt+F12):** depois.
- **Realce semântico, inlay hints, CodeLens, hierarquia de chamadas e de tipos:** depois.
- **Configurar clang-tidy ou analisadores do Roslyn pela interface:** depois. O que estiver em `.clangd` / `.editorconfig` já vale, porque os servidores leem esses arquivos.
- **Filtro de texto e de escopo no painel Problemas:** depois.
- **Razor/Blazor e linguagem CMake:** fora / depois (README).

## Notas para implementação

- **Ligar o LSP ao Monaco:**
  - O MVP usa só cinco recursos: diagnósticos, completion, signatureHelp, hover e definition.
  - Escrever esses cinco provedores à mão provavelmente é menor que adotar `monaco-languageclient` (MIT), que traz uma camada grande de compatibilidade com o VS Code.
  - A decisão é do frontend, justificada no PR.
- **Núcleo Rust:** "cliente de servidor de linguagem" é uma porta (trait). clangd e Roslyn são adaptadores que só diferem no comando e nos argumentos (princípio O do docs/STACK.md).
