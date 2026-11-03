# Checklist: o que falta corrigir e validar

Estado em 2026-11-02, na v0.8.0. Cada item tem a explicação em [RISCOS.md](RISCOS.md), na seção indicada entre parênteses. Ao concluir um item, marque `[x]` aqui e atualize o RISCOS.md.

## 1. Validar no Windows (precisa de uma máquina Windows)

- [ ] Abrir os instaladores `.exe` e `.msi` e usar o app (Sem teste na janela › Instaladores)
- [ ] Projeto com MSVC: critério 13 de [projeto.md](specs/projeto.md) — depende de corrigir o vcvars (item 5) (Windows)
- [ ] Cancelar a compilação, parar e reiniciar o programa sem sobrar processo (`taskkill /T /F`): critério 14 de [compilar-e-executar.md](specs/compilar-e-executar.md) (Windows)
- [ ] Compilar e executar inteiro (critérios 7 a 17 de compilar-e-executar.md) (Sem teste na janela › Compilar e executar)
- [ ] Depuração com lldb-dap e netcoredbg; critério 19 (MSVC com lldb-dap) de [depuracao.md](specs/depuracao.md) (Depuração)
- [ ] Queda do depurador não deixa o programa rodando (Depuração › Windows)
- [ ] Atualizar pela IDE com um release real, pelo `.exe` (NSIS) e pelo `.msi`: aviso, progresso, "Reiniciar agora" e abrir na versão nova (Atualização automática)
- [ ] Temporários do clangd na pasta `servers` do app e limpeza ao abrir (Linguagem › Servidores encerrados à força)
- [ ] Testes de integração (cmake, dotnet, clangd, Roslyn reais) rodando no CI do Windows (Windows)

## 2. Validar no macOS (precisa de um Mac)

- [ ] Abrir o `.dmg` (Intel e Apple Silicon) e usar o app (Sem teste na janela › Instaladores)
- [ ] Atalhos ⇧⌘B, ⌃F5, ⇧⌘U, ⇧⌘D e as teclas F (F11 é "Mostrar mesa" no sistema) (Sem teste na janela; [depuracao.md](specs/depuracao.md) › Riscos)
- [ ] Compilar, executar e depurar com o lldb-dap do Xcode (Depuração)
- [ ] Colar um texto grande no terminal sem perder nada (Terminal › `\r` a mais no macOS)
- [ ] Temporários do clangd na pasta `servers` do app (Linguagem)
- [ ] Atualizar pela IDE com um release real, pelo `.app` (Intel e Apple Silicon): aviso, progresso, "Reiniciar agora" e abrir na versão nova (Atualização automática)

## 3. Validar no Linux com teclado e mouse reais

O WebDriver não mede nem faz estes. **O usuário faz estes testes conforme usa a IDE; os agentes não fazem** (decisão de 2026-11-02). Ao notar um problema, ele vira item do grupo 5.

- [ ] Digitar no editor durante a compilação sem atraso perceptível (Compilar e executar › Tempo de digitação)
- [ ] Colar no terminal pelo WebKitGTK (Terminal › Colar no Linux)
- [ ] Clicar nas abas com a janela estreita (800 px) (Sem teste na janela › Depuração) → pelo WebDriver, a 800 px, o clique em aba funcionou com o tema novo (causa provável do problema antigo: a barra de status empurrava os editores para fora da janela; não reproduzido na versão antiga); falta com o mouse real
- [ ] Digitar com o clangd ativo: decidir se o atraso se percebe (a medida automática oscila em torno da meta de 50 ms) (Sem teste na janela › Linguagem)
- [ ] Abrir o AppImage, o `.deb` e o `.rpm` e usar o app de verdade (Sem teste na janela › Instaladores)
- [ ] Atualizar pela IDE com um release real, pelo AppImage, pelo `.deb` e pelo `.rpm` (estes pedem a senha: a tela não pode parecer travada), com um arquivo sem salvar e um programa rodando antes de "Reiniciar agora" (Atualização automática)

