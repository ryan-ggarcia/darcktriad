# Ferramentas: verificar e instalar

Status: **MVP (v0.3)** · Depende de: [projeto.md](projeto.md) (lista de ferramentas e versões mínimas), [paleta-de-comandos.md](paleta-de-comandos.md) · Usado por: [linguagem.md](linguagem.md), [compilar-e-executar.md](compilar-e-executar.md), [depuracao.md](depuracao.md)

## Problema do usuário

Instalo a IDE e quero programar, sem caçar clangd, CMake, Ninja, compilador, .NET, servidor do C# e depuradores em sites diferentes. Se a IDE baixar algo por mim, quero saber **o quê**, **de onde**, **com que licença**, e ter certeza de que é o arquivo original, não uma cópia adulterada.

## Decisão do usuário

1. O instalador da IDE vem **sem** ferramentas.
2. **Primeira abertura:** a IDE detecta as ferramentas. Se todas existem, não pergunta nada. Se falta algo, mostra a lista e pergunta "Instalar agora?".
3. **Se o usuário aceitar:**
   - ferramentas portáteis são baixadas para a pasta de dados da IDE, sem administrador;
   - o que é do sistema usa o gerenciador oficial do sistema operacional.
4. **Se recusar** (ou se o sistema não for suportado): a IDE abre normalmente e mostra o passo a passo do sistema dele, com o botão **Verificar de novo**.
5. **Depois**, o comando `Ferramentas: Verificar e instalar` fica sempre disponível na paleta.

Esta spec substitui o "não baixa nada" anterior do [projeto.md](projeto.md).

## O que as IDEs de referência fazem

