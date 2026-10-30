# Dark Triad: roadmap de funcionalidades

O que entra no MVP, o que vem depois e o que fica de fora. Cada funcionalidade do MVP tem uma spec própria nesta pasta.

**Critério do MVP (v0.x):** o menor conjunto com que alguém abre um projeto CMake (C ou C++) ou `.csproj`/`.sln` (C#), edita, tem autocomplete e erros, compila, roda e depura. Tudo que não serve a esse fluxo fica para depois.

**Legenda:** **MVP** = entra em v0.x · **Depois** = planejado após o MVP · **Fora** = não planejado.

## Specs do MVP e ordem de implementação

| Versão | Spec | Resumo |
|---|---|---|
| v0.1 | [editor.md](editor.md) | Abrir, editar e salvar arquivos em abas (Monaco). |
| v0.1 | [explorador.md](explorador.md) | Abrir pasta e navegar/criar/renomear/excluir arquivos em árvore. |
| v0.2 | [paleta-de-comandos.md](paleta-de-comandos.md) | Paleta de comandos, abrir arquivo por nome, ir para linha, menu principal e atalhos globais. |
| v0.3 | [projeto.md](projeto.md) | Detectar CMake/.NET, configurar, escolher Debug/Release e alvo, verificar ferramentas. |
| v0.3 | [terminal.md](terminal.md) | Terminal integrado (também usado para rodar o programa). |
| v0.4 | [linguagem.md](linguagem.md) | Erros, autocomplete, hover, dicas de parâmetros e ir para definição (clangd e Roslyn). |
| v0.5 | [compilar-e-executar.md](compilar-e-executar.md) | Compilar com erros clicáveis e executar sem depurar. |
| v0.6 | [depuracao.md](depuracao.md) | Pontos de parada, passos, pilha de chamadas e variáveis (DAP). |

A ordem segue as dependências: a linguagem precisa do `compile_commands.json` gerado pelo projeto, e executar precisa do terminal.

## Roadmap completo

### Edição e navegação

| Funcionalidade | Status | Por quê |
|---|---|---|
| Editor com abas: abrir, editar, salvar, novo arquivo | **MVP** | Base de tudo ([editor.md](editor.md)). |
| Localizar/substituir no arquivo, multicursor, dobrar código, comentar linha | **MVP** | Já vem no Monaco, sem custo. |
| Explorador de arquivos | **MVP** | Sem ele não há como achar arquivos ([explorador.md](explorador.md)). |
| Paleta de comandos, abrir rápido (Ctrl+P), ir para linha, menu principal | **MVP** | Responde a "o que cada coisa faz": todo comando tem nome e atalho visíveis ([paleta-de-comandos.md](paleta-de-comandos.md)). |
| Abas de pré-visualização (aba em itálico que é substituída) | Depois | Confunde quem não conhece ("minha aba sumiu"). No MVP toda aba é fixa. **Decisão do usuário.** |
| Reabrir aba fechada (Ctrl+Shift+T) | Depois | Conforto, não bloqueia o fluxo. |
| Dividir editor (Ctrl+\\) | Depois | Uma área de edição basta para o fluxo mínimo. |
| Busca e substituição em todos os arquivos (Ctrl+Shift+F) | Depois (primeiro pós-MVP) | A stack já prevê ripgrep, mas não é necessária para compilar e depurar. |
| Revelar o arquivo ativo no explorador automaticamente | Depois | Útil, mas exige expandir a árvore sob demanda. |
| Salvamento automático e "hot exit" (lembrar alterações não salvas ao fechar) | Depois | No MVP: salvar explícito com Ctrl+S, como o VS Code por padrão, e confirmação ao fechar. |
| Arquivo de configurações e atalhos personalizados | Depois | O MVP usa padrões fixos; menos coisa para entender. |
| Tema claro / seguir o sistema | Depois | O MVP usa só o tema escuro. |
| Interface em inglês | Depois | O MVP é só em pt-BR. |
| Breadcrumbs, modo zen, layouts de janela | Fora | Pouco valor para o público-alvo, e mais coisa na tela. |

### Inteligência de linguagem

| Funcionalidade | Status | Por quê |
|---|---|---|
| Erros e avisos ao digitar, painel Problemas | **MVP** | Pedido explícito ([linguagem.md](linguagem.md)). |
| Autocomplete, dicas de parâmetros, hover | **MVP** | Pedido explícito. |
| Ir para definição (F12 / Ctrl+clique) e voltar | **MVP** | Navegação mínima em código C/C++/C#. |
| Localizar referências (Shift+F12), renomear símbolo (F2) | Depois | O LSP já oferece; fica para logo após o MVP. |
| Formatar documento (clang-format / Roslyn) | Depois | Útil, não bloqueia o fluxo. |
| Correções rápidas (Ctrl+.) | Depois | Exige UI de code actions. |
| Símbolos do arquivo (Ctrl+Shift+O) e do projeto (Ctrl+T) | Depois | Ctrl+P e F12 cobrem o MVP. |
| Realce semântico, inlay hints, CodeLens | Depois | Polimento visual. |
| Autocomplete em CMakeLists.txt | Depois | Não há servidor oficial; baixa prioridade. |
| Refatorações além das que o servidor de linguagem oferece | Fora | Regra da stack: não reimplementar o que clangd/Roslyn fazem. |
| Razor/Blazor, designers XAML/WinForms/WPF | Fora | Fora do escopo de "C/C++/C# de console e bibliotecas". |

### Projeto e build

| Funcionalidade | Status | Por quê |
|---|---|---|
| Abrir projeto CMake (com ou sem `CMakePresets.json`) e `.csproj`/`.sln` | **MVP** | Pedido explícito ([projeto.md](projeto.md)). |
| Configuração Debug/Release e alvo executável ativo | **MVP** | Necessário para compilar e rodar o programa certo. |
| Verificação de ferramentas (cmake, ninja, clangd, dotnet, depuradores) com instrução clara | **MVP** | Sem isso o usuário não sabe por que "nada funciona". |
| Compilar (Ctrl+Shift+B) com erros clicáveis | **MVP** | Pedido explícito ([compilar-e-executar.md](compilar-e-executar.md)). |
| Executar sem depurar (Ctrl+F5) | **MVP** | Pedido explícito. |
| Argumentos, variáveis de ambiente e pasta de trabalho da execução | Depois | O MVP roda sem argumentos, a partir da raiz do projeto. |
| Ferramentas embutidas no instalador (clangd, cmake, ninja, lldb-dap, netcoredbg) | Depois | O MVP detecta o que está instalado. Embutir aumenta o instalador. **Decisão do usuário.** |
| Criar projeto novo a partir de modelo (CMake "hello", `dotnet new console`) | Depois | Ajuda iniciantes; não é necessário para abrir um projeto existente. |
| Testes (CTest, `dotnet test`, painel de testes) | Depois | Fluxo seguinte ao MVP. |
| Escolher entre vários projetos .NET executáveis / vários frameworks-alvo | Depois | No MVP: seletor de alvo simples e primeiro framework-alvo. |
| Compilar arquivo C/C++ solto, sem CMake | Depois | No MVP, arquivo solto só é editado (com autocomplete básico do clangd). |
| Projetos `.vcxproj` (MSBuild C++), Makefile puro, Meson, Bazel | Fora | CMake funciona nos três sistemas e gera `compile_commands.json` para o clangd. **Decisão do usuário.** |
| Interface para NuGet, vcpkg, Conan | Fora | Usar o terminal. |
| WSL, SSH, contêineres, toolchains remotos | Fora (curto prazo) | Multiplica a matriz de testes. |

### Execução e depuração

| Funcionalidade | Status | Por quê |
|---|---|---|
| Terminal integrado | **MVP** | Programas de console precisam de entrada e saída ([terminal.md](terminal.md)). |
| Depuração: pontos de parada, continuar/passos, pilha, variáveis | **MVP** | Pedido explícito ([depuracao.md](depuracao.md)). |
| Expressões observadas (Watch), console de depuração, valor ao passar o mouse | Depois | O painel Variáveis cobre o MVP. |
| Pontos de parada condicionais, de log, de função, de dados | Depois | Avançado. |
| Anexar a processo em execução | Depois | Fluxo menos comum. |
| Memória, desmontagem, registradores | Depois | Avançado. |
| Edit and Continue / Hot Reload | Fora | Muito complexo e depende de suporte específico do depurador; reavaliar se os depuradores abertos (lldb-dap, netcoredbg) passarem a oferecer. |
| Profiler / diagnóstico de desempenho | Fora | Produto à parte. |

### Outros

| Funcionalidade | Status | Por quê |
|---|---|---|
| Git (status, diff, commit) | Depois | Muito usado, mas fora do fluxo mínimo; o terminal resolve no MVP. |
| Atualização automática do app | Depois | O release já existe via GitHub; o updater vem depois. |
| Extensões/plugins | Fora | Aumenta a complexidade e a superfície de falhas; contraria "simples e claro". |
| Assistente de IA | Fora | Não pedido. |
| Sincronização de configurações | Fora | Não há configurações no MVP. |

## Regras comuns a todas as specs

- **Atalhos:** idênticos aos padrões do VS Code, conferidos na [referência oficial de atalhos padrão do VS Code](https://code.visualstudio.com/docs/reference/default-keybindings) e na página [Keyboard shortcuts](https://code.visualstudio.com/docs/configure/keybindings) (com os PDFs por sistema). Onde a página não lista o atalho, a fonte é o código do VS Code (licença MIT), com link para o arquivo.
- **Descoberta:** todo comando tem um nome em pt-BR no formato `Categoria: Ação` (ex.: `Arquivo: Salvar`), aparece na paleta e mostra o seu atalho. Todo botão tem rótulo ou dica (tooltip) com o atalho.
- **Sem travar:** nenhuma operação de disco, processo externo ou análise roda na thread da interface (docs/STACK.md). A queda de clangd, Roslyn, depurador ou do processo do terminal mostra uma mensagem e não derruba a IDE.
- **Layout fixo e simples:**
  - barra lateral esquerda com duas visões: Explorador e Executar e Depurar;
  - área de editores com abas;
  - painel inferior com as abas Problemas, Saída e Terminal;
  - barra de status embaixo.

  Nenhum painel escondido além desses.
- **Estado por projeto** (configuração ativa, alvo, pontos de parada, abas abertas) fica na pasta de dados do app, nunca dentro da pasta do projeto.

## Projetos de exemplo para os critérios de aceite

Os critérios das specs citam estes projetos, que o QA cria em `tests/fixtures/`:

| Nome | Conteúdo |
|---|---|
| `hello-c` | `CMakeLists.txt` com `project(hello C)` e o executável `hello`; `main.c` lê um inteiro com `scanf` e imprime o dobro. |
| `hello-cpp` | `CMakeLists.txt` com dois executáveis (`app`, `tool`) e uma biblioteca estática `core`, que expõe `int soma(int a, int b)`; `app/main.cpp` chama `soma` e usa `std::string`. Sem presets. |
| `hello-cpp-presets` | Igual a `hello-cpp`, com `CMakePresets.json` contendo os presets de configuração `debug` e `release`. |
| `hello-cs` | Projeto de console `.csproj` (gerado por `dotnet new console`); `Program.cs` lê uma linha com `Console.ReadLine` e a imprime invertida. |
| `grande` | Gerado pelo teste: um arquivo `.cpp` de 10.000 linhas e uma pasta com 5.000 arquivos. |

## Metas de desempenho iniciais

O QA pode ajustar estas metas, mas precisa medi-las no CI (qa.md):

| Medida | Meta |
|---|---|
| Abrir a IDE até a janela aceitar entrada (com a última pasta reaberta) | < 1 s |
| Abrir um arquivo de 10.000 linhas até o texto aparecer | < 300 ms |
| Latência de digitação (tecla até a tela atualizar), arquivo de 10.000 linhas, com servidor de linguagem ativo | p95 < 50 ms |
| Expandir uma pasta com 5.000 itens no explorador | < 300 ms |
| Ctrl+P em projeto com 50.000 arquivos: primeira lista / filtrar a cada tecla | < 500 ms / < 100 ms |
