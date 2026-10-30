# Compilar e executar

Status: **MVP (v0.5)** · Depende de: [projeto.md](projeto.md), [terminal.md](terminal.md), [linguagem.md](linguagem.md) (painel Problemas) · Usado por: [depuracao.md](depuracao.md)

## Problema do usuário

Quero apertar uma tecla e compilar. Se der erro, quero clicar nele e ir para a linha. Quero apertar outra tecla e ver meu programa rodando, podendo digitar a entrada dele. Tudo isso sem configurar tarefas nem perfis.

## O que as IDEs de referência fazem

- **VS Code:**
  - Ctrl+Shift+B executa a tarefa de build. Com uma tarefa padrão definida, roda direto.
  - "Problem matchers" leem a saída da tarefa e mandam erros e avisos para o editor e o painel Problemas. O `$mscompile` (compiladores C# e VB) já vem embutido, e a extensão de C/C++ traz o equivalente para GCC.

  [Tasks](https://code.visualstudio.com/docs/debugtest/tasks)
- **VS Code:**
  - Por padrão salva todos os editores antes de rodar uma tarefa (`task.saveBeforeRun` = `always`).
  - Antes de iniciar uma depuração, salva os editores do grupo ativo (`debug.saveBeforeStart`).

  Fontes: [task.contribution.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/tasks/browser/task.contribution.ts) e [debug.contribution.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/debug/browser/debug.contribution.ts) (MIT).
- **VS Code:** Ctrl+F5 (⌃F5 no mac) inicia sem depurar. [Default keyboard shortcuts](https://code.visualstudio.com/docs/reference/default-keybindings), [debugCommands.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/debug/browser/debugCommands.ts) (MIT)
- **CLion:** salva automaticamente ao compilar, rodar e depurar. [Save and revert changes](https://www.jetbrains.com/help/clion/saving-and-reverting-changes.html)
- **CLion:**
  - Cria uma configuração de execução por alvo do CMake no primeiro carregamento.
  - Ao rodar, abre a janela Run (ou Debug) com a saída.

  [Quick CMake tutorial](https://www.jetbrains.com/help/clion/quick-cmake-tutorial.html), [Run/debug configurations](https://www.jetbrains.com/help/clion/run-debug-configuration.html)
- **Visual Studio:**
  - Ctrl+Shift+B compila a solução.
  - A Lista de Erros junta erros de build e de IntelliSense; duplo clique leva à linha.
  - A janela Saída (Ctrl+Alt+O) mostra o texto completo.

  [Keyboard shortcuts in Visual Studio](https://learn.microsoft.com/en-us/visualstudio/ide/default-keyboard-shortcuts-in-visual-studio), [Error List](https://learn.microsoft.com/en-us/visualstudio/ide/error-list-window)
- **Ferramentas:**
  - `cmake --build <pasta> [--target <alvo>]` compila uma pasta de build já configurada.
  - `dotnet build -c <config>` e `dotnet run --no-build` compilam e rodam projetos .NET.

  [cmake(1): Build a Project](https://cmake.org/cmake/help/latest/manual/cmake.1.html), [dotnet build](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build), [dotnet run](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run)

## Comportamento esperado no Dark Triad

### Compilar (Ctrl+Shift+B)

1. **Antes de compilar:**
   - salva **todos** os arquivos modificados (como o padrão do VS Code e o CLion);
   - se o CMake ainda não foi configurado, ou se a configuração está pendente, configura primeiro ([projeto.md](projeto.md)).
2. **Comando** (com o ambiente do MSVC no Windows, quando em uso):

   | Projeto | Comando |
   |---|---|
   | CMake | `cmake --build <pasta de build ativa>` (todos os alvos) |
   | .NET | `dotnet build <sln ou csproj> -c <Debug ou Release>` |

3. **Saída:**
   - O painel Saída abre no canal **Build**, sem tirar o foco do editor.
   - O texto chega ao vivo. A última linha é "Concluída em 3,2 s" ou "Falhou em 3,2 s".
4. **Barra de status:**
   - durante a compilação: "Compilando…" com um botão ✕ (dica "Cancelar compilação");
   - ao terminar, por 5 s: "Compilação concluída" ou "Compilação falhou: 2 erros, 1 aviso".
5. **Erros clicáveis:** as linhas da saída abaixo viram links na Saída e itens no painel Problemas (origem `build`).

   | Formato | Exemplo |
   |---|---|
   | GCC/Clang | `app/main.cpp:5:10: error: expected ';' after expression`. Também sem coluna. `warning:` vira aviso; `note:` vira informação. |
   | MSVC | `C:\p\app\main.cpp(5,10): error C2143: syntax error`. Também `(5)` sem coluna. |
   | dotnet/MSBuild | `C:\p\Program.cs(3,17): error CS0029: … [C:\p\hello-cs.csproj]`. O sufixo `[projeto]` é removido. |

6. **Regras dos erros:**
   - Caminhos relativos são resolvidos primeiro pela pasta de build e depois pela raiz do projeto. Se o arquivo não existe em nenhuma, a linha fica sem link.
   - Itens repetidos (mesmo arquivo, linha, coluna e mensagem) entram uma vez só. O dotnet repete os erros no resumo final.
   - **Reserva:** se a compilação falhou e nenhuma linha foi reconhecida (ex.: erro do linker), o painel Problemas recebe um item "A compilação falhou. Veja a Saída." que abre a Saída. Assim nunca há "falhou, mas não diz onde".
   - Cada compilação substitui os itens de origem `build` e não mexe nos do clangd/Roslyn ([linguagem.md](linguagem.md)).
7. **Cancelar:** o ✕ ou o comando **Compilar: Cancelar** encerram o processo e **todos os filhos** (ninja, compiladores).
8. **Uma compilação por vez:** Ctrl+Shift+B durante uma compilação mostra "Já há uma compilação em andamento" e não inicia outra.

### Executar sem depurar (Ctrl+F5)

1. **Precisa de um alvo ativo** ([projeto.md](projeto.md)). Sem alvo executável: "Nenhum programa para executar. Escolha um alvo na barra de status."
2. **Antes de rodar:** salva tudo e compila só o necessário:

   | Projeto | Comando |
   |---|---|
   | CMake | `cmake --build <pasta> --target <alvo>` |
   | .NET | `dotnet build <projeto> -c <config>` |

   Se falhar, não roda e abre o painel Problemas.
3. **Rodar:**

   | Projeto | Comando |
   |---|---|
   | CMake | executa o caminho do executável vindo da File API |
   | .NET | `dotnet run --project <projeto> -c <config> --no-build` |

4. **Onde roda:**
   - num terminal integrado chamado `▶ <alvo>`, reaproveitado entre execuções ([terminal.md](terminal.md));
   - pasta de trabalho: a raiz do projeto;
   - o programa lê o teclado normalmente (`scanf`, `std::cin`, `Console.ReadLine`).
5. **Ao terminar:** o terminal mostra "O programa terminou com código N" e continua aberto para leitura.
6. **Barra de status:** "▶ app rodando", com o botão ■ (dica "Parar (Shift+F5)").
7. **Ctrl+F5 com o programa já rodando:** pergunta "app já está rodando. Reiniciar?", com as opções **Reiniciar** e **Cancelar**. Reiniciar encerra o processo anterior (e os filhos) antes de começar de novo.
8. **Parar:** Shift+F5 encerra o programa, o mesmo atalho de parar a depuração.

### Painel Saída

1. Ctrl+Shift+U; no Linux, Ctrl+K Ctrl+H.
2. É somente leitura, com uma lista de canais: Build, CMake, dotnet, clangd, C#, Depuração.
3. Rola sozinho, a não ser que o usuário tenha subido a rolagem.
4. Tem o botão **Limpar** e guarda até 10.000 linhas por canal.

## Atalhos (padrão do VS Code)

| Ação no Dark Triad | Windows | Linux | macOS | Comando VS Code e fonte |
|---|---|---|---|---|
| Executar: Compilar | Ctrl+Shift+B | Ctrl+Shift+B | ⇧⌘B | `workbench.action.tasks.build` ([Tasks](https://code.visualstudio.com/docs/debugtest/tasks)) |
| Executar: Executar sem depurar | Ctrl+F5 | Ctrl+F5 | ⌃F5 | `workbench.action.debug.run` ([debugCommands.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/debug/browser/debugCommands.ts), MIT) |
| Executar: Parar | Shift+F5 | Shift+F5 | ⇧F5 | `workbench.action.debug.stop` ([Debugging](https://code.visualstudio.com/docs/debugtest/debugging)) |
| Ver: Saída | Ctrl+Shift+U | Ctrl+K Ctrl+H | ⇧⌘U | `workbench.action.output.toggleOutput` ([default keybindings](https://code.visualstudio.com/docs/reference/default-keybindings)) |
| Compilar: Cancelar | nenhum | nenhum | nenhum | (paleta e botão ✕) |

## Critérios de aceite

1. **[auto]** O leitor de saída reconhece:
   - `app/main.cpp:5:10: error: expected ';'` → erro, `app/main.cpp`, linha 5, coluna 10;
   - `app/main.cpp:5: warning: x` → aviso, linha 5, sem coluna;
   - `…: note: …` → informação.
2. **[auto]** O leitor reconhece `C:\p\app\main.cpp(5,10): error C2143: syntax error` (código `C2143`) e `main.cpp(7): warning C4244: conversion`.
3. **[auto]** O leitor reconhece `C:\p\Program.cs(3,17): error CS0029: Cannot convert [C:\p\hello-cs.csproj]`: mensagem sem o sufixo, código `CS0029`. A mesma linha repetida duas vezes vira um item só.
4. **[auto]** Com o processo terminando com código ≠ 0 e nenhuma linha reconhecida, o resultado tem exatamente um item "A compilação falhou. Veja a Saída.". Com código 0, nenhum item de reserva.
5. **[auto]** `../app/main.cpp` emitido com pasta de build `<raiz>/build/debug` resolve para `<raiz>/app/main.cpp`.
6. **[auto]** Os comandos montados são exatamente:
   - `cmake --build <raiz>/build/debug`;
   - `cmake --build <raiz>/build/debug --target app`;
   - `dotnet build <raiz>/hello-cs.csproj -c Release`;
   - `dotnet run --project <raiz>/hello-cs.csproj -c Debug --no-build`.
7. **[manual]** Em `hello-cpp`, altere `app/main.cpp` **sem salvar** e pressione Ctrl+Shift+B (⇧⌘B). Esperado: o arquivo é salvo (o ● some), a Saída/Build mostra o log, e a barra mostra "Compilação concluída".
8. **[manual]** Apague um `;` e compile. Esperado: "Compilação falhou: 1 erro". O painel Problemas tem o item com origem `build`. A linha na Saída é um link que abre o arquivo na linha e coluna do erro.
9. **[manual]** Declare `int falta();`, chame `falta()` e compile. Esperado: falha do linker; o painel Problemas tem ao menos um item, e clicar nele leva à Saída ou ao arquivo.
10. **[manual]** Em `hello-c`, pressione Ctrl+F5 (⌃F5). Esperado: abre o terminal `▶ hello`. Digite `21` e Enter. Esperado: aparece `42` e depois "O programa terminou com código 0".
11. **[manual]** Em `hello-cs`, pressione Ctrl+F5, digite `abc` e Enter. Esperado: aparece `cba`.
12. **[manual]** Com o programa do item 10 esperando entrada, pressione Ctrl+F5 de novo. Esperado: a pergunta "já está rodando. Reiniciar?". **Reiniciar** encerra o processo antigo (o PID some) e inicia um novo.
13. **[manual]** Com o programa esperando entrada, pressione Shift+F5. Esperado: o programa termina, e o terminal mostra o encerramento.
14. **[manual]** Apague `build/` e compile o `hello-cpp`. Durante a compilação, digite no editor (sem atraso perceptível) e clique no ✕. Esperado: a compilação para, e no gerenciador de tarefas / `ps` não sobra `ninja`, `cl`, `clang` nem `cc1plus`.
15. **[manual]** Escolha o alvo `tool` e pressione Ctrl+F5. Esperado: roda `tool`, não `app`.
16. **[manual]** Numa pasta CMake só com uma biblioteca, Ctrl+F5 mostra "Nenhum programa para executar…".
17. **[manual]** Ctrl+Shift+U (Ctrl+K Ctrl+H no Linux) mostra e esconde a Saída. A lista de canais mostra Build, CMake e clangd depois de compilar o `hello-cpp`.

## O que fica de fora

- **Argumentos, variáveis de ambiente e outra pasta de trabalho para o programa:** depois (README).
- **Limpar, recompilar tudo e compilar só um alvo escolhido à mão:** depois. Compilar = todos; executar = só o alvo ativo.
- **Tarefas personalizadas (`tasks.json`) e problem matchers configuráveis:** fora.
- **Rodar vários programas ao mesmo tempo:** depois.
- **Console externo (janela separada do sistema):** fora.
- **Presets de build do CMake:** depois ([projeto.md](projeto.md)).
- **`dotnet watch` e Hot Reload:** fora (README).