## 4. Validar no Linux (o QA pode fazer pelo WebDriver ou com teste automático)

- [x] Apagar o `build/` e compilar logo em seguida, 8 vezes (correção 29b7ee9 só tem teste automático) (Compilar e executar › Apagar o `build/`)
- [x] .NET na janela: critério 12 de [projeto.md](specs/projeto.md) (Sem teste na janela › Projeto)
- [ ] Desempenho do clangd num arquivo de 10.000 linhas: criar a fixture `grande` e o critério 15 de [linguagem.md](specs/linguagem.md) (Sem teste na janela › Linguagem) → FALHOU por pouco na v0.6.2: p95 de 44 a 52 ms (4 de 5 rodadas abaixo da meta de 50 ms); era 65 ms
- [x] C# num projeto grande: tempo dos diagnósticos do Roslyn (Linguagem › C# em projeto grande)
- [x] 4ª queda do clangd em 5 minutos mostra o botão Reiniciar (Linguagem › Queda repetida)
- [x] Parar com o depurador travado termina em ~3 s (Sem teste na janela › Depuração)
- [x] Teste do netcoredbg instável com a máquina ocupada: descobrir se o `disconnect` às vezes não encerra a sessão (Depuração): sim, defeito do netcoredbg; a IDE não é afetada, o teste sim (item novo no grupo 5)
- [x] Duas janelas da IDE abertas: os temporários do clangd não são apagados enquanto a outra usa (Linguagem)
- [x] CI do Ubuntu rodando os testes com o cmake real (Projeto › CI): não são pulados; a imagem do Ubuntu já tem cmake e ninja

## 5. Corrigir

Bugs e limites, do mais importante para o menos importante.

