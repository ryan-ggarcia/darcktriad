# Depuração

Status: **MVP (v0.6)** · Depende de: [projeto.md](projeto.md), [compilar-e-executar.md](compilar-e-executar.md), [terminal.md](terminal.md)

## Problema do usuário

Quero parar o programa numa linha e avançar passo a passo, vendo o valor das variáveis e por onde a execução passou. Tem que funcionar igual em C, C++ e C#, com os mesmos atalhos (F5, F9, F10, F11) e sem configurar nada.

## O que as IDEs de referência fazem

- **VS Code:**
  - A barra de depuração tem Continuar/Pausar (F5), Passar por cima (F10), Entrar (F11), Sair (Shift+F11), Reiniciar (Ctrl+Shift+F5) e Parar (Shift+F5).
  - F9 alterna o ponto de parada.
  - A visão Executar e Depurar tem as seções Variáveis, Watch, Pilha de chamadas e Pontos de parada.
  - Há pontos de parada condicionais, de log, de função, de dados e em linha. O suporte depende do depurador.

  [Debugging](https://code.visualstudio.com/docs/debugtest/debugging)
- **Visual Studio:**
  - F9 cria o ponto de parada. F11 entra, F10 passa por cima, Shift+F11 sai.
  - Ctrl+F10 roda até o cursor.
  - "Just My Code" esconde o código que não é do usuário por padrão.
  - Locals e Watch só mostram valores com o programa pausado.

  [Navigate code with the debugger](https://learn.microsoft.com/en-us/visualstudio/debugger/navigating-through-code-with-the-debugger)
- **CLion:**
  - Ctrl+F8 alterna o ponto de parada; F8 passa por cima; F7 entra; F9 continua; Ctrl+F2 para.
  - Avaliar expressões, mudar valores e watchpoints também estão disponíveis.

  [Debugging code](https://www.jetbrains.com/help/clion/debugging-code.html)
- **CLion:**
  - Embute LLDB (macOS e Linux), GDB (Windows e Linux) e um LLDB próprio para o toolchain MSVC no Windows, derivado do LLDB 9.
  - Isso mostra que depurar binários MSVC sem o depurador da Microsoft exige trabalho extra.

  [Debugger options](https://www.jetbrains.com/help/clion/configuring-debugger-options.html)
- **lldb-dap** (LLVM):
  - Adaptador DAP do LLDB.
  - O `launch` aceita `program`, `args`, `cwd`, `env` e `stopOnEntry`.
  - `console: integratedTerminal` roda o programa no terminal da IDE desde o lldb-dap 21; antes, era `runInTerminal`.

  [lldb-dap README](https://github.com/llvm/llvm-project/blob/main/lldb/tools/lldb-dap/README.md)
- **LLDB no Windows:** em 2025, o LLDB passou a usar por padrão o leitor nativo de PDB. Também ganhou formatadores para a STL do MSVC e suporte a ConPTY no lldb-dap, para a entrada e a saída padrão funcionarem. [LLDB in 2025](https://jonasdevlieghere.com/post/lldb-2025/)
- **GDB:**
  - Fala DAP quando iniciado com `-i dap` / `--interpreter=dap`. Precisa de GDB com Python; o recurso existe desde o GDB 14.
  - O `launch` aceita `program`, `args`, `cwd`, `env` e `stopAtBeginningOfMainSubprogram`.

  [GDB Interpreters](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Interpreters.html), [GDB DAP](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Debugger-Adapter-Protocol.html), [GDB 14.1](https://www.phoronix.com/news/GNU-Debugger-GDB-14.1)
- **netcoredbg** (Samsung, MIT): depurador .NET que fala DAP com `--interpreter=vscode`, para Windows, macOS e Linux. [netcoredbg](https://github.com/Samsung/netcoredbg)
- **Protocolo:** o Debug Adapter Protocol define as mensagens usadas aqui:
  - `launch`;
  - `setBreakpoints`;
  - `stopped`, `continue`, `next`, `stepIn`, `stepOut`, `pause`;
  - `stackTrace`, `scopes`, `variables`;
  - `terminate`, `disconnect`;
  - o pedido reverso `runInTerminal`.

  [DAP specification](https://microsoft.github.io/debug-adapter-protocol/specification)

## Comportamento esperado no Dark Triad

### Qual depurador

A escolha é uma função pura no núcleo. Nunca usa vsdbg nem cpptools (docs/STACK.md).

| Projeto / compilador (vem do CMake) | Depurador |
|---|---|
| C/C++ com Clang, AppleClang ou MSVC | `lldb-dap` |
| C/C++ com GCC | `gdb -i dap` se houver GDB ≥ 14 com Python; senão `lldb-dap` |
| C# (.NET) | `netcoredbg --interpreter=vscode` |

Se faltar o depurador, aparece a mensagem de ferramenta ausente ([projeto.md](projeto.md)).

### Iniciar (F5, sem sessão ativa)

1. **Preparar:** salva tudo e compila o alvo ativo, como em [compilar-e-executar.md](compilar-e-executar.md). Se a compilação falhar, não inicia e abre o painel Problemas.
2. **Iniciar o depurador:** inicia o adaptador e envia `launch` com:
   - `program`: o executável (CMake) ou o `TargetPath` `.dll` (.NET);
   - `cwd`: a raiz do projeto;
   - sem argumentos;
   - execução no terminal integrado: `console: integratedTerminal`; para lldb-dap anterior ao 21, `runInTerminal: true`.
3. **O programa no terminal:**
   - Quando o adaptador pede `runInTerminal`, a IDE roda o programa num terminal chamado `🐞 <alvo>`, onde ele lê o teclado normalmente.
   - Se o adaptador não pedir, a saída que chega por eventos `output` aparece nesse mesmo terminal, só para leitura e sem entrada pelo teclado. Nesse caso, uma linha no terminal avisa: "Este depurador não permite digitar a entrada do programa".
4. **Pontos de parada:** os já marcados são enviados antes de o programa rodar.
5. **Exceções:**
   - C#: para em exceções **não tratadas**.
   - C/C++: para em falhas como acesso inválido de memória, que é o padrão dos depuradores.
6. **Barra de status:** mostra "🐞 Depurando app" com outra cor de fundo, enquanto a sessão existir.

### Pontos de parada

1. **Marcar:**
   - F9 alterna o ponto de parada na linha do cursor. Clicar na margem à esquerda dos números de linha faz o mesmo.
   - O ponto aparece como uma bolinha vermelha.
   - Se o depurador não conseguir vincular a linha (ex.: linha sem código ou arquivo não compilado), a bolinha fica vazada e cinza. A dica diz "Ponto de parada não vinculado: esta linha não gerou código ou não tem símbolos de depuração".
   - Se o depurador mover o ponto para outra linha, a bolinha vai para essa linha.
2. **Ao editar:** a bolinha acompanha o texto (inserir linhas acima a empurra para baixo).
3. **Durante a sessão:** mudanças são enviadas na hora (`setBreakpoints` do arquivo).
4. **Persistência:** os pontos ficam salvos por projeto.
5. **Seção "Pontos de parada"** da visão Executar e Depurar:
   - lista os pontos como `arquivo:linha`;
   - clique leva à linha; o X remove;
   - o comando **Depuração: Remover todos os pontos de parada** limpa tudo.

### Programa pausado

1. **No editor:**
   - O arquivo da linha atual abre, e a linha ganha fundo amarelo e uma seta na margem.
   - Uma faixa no topo do editor diz o motivo: "Pausado: ponto de parada", "Pausado: passo", "Pausado por você" ou "Pausado: exceção. <mensagem>".
2. **Visão Executar e Depurar** (Ctrl+Shift+D), com três seções:
   - **Variáveis:**
     - mostra os escopos que o depurador devolve (ex.: Locais, Globais); o primeiro aberto, os outros fechados;
     - cada linha tem `nome = valor`, com o tipo na dica;
     - objetos, structs e coleções se expandem, carregando os filhos só ao abrir (`variables`); coleções grandes vêm em blocos de 100;
     - valores longos aparecem cortados, com o valor inteiro na dica.
   - **Pilha de chamadas:**
     - lista as threads e, dentro delas, os frames (função, arquivo:linha); frames sem código-fonte aparecem em cinza;
     - clicar num frame leva à linha dele e mostra as variáveis daquele frame.
   - **Pontos de parada:** a seção descrita acima.
3. **Barra flutuante** no topo da área de editores, com ícones rotulados por dica (nome e atalho):

   | Botão | Atalho |
   |---|---|
   | Continuar / Pausar | F5 / F6 |
   | Passar por cima | F10 |
   | Entrar | F11 |
   | Sair | Shift+F11 |
   | Reiniciar | Ctrl+Shift+F5 |
   | Parar | Shift+F5 |

4. **Disponibilidade:** os comandos de passo só existem com o programa pausado. Fora disso, não aparecem na paleta ([paleta-de-comandos.md](paleta-de-comandos.md)), e F10/F11 não fazem nada.

### Fim da sessão

1. **O programa termina:** a sessão acaba, o terminal mostra "O programa terminou com código N", e a barra flutuante e a cor da barra de status somem.
2. **Parar** (Shift+F5):
   - pede `terminate` ao depurador;
   - se em 3 s o programa não terminar, envia `disconnect` encerrando o programa;
   - em último caso, encerra os processos à força.

   Nenhum processo do programa ou do adaptador sobra.
3. **Reiniciar** (Ctrl+Shift+F5): para a sessão, recompila e inicia de novo, com os mesmos pontos de parada.
4. **O adaptador cai:**
   - a sessão acaba, e o programa é encerrado;
   - aparece "O depurador (lldb-dap) encerrou inesperadamente. Veja o canal Depuração na Saída.";
   - a IDE continua funcionando, e F5 inicia uma sessão nova;
   - o stderr do adaptador vai sempre para o canal **Depuração**.

## Atalhos (padrão do VS Code)

Fonte: [Debugging: debug actions](https://code.visualstudio.com/docs/debugtest/debugging) e [Default keyboard shortcuts](https://code.visualstudio.com/docs/reference/default-keybindings), salvo indicação.

| Ação no Dark Triad | Windows | Linux | macOS | Comando VS Code |
|---|---|---|---|---|
| Depuração: Iniciar / Continuar | F5 | F5 | F5 | `workbench.action.debug.start` / `workbench.action.debug.continue` |
| Depuração: Pausar | F6 | F6 | F6 | `workbench.action.debug.pause` ([debugCommands.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/debug/browser/debugCommands.ts), MIT) |
| Depuração: Parar | Shift+F5 | Shift+F5 | ⇧F5 | `workbench.action.debug.stop` |
| Depuração: Reiniciar | Ctrl+Shift+F5 | Ctrl+Shift+F5 | ⇧⌘F5 | `workbench.action.debug.restart` |
| Depuração: Passar por cima | F10 | F10 | F10 | `workbench.action.debug.stepOver` |
| Depuração: Entrar | F11 | F11 | F11 | `workbench.action.debug.stepInto` |
| Depuração: Sair | Shift+F11 | Shift+F11 | ⇧F11 | `workbench.action.debug.stepOut` |
| Depuração: Alternar ponto de parada | F9 | F9 | F9 | `editor.debug.action.toggleBreakpoint` |
| Ver: Executar e Depurar | Ctrl+Shift+D | Ctrl+Shift+D | ⇧⌘D | `workbench.view.debug` |
| Depuração: Remover todos os pontos de parada | nenhum | nenhum | nenhum | (paleta) |

## Critérios de aceite

1. **[auto]** A escolha do depurador devolve:
   - GCC com GDB 14 → `gdb -i dap`;
   - GCC com GDB 13 → `lldb-dap`;
   - Clang, AppleClang e MSVC → `lldb-dap`;
   - .NET → `netcoredbg --interpreter=vscode`.
2. **[auto]** O `launch` montado:
   - para o `app` do `hello-cpp`: `program` com o caminho absoluto do executável, `cwd` igual à raiz e `console` igual a `integratedTerminal`;
   - para o `hello-cs`: `program` terminando em `hello-cs.dll`.
3. **[auto]** Os pontos de parada:
   - alternar duas vezes a mesma linha remove o ponto;
   - salvar e recarregar o estado do projeto devolve os mesmos pontos;
   - uma resposta de `setBreakpoints` com `verified: false` marca o ponto como não vinculado;
   - uma resposta com `line` diferente move o ponto.
4. **[auto, integração]** No CI com `lldb-dap`:
   - inicia o `hello-cpp/app` com um ponto de parada na linha N;
   - recebe `stopped` com motivo `breakpoint` na linha N;
   - o `stackTrace` tem `main` no topo;
   - `variables` contém a variável local esperada com o valor esperado;
   - `continue` leva a `exited` com código 0.

   O mesmo teste com `netcoredbg` sobre o `hello-cs`.
5. **[manual]** No `hello-cpp`, pressione F9 numa linha de `main`. Esperado: aparece a bolinha vermelha. Pressione F5. Esperado: compila, inicia e pausa na linha (fundo amarelo, faixa "Pausado: ponto de parada"). Variáveis mostra os locais com valores; Pilha de chamadas mostra `main`.
6. **[manual]** **Passos:**
   - F10 avança uma linha.
   - F11 numa chamada a `soma` entra no arquivo de `core`; Shift+F11 volta para quem chamou.
   - F5 continua até o fim. Esperado: o terminal mostra o código 0, e a barra flutuante some.
7. **[manual]** No `hello-c`, ponha um ponto de parada logo após o `scanf` e pressione F5. Esperado: no terminal `🐞 hello`, digite `21`. A execução pausa, e Variáveis mostra o número lido igual a 21.
8. **[manual]** No `hello-cs`, ponha um ponto de parada após o `ReadLine` e pressione F5. Digite `abc`. Esperado: pausa, e Variáveis mostra `"abc"`. Após F10, o valor invertido aparece.
9. **[manual]** **Expandir variáveis:**
   - uma struct/classe com dois campos expande e mostra os dois;
   - um `std::vector<int>` e uma `List<int>` com 1.000 itens expandem e mostram os itens em blocos, sem travar.
10. **[manual]** Pressione F9 numa linha de comentário e depois F5. Esperado: a bolinha fica vazada com a dica de "não vinculado", ou vai para a próxima linha com código, conforme o depurador responder.
11. **[manual]** Num programa em laço infinito, sem pontos de parada, pressione F5 e depois F6. Esperado: pausa e mostra a pilha, com frames sem fonte em cinza se for código do sistema.
12. **[manual]** Pausado num ponto de parada, pressione Ctrl+Shift+F5. Esperado: recompila, reinicia e pausa no mesmo ponto.
13. **[manual]** Pausado, pressione Shift+F5. Esperado: em até 3 s a sessão termina, e no gerenciador de tarefas / `ps` não sobra o programa nem `lldb-dap`, `gdb` ou `netcoredbg`.
14. **[manual]** Adicione `int* p = nullptr; *p = 1;` e pressione F5. Esperado: pausa nessa linha, com a faixa "Pausado: exceção…" (acesso inválido).
15. **[manual]** Em C#, adicione `throw new Exception("x");` e pressione F5. Esperado: pausa no `throw`, com a mensagem `x` na faixa.
16. **[manual]** Pausado, encerre o processo `lldb-dap` pelo sistema. Esperado: aparece a mensagem de que o depurador encerrou, a IDE continua, e F5 inicia uma nova sessão.
17. **[manual]** Feche e reabra a IDE. Esperado: os pontos de parada voltam. A seção Pontos de parada lista todos; clicar leva à linha; o X remove.
18. **[manual]** Com um erro de compilação, pressione F5. Esperado: nenhuma sessão inicia, e o painel Problemas mostra o erro.
19. **[manual, Windows, risco conhecido]** Com o `hello-cpp` compilado com MSVC, os itens 5, 6 e 9 funcionam com `lldb-dap`. Anotar o resultado no relatório de release.

## O que fica de fora

- **Watch, console de depuração (avaliar expressões), valor ao passar o mouse e mudar o valor de variável:** depois (README).
- **Pontos de parada condicionais, de log, de função, de dados e em linha; ativar/desativar sem remover:** depois.
- **Executar até o cursor, definir a próxima instrução e escolher em qual chamada entrar:** depois.
- **Anexar a processo, várias sessões ao mesmo tempo, core dumps e depuração remota:** depois / fora.
- **Janelas de memória, desmontagem e registradores:** depois. Se o depurador devolver um escopo de registradores, ele aparece fechado em Variáveis.
- **Configurar quais exceções param:** depois. O MVP para só nas não tratadas (C#) e nas falhas de memória (C/C++).
- **Edit and Continue / Hot Reload:** fora (README).
- **Arquivo de configuração de depuração (estilo `launch.json`):** fora. O MVP não exige configuração.

## Riscos para a implementação

- **macOS:**
  - F11 é, por padrão, "Mostrar mesa" no sistema.
  - Em notebooks, as teclas F exigem Fn.
  - A IDE mantém os atalhos do VS Code; o aviso vai para a documentação de usuário.
- **Windows:**
  - Depurar binários MSVC com `lldb-dap` é menos maduro que o depurador do Visual Studio, que é proibido pela stack.
  - Ver a decisão no README e o critério 19.
- **GDB em modo DAP:** é preciso confirmar se ele atende `runInTerminal`. Se não atender, a regra de "saída só para leitura" do item 3 de "Iniciar" se aplica.