- **CLion:** embute LLDB, GDB e um LLDB próprio para MSVC no instalador, em vez de baixar sob demanda. [Debugger options](https://www.jetbrains.com/help/clion/configuring-debugger-options.html)
- **Visual Studio:** o instalador baixa os componentes da Microsoft. O motor de instalação **só instala conteúdo confiável**: confere a assinatura Authenticode de tudo o que baixa antes de instalar. [Install certificates for Visual Studio offline](https://learn.microsoft.com/en-us/visualstudio/install/install-certificates-for-visual-studio-offline)
- **VS Code / extensões:**
  - Indicam onde obter o `lldb-dap`: o do toolchain (no macOS, `xcrun -f lldb-dap`) ou os pacotes de release do LLVM.
  - Por padrão, procuram o binário no `PATH`.

  [lldb-dap README](https://github.com/llvm/llvm-project/blob/main/lldb/tools/lldb-dap/README.md)

## Fontes oficiais, uma a uma

Origem = a página do próprio projeto que manda baixar dali.

**Ferramentas portáteis** (baixadas pela IDE para a pasta de dados, sem administrador)

**clangd** (Apache-2.0 com exceção LLVM)
- **Plataformas:** macOS (universal x86_64+arm64), Linux x86_64.
- **Onde o projeto manda baixar:** [clangd.llvm.org/installation](https://clangd.llvm.org/installation) aponta "Standalone .zip releases" para `github.com/clangd/clangd/releases`.
- **Arquivo:** `https://github.com/clangd/clangd/releases/download/<v>/clangd-{mac,linux}-<v>.zip`.
- **Integridade publicada pelo projeto:** nenhuma. Não há checksums, assinatura nem atestação (consultamos a API de atestações do GitHub: 404).
- **Assinatura do binário:** nenhuma.

**clangd + lldb-dap** (Apache-2.0 com exceção LLVM)
- **Plataformas:** Windows x64.
- **Onde o projeto manda baixar:** [releases do LLVM](https://github.com/llvm/llvm-project/releases). O README do lldb-dap indica esses pacotes.
- **Arquivo:** `https://github.com/llvm/llvm-project/releases/download/llvmorg-<v>/LLVM-<v>-win64.msi`, de 611 MB, extraído sem instalar (`msiexec /a`). É o único pacote Windows x64 com o `lldb-dap`: o `clang+llvm-<v>-x86_64-pc-windows-msvc.tar.zst`, de 264 MB, tem o clang e o clangd, mas nenhum LLDB (conferido na 23.1.4). Só os arquivos listados no manifesto são extraídos.
- **Integridade publicada pelo projeto:** `.jsonl` com atestação Sigstore de proveniência SLSA, gerada pelo workflow `release-tasks.yml` (conferida pela API). Há também `.sig` GPG das chaves dos gerentes de release em [releases.llvm.org/release-keys.asc](https://releases.llvm.org/release-keys.asc). O próprio release explica como verificar ([llvmorg-23.1.3](https://github.com/llvm/llvm-project/releases/tag/llvmorg-23.1.3)).
- **Assinatura do binário:** nenhuma. O MSI, o `clang.exe`, o `clangd.exe` e o `lldb-dap.exe` vêm sem Authenticode (conferido na 23.1.4).

**CMake** (BSD-3-Clause)
- **Plataformas:** Windows x64, macOS universal, Linux x86_64/aarch64.
- **Onde o projeto manda baixar:** [cmake.org/download](https://cmake.org/download/) linka os arquivos em `github.com/Kitware/CMake/releases`.
- **Arquivo:** `https://github.com/Kitware/CMake/releases/download/v<v>/cmake-<v>-{windows-x86_64.zip, macos-universal.tar.gz, linux-x86_64.tar.gz, linux-aarch64.tar.gz}`.
- **Integridade publicada pelo projeto:**
  - `cmake-<v>-SHA-256.txt`, com assinatura GPG `cmake-<v>-SHA-256.txt.asc`;
  - a página indica "PGP sig by 2D2CEF1034921684";
  - chave de Brad King (Kitware): primária `CBA2 3971 357C 2E65 90D9 EFD3 EC8F EF3A 7BFB 4EDA`, subchave de assinatura `C6C2 6532 4BBE BDC3 50B5 13D0 2D2C EF10 3492 1684`;
  - "Good signature" conferida na 4.4.5.
- **Assinatura do binário:**
  - Windows: `cmake.exe` com Authenticode válido de "Kitware, Inc." (conferido).
  - macOS: `CMake.app` assinado e notarizado pelos mantenedores ([script de release da Kitware](https://gitlab.kitware.com/cmake/cmake/-/merge_requests/6784)).

**Ninja** (Apache-2.0)
- **Plataformas:** Windows x64, macOS universal, Linux x86_64/aarch64.
- **Onde o projeto manda baixar:** [ninja-build.org](https://ninja-build.org/) ("download the Ninja binary") aponta para `github.com/ninja-build/ninja/releases`.
- **Arquivo:** `https://github.com/ninja-build/ninja/releases/download/v<v>/ninja-{win,mac,linux,linux-aarch64}.zip`.
- **Integridade publicada pelo projeto:** nenhuma.
- **Assinatura do binário:** nenhuma (`ninja.exe` sem Authenticode, conferido).

**netcoredbg** (MIT)
- **Plataformas:** Windows x64, Linux x64/arm64, macOS arm64.
- **Onde o projeto manda baixar:** o [README do projeto](https://github.com/Samsung/netcoredbg) manda usar os binários dos releases do GitHub.
- **Arquivo:** `https://github.com/Samsung/netcoredbg/releases/download/<v>/netcoredbg-{win64.zip, linux-amd64.tar.gz, linux-arm64.tar.gz, osx-arm64.zip}`.
- **Integridade publicada pelo projeto:** nenhuma.
- **Assinatura do binário:** nenhuma (`netcoredbg.exe` sem Authenticode, conferido).

**Servidor Roslyn** (MIT)
- **Plataformas:** todas.
- **Onde o projeto manda baixar:** [nuget.org/packages/roslyn-language-server](https://www.nuget.org/packages/roslyn-language-server), da Microsoft. O pacote principal só aponta para pacotes por plataforma, `roslyn-language-server.<rid>`.
- **Arquivo:** `https://api.nuget.org/v3-flatcontainer/roslyn-language-server.<rid>/<v>/roslyn-language-server.<rid>.<v>.nupkg`, com cerca de 64 MB. Extrai `tools/net10.0/<rid>/`.
- **Integridade publicada pelo projeto:** SHA-512 do pacote no registro do NuGet.
- **Assinatura:**
  - assinatura de **autor** "Microsoft Corporation" e **referenda do repositório** "NuGet.org Repository by Microsoft", conferidas com `dotnet nuget verify --all`;
  - binários com Authenticode válido de "Microsoft Corporation (.NET)" (conferido).
- **Instalado com `dotnet tool install -g`:** no Windows, isso só cria um `.cmd` em `~/.dotnet/tools`. A busca aceita o `.cmd` quando não há `.exe` na mesma pasta.

**Runtime .NET 10** (MIT)
- **Para quê:** só para rodar o servidor Roslyn, e só se não houver .NET ≥ 10.
- **Plataformas:** todas.
- **Onde o projeto manda baixar:** [dotnet.microsoft.com/download](https://dotnet.microsoft.com/download); os metadados oficiais estão em [releases.json](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json).
- **Arquivo:** `https://builds.dotnet.microsoft.com/dotnet/Runtime/<v>/dotnet-runtime-<v>-<rid>.{zip,tar.gz}`.
- **Integridade publicada pelo projeto:** SHA-512 de cada arquivo no `releases.json`.
- **Assinatura:** Windows com Authenticode da Microsoft, a confirmar pelo QA. Linux e macOS: nenhuma separada.

**Do sistema** (instaladas com o gerenciador oficial do sistema)

**Compilador C/C++ (Windows):** Visual Studio Build Tools (licença proprietária, Microsoft)
- **Fonte oficial:** winget, pacote `Microsoft.VisualStudio.BuildTools` do repositório oficial [winget-pkgs](https://github.com/microsoft/winget-pkgs). O instalador vem de `download.visualstudio.microsoft.com`.
- **Como o pacote é validado:**
  - o manifesto do winget fixa o `InstallerSha256`, e o winget recusa se o hash não bater. A opção para ignorar existe, mas não é recomendada e a IDE **nunca** a usa ([winget install](https://learn.microsoft.com/en-us/windows/package-manager/winget/install));
  - o motor do VS confere o Authenticode de todo o conteúdo baixado.

**.NET SDK (Windows)** (MIT)
- **Fonte oficial:** winget, pacote `Microsoft.DotNet.SDK.10`. O instalador vem de `download.microsoft.com`.
- **Como o pacote é validado:** `InstallerSha256` no manifesto, mais o Authenticode da Microsoft.

**Compilador, lldb e lldb-dap (macOS):** Command Line Tools (licença da Apple)
- **Fonte oficial:** `xcode-select --install`, que abre o instalador da Apple ([Installing the command-line tools](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools/)). O `lldb-dap` vem com o toolchain (`xcrun -f lldb-dap`).
- **Como o pacote é validado:** pacotes assinados pela Apple, entregues pela atualização de software do sistema.

**.NET SDK (macOS)** (MIT)
- **Fonte oficial:** instalador `.pkg` oficial, de `builds.dotnet.microsoft.com/dotnet/Sdk/<v>/dotnet-sdk-<v>-osx-{arm64,x64}.pkg`.
- **Como o pacote é validado:**
  - SHA-256 fixado no manifesto (conferido contra o SHA-512 do `releases.json`);
  - assinatura Developer ID da Microsoft e notarização, conferidas com `pkgutil --check-signature` e `spctl --assess --type install` antes de abrir.

**Compilador e gdb (Linux)** (GPL-3.0)
- **Fonte oficial**, sempre via `pkexec`, que pede a senha de administrador pelo polkit ([pkexec](https://www.freedesktop.org/software/polkit/docs/latest/pkexec.1.html)):
  - Debian/Ubuntu: `apt-get install -y build-essential gdb`;
  - Fedora: `dnf install -y gcc gcc-c++ make gdb`;
  - Arch: `pacman -S --needed --noconfirm base-devel gdb`.
- **Como os pacotes são validados:**
  - **apt:** arquivos `Release` assinados por GPG e checksums de cada pacote ([SecureApt](https://wiki.debian.org/SecureApt)).
  - **pacman:** o padrão é `SigLevel = Required DatabaseOptional TrustedOnly` ([Package signing](https://wiki.archlinux.org/title/Pacman/Package_signing)).
  - **dnf:** confere a assinatura GPG só se o repositório tiver `gpgcheck`. O padrão do próprio dnf é **desligado** ([dnf.conf](https://dnf.readthedocs.io/en/latest/conf_ref.html)). Por isso a IDE lê os repositórios ativos e **recusa** instalar se algum estiver com `gpgcheck=0`.

**.NET SDK (Linux)** (MIT)
- **Fonte oficial:** `https://builds.dotnet.microsoft.com/dotnet/Sdk/<v>/dotnet-sdk-<v>-linux-{x64,arm64}.tar.gz`, extraído em `~/.dotnet`. É o mesmo resultado do `dotnet-install`, sem executar o script (ver abaixo).
- **Como o pacote é validado:** SHA-256 fixado (conferido contra o SHA-512 do `releases.json`). Sem assinatura separada.

### Por que não usar o script `dotnet-install` (decisão a confirmar com o usuário)

1. **O problema:** o `dotnet-install.sh` oficial não confere o hash do SDK que ele mesmo baixa. A versão atual tem 1.887 linhas e nenhuma verificação de checksum. Mesmo com o script fixado por hash, o SDK chegaria sem hash fixado, o que quebra a regra "todo arquivo com SHA-256 no manifesto".
2. **A proposta:** a IDE baixa o `.tar.gz` do SDK e extrai em `~/.dotnet`, que é o que o script faz.
3. **Resultado:** nenhum script de terceiros é executado.

### Lacunas: onde o projeto não publica assinatura

1. **Sem nada publicado:** clangd (macOS/Linux), Ninja e netcoredbg não publicam checksum, assinatura nem atestação.
   - A única proteção é o SHA-256 fixado no manifesto da IDE, registrado na atualização do manifesto e conferido contra o `digest` que o GitHub calcula para cada arquivo de release ([API de assets](https://docs.github.com/en/rest/releases/assets)).
   - Isso protege contra adulteração **depois** do registro (espelho, rede, CDN), mas não contra um release já publicado comprometido na conta do projeto.
2. **Só hash publicado:** o .NET para Linux/macOS (tarball) só tem o SHA-512 publicado pela Microsoft, sem assinatura separada.

## Comportamento esperado no Dark Triad

### Detecção

1. **O que procura:** a lista e as versões mínimas são as do [projeto.md](projeto.md): clangd, cmake, ninja, compilador C/C++, .NET SDK, servidor Roslyn, lldb-dap e netcoredbg.
2. **Onde procura, nesta ordem:** o `PATH`, depois os caminhos conhecidos de cada ferramenta ([projeto.md](projeto.md)), depois a pasta de ferramentas da IDE (`<dados do app>/tools/`).
3. **Qual vale:** a primeira que atende a versão mínima. O que o usuário instalou por conta própria ganha.
4. **Primeira abertura:**
   - a detecção roda em segundo plano, sem atrasar a janela;
   - se nada falta, nenhuma pergunta aparece;
   - nas aberturas seguintes, não pergunta sozinha.

   Uma ação que precisa de uma ferramenta ausente mostra a mensagem do [projeto.md](projeto.md), com o botão **Instalar**, que abre esta tela.
5. **`PATH` nos terminais:** os terminais da IDE ([terminal.md](terminal.md)) recebem as pastas das ferramentas instaladas pela IDE no `PATH`, então `cmake` e `ninja` funcionam neles. A IDE **não** altera arquivos de configuração do shell do usuário.

### Tela "Ferramentas"

1. **A lista:**
   - Cada ferramenta ausente vem com uma caixa marcada.
   - Cada item mostra **nome**, **versão**, **origem** (domínio, ex.: `github.com/Kitware/CMake`), **licença** e **tamanho do download**.
   - Itens do sistema mostram também o **comando exato** que será executado (ex.: `winget install --id Microsoft.DotNet.SDK.10 --exact --version 10.0.403 --source winget`) e o aviso "Pedirá permissão de administrador".
2. **Rodapé:** mostra o total do download e as opções **Instalar agora** e **Agora não**.
3. **Sem instalação automática:** item sem instalação automática nesta plataforma aparece como "Instalação manual" com o motivo, ex.: "O netcoredbg não publica binário para macOS Intel".

### Instalação (ao aceitar)

1. **Ordem:** os itens são instalados em sequência respeitando dependências: o .NET SDK antes do Roslyn; o compilador antes do resto.
2. **Progresso por item:**
   - aguardando;
   - baixando 45% (12 de 30 MB);
   - verificando;
   - instalando;
   - ✓ concluído, ou ✗ falhou, com o motivo e o botão **Tentar de novo**.
3. **Falha isolada:** a falha de um item não cancela os outros.
4. **Cancelar:** interrompe o item atual, apaga os temporários e não começa os próximos.
5. **Ao terminar:** a detecção roda de novo, e a barra de status e os servidores passam a usar o que foi instalado.

### Recusa ou sistema não suportado

1. **Quando acontece:**
   - o usuário recusou;
   - Linux fora de Debian/Ubuntu, Fedora e Arch (lido de `/etc/os-release`);
   - Windows sem `winget`.

   Nesses casos, os itens portáteis continuam instaláveis, e os do sistema viram passo a passo.
2. **O passo a passo do sistema dele:**
   - por item: o link oficial da tabela acima, ou o comando do gerenciador;
   - **onde a IDE procura** cada ferramenta: `PATH`, pasta da IDE (com o caminho completo) e caminhos conhecidos;
   - o botão **Verificar de novo**.

### Segurança da cadeia de download (obrigatório)

**1. Manifesto embutido**

1. Cada versão da IDE traz um `tools-manifest.json` compilado dentro do binário, nunca baixado.
2. Por ferramenta, ele tem: id, nome, versão, licença, origem e dependências.
3. Por sistema/arquitetura, ele tem:
   - `url`;
   - `sha256`;
   - `tamanho`;
   - formato (`zip`, `tar.gz`, `tar.zst`, `nupkg`, `pkg`);
   - prefixo a remover;
   - arquivos a extrair e executáveis;
   - verificação extra: Authenticode com titular esperado, assinatura macOS com Team ID esperado, ou impressão digital do certificado NuGet.
4. Para itens do sistema: o id e a versão do winget com o `InstallerSha256` esperado, ou os nomes dos pacotes apt/dnf/pacman.

**2. Lista de origem permitida**

1. Só estas URLs e hosts são aceitos:
   - `https://github.com/{clangd/clangd, llvm/llvm-project, Kitware/CMake, ninja-build/ninja, Samsung/netcoredbg}/releases/download/`;
   - `https://api.nuget.org/v3-flatcontainer/`;
   - `https://builds.dotnet.microsoft.com/dotnet/`.
2. **Redirecionamentos:**
   - no máximo 5;
   - cada salto precisa ser HTTPS e estar na lista;
   - `release-assets.githubusercontent.com` só é aceito como redirecionamento vindo de uma URL permitida do `github.com`.
3. A interface pede a instalação **por id do item**, nunca por URL. Não existe caminho para instalar uma URL arbitrária.

**3. Só HTTPS**

1. Validação normal de certificado, pelas raízes do sistema.
2. Proibido desligar a validação ou cair para HTTP.
3. Proxy do sistema (`HTTPS_PROXY`) é respeitado, sem exceção à validação.

**4. Download**

1. Vai para `<dados>/tools/.tmp/<aleatório>.part`.
2. Para se passar do `tamanho` do manifesto.
3. Até 3 tentativas, recomeçando do zero.

**5. Verificação antes de tudo**

1. Calcula o SHA-256 do arquivo baixado. Se não bater: apaga o arquivo, não extrai nem executa nada, e mostra "O arquivo baixado não confere com o esperado (possível adulteração ou download corrompido)".
2. Depois do hash, quando o manifesto pedir:
   - **Windows:** Authenticode válido (WinVerifyTrust) com o titular esperado;
   - **macOS:** `pkgutil --check-signature` + `spctl --assess --type install` com o Team ID esperado (`.pkg`), ou `codesign --verify --deep --strict` (`CMake.app`);
   - **NuGet:** `dotnet nuget verify --all --certificate-fingerprint <manifesto>`.
3. Falha em qualquer verificação: mesmo tratamento do hash.

**6. GPG e Sigstore ficam na atualização do manifesto, não em tempo de execução**

1. O SHA-256 fixado já amarra os bytes exatos que foram verificados por GPG/Sigstore quando o manifesto foi atualizado.
2. Repetir a verificação na máquina do usuário não protege contra nada além disso, e exigiria embutir chaves e bibliotecas novas.
3. As verificações do próprio sistema (Authenticode, codesign, NuGet) são baratas e entram como defesa extra.

**7. Extração segura**

1. **Entradas rejeitadas:** a entrada inteira é rejeitada (e nada é instalado) se tiver:
   - caminho absoluto;
   - letra de unidade (`C:`) ou caminho UNC;
   - componente `..`;
   - byte NUL;
   - nome que, normalizado (com `\` tratado como `/`), saia da pasta de destino.
2. **Tipos de entrada:**
   - links físicos, dispositivos e FIFOs: rejeitados;
   - links simbólicos: só relativos e cujo alvo resolva dentro da pasta, criados **depois** de todos os arquivos, e nunca usados para escrever através deles.
3. **Limite de tamanho:** extraído total ≤ tamanho extraído do manifesto + 10% (proteção contra "zip bomb").
4. **Destino:** só dentro de `<dados>/tools/.tmp/<id>-<versão>-<aleatório>/`. Executáveis listados recebem permissão de execução no Unix.

**8. Instalação atômica**

1. Só depois de extrair tudo com sucesso, a pasta temporária é renomeada para `<dados>/tools/<id>/<versão>/`.
2. Uma ferramenta só "existe" se a pasta final existe.
3. Na inicialização, `<dados>/tools/.tmp/` é apagada.
4. Uma versão antiga é removida só depois de a nova estar instalada.

**9. Sem scripts de terceiros**

1. Nenhum script baixado é executado. É proibido "curl | sh".
2. O único instalador baixado e aberto pela IDE é o `.pkg` do .NET no macOS, depois de hash e assinatura conferidos.

**10. Gerenciadores do sistema**

1. Só com os repositórios oficiais já configurados no sistema. A IDE não adiciona repositórios nem chaves.
2. Argumentos fixos vêm do manifesto, sem shell e sem interpolar texto do usuário.
3. **winget:**
   - sempre `--exact --id <id> --version <v> --source winget`;
   - antes de instalar, `winget show` com os mesmos argumentos precisa mostrar o mesmo "Installer SHA256" do manifesto da IDE, senão o item não é instalado;
   - nunca `--ignore-security-hash`.
4. **Nunca:** `--allow-unauthenticated` (apt), `--nogpgcheck` (dnf) ou mudar o `SigLevel` (pacman).
5. **Build Tools:** usa `--override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`. Os IDs de carga de trabalho estão em [Build Tools workload IDs](https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-build-tools).
6. **Licenças:** a IDE só passa `--accept-package-agreements` **depois** de o usuário ver a licença do item na lista e aceitar a instalação.

### Atualização do manifesto (processo)

1. **Quem:**
   - o backend abre o PR "Atualizar ferramentas para …";
   - outra pessoa revisa (QA ou CTO);
   - o manifesto só muda junto com uma versão nova da IDE.
2. **Como os hashes são obtidos:** um script do repositório baixa cada arquivo da URL oficial, calcula o SHA-256 e confere contra a referência publicada pelo projeto. Se alguma conferência falhar, o PR não é aberto.

   | Projeto | Conferência |
   |---|---|
   | CMake | `SHA-256.txt` verificado com `gpg --verify` pela chave da Kitware (impressão digital fixada no repositório) |
   | LLVM | `gh attestation verify --repo llvm/llvm-project <arquivo> --bundle <arquivo>.jsonl`, e `gpg --verify` do `.sig` quando houver, com `release-keys.asc` |
   | .NET | SHA-512 calculado igual ao do `releases.json` |
   | NuGet | `dotnet nuget verify --all` aprovado. A impressão digital do certificado de autor é registrada no manifesto. |
   | winget | `InstallerSha256` copiado do manifesto do `winget-pkgs` |
   | clangd, Ninja, netcoredbg | SHA-256 calculado igual ao `digest` da API do GitHub, baixando em duas redes diferentes (CI e máquina do autor do PR) |
   | macOS `.pkg` | assinatura e Team ID conferidos no runner macOS do CI |

3. **CI do QA:**
   - um job roda em todo PR que mexe no manifesto, e uma vez por semana;
   - para cada entrada: a URL responde por HTTPS, passando só por hosts permitidos; o arquivo baixado tem o `tamanho` e o `sha256` do manifesto; as verificações extras passam;
   - qualquer falha deixa o CI vermelho.

## Atalhos (padrão do VS Code)

O VS Code não tem atalho para instalar ferramentas. O comando fica **sem atalho**, na paleta (Ctrl+Shift+P / ⇧⌘P, [Default keyboard shortcuts](https://code.visualstudio.com/docs/reference/default-keybindings)) e no menu Ajuda.

| Comando no Dark Triad | Atalho |
|---|---|
| Ferramentas: Verificar e instalar | nenhum (paleta / menu Ajuda) |

## Critérios de aceite

### Casos de ataque e falha (obrigatórios, [auto] com servidor HTTPS local de teste e manifesto de teste)

1. **Arquivo adulterado:** o servidor entrega um arquivo com 1 byte diferente. Esperado:
   - o item falha com a mensagem de "não confere";
   - o `.part` é apagado;
   - nada é extraído;
   - não existe `<dados>/tools/<id>/`;
   - os demais itens do lote continuam e terminam.
2. **Zip slip:** zips e tars com entradas `../fora.txt`, `/etc/x`, `C:\x` e `a\..\..\x`, e um tar com link simbólico apontando para fora (com hash "correto" no manifesto de teste). Esperado: cada um é rejeitado, e nenhum arquivo é criado fora da pasta temporária. Teste confere o diretório pai antes e depois.
3. **URL fora da lista:**
   - um manifesto com `https://evil.example/x.zip` é rejeitado na validação, com erro que nomeia o item;
   - uma URL permitida que redireciona para um host fora da lista é interrompida no redirecionamento;
   - uma URL ou um redirecionamento com `http://` é rejeitado.
4. **Download interrompido:** o servidor fecha a conexão na metade. Esperado:
   - nova tentativa, até 3;
   - na falha final, não existe pasta final da ferramenta;
   - reiniciar a IDE apaga `<dados>/tools/.tmp/`.
5. **Extração interrompida:** matar o processo entre a extração e a renomeação (ponto de injeção de falha no teste). Esperado: a ferramenta não é detectada como instalada, e a próxima inicialização limpa o temporário.
6. **Tamanho excedido:** o servidor envia mais bytes que o `tamanho` do manifesto. O download é abortado.
7. **"Zip bomb":** o conteúdo extraído passa do limite. A extração é abortada, e nada é instalado.
8. **[auto, Windows] Assinatura errada:** um `.exe` com hash certo no manifesto de teste, mas sem Authenticode ou assinado por outro titular, quando o manifesto exige "Kitware, Inc.". Esperado: o item é rejeitado.
9. **[auto] Hash do winget diferente:** com `winget show` simulado devolvendo outro "Installer SHA256", o item não é instalado e mostra a divergência.
10. **[auto] dnf sem verificação:** com um repositório ativo simulado com `gpgcheck=0`, a instalação por dnf é recusada com mensagem.
11. **[auto] Validação do manifesto real**, como teste de unidade: toda URL é HTTPS e está na lista; todo `sha256` tem 64 dígitos hexadecimais; todo item tem licença, origem e tamanho; não há tipo "script".

### Fluxo

12. **[manual]** Numa máquina com todas as ferramentas, a primeira abertura não mostra pergunta nenhuma.
13. **[manual]** Numa máquina limpa (VM) de Windows 11, macOS e Ubuntu, a primeira abertura mostra a lista. Cada item tem nome, versão, domínio de origem, licença e tamanho. Os itens do sistema mostram o comando exato. Desmarcar um item faz com que ele não seja instalado.
14. **[manual]** Aceite.
    - **Esperado:**
      - progresso por item;
      - os portáteis terminam em `<dados>/tools/<id>/<versão>/`, sem pedido de administrador;
      - os do sistema pedem permissão pelo mecanismo do sistema (UAC, senha do macOS, polkit).
    - **Ao final:** o `hello-cpp` configura, compila e depura, e o `hello-cs` mostra erros do Roslyn.
15. **[manual]** Com o cabo de rede desligado no meio do lote: o item atual falha com **Tentar de novo**, os outros seguem ou falham por conta própria, e **Tentar de novo** funciona depois de religar a rede.
16. **[manual]** Recuse. Esperado:
    - a IDE abre normalmente;
    - aparece o passo a passo do sistema, com o caminho completo da pasta da IDE e a lista de lugares onde a IDE procura;
    - depois de instalar o CMake à mão, **Verificar de novo** marca o CMake com ✓.
17. **[manual]** Numa VM com distro fora da lista (ex.: openSUSE): os itens do sistema aparecem como passo a passo, nenhum gerenciador é executado, e os portáteis continuam instaláveis.
18. **[manual]** Em Windows sem `winget`: o Build Tools e o .NET SDK aparecem como passo a passo, com os links oficiais.
19. **[manual]** `Ferramentas: Verificar e instalar` aparece na paleta e no menu Ajuda a qualquer momento, e abre a mesma tela.
20. **[manual]** Depois de instalar pela IDE, no terminal integrado, `cmake --version` mostra a versão do manifesto. Num terminal do sistema, fora da IDE, o `PATH` do usuário não foi alterado.
21. **[auto, CI semanal]** O job do manifesto baixa todas as entradas reais e confere hash, tamanho e verificações extras. O teste falha se alguma divergir.

## O que fica de fora

- **Atualizar ferramentas já instaladas para versões novas sem atualizar a IDE:** fora. A versão vem do manifesto da IDE.
- **Escolher a versão de cada ferramenta:** fora.
- **Retomar download parcial:** depois. O MVP recomeça do zero.
- **Windows ARM64, macOS Intel (netcoredbg, lldb-dap do LLVM) e Linux ARM64 (clangd):** instalação manual. Os projetos não publicam todos os binários dessas plataformas.
- **WSL e contêineres:** fora.
- **Desinstalar pela IDE:** depois. Por ora, basta apagar `<dados>/tools/`.

## Riscos para a implementação

1. **lldb no Windows e Python:** relatos indicam que o `liblldb.dll` dos pacotes do LLVM para Windows depende de uma DLL do Python que o pacote não traz ([llvm-project#74073](https://github.com/llvm/llvm-project/issues/74073)).
   - Confirmado em 2026-11-04: o `liblldb.dll` do LLVM 23.1.4 pede o `python3.dll`, e sem ele o `lldb-dap` não abre. O QA deve confirmar com a versão do manifesto.
   - Se ainda for assim, é preciso decidir: incluir o Python "embeddable" oficial de python.org (que publica assinaturas), ou aceitar o lldb-dap só por instalação manual.
2. **Dependências novas no Rust:**
   - cliente HTTPS, SHA-256, `zip`, `tar`, `flate2` e `zstd` (para o pacote do LLVM);
   - verificação Authenticode pela API do Windows.

   O backend justifica cada uma no PR.
4. **Roslyn em prévia:** o servidor só sai em versão prévia, e as opções de linha de comando podem mudar ([NuGet](https://www.nuget.org/packages/roslyn-language-server)). Cada atualização do manifesto roda o teste de integração da [linguagem.md](linguagem.md).
