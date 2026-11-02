import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createFakes, Fakes, settle } from '../../testing/fakes';
import { EditorTabs } from '../editor/editor-tabs';
import { ProjectState, ToolCheck } from '../ipc';
import { Commands } from '../shared/commands';
import { Panel } from '../shared/panel';
import { Terminals } from '../terminal/terminals';
import { ProblemsView } from './problems-view';
import { OUTPUT_LIMIT, Project } from './project';
import { ProjectStatus } from './project-status';
import { toolSummary, ToolsView } from './tools-view';

const ROOT = '/home/ana/hello-cpp';
const CMAKE: Partial<ProjectState> = {
  root: ROOT,
  kind: 'cmake',
  configs: ['Debug', 'Release'],
  config: 'Debug',
};

describe('projeto', () => {
  let fakes: Fakes;
  let project: Project;
  let panel: Panel;

  beforeEach(async () => {
    fakes = createFakes();
    TestBed.configureTestingModule({ providers: fakes.providers });
    project = TestBed.inject(Project);
    panel = TestBed.inject(Panel);
    await project.start();
  });

  function render<T>(component: Type<T>) {
    const fixture = TestBed.createComponent(component);
    const page = fixture.nativeElement as HTMLElement;
    const stable = async () => {
      await settle();
      await fixture.whenStable();
    };
    return { page, stable };
  }

  const text = (element: Element) => element.textContent!.replace(/\s+/g, ' ').trim();

  describe('barra de status', () => {
    it('mostra tipo, configuração e alvo, e o andamento da configuração', async () => {
      const { page, stable } = render(ProjectStatus);
      await stable();
      expect(text(page)).toBe('');

      fakes.project.emitState({ ...CMAKE, status: { kind: 'configuring' } });
      await stable();
      expect(text(page)).toBe('CMake: configurando… · Debug');

      fakes.project.emitState({
        status: { kind: 'ready' },
        targets: [{ name: 'app', path: `${ROOT}/build/debug/app` }],
        target: 'app',
      });
      await stable();
      expect(text(page)).toBe('CMake · Debug · ▶ app');
      expect(page.querySelector('[aria-label="Configuração: Debug"]')?.getAttribute('title')).toBe(
        'Configuração ativa: Debug. Clique para trocar.',
      );
    });

    it('com erro, avisa na barra e abre o painel na aba Saída', async () => {
      const { page, stable } = render(ProjectStatus);
      fakes.project.emitState({ ...CMAKE, status: { kind: 'configuring' } });
      panel.show('terminal');
      panel.visible.set(false);

      fakes.project.emitState({
        status: { kind: 'failed', message: 'O CMake terminou com erro.' },
      });
      await stable();

      const kind = page.querySelector('.status-error')!;
      expect(text(kind)).toBe('CMake: erro (ver Saída)');
      expect(kind.getAttribute('title')).toContain('O CMake terminou com erro.');
      expect(panel.visible()).toBe(true);
      expect(panel.tab()).toBe('output');
    });

    it('clicar na configuração ou no alvo abre a escolha pelos comandos', async () => {
      const ran: string[] = [];
      const commands = TestBed.inject(Commands);
      commands.register({
        selectConfig: () => ran.push('selectConfig'),
        selectTarget: () => ran.push('selectTarget'),
      });
      commands.setConditions({
        editorOpen: () => false,
        textEditor: () => false,
        folderOpen: () => true,
        project: () => project.channel() !== null,
        debugging: () => false,
        debugPaused: () => false,
        debugRunning: () => false,
      });
      const { page, stable } = render(ProjectStatus);
      fakes.project.emitState({ ...CMAKE, status: { kind: 'ready' }, target: 'app' });
      await stable();

      page.querySelector<HTMLElement>('[aria-label="Configuração: Debug"]')!.click();
      page.querySelector<HTMLElement>('[aria-label="Alvo: app"]')!.click();

      expect(ran).toEqual(['selectConfig', 'selectTarget']);
    });

    it('.NET: mostra ".NET" no lugar de "CMake", com andamento e erro', async () => {
      const { page, stable } = render(ProjectStatus);
      fakes.project.emitState({
        root: '/home/ana/hello-cs',
        kind: 'dotnetSolution',
        configs: ['Debug', 'Release'],
        config: 'Debug',
        status: { kind: 'configuring' },
      });
      await stable();
      expect(text(page)).toBe('.NET: configurando… · Debug');
      expect(project.channel()).toBe('dotnet');

      fakes.project.emitState({ status: { kind: 'failed', message: 'O dotnet restore falhou.' } });
      await stable();
      const kind = page.querySelector('.status-error')!;
      expect(text(kind)).toBe('.NET: erro (ver Saída)');
      expect(kind.getAttribute('title')).toBe(
        'O dotnet restore falhou. Clique para ver a saída no canal dotnet.',
      );
      expect(panel.tab()).toBe('output');
    });

    it('sem projeto, diz que é só edição e explica o que falta para compilar', async () => {
      const { page, stable } = render(ProjectStatus);
      fakes.project.emitState({ root: ROOT, kind: 'editOnly' });
      await stable();

      expect(text(page)).toBe('Sem projeto (só edição)');
      expect(page.querySelector('.status-item')?.getAttribute('title')).toContain('CMakeLists.txt');
      expect(page.querySelector('.status-item')?.getAttribute('title')).toContain('.csproj');
    });
  });

  describe('estado e canal da Saída', () => {
    it('a Saída guarda só as últimas linhas e começa limpa a cada configuração', () => {
      for (let i = 0; i < OUTPUT_LIMIT + 10; i++) {
        fakes.project.emit({ kind: 'output', line: `linha ${i}` });
      }
      expect(project.output().length).toBe(OUTPUT_LIMIT);
      expect(project.output()[0]).toBe('linha 10');

      fakes.project.emitState({ ...CMAKE, status: { kind: 'configuring' } });
      expect(project.output()).toEqual([]);
      fakes.project.emit({ kind: 'output', line: '> cmake -S …' });
      // Mais um estado durante a mesma configuração (ex.: presets) não apaga o que chegou.
      fakes.project.emitState({ configs: ['debug'] });
      expect(project.output()).toEqual(['> cmake -S …']);
    });

    it('ao iniciar, a resposta do project_state não desfaz um evento que chegou antes', async () => {
      TestBed.resetTestingModule();
      fakes = createFakes();
      TestBed.configureTestingModule({ providers: fakes.providers });
      project = TestBed.inject(Project);

      const started = project.start();
      fakes.project.emit({
        kind: 'state',
        state: { ...fakes.project.current, ...CMAKE, status: { kind: 'configuring' } },
      });
      await started;

      expect(project.state().status.kind).toBe('configuring');
    });

    it('mostra o aviso uma vez por pasta', async () => {
      const warning = 'Também há um projeto .NET aqui.';
      fakes.project.emitState({ ...CMAKE, warning, status: { kind: 'configuring' } });
      fakes.project.emitState({ status: { kind: 'ready' } });
      await settle();

      expect(fakes.dialogs.asked.map((question) => question.message)).toEqual([warning]);
    });

    it('troca configuração e alvo pelo núcleo e conta a falha', async () => {
      fakes.project.emitState({ ...CMAKE, status: { kind: 'ready' } });

      project.selectConfig('Debug');
      project.selectConfig('Release');
      fakes.project.selectTarget = () => Promise.reject({ kind: 'invalidInput', message: 'x' });
      project.selectTarget('tool');
      await settle();

      expect(fakes.project.selectedConfigs).toEqual(['Release']);
      expect(fakes.dialogs.asked).toEqual([
        { message: 'Não foi possível trocar o alvo.', buttons: ['OK'], detail: 'x' },
      ]);
    });
  });

  describe('Problemas', () => {
    it('lista o arquivo e, em cada item, mensagem, origem e linha:coluna; o clique abre na linha', async () => {
      const file = `${ROOT}/CMakeLists.txt`;
      fakes.files.write(file, 'project(x)\n');
      const { page, stable } = render(ProblemsView);
      await stable();
      expect(text(page)).toBe('Nenhum problema encontrado.');

      fakes.project.emitState({
        ...CMAKE,
        status: { kind: 'failed', message: 'erro' },
        problems: [{ file, line: 7, message: 'Unknown CMake command "add_executabl".' }],
      });
      await stable();
      expect(text(page.querySelector('.problem-file-name')!)).toBe('CMakeLists.txt');
      const item = page.querySelector<HTMLElement>('.problem')!;
      expect(text(item.querySelector('.problem-location')!)).toBe('7:1');
      expect(text(item.querySelector('.problem-source')!)).toBe('CMake');
      expect(text(item.querySelector('.problem-message')!)).toBe(
        'Unknown CMake command "add_executabl".',
      );

      item.click();
      await stable();
      const tabs = TestBed.inject(EditorTabs);
      expect(tabs.active()?.path()).toBe(file);
      expect(tabs.goTo()).toEqual({ line: 7, column: 1 });
    });
  });

  it('Ctrl+` com o painel em outra aba vai para o Terminal em vez de esconder', async () => {
    const terminals = TestBed.inject(Terminals);
    await terminals.create();
    panel.show('output');

    terminals.toggle();
    expect([panel.visible(), panel.tab()]).toEqual([true, 'terminal']);
    terminals.toggle();
    expect(panel.visible()).toBe(false);
  });
});

