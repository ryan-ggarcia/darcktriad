import { TestBed } from '@angular/core/testing';
import { createFakes, FakeBuffer, Fakes, settle } from '../../testing/fakes';
import { EditorTabs } from '../editor/editor-tabs';
import { BuildProblem, ProjectState } from '../ipc';
import { MarkerSeverity } from '../language/lsp';
import { Commands } from '../shared/commands';
import { Panel } from '../shared/panel';
import { Terminals } from '../terminal/terminals';
import { OutputChannels } from './output-channels';
import { linkProblems, OutputView } from './output-view';
import { Problems } from './problems';
import { ProblemsView } from './problems-view';
import { buildSummary, Project } from './project';

const ROOT = '/home/ana/hello-cpp';
const MAIN = `${ROOT}/app/main.cpp`;
const CMAKE: Partial<ProjectState> = { root: ROOT, kind: 'cmake', status: { kind: 'ready' } };

function problem(change: Partial<BuildProblem> = {}): BuildProblem {
  return {
    file: MAIN,
    line: 5,
    column: 10,
    severity: 'error',
    code: null,
    message: "expected ';' after expression",
    ...change,
  };
}

const RESERVE = problem({
  file: null,
  line: null,
  column: null,
  message: 'A compilação falhou. Veja a Saída.',
});

describe('resumo da compilação na barra de status', () => {
  it('conta erros e avisos, no singular e no plural', () => {
    const warning = problem({ severity: 'warning' });
    expect(buildSummary('succeeded', [warning])).toBe('Compilação concluída');
    expect(buildSummary('failed', [problem(), problem(), warning])).toBe(
      'Compilação falhou: 2 erros, 1 aviso',
    );
    expect(buildSummary('failed', [problem()])).toBe('Compilação falhou: 1 erro');
    expect(buildSummary('failed', [problem({ severity: 'info' })])).toBe('Compilação falhou');
    expect(buildSummary('cancelled', [])).toBeNull();
  });
});

describe('links da Saída', () => {
  const lines = [
    '> cmake --build /home/ana/hello-cpp/build/debug',
    "../../app/main.cpp:5:10: error: expected ';' after expression",
    '1 error generated.',
    'C:\\p\\app\\main.cpp(7): warning C4244: conversion',
    'Falhou em 3,2 s',
  ];

  it('as linhas marcadas pelo núcleo viram links; o texto fica igual', () => {
    const windows = problem({ file: 'C:\\p\\app\\main.cpp', line: 7, message: 'conversion' });
    const links = new Map([
      [lines[1], problem()],
      [lines[3], windows],
    ]);
    const segments = linkProblems(lines, links);

    expect(segments.map((segment) => segment.text).join('')).toBe(lines.join('\n'));
    expect(segments.filter((segment) => segment.problem).map((segment) => segment.text)).toEqual([
      lines[1],
      lines[3],
    ]);
  });

  it('sem marca, nenhuma linha vira link', () => {
    expect(linkProblems(lines, new Map())).toEqual([{ text: lines.join('\n') }]);
  });
});

