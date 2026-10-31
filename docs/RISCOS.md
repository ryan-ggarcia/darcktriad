# Riscos e problemas conhecidos

O que ficou sem corrigir ou sem testar, em linguagem simples. Os detalhes técnicos do núcleo estão em [ipc.md](ipc.md#limites-conhecidos). Atualize esta lista ao corrigir um item ou ao achar um novo.

## Windows

- **Ambiente do compilador da Microsoft (vcvars):** ainda não é aplicado. O cmake, o clangd e o terminal só acham o compilador se ele já estiver no `PATH`. Critério manual 13 de [projeto.md](specs/projeto.md) sem teste.
- **Ferramentas:** a busca não olha `C:\Program Files\LLVM\bin`.
- **Processos que sobram:** cancelar o cmake não encerra o que ele iniciou, e parar o Roslyn deixa o BuildHost rodando.
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
- **Instaladores:** os do Windows e do macOS nunca foram abertos. O AppImage só foi aberto, sem uso.

## Adiado de propósito

- **Instalação automática de ferramentas** ([ferramentas.md](specs/ferramentas.md)): a IDE só detecta e explica como instalar.