describe('tela de ferramentas', () => {
  beforeAll(() => {
    // O jsdom não tem o modal do <dialog>.
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
  });

  const tools: ToolCheck[] = [
    {
      program: 'cmake',
      purpose: 'configurar e compilar C/C++',
      minimum: '3.21',
      install: 'Instale pelo gerenciador de pacotes.',
      status: { kind: 'present', path: '/usr/bin/cmake', version: '3.30.1' },
    },
    {
      program: 'clangd',
      purpose: 'erros e autocomplete C/C++',
      minimum: '17',
      install: 'sudo apt install clangd-18',
      status: { kind: 'outdated', path: '/usr/bin/clangd', version: '16.0.0' },
    },
    {
      program: 'gdb',
      purpose: 'depurar C/C++ compilado com GCC',
      minimum: '14',
      install: 'sudo apt install gdb',
      status: { kind: 'missing' },
    },
  ];

  it('resume cada ferramenta: caminho e versão, versão antiga ou ausente', () => {
    expect(tools.map(toolSummary)).toEqual([
      '/usr/bin/cmake (3.30.1)',
      'versão antiga (mínimo 17): /usr/bin/clangd (16.0.0)',
      'não encontrado',
    ]);
  });

  it('mostra uma linha por ferramenta, com para quê e como instalar no que falta', async () => {
    const fakes = createFakes();
    fakes.project.tools = tools;
    TestBed.configureTestingModule({ providers: fakes.providers });
    const fixture = TestBed.createComponent(ToolsView);
    const page = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();

    fixture.componentInstance.show();
    await settle();
    await fixture.whenStable();

    const rows = [...page.querySelectorAll('.tool')];
    expect(rows.map((row) => row.querySelector('.tool-mark')?.textContent)).toEqual([
      '✓',
      '✗',
      '✗',
    ]);
    expect(rows[0].textContent).not.toContain('Para quê');
    expect(rows[2].textContent).toContain('Para quê: depurar C/C++ compilado com GCC');
    expect(rows[2].textContent).toContain('Como instalar: sudo apt install gdb');
    const buttons = [...page.querySelectorAll('button')];
    // A instalação automática foi adiada: só o passo a passo manual.
    expect(buttons.map((button) => button.textContent!.trim())).toEqual(['Verificar de novo', '']);

    const again = buttons[0];
    expect(again.title).not.toBe('');
    again.click();
    await settle();
    expect(fakes.project.toolsChecks).toBe(2);
  });

  it('conta quando a verificação falha', async () => {
    const fakes = createFakes();
    fakes.project.toolsError = { kind: 'notFound', message: 'Sem pasta de dados do app.' };
    TestBed.configureTestingModule({ providers: fakes.providers });
    const fixture = TestBed.createComponent(ToolsView);
    await fixture.whenStable();

    fixture.componentInstance.show();
    await settle();
    await fixture.whenStable();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[role=alert]')?.textContent,
    ).toContain('Sem pasta de dados do app.');
  });
});