- [ ] **Windows:** aplicar o ambiente do compilador da Microsoft (vcvars) (Windows)
- [ ] **Windows:** procurar ferramentas em `C:\Program Files\LLVM\bin` (Windows)
- [x] **macOS:** terminal e busca de ferramentas com o `PATH` do `~/.zprofile` quando a IDE é aberta pelo Finder (macOS)
- [x] **macOS:** reconfigurar ao salvar quando a pasta passa por link simbólico (macOS)
- [x] Salvar o `CMakeLists.txt` durante a configuração da compilação não pode interromper a configuração (Compilar e executar) → passou na janela (QA, 03b186a)
- [x] Cancelar enquanto o CMake configura deve parar na hora (Compilar e executar) → passou na janela (QA, 03b186a)
- [x] Apagar o `build/` deve reconfigurar sem esperar a próxima compilação, para o clangd não ficar sem o `compile_commands.json` (Compilar e executar) → passou na janela (QA, 03b186a)
- [x] .NET com vários frameworks-alvo: passar `--framework` no `dotnet run` (Compilar e executar) → passou na janela (QA, 03b186a), com `net10.0;net10.0-browser`, sem baixar o 8.0
- [x] .NET: salvar `.csproj`/`.sln` reconfigura; erros de restore sem linha aparecem em Problemas (Projeto) → passou na janela (QA, 03b186a)
- [x] Trocar Debug/Release duas vezes rápido deixa o clangd na pasta errada (Linguagem) → passou na janela (QA, 03b186a)
- [ ] Encerrar o clangd e o Roslyn com `shutdown`/`exit` do LSP antes de matar (Linguagem)
- [ ] Digitar com o clangd ativo: meta de p95 abaixo de 50 ms (critério 15 de [linguagem.md](specs/linguagem.md)) (Sem teste na janela › Linguagem) → com a máquina livre, pelo WebDriver no arquivo de 10.000 linhas: 49, 45, 44, 52 e 45 ms; pelo inspetor: todas as 12 rodadas abaixo de 50 ms (34 a 46 ms). Não passa por uma rodada; números em RISCOS.md, decisão do CTO
- [x] Teste do netcoredbg: não esperar o netcoredbg sair sozinho depois do `disconnect`, que às vezes ele não sai; chamar o `stop` como a interface faz (Depuração)
- [ ] Links de erro na Saída enquanto a compilação ainda roda, e sem confundir arquivos com o mesmo nome (Compilar e executar)
- [ ] Erros da compilação sublinhados no editor (Compilar e executar)
- [x] Lixo em `/tmp`: `cc*.s` do GCC ao cancelar e `lldb-dap-run-in-terminal-comm-*` (Compilar e executar; Depuração) → o `cc*.s` foi corrigido e passou na janela (QA, 03b186a); o do lldb-dap foi para a pasta `servers` do app (teste automático com o lldb-dap real; sem teste na janela)
- [ ] Programas que saem da sessão (`setsid`, `nohup … &`) continuam depois de Parar ou de fechar o terminal (Terminal; Compilar e executar)
- [ ] Terminal sem controle de fluxo: muita saída pode travar a interface por ~0,3 s (Terminal)
- [x] ABNT2: mostrar "Ctrl+'" desde a abertura, e não só depois do primeiro aperto (Terminal): o caractere aprendido fica guardado; só a primeira abertura de todas ainda espera o aperto; passou na janela (QA, 03b186a)
- [ ] Fonte do terminal em Linux sem as fontes monoespaçadas conhecidas (Terminal)
- [x] Depuração: não mostrar "terminate: recusado" do lldb-dap como erro no canal Depuração (Depuração) → passou na janela (QA, 03b186a)
- [ ] Depuração: campos com nome (ex.: `Count`) junto com os blocos de coleções grandes (Depuração)
- [x] Depuração: pontos de parada ao recarregar o arquivo do disco (Depuração) → passou na janela (QA, 03b186a)
- [ ] Depuração: bolinha clara ao passar o mouse na margem (Depuração)
- [ ] Linguagem: Ctrl+clique sublinha o nome; "Ir para definição" no menu de contexto (Linguagem)
- [x] Linguagem: F8 vai para o problema mais próximo do cursor (Linguagem): fora de um problema, o próximo depois do cursor (Shift+F8, o anterior), dando a volta no arquivo; teste automático, sem teste na janela
- [x] Linguagem: traduzir "View Problem" e "No quick fixes available" do Monaco (Linguagem): pela tabela de mensagens do Monaco, por índice; um teste avisa se os índices mudarem ao atualizar o Monaco; sem teste na janela
- [ ] Linguagem: contador da barra com os itens informativos (Linguagem)
- [x] Abas: a aba ativa pode ficar fora da faixa visível quando há muitas abas (ex.: o depurador pausa e abre um arquivo, e a aba dele não aparece). Rolar a faixa até ela. Visto nas capturas do tema novo; o código das abas não tem rolagem até a ativa, então não é efeito do tema. → a faixa rola até a aba ativa a cada troca, por qualquer caminho, sem animação; teste de componente, sem teste na janela

## 6. Decisões pendentes (do usuário)

- [ ] C# sem teclado ao depurar: implementar o contorno só para Linux e macOS? (Depuração › C# não lê o teclado)
- [ ] netcoredbg exige glibc 2.38: aceitar que Ubuntu 22.04 e distros antigas fiquem sem depuração de C#, ou procurar outra versão (Depuração)
- [ ] Instalação automática de ferramentas ([ferramentas.md](specs/ferramentas.md)) (Adiado de propósito)
- [ ] Gdb como depurador de C/C++ (hoje "depois" no [roadmap](specs/README.md))

## Fora deste checklist

Comportamentos aceitos, que não precisam de ação: o `VBCSCompiler` do .NET aberto por alguns minutos, o `DEBUGINFOD_URLS` desligado, os atalhos Voltar/Avançar do VS Code no Linux e a pilha limitada a 200 frames.
