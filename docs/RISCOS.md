# Riscos e problemas conhecidos

O que ficou sem corrigir ou sem testar, em linguagem simples. Os detalhes técnicos do núcleo estão em [ipc.md](ipc.md#limites-conhecidos). Atualize esta lista ao corrigir um item ou ao achar um novo.

## Windows

- **Ambiente do compilador da Microsoft (vcvars):** ainda não é aplicado. O cmake, a compilação, o clangd e o terminal só acham o compilador se ele já estiver no `PATH`. Critério manual 13 de [projeto.md](specs/projeto.md) sem teste.
- **Ferramentas:** a busca não olha `C:\Program Files\LLVM\bin`.
- **Processos que sobram:** cancelar o cmake ou a compilação, parar o Roslyn e parar o programa agora encerram a árvore toda com `taskkill /T /F`. Nunca foi testado no Windows (critério 14 de [compilar-e-executar.md](specs/compilar-e-executar.md)).
- **Testes de integração** (cmake, dotnet, clangd, Roslyn reais) não rodam no Windows.

## macOS

- **PATH:** com a IDE aberta pelo Finder, o terminal e a busca de ferramentas não têm o `PATH` do `~/.zprofile` (Homebrew, cmake, dotnet). O shell do terminal não é de login.
- **Reconfigurar ao salvar** depende de o caminho da pasta aberta não passar por link simbólico (ex.: `/tmp` → `/private/tmp`).

## Terminal

- **`\r` a mais no macOS:** com a fila de saída do terminal cheia, o macOS às vezes manda `\r\r\n` no lugar de `\r\n` (o kernel repete o `\r` ao tentar de novo). Na tela não muda nada e nenhuma entrada se perde; só quem compara a saída byte a byte (testes) precisa ignorar os `\r`. Era a causa do teste instável `writes_reach_the_program_in_order`.
- **Sem controle de fluxo:** um programa que escreve sem parar pode deixar a interface lenta. Com 100.000 linhas, a interface travou no máximo cerca de 0,3 s.
- **Programa que ignora o fechamento** (`nohup … &`) continua rodando se o shell já saiu.
- **Colar no Linux** usa a área de transferência do navegador e nunca foi testado no WebKitGTK. Pode ser recusado ou pedir confirmação.
- **Atalho no teclado ABNT2:** no Linux o app só descobre o caractere da tecla depois do primeiro aperto. Até lá a tela mostra "Ctrl+`" em vez de "Ctrl+'", a cada abertura do app.
- **Fonte:** em Linux sem Adwaita Mono, DejaVu Sans Mono, Liberation Mono ou Ubuntu Mono, o terminal cai numa fonte com espaçamento ruim (ex.: "Interf ace").

## Projeto (CMake e .NET)

- **.NET:** salvar `.csproj`/`.sln` não reconfigura sozinho, e erros de restore sem linha e coluna (ex.: pacote não encontrado) só aparecem na Saída.
- **CI:** no Ubuntu, os testes com o cmake real provavelmente são pulados, porque o CI não instala o cmake. Só o macOS confirma essa parte.

## Compilar e executar

- **.NET deixa processos rodando:** o `dotnet build` deixa o servidor de compilação (`VBCSCompiler`) e nós do MSBuild abertos depois de terminar, para a próxima compilação ser rápida. Eles saem sozinhos depois de alguns minutos e continuam mesmo com a IDE fechada. É o comportamento normal do dotnet.
- **.NET com vários frameworks-alvo não roda:** o `dotnet run` pede `--framework`, e o comando da spec não passa.
- **Cancelar durante a configuração:** se o ✕ for clicado enquanto o CMake configura (antes de compilar), a configuração vai até o fim e só então a compilação é cancelada.
- **Programa que sai da sessão** (daemon, `setsid`) continua rodando depois de Parar, no macOS e no Linux.
- **Links na Saída só no fim:** as linhas de erro do canal Build viram links quando a compilação termina, não enquanto o texto chega. O link casa nome do arquivo, linha e mensagem; dois arquivos com o mesmo nome, a mesma linha e a mesma mensagem em pastas diferentes podem trocar de destino.
- **Cancelar deixa lixo em `/tmp`:** os compiladores encerrados à força deixam arquivos temporários vazios do GCC (`/tmp/ccXXXX.s`), alguns por cancelamento.
- **Tempo de digitação durante a compilação** não foi medido de verdade: pelo WebDriver, a ida e volta de cada tecla foi de 40–100 ms parado e de 90–420 ms compilando (máquina de 2 núcleos, com o clangd reindexando). Precisa de um teste com teclado real.
- **Salvar o `CMakeLists.txt` enquanto a compilação configura** interrompe a configuração ("A configuração do projeto foi interrompida.").
- **Apagar o `build/`** só reconfigura na próxima compilação. Até lá, o clangd fica sem o `compile_commands.json`. A correção (29b7ee9) tem só teste automático: os 8 ciclos do QA na janela não foram refeitos.
- **Erros da compilação não sublinham o editor:** eles vão para o painel Problemas e para a Saída; o sublinhado continua sendo só do clangd/Roslyn.

## Linguagem (clangd e Roslyn)

- **Pasta de build trocada rápido demais:** trocar Debug/Release duas vezes muito rápido pode deixar o clangd com a pasta da configuração anterior, até a próxima troca ou um "Linguagem: Reiniciar servidor".
- **Servidores encerrados à força,** sem o aviso de saída do LSP. Não perde nada, mas o clangd não apaga os seus arquivos `preamble-*.pch` (0,2 a 5 MB cada). Em 2026-11-02 havia 62 deles (152 MB) em `/tmp`, só dos testes do dia. Corrigido para a v0.6.1: os servidores de linguagem escrevem os temporários na pasta `servers` do cache do app, e não mais em `/tmp`. Ela é esvaziada quando o app abre e nenhuma outra instância dele está aberta. Com duas instâncias abertas, a limpeza fica para a próxima vez que o app abrir sozinho. Testado com o clangd de verdade (teste automático: o `.pch` vai para a pasta do app e some na limpeza), mas não na janela. Os `.pch` antigos em `/tmp` não são apagados.
- **Abrir uma pasta recente enquanto a última pasta ainda reabre** (logo depois de abrir o app) junta as abas das duas pastas, e a mistura fica salva na sessão da pasta nova. Reabrir a mesma pasta assim duplica a aba. Visto pelo WebDriver (QA, 2026-11-02), com o clique logo que a tela inicial apareceu; não foi medido por quanto tempo a tela inicial fica clicável. Corrigido para a v0.6.1 (cada abertura de pasta ganha um número e o que chega de uma abertura antiga é descartado; o mesmo arquivo nunca vira duas abas), só com teste automático: falta o reteste na janela.
- **Atalhos Voltar/Avançar no Linux** são Ctrl+Alt+- e Ctrl+Shift+-, como no VS Code, não Alt+← / Alt+→.
- **Ctrl+clique** não sublinha o nome ao segurar o Ctrl, e o menu de contexto do editor não tem "Ir para definição".
- **F8 fora de um problema** vai para o primeiro problema do arquivo, não para o mais próximo do cursor.
- **Queda repetida do clangd:** o reinício automático foi testado na janela, mas a 4ª queda em 5 minutos (mensagem com o botão Reiniciar) só tem teste automático.
- **Textos do editor em inglês:** o hover de erro mostra "View Problem (Alt+F8)" e "No quick fixes available", que vêm do Monaco sem tradução.
- **Contador da barra** mostra só erros e avisos; itens informativos (ex.: `IDE0059` do C#) aparecem só no painel Problemas.
- **C# em projeto grande:** a cada alteração (300 ms depois de parar de digitar), o editor pede ao Roslyn os erros das 8 categorias. Foi rápido no `hello-cs`, mas nunca foi medido num projeto grande.

## Depuração (núcleo da v0.6)

- **Teste do netcoredbg instável com a máquina ocupada:** `netcoredbg_stops_at_a_breakpoint_in_hello_cs_and_runs_to_the_end` falhou 1 vez (68 s, esperando o fim da sessão depois do `disconnect`) com a bateria inteira rodando junto com outro agente; sozinho passou 4 de 4 vezes em ~8 s. Não se sabe se é só lentidão ou se o `disconnect` às vezes não encerra a sessão.
- **Sem símbolos baixados do sistema:** o núcleo tira o `DEBUGINFOD_URLS` dos processos que inicia. Com ele (padrão no Arch, Fedora e Ubuntu), o lldb-dap travava minutos baixando os símbolos do próprio lldb-dap ao usar o terminal integrado. Efeito: entrar em funções da libc mostra só desmontagem.
- **C# não lê o teclado ao depurar:** o netcoredbg 3.2 não pede o `runInTerminal`, e o `Console.ReadLine` do programa espera para sempre. **Decisão do usuário (2026-11-02): aceitar o limite no MVP**; o critério 8 de [depuracao.md](specs/depuracao.md) foi trocado para uma entrada fixa, e o terminal 🐞 mostra a saída só para leitura com o aviso. O teste automático do `hello-cs` troca o `ReadLine` por um texto fixo.
  - **Por quê (testado e lido no código do netcoredbg):** no modo DAP, ele sempre liga a entrada e a saída do programa a canos (pipes) dele mesmo. A saída vira eventos `output`. A entrada só é repassada no modo de linha de comando (`--interpreter=cli`), nunca no DAP. O `launch` não tem opção de console ou terminal: só `program`, `args`, `cwd`, `env`, `stopAtEntry`, `justMyCode` e `enableStepFiltering`.
  - **Rodar o netcoredbg dentro do terminal 🐞, falando DAP por TCP, não resolve:** o programa não herda o terminal, porque a entrada dele continua sendo o cano. Esse modo também tem dois problemas: o `--server` escuta em todas as interfaces de rede (`0.0.0.0`), não só em `127.0.0.1`, e não aceita porta escolhida pelo sistema (porta 0).
  - **Caminho que funcionou num protótipo, só no Linux e no macOS:** pedir ao netcoredbg para iniciar `/bin/sh -c 'exec dotnet "$0" </dev/pts/N >/dev/pts/N 2>&1' <programa>.dll`, onde `/dev/pts/N` é o terminal 🐞. O `exec` mantém o mesmo processo, então o netcoredbg depura o `dotnet` normalmente: o ponto de parada funcionou, `abc` foi lido do terminal e `cba` apareceu nele. Não serve no Windows, que não tem `exec`. Não foi implementado: exige um terminal sem processo próprio e é uma decisão de spec.
- **Só o lldb-dap 23 e o netcoredbg 3.2 foram testados**, e só no Linux. O CI instala o lldb-dap 21 (apt.llvm.org) no Ubuntu e usa o do Xcode no macOS. O netcoredbg 3.2 **não roda no Ubuntu 22.04 nem em distros com glibc < 2.38** (exige GLIBC_2.38 e GLIBCXX_3.4.32), por isso o CI não o instala e o teste de C# só roda localmente. Windows: nenhum teste de depuração.
- **Windows:** se o adaptador cair, o que ele iniciou (o programa sob o netcoredbg) pode sobrar. No Linux e no macOS isso é encerrado.
- **O lldb-dap recusa o `terminate`:** cada Parar no C/C++ deixa "terminate: recusado pelo depurador" no canal Depuração. O Parar funciona mesmo assim (segue para o `disconnect`), mas a linha pode confundir quem lê a Saída. O F6 cedo também pode deixar "pause: Failed command 'pause' : 0x80070057" (netcoredbg) enquanto o programa ainda não começou: é a recusa esperada antes de repetir.
- **Lixo em `/tmp`:** um lldb-dap encerrado à força no meio do início pode deixar o arquivo `/tmp/lldb-dap-run-in-terminal-comm-*`.
- **Recarregar do disco** um arquivo com pontos de parada mantém as linhas antigas, mesmo que o código delas tenha mudado. Sem isso, todas as bolinhas iriam para a linha 1.
- **Coleções em blocos:** quando o depurador avisa que há mais de 100 itens, só os blocos aparecem; os campos com nome do objeto (ex.: `Count`) ficam de fora.
- **Pilha de chamadas** mostra só os 200 frames do topo (ex.: numa recursão infinita).
- **Margem do editor:** não aparece a bolinha clara ao passar o mouse; o ponto só aparece depois do clique (ou F9).
- **Interface da v0.6 na janela** (Linux, lldb-dap 23 e netcoredbg 3.2, 2026-11-02): os critérios 5 a 18 de [depuracao.md](specs/depuracao.md) passaram. O 11 (F6) e o 15 (mensagem da exceção) falharam no primeiro teste e passaram no reteste depois da correção (e187506). Os pontos de parada (critério 3) e a sequência DAP têm teste automático no `ng test`.

## Sem teste na janela

- **Linguagem:** o critério 15 (desempenho com o clangd num arquivo de 10.000 linhas) não tem a fixture `grande`. Os critérios 5 a 14 passaram na janela em 2026-10-31, só no Linux.
- **Projeto:** o critério 12 (.NET na janela) e o 13 (Windows).
- **Compilar e executar:** na janela, no Linux, com o `hello-c` (2026-11-02): compilar com erro (links, Problemas, foco no editor), erro do linker (item de reserva), Ctrl+F5 com entrada (`21` → `42` e o código de saída), a pergunta de reiniciar, Shift+F5 e Ctrl+K Ctrl+H passaram. Também passaram na janela (QA, 2026-11-02): salvar antes de compilar, C# (`abc` → `cba`), cancelar com o ✕ (para em menos de 0,1 s e não sobra `ninja`, `cmake` nem `cc1plus`), alvo `tool` no Ctrl+F5, pasta só com biblioteca e a lista de canais (Build, CMake, clangd). Nada disso foi testado no Windows nem no macOS: lá, o encerramento da árvore de processos com `taskkill` (cancelar, parar, reiniciar) e os atalhos ⇧⌘B, ⌃F5 e ⇧⌘U só foram compilados pelo CI.
- **Depuração:** passaram na janela, no Linux (QA, 2026-11-02): os critérios 5 a 10, 12 a 14 e 16 a 18 de [depuracao.md](specs/depuracao.md), com `hello-cpp`, `hello-c` (`21` digitado no terminal 🐞) e `hello-cs` (entrada fixa `abc` → `cba`, `List<int>` de 1.000 itens em blocos). No reteste (QA, 2026-11-02, e187506) passaram o 11 (F5/F6 três vezes no C++ e no C#, faixa "Pausado por você"), o 15 (faixa com a mensagem `x`), o nome `🐞 hello-cs` do terminal com F5 durante a configuração, o F11/Shift+F11 no C# e a barra flutuante com 6 abas (não cobre nenhuma; o clique em todas funciona). Com a janela estreitada pelo WebDriver (800 px), nenhum clique em aba funcionou, com ou sem depuração: não deu para saber se é limite do WebDriver ou das abas. O 19 (MSVC com lldb-dap) só pode ser testado no Windows. Nada foi testado no Windows nem no macOS. As correções depois da v0.6.0 passaram na janela (QA, 2026-11-02, 94f1f35): F6 cedo (C++ 8 vezes, de 0,1 s depois do F5 até 1 s depois de o programa nascer; C# 3 vezes, compilando, com o netcoredbg nascendo e 1,5 s depois do F5), sempre com um só F6; "🐞 Iniciando depuração…" e depois "🐞 Depurando hello-cs", nunca "Depurando programa"; Parar pausado e rodando em 0,03–0,23 s, sem sobrar programa, `lldb-dap`, `lldb-server` nem `netcoredbg`, com "O programa foi encerrado" no terminal 🐞; matar o `lldb-dap` filho pelo PID mostra o aviso na barra, sem caixa, e o F5 logo depois inicia outra sessão. O caminho de 3 s do Parar (depurador que não responde) só tem teste automático: na janela, o fim sempre veio antes.
- **Instaladores:** os do Windows e do macOS nunca foram abertos. O AppImage da v0.3.0 só foi aberto, sem uso; os da v0.4.0 e v0.5.0 foram publicados sem abrir nenhum.

## Adiado de propósito

- **Instalação automática de ferramentas** ([ferramentas.md](specs/ferramentas.md)): a IDE só detecta e explica como instalar.