describe('compilar e executar', () => {
  let fakes: Fakes;
  let project: Project;
  let panel: Panel;
  let problems: Problems;

  beforeEach(async () => {
    fakes = createFakes();
    TestBed.configureTestingModule({ providers: fakes.providers });
    project = TestBed.inject(Project);
    panel = TestBed.inject(Panel);
    problems = TestBed.inject(Problems);
    await project.start();
    fakes.project.emitState(CMAKE);
  });

  function hold(): () => void {
    let release!: () => void;
    fakes.project.buildReply = new Promise((done) => (release = done));
    return release;
  }

  const finish = (status: 'succeeded' | 'failed' | 'cancelled', list: BuildProblem[] = []) =>
    fakes.project.emit({ kind: 'buildFinished', status, problems: list });

  describe('Compilar', () => {
    it('salva os arquivos modificados, limpa o canal Build e o mostra sem compilar duas vezes', async () => {
      fakes.files.write(MAIN, 'int main() {}\n');
      const tabs = TestBed.inject(EditorTabs);
      const tab = (await tabs.open(MAIN))!;
      (tab.buffer as FakeBuffer).type('int main() { return 1; }\n');
      fakes.project.emit({ kind: 'buildOutput', line: 'velha' });
      const release = hold();

      project.build();
      project.build();
      await settle();

      expect(fakes.files.saves.map((save) => save.path)).toEqual([MAIN]);
      expect(fakes.project.builds).toBe(1);
      expect(project.building()).toBe(true);
      expect(TestBed.inject(Commands).keyStatus()).toBe('Já há uma compilação em andamento');
      expect(project.buildOutput()).toEqual([]);
      expect([panel.visible(), panel.tab(), panel.outputChannel()]).toEqual([
        true,
        'output',
        'Build',
      ]);

      fakes.project.emit({ kind: 'buildOutput', line: '> cmake --build build/debug' });
      finish('succeeded');
      release();
      await settle();
      expect(project.building()).toBe(false);
      expect(project.buildOutput()).toEqual(['> cmake --build build/debug']);
      expect(project.buildResult()).toBe('Compilação concluída');
    });

    it('cada compilação troca só os problemas de origem build', () => {
      problems.set('cpp', [problemItem()], MAIN);

      finish('failed', [problem(), problem({ line: 6, severity: 'warning' })]);
      finish('failed', [problem({ line: 8, code: 'C2143' })]);

      expect(problems.items().map((item) => [item.source, item.startLineNumber])).toEqual([
        ['build', 8],
        ['clangd', 3],
      ]);
      expect(problems.items()[0]).toEqual(
        expect.objectContaining({ code: 'C2143', startColumn: 10, severity: MarkerSeverity.Error }),
      );
      expect(project.buildResult()).toBe('Compilação falhou: 1 erro');
    });

    it('o resultado some da barra depois de 5 s', () => {
      vi.useFakeTimers();
      try {
        finish('succeeded');
        vi.advanceTimersByTime(4999);
        expect(project.buildResult()).toBe('Compilação concluída');
        vi.advanceTimersByTime(1);
        expect(project.buildResult()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('um erro do núcleo vira uma mensagem e libera a próxima compilação', async () => {
      fakes.project.buildReply = Promise.reject({ kind: 'notFound', message: 'O cmake sumiu.' });
      project.build();
      await settle();

      expect(fakes.dialogs.asked.map((question) => question.message)).toEqual(['O cmake sumiu.']);
      expect(project.building()).toBe(false);
    });
  });

  it('o item de reserva aparece sem linha e abre a Saída no canal Build', async () => {
    finish('failed', [RESERVE]);
    const fixture = TestBed.createComponent(ProblemsView);
    const page = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();

    expect(page.querySelector('.problem-file-name')?.textContent).toBe('Compilação');
    const item = page.querySelector<HTMLElement>('.problem')!;
    expect(item.querySelector('.problem-location')?.textContent).toBe('');
    item.click();
    expect([panel.tab(), panel.outputChannel()]).toEqual(['output', 'Build']);
  });

  describe('Saída', () => {
    it('no canal Build, a linha do erro abre o arquivo na linha e na coluna; Limpar esvazia', async () => {
      fakes.files.write(MAIN, 'int main() {}\n');
      // Sem o fim da compilação: o link existe assim que a linha chega.
      fakes.project.emit({
        kind: 'buildOutput',
        line: 'app/main.cpp:5:10: error: x',
        problem: problem({ message: 'x' }),
      });
      panel.showOutput('Build');
      const fixture = TestBed.createComponent(OutputView);
      const page = fixture.nativeElement as HTMLElement;
      await fixture.whenStable();

      const link = page.querySelector<HTMLElement>('.output-link')!;
      expect(link.textContent).toBe('app/main.cpp:5:10: error: x');
      expect(link.title).toBe('Abrir main.cpp na linha 5');
      link.click();
      await settle();
      const tabs = TestBed.inject(EditorTabs);
      expect(tabs.active()?.path()).toBe(MAIN);
      expect(tabs.goTo()).toEqual({ line: 5, column: 10 });

      TestBed.inject(OutputChannels).clear();
      expect(project.buildOutput()).toEqual([]);
    });

    it('Ver: Saída mostra e esconde o painel na aba Saída', () => {
      panel.show('terminal');
      panel.toggle('output');
      expect([panel.visible(), panel.tab()]).toEqual([true, 'output']);
      panel.toggle('output');
      expect(panel.visible()).toBe(false);
    });
  });

  describe('Executar sem depurar', () => {
    let terminals: Terminals;

    beforeEach(() => {
      terminals = TestBed.inject(Terminals);
    });

    it('abre o terminal ▶ app, mostra o fim do programa e reaproveita a aba na próxima vez', async () => {
      await terminals.create();
      await terminals.run();

      const first = terminals.active()!;
      expect(first.name()).toBe('▶ app');
      expect(terminals.program()).toBe(first);
      expect(panel.tab()).toBe('terminal');
      expect(fakes.project.runs).toEqual([{ cols: 80, rows: 24 }]);

      fakes.project.runEvents({ kind: 'output', data: '42' });
      fakes.project.runEvents({ kind: 'exited', code: 0 });
      expect(fakes.screens.screens[1].text).toBe('42\r\n\r\nO programa terminou com código 0\r\n');
      expect(terminals.program()).toBeNull();

      fakes.project.runInfo = { id: 101, name: '▶ app' };
      await terminals.run();
      expect(terminals.sessions().map((session) => session.name())).toEqual(['bash', '▶ app']);
      expect(terminals.active()).not.toBe(first);
      expect(fakes.screens.screens[1].disposed).toBe(true);
    });

    it('com o programa rodando, pergunta antes de reiniciar', async () => {
      await terminals.run();
      fakes.dialogs.answers.push('Cancelar');
      await terminals.run();
      expect(fakes.dialogs.asked.at(-1)).toEqual({
        message: 'app já está rodando. Reiniciar?',
        buttons: ['Reiniciar', 'Cancelar'],
        detail: '',
      });
      expect(fakes.project.runs.length).toBe(1);

      fakes.dialogs.answers.push('Reiniciar');
      fakes.project.runInfo = { id: 101, name: '▶ app' };
      await terminals.run();
      // Fecha o antigo antes de compilar de novo.
      expect(fakes.terminals.closed[0]).toBe(100);
      expect(fakes.project.runs.length).toBe(2);
      expect(terminals.program()?.id).toBe(101);
    });

    it('Parar encerra o programa e deixa a aba aberta', async () => {
      await terminals.run();
      terminals.stop();
      expect(fakes.terminals.closed).toEqual([100]);
      fakes.project.runEvents({ kind: 'exited', code: null });
      expect(terminals.sessions().length).toBe(1);
      expect(terminals.program()).toBeNull();
    });

    it('com a compilação falha, não roda e abre o painel Problemas', async () => {
      fakes.project.runInfo = null;
      const release = hold();
      const running = terminals.run();
      await settle();
      finish('failed', [problem()]);
      release();
      await running;

      expect(terminals.sessions()).toEqual([]);
      expect(fakes.screens.screens[0].disposed).toBe(true);
      expect([panel.visible(), panel.tab()]).toEqual([true, 'problems']);
    });
  });
});

function problemItem() {
  return {
    file: MAIN,
    severity: MarkerSeverity.Warning,
    message: 'unused',
    source: 'clangd',
    startLineNumber: 3,
    startColumn: 1,
    endLineNumber: 3,
    endColumn: 2,
  };
}
