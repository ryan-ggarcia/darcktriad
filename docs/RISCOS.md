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
- **Critério 5 da spec:** `../app/main.cpp` com pasta de build `<raiz>/build/debug` aponta para `<raiz>/build/app/main.cpp`, não para `<raiz>/app/main.cpp`. O núcleo segue a regra (pasta de build, depois raiz), e o teste usa `../../app/main.cpp`.

## Linguagem (clangd e Roslyn)

- **Pasta de build trocada rápido demais:** trocar Debug/Release duas vezes muito rápido pode deixar o clangd com a pasta da configuração anterior, até a próxima troca ou um "Linguagem: Reiniciar servidor".
- **Servidores encerrados à força,** sem o aviso de saída do LSP. Hoje isso não perde nada.
- **Atalhos Voltar/Avançar no Linux** são Ctrl+Alt+- e Ctrl+Shift+-, como no VS Code, não Alt+← / Alt+→.
- **Ctrl+clique** não sublinha o nome ao segurar o Ctrl, e o menu de contexto do editor não tem "Ir para definição".
- **F8 fora de um problema** vai para o primeiro problema do arquivo, não para o mais próximo do cursor.
- **Queda repetida do clangd:** o reinício automático foi testado na janela, mas a 4ª queda em 5 minutos (mensagem com o botão Reiniciar) só tem teste automático.
- **Textos do editor em inglês:** o hover de erro mostra "View Problem (Alt+F8)" e "No quick fixes available", que vêm do Monaco sem tradução.
- **Contador da barra** mostra só erros e avisos; itens informativos (ex.: `IDE0059` do C#) aparecem só no painel Problemas.
- **C# em projeto grande:** a cada alteração (300 ms depois de parar de digitar), o editor pede ao Roslyn os erros das 8 categorias. Foi rápido no `hello-cs`, mas nunca foi medido num projeto grande.

## Sem teste na janela

- **Linguagem:** o critério 15 (desempenho com o clangd num arquivo de 10.000 linhas) não tem a fixture `grande`. Os critérios 5 a 14 passaram na janela em 2026-10-31, só no Linux.
- **Projeto:** o critério 12 (.NET na janela) e o 13 (Windows).
- **Compilar e executar:** a interface ainda não existe. Os critérios manuais 7 a 17 só têm a parte do núcleo testada (cmake, dotnet e PTY reais, no Linux).
- **Instaladores:** os do Windows e do macOS nunca foram abertos. O AppImage só foi aberto, sem uso.

## Adiado de propósito

- **Instalação automática de ferramentas** ([ferramentas.md](specs/ferramentas.md)): a IDE só detecta e explica como instalar.
