# Checklist: o que falta corrigir e validar

Estado em 2026-11-02, na v0.6.1. Cada item tem a explicação em [RISCOS.md](RISCOS.md), na seção indicada entre parênteses. Ao concluir um item, marque `[x]` aqui e atualize o RISCOS.md.

## 1. Validar no Windows (precisa de uma máquina Windows)

- [ ] Abrir os instaladores `.exe` e `.msi` e usar o app (Sem teste na janela › Instaladores)
- [ ] Projeto com MSVC: critério 13 de [projeto.md](specs/projeto.md) — depende de corrigir o vcvars (item 5) (Windows)
- [ ] Cancelar a compilação, parar e reiniciar o programa sem sobrar processo (`taskkill /T /F`): critério 14 de [compilar-e-executar.md](specs/compilar-e-executar.md) (Windows)
- [ ] Compilar e executar inteiro (critérios 7 a 17 de compilar-e-executar.md) (Sem teste na janela › Compilar e executar)
- [ ] Depuração com lldb-dap e netcoredbg; critério 19 (MSVC com lldb-dap) de [depuracao.md](specs/depuracao.md) (Depuração)
- [ ] Queda do depurador não deixa o programa rodando (Depuração › Windows)
- [ ] Temporários do clangd na pasta `servers` do app e limpeza ao abrir (Linguagem › Servidores encerrados à força)
- [ ] Testes de integração (cmake, dotnet, clangd, Roslyn reais) rodando no CI do Windows (Windows)

## 2. Validar no macOS (precisa de um Mac)

- [ ] Abrir o `.dmg` (Intel e Apple Silicon) e usar o app (Sem teste na janela › Instaladores)
- [ ] Atalhos ⇧⌘B, ⌃F5, ⇧⌘U, ⇧⌘D e as teclas F (F11 é "Mostrar mesa" no sistema) (Sem teste na janela; [depuracao.md](specs/depuracao.md) › Riscos)
- [ ] Compilar, executar e depurar com o lldb-dap do Xcode (Depuração)
- [ ] Colar um texto grande no terminal sem perder nada (Terminal › `\r` a mais no macOS)
- [ ] Temporários do clangd na pasta `servers` do app (Linguagem)

## 3. Validar no Linux com teclado e mouse reais

O WebDriver não mede nem faz estes. Avisar antes de usar entrada real.

- [ ] Digitar no editor durante a compilação sem atraso perceptível (Compilar e executar › Tempo de digitação)
- [ ] Colar no terminal pelo WebKitGTK (Terminal › Colar no Linux)
- [ ] Clicar nas abas com a janela estreita (800 px) (Sem teste na janela › Depuração)
- [ ] Abrir o AppImage, o `.deb` e o `.rpm` e usar o app de verdade (Sem teste na janela › Instaladores)

## 4. Validar no Linux (o QA pode fazer pelo WebDriver ou com teste automático)

- [x] Apagar o `build/` e compilar logo em seguida, 8 vezes (correção 29b7ee9 só tem teste automático) (Compilar e executar › Apagar o `build/`)
- [x] .NET na janela: critério 12 de [projeto.md](specs/projeto.md) (Sem teste na janela › Projeto)
- [ ] Desempenho do clangd num arquivo de 10.000 linhas: criar a fixture `grande` e o critério 15 de [linguagem.md](specs/linguagem.md) (Sem teste na janela › Linguagem) → FALHOU: p95 de 65 ms com o clangd ativo (meta 50 ms); 35 ms com ele parado
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
- [ ] **macOS:** terminal e busca de ferramentas com o `PATH` do `~/.zprofile` quando a IDE é aberta pelo Finder (macOS)
- [ ] **macOS:** reconfigurar ao salvar quando a pasta passa por link simbólico (macOS)
- [ ] Salvar o `CMakeLists.txt` durante a configuração da compilação não pode interromper a configuração (Compilar e executar)
- [ ] Cancelar enquanto o CMake configura deve parar na hora (Compilar e executar)
- [ ] Apagar o `build/` deve reconfigurar sem esperar a próxima compilação, para o clangd não ficar sem o `compile_commands.json` (Compilar e executar)
- [ ] .NET com vários frameworks-alvo: passar `--framework` no `dotnet run` (Compilar e executar)
- [ ] .NET: salvar `.csproj`/`.sln` reconfigura; erros de restore sem linha aparecem em Problemas (Projeto)
- [ ] Trocar Debug/Release duas vezes rápido deixa o clangd na pasta errada (Linguagem)
- [ ] Encerrar o clangd e o Roslyn com `shutdown`/`exit` do LSP antes de matar (Linguagem)
- [ ] Digitar com o clangd ativo: p95 de 65 ms, meta de 50 ms (critério 15 de [linguagem.md](specs/linguagem.md)) (Sem teste na janela › Linguagem)
- [ ] Teste do netcoredbg: não esperar o netcoredbg sair sozinho depois do `disconnect`, que às vezes ele não sai; chamar o `stop` como a interface faz (Depuração)
- [ ] Links de erro na Saída enquanto a compilação ainda roda, e sem confundir arquivos com o mesmo nome (Compilar e executar)
- [ ] Erros da compilação sublinhados no editor (Compilar e executar)
- [ ] Lixo em `/tmp`: `cc*.s` do GCC ao cancelar e `lldb-dap-run-in-terminal-comm-*` (Compilar e executar; Depuração)
- [ ] Programas que saem da sessão (`setsid`, `nohup … &`) continuam depois de Parar ou de fechar o terminal (Terminal; Compilar e executar)
- [ ] Terminal sem controle de fluxo: muita saída pode travar a interface por ~0,3 s (Terminal)
- [ ] ABNT2: mostrar "Ctrl+'" desde a abertura, e não só depois do primeiro aperto (Terminal)
- [ ] Fonte do terminal em Linux sem as fontes monoespaçadas conhecidas (Terminal)
- [ ] Depuração: não mostrar "terminate: recusado" do lldb-dap como erro no canal Depuração (Depuração)
- [ ] Depuração: campos com nome (ex.: `Count`) junto com os blocos de coleções grandes (Depuração)
- [ ] Depuração: pontos de parada ao recarregar o arquivo do disco (Depuração)
- [ ] Depuração: bolinha clara ao passar o mouse na margem (Depuração)
- [ ] Linguagem: Ctrl+clique sublinha o nome; "Ir para definição" no menu de contexto (Linguagem)
- [ ] Linguagem: F8 vai para o problema mais próximo do cursor (Linguagem)
- [ ] Linguagem: traduzir "View Problem" e "No quick fixes available" do Monaco (Linguagem)
- [ ] Linguagem: contador da barra com os itens informativos (Linguagem)

## 6. Decisões pendentes (do usuário)

- [ ] C# sem teclado ao depurar: implementar o contorno só para Linux e macOS? (Depuração › C# não lê o teclado)
- [ ] netcoredbg exige glibc 2.38: aceitar que Ubuntu 22.04 e distros antigas fiquem sem depuração de C#, ou procurar outra versão (Depuração)
- [ ] Instalação automática de ferramentas ([ferramentas.md](specs/ferramentas.md)) (Adiado de propósito)
- [ ] Gdb como depurador de C/C++ (hoje "depois" no [roadmap](specs/README.md))

## Fora deste checklist

Comportamentos aceitos, que não precisam de ação: o `VBCSCompiler` do .NET aberto por alguns minutos, o `DEBUGINFOD_URLS` desligado, os atalhos Voltar/Avançar do VS Code no Linux e a pilha limitada a 200 frames.
