# Terminal integrado

Status: **MVP (v0.3)** · Depende de: [paleta-de-comandos.md](paleta-de-comandos.md) · Usado por: [compilar-e-executar.md](compilar-e-executar.md), [depuracao.md](depuracao.md)

## Problema do usuário

Quero rodar comandos (git, scripts, `dotnet new`) sem sair da IDE. Meu programa de console precisa de um terminal de verdade para ler o que eu digito (`scanf`, `std::cin`, `Console.ReadLine`).

## O que as IDEs de referência fazem

- **VS Code:**
  - Ctrl+\` mostra ou esconde o terminal; Ctrl+Shift+\` cria outro.
  - Os terminais aparecem como abas numa lista à direita do painel.
  - O terminal pode ser dividido, e as abas reordenadas arrastando.
  - Copiar e colar: Ctrl+C/Ctrl+V no Windows, Ctrl+Shift+C/Ctrl+Shift+V no Linux, ⌘C/⌘V no macOS.

  [Terminal basics](https://code.visualstudio.com/docs/terminal/basics)
- **VS Code:**
  - Uma lista fixa de comandos "pula o shell": os atalhos desses comandos vão para a IDE, mesmo com o foco no terminal.
  - Os demais vão para o programa que roda no terminal.
  - Atalhos em duas etapas (acordes) também pulam o shell por padrão.

  [Terminal advanced: keyboard shortcuts and the shell](https://code.visualstudio.com/docs/terminal/advanced)
- **CLion:**
  - Alt+F12 abre o terminal.
  - Ctrl+Shift+T abre nova aba, e cada aba pode ser dividida.
  - Começa na raiz do projeto, com o shell padrão do sistema. No Windows oferece PowerShell, Prompt de Comando, Git Bash e WSL.

  [Terminal](https://www.jetbrains.com/help/clion/terminal-emulator.html)
- **Stack aprovada:** xterm.js (MIT) desenha o terminal; portable-pty (MIT) cria o pseudo-terminal (ConPTY no Windows, PTY no Unix). Ver docs/STACK.md.

## Comportamento esperado no Dark Triad

**Painel**

1. O terminal é uma aba do painel inferior (Problemas | Saída | **Terminal**).
2. Ctrl+\` mostra ou esconde o painel, já na aba Terminal. Se não há nenhum terminal, cria um.
3. Ctrl+Shift+\` cria um terminal novo e o ativa.

**Vários terminais**

1. Uma lista lateral simples mostra os terminais. Cada linha tem o nome e um botão **Fechar** (X, com dica "Fechar terminal").
2. O nome é o do shell (`pwsh`, `powershell`, `zsh`, `bash`).
3. Terminais de execução e de depuração usam o nome do alvo, ex.: `▶ app` (ver [compilar-e-executar.md](compilar-e-executar.md)).

**Shell e pasta inicial**

1. Shell padrão:
   - **Windows:** `pwsh` se estiver instalado; senão, Windows PowerShell.
   - **macOS e Linux:** o shell de `$SHELL`; se não estiver definido, `/bin/sh`.
2. A pasta inicial é a raiz do projeto, ou a pasta do usuário se não houver projeto.
3. No Windows, se o projeto usa o ambiente do MSVC ([projeto.md](projeto.md)), o terminal recebe esse ambiente. Assim, `cl`, `cmake` e `ninja` funcionam nele.

**Terminal de verdade**

1. Cores ANSI, Unicode (acentos, emoji, caracteres de caixa) e programas de tela cheia (`vim`, `htop`) funcionam.
2. Redimensionar o painel avisa o processo do novo tamanho.

**Teclado**

1. **Teclas que vão para a IDE** mesmo com o foco no terminal:
   - Ctrl+Shift+P, Ctrl+P, Ctrl+\`, Ctrl+Shift+\`, F1;
   - Ctrl+Shift+B, F5, Ctrl+F5, Shift+F5, F9, F10, F11, Shift+F11;
   - Ctrl+B e todos os acordes Ctrl+K.

   No macOS, os equivalentes com ⌘ e ⌃ da tabela abaixo. Todo o resto vai para o processo, inclusive Ctrl+C (interromper), Ctrl+D e as setas.
2. **Copiar e colar:**
   - **Windows:** Ctrl+C copia **se houver texto selecionado**; sem seleção, envia a interrupção ao processo. Ctrl+V cola.
   - **Linux:** Ctrl+Shift+C / Ctrl+Shift+V.
   - **macOS:** ⌘C / ⌘V.
3. **Rolagem:** Shift+PageUp/PageDown no Windows e no Linux; PageUp/PageDown no macOS.

**Ciclo de vida**

1. **Shell encerrado** (ex.: `exit`): o terminal mostra "Processo encerrado com código N" e fica aberto para leitura, até ser fechado.
2. **Fechar um terminal** encerra o processo e todos os filhos.
3. **Fechar a IDE** encerra todos os processos de todos os terminais: nenhum processo órfão fica rodando.
4. **Falha ao criar o terminal** (ex.: shell não encontrado): mostra a mensagem com o caminho tentado. A IDE continua funcionando.

**Desempenho**

1. A saída é repassada à interface em lotes, a no máximo uma atualização por quadro.
2. Um programa que despeja muitas linhas (ex.: 100.000) não congela a IDE.
3. O histórico guarda até 10.000 linhas por terminal.

## Atalhos (padrão do VS Code)

Fonte principal: [Terminal basics](https://code.visualstudio.com/docs/terminal/basics).

| Ação no Dark Triad | Windows | Linux | macOS | Comando VS Code e fonte |
|---|---|---|---|---|
| Ver: Mostrar/ocultar terminal | Ctrl+\` | Ctrl+\` | ⌃\` | `workbench.action.terminal.toggleTerminal` ([default keybindings](https://code.visualstudio.com/docs/reference/default-keybindings)) |
| Terminal: Novo terminal | Ctrl+Shift+\` | Ctrl+Shift+\` | ⌃⇧\` | `workbench.action.terminal.new` ([terminalActions.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/terminalActions.ts), MIT) |
| Terminal: Copiar seleção | Ctrl+C (com seleção) | Ctrl+Shift+C | ⌘C | `workbench.action.terminal.copySelection` |
| Terminal: Colar | Ctrl+V | Ctrl+Shift+V | ⌘V | `workbench.action.terminal.paste` |
| Terminal: Rolar uma página para cima/baixo | Shift+PageUp / Shift+PageDown | Shift+PageUp / Shift+PageDown | PageUp / PageDown | `workbench.action.terminal.scrollUpPage` / `scrollDownPage` |

## Critérios de aceite

1. **[auto]** O adaptador de terminal (no `infra`) cria um processo de shell com o tamanho pedido. Escrever `echo dark-triad` e Enter faz `dark-triad` aparecer na saída lida. Encerrar o terminal termina o processo: o PID deixa de existir.
2. **[auto]** A escolha do shell padrão é uma função pura testável. Com `$SHELL=/bin/zsh`, devolve `/bin/zsh`; sem `$SHELL`, devolve `/bin/sh`. No Windows, com `pwsh` no `PATH`, devolve `pwsh`; senão, `powershell.exe`.
3. **[manual]** Ctrl+\` (⌃\` no mac). Esperado: o painel abre na aba Terminal, com um shell na raiz do projeto (`pwd`/`Get-Location` confirmam). Ctrl+\` de novo esconde o painel.
4. **[manual]** Ctrl+Shift+\` duas vezes. Esperado: a lista mostra três terminais; clicar em cada um troca o terminal visível; o X fecha o terminal escolhido.
5. **[manual]** No terminal, rode `git log --oneline` num repositório. Esperado: cores e rolagem funcionam. Rode `vim` (ou `nano`). Esperado: abre em tela cheia e sai normalmente.
6. **[manual]** Rode `ping -t localhost` (Windows) ou `ping localhost` (macOS/Linux) e pressione Ctrl+C. Esperado: o ping para. No Windows, selecione texto e pressione Ctrl+C. Esperado: o texto é copiado e nada é interrompido.
7. **[manual]** Com o foco no terminal, pressione Ctrl+P (⌘P) e Ctrl+Shift+P (⇧⌘P). Esperado: abrem o Abrir rápido e a paleta da IDE, não algo dentro do shell.
8. **[manual]** Rode um comando que imprime 100.000 linhas (`seq 100000`, ou `1..100000` no PowerShell). Esperado: enquanto roda, o editor aceita digitação e a IDE não para de responder. Ao final, a rolagem vai até 10.000 linhas para trás.
9. **[manual]** Com um terminal rodando `sleep 1000` (ou `Start-Sleep 1000`), feche a IDE. Esperado: no gerenciador de tarefas / `ps`, nenhum `sleep` nem shell da IDE continua vivo.
10. **[manual]** Digite `echo ação ✓ 日本` e Enter. Esperado: o texto aparece correto, sem caracteres trocados.

## O que fica de fora

- **Dividir terminal, reordenar arrastando, renomear e colorir abas:** depois.
- **Escolher outro shell pela interface (perfis):** depois. No MVP usa-se o shell padrão; para outro, basta digitar o nome dele no terminal.
- **Localizar texto no terminal e links clicáveis (`arquivo:linha`) no terminal:** depois. Os links clicáveis já existem no painel Saída ([compilar-e-executar.md](compilar-e-executar.md)).
- **Integração com o shell** (marcar comandos, navegar entre eles): depois.
- **Terminais que sobrevivem ao fechar a IDE:** fora.
- **Terminal externo do sistema:** fora.
