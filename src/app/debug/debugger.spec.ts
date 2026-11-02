import { TestBed } from '@angular/core/testing';
import { createFakes, Fakes, settle } from '../../testing/fakes';
import { Project } from '../project/project';
import { Terminals } from '../terminal/terminals';
import { Breakpoints } from './breakpoints';
import { flatten } from './debug-view';
import { blocks, Debugger, pauseText, sourcePath, STOP_MS } from './debugger';

const ROOT = '/proj';
const MAIN = `${ROOT}/app/main.cpp`;

describe('textos e blocos', () => {
  it('frame de desmontagem do lldb-dap não tem código-fonte', () => {
    const frame = { id: 1, name: 'f', line: 3, column: 1 };
    expect(sourcePath({ ...frame, source: { path: '/p/main.cpp' } })).toBe('/p/main.cpp');
    expect(
      sourcePath({ ...frame, source: { path: 'libc.so.6`f', sourceReference: 7 } }),
    ).toBeNull();
    expect(
      sourcePath({ ...frame, source: { path: '/x', presentationHint: 'deemphasize' } }),
    ).toBeNull();
    expect(sourcePath(frame)).toBeNull();
  });

  it('a faixa diz o motivo da pausa', () => {
    expect(pauseText({ reason: 'breakpoint', description: 'breakpoint 1.1' })).toBe(
      'Pausado: ponto de parada',
    );
    expect(pauseText({ reason: 'step' })).toBe('Pausado: passo');
    expect(pauseText({ reason: 'pause' })).toBe('Pausado por você');
    expect(pauseText({ reason: 'exception', text: 'x' })).toBe('Pausado: exceção. x');
    expect(pauseText({ reason: 'exception', description: 'EXC_BAD_ACCESS' })).toBe(
      'Pausado: exceção. EXC_BAD_ACCESS',
    );
  });

  it('coleções grandes vêm em blocos de 100', () => {
    expect(blocks(250)).toEqual([
      { start: 0, count: 100 },
      { start: 100, count: 100 },
      { start: 200, count: 50 },
    ]);
    expect(blocks(0)).toEqual([]);
  });
});

describe('sessão de depuração', () => {
  let fakes: Fakes;
  let debug: Debugger;
  let breakpoints: Breakpoints;

  beforeEach(async () => {
    fakes = createFakes();
    fakes.files.write(MAIN, 'int main() {\n  int x = 21;\n  return 0;\n}\n');
    TestBed.configureTestingModule({ providers: fakes.providers });
    debug = TestBed.inject(Debugger);
    breakpoints = TestBed.inject(Breakpoints);
    const project = TestBed.inject(Project);
    await project.start();
    fakes.project.emitState({
      root: ROOT,
      kind: 'cmake',
      status: { kind: 'ready' },
      target: 'app',
    });
  });

  const sent = (command: string) => fakes.debug.sent.filter((item) => item.command === command);

  /** F5 até o `configurationDone`, com o `runInTerminal` do lldb-dap no meio. */
  async function startLldb(): Promise<void> {
    const started = debug.start();
    await settle();
    expect(fakes.debug.commands()).toEqual(['initialize']);
    expect(sent('initialize')[0].arguments).toEqual(
      expect.objectContaining({ adapterID: 'lldb-dap', supportsRunInTerminalRequest: true }),
    );
    fakes.debug.respond('initialize', { supportsTerminateRequest: true });
    await settle();
    expect(sent('launch')[0].arguments).toEqual({ program: '/proj/build/app' });

    fakes.debug.message({
      type: 'request',
      command: 'runInTerminal',
      arguments: { kind: 'integrated', args: ['/usr/bin/lldb-dap', '--comm'], cwd: ROOT },
    });
    await settle();
    expect(fakes.debug.terminals).toEqual([{ args: ['/usr/bin/lldb-dap', '--comm'], cwd: ROOT }]);
    expect(fakes.debug.sent.at(-1)).toEqual(
      expect.objectContaining({ type: 'response', command: 'runInTerminal', success: true }),
    );
    expect(TestBed.inject(Terminals).active()?.name()).toBe('🐞 app');

    fakes.debug.dapEvent('initialized');
    await started;
  }

  it('F5 envia initialize, launch, os pontos marcados e configurationDone, nessa ordem', async () => {
    breakpoints.toggle(MAIN, 2);
    await startLldb();

    expect(fakes.debug.commands()).toEqual([
      'initialize',
      'launch',
      'resposta',
      'setBreakpoints',
      'setExceptionBreakpoints',
      'configurationDone',
    ]);
    expect(sent('setBreakpoints')[0].arguments).toEqual({
      source: { path: MAIN },
      breakpoints: [{ line: 2 }],
    });
    expect(sent('setExceptionBreakpoints')[0].arguments).toEqual({ filters: [] });
    expect(debug.state()).toBe('running');

    // O depurador moveu o ponto para a linha seguinte.
    fakes.debug.respond('setBreakpoints', { breakpoints: [{ id: 1, verified: true, line: 3 }] });
    await settle();
    expect(breakpoints.list()).toEqual([{ file: MAIN, line: 3, verified: true, id: 1 }]);

    // Durante a sessão, F9 manda o arquivo inteiro de novo.
    breakpoints.toggle(MAIN, 2);
    expect(sent('setBreakpoints')[1].arguments.breakpoints).toEqual([{ line: 3 }, { line: 2 }]);
  });

  it('pausado: faixa, pilha, linha atual e variáveis carregadas só ao abrir; F10 retoma', async () => {
    await startLldb();
    fakes.debug.dapEvent('stopped', { reason: 'breakpoint', threadId: 7 });
    await settle();
    expect(debug.state()).toBe('paused');
    expect(debug.pauseReason()).toBe('Pausado: ponto de parada');

    fakes.debug.respond('threads', { threads: [{ id: 7, name: 'app' }] });
    await settle();
    expect(sent('stackTrace')[0].arguments).toEqual(expect.objectContaining({ threadId: 7 }));
    fakes.debug.respond('stackTrace', {
      stackFrames: [
        { id: 100, name: 'main', line: 2, column: 3, source: { path: MAIN } },
        {
          id: 101,
          name: '__libc_start_main',
          line: 42,
          column: 0,
          source: { name: 'libc.so.6`__libc_start_main', path: 'libc.so.6`x', sourceReference: 3 },
        },
      ],
    });
    await settle();
    expect(debug.currentLine()).toEqual({ file: MAIN, line: 2 });
    expect(sent('scopes')[0].arguments).toEqual({ frameId: 100 });

    fakes.debug.respond('scopes', {
      scopes: [
        { name: 'Locals', variablesReference: 1 },
        { name: 'Registers', variablesReference: 2 },
      ],
    });
    await settle();
    // Só o primeiro escopo abre.
    expect(sent('variables').map((item) => item.arguments.variablesReference)).toEqual([1]);
    fakes.debug.respond('variables', {
      variables: [
        { name: 'x', value: '21', type: 'int', variablesReference: 0 },
        { name: 'v', value: 'size=1000', variablesReference: 5, indexedVariables: 1000 },
      ],
    });
    await settle();
    const names = () => flatten(debug.scopes()).map((row) => row.node.name);
    expect(names()).toEqual(['Locals', 'x', 'v', 'Registers']);

    // 1000 itens: 10 blocos sem pedir nada; o bloco pede só os 100 dele.
    const vector = flatten(debug.scopes())[2].node;
    await debug.toggle(vector);
    expect(names()).toHaveLength(14);
    expect(sent('variables')).toHaveLength(1);
    void debug.toggle(vector.children()![1]);
    await settle();
    expect(sent('variables')[1].arguments).toEqual({
      variablesReference: 5,
      filter: 'indexed',
      start: 100,
      count: 100,
    });

    debug.stepOver();
    expect(sent('next')[0].arguments).toEqual({ threadId: 7 });
    expect(debug.state()).toBe('running');
    expect(debug.pauseReason()).toBeNull();
    expect(debug.currentLine()).toBeNull();
    // Fora da pausa, os passos não fazem nada.
    debug.stepInto();
    expect(sent('stepIn')).toEqual([]);
  });

  it('Parar: terminate; sem fim em 3 s, disconnect; com a resposta, debug_stop', async () => {
    await startLldb();
    vi.useFakeTimers();
    try {
      const stopped = debug.stop();
      expect(fakes.debug.commands().at(-1)).toBe('terminate');
      vi.advanceTimersByTime(STOP_MS);
      expect(sent('disconnect')[0].arguments).toEqual({ terminateDebuggee: true });
      fakes.debug.respond('disconnect');
      await stopped;
      expect(fakes.debug.stops).toBe(1);
      expect(debug.state()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('o programa terminou: terminated leva ao disconnect e a sessão acaba', async () => {
    await startLldb();
    fakes.debug.dapEvent('exited', { exitCode: 0 });
    fakes.debug.dapEvent('terminated');
    expect(sent('disconnect')).toHaveLength(1);
    fakes.debug.emit({ kind: 'ended', reason: null });
    expect(debug.state()).toBeNull();
    expect(fakes.dialogs.asked).toEqual([]);
  });

  it('o adaptador caiu: a mensagem aparece e F5 inicia outra sessão', async () => {
    await startLldb();
    const reason =
      'O depurador (lldb-dap) encerrou inesperadamente. Veja o canal Depuração na Saída.';
    fakes.debug.emit({ kind: 'log', line: 'Segmentation fault' });
    fakes.debug.emit({ kind: 'ended', reason });
    expect(debug.state()).toBeNull();
    expect(fakes.dialogs.asked[0].message).toBe(reason);
    expect(debug.log()).toEqual(['Segmentation fault']);

    void debug.start();
    await settle();
    expect(debug.state()).toBe('running');
  });

  it('F6 pausa toda vez, sem pedir threads com o programa rodando, e diz "Pausado por você"', async () => {
    await startLldb();
    // Sem thread conhecida: pede `threads`; o lldb-dap recusa, e o `pause` vai com 0.
    void debug.pause();
    await settle();
    fakes.debug.respond('threads', {}, false);
    await settle();
    expect(sent('pause')[0].arguments).toEqual({ threadId: 0 });
    fakes.debug.respond('pause');
    // O lldb-dap avisa a pausa pedida como exceção (SIGSTOP).
    fakes.debug.dapEvent('stopped', {
      reason: 'exception',
      description: 'signal SIGSTOP',
      threadId: 7,
    });
    await settle();
    expect(debug.pauseReason()).toBe('Pausado por você');
    expect(sent('exceptionInfo')).toEqual([]);

    void debug.start();
    expect(debug.state()).toBe('running');
    const threads = sent('threads').length;
    void debug.pause();
    await settle();
    expect(sent('threads')).toHaveLength(threads);
    expect(sent('pause')[1].arguments).toEqual({ threadId: 7 });
  });

  it('netcoredbg: F6 usa a thread do evento `thread`', async () => {
    await startLldb();
    fakes.debug.dapEvent('thread', { reason: 'started', threadId: 40 });
    fakes.debug.dapEvent('thread', { reason: 'started', threadId: 41 });
    fakes.debug.dapEvent('thread', { reason: 'exited', threadId: 41 });
    void debug.pause();
    await settle();
    expect(sent('threads')).toEqual([]);
    expect(sent('pause')[0].arguments).toEqual({ threadId: 40 });
    // Pausa recusada: o próximo `stopped` volta a usar o motivo do adaptador.
    fakes.debug.respond('pause', {}, false);
    await settle();
    fakes.debug.dapEvent('stopped', { reason: 'breakpoint', threadId: 40 });
    expect(debug.pauseReason()).toBe('Pausado: ponto de parada');
  });

  it('exceção: a faixa mostra a mensagem do exceptionInfo', async () => {
    fakes.debug.launch = { adapter: 'netcoredbg', launch: { program: '/proj/bin/hello-cs.dll' } };
    void debug.start();
    await settle();
    fakes.debug.respond('initialize', { supportsExceptionInfoRequest: true });
    await settle();
    fakes.debug.respond('launch');
    fakes.debug.dapEvent('initialized');
    await settle();
    const text = "An unhandled exception of type 'System.Exception' occurred in hello-cs.dll";
    fakes.debug.dapEvent('stopped', { reason: 'exception', text, threadId: 9 });
    await settle();
    expect(debug.pauseReason()).toBe(`Pausado: exceção. ${text}`);
    expect(sent('exceptionInfo')[0].arguments).toEqual({ threadId: 9 });
    fakes.debug.respond('exceptionInfo', { description: `${text}: 'x'` });
    await settle();
    expect(debug.pauseReason()).toBe(`Pausado: exceção. ${text}: 'x'`);
  });

  it('compilação falha: nenhuma sessão', async () => {
    fakes.debug.launch = null;
    await debug.start();
    expect(debug.state()).toBeNull();
    expect(fakes.debug.sent).toEqual([]);
  });

  it('netcoredbg sem runInTerminal: terminal só de leitura com o aviso, a saída e o código', async () => {
    fakes.debug.launch = { adapter: 'netcoredbg', launch: { program: '/proj/bin/hello-cs.dll' } };
    // F5 com o .NET ainda configurando: o alvo só aparece depois.
    fakes.project.emitState({ target: null });
    void debug.start();
    fakes.project.emitState({ target: 'hello-cs' });
    await settle();
    fakes.debug.respond('initialize');
    await settle();
    fakes.debug.respond('launch');
    fakes.debug.dapEvent('initialized');
    await settle();
    expect(sent('setExceptionBreakpoints')[0].arguments).toEqual({ filters: ['user-unhandled'] });

    fakes.debug.dapEvent('output', { category: 'stdout', output: 'cba\n' });
    fakes.debug.dapEvent('output', { category: 'console', output: 'Carregado hello-cs.dll\n' });
    fakes.debug.dapEvent('exited', { exitCode: 0 });
    await settle();

    const terminal = TestBed.inject(Terminals).active()!;
    expect(terminal.name()).toBe('🐞 hello-cs');
    expect(debug.target()).toBe('hello-cs');
    expect(fakes.screens.screens[0].text).toBe(
      'Este depurador não permite digitar a entrada do programa.\r\n\r\n' +
        'cba\r\n\r\n\r\nO programa terminou com código 0\r\n',
    );
    expect(debug.log()).toEqual(['Carregado hello-cs.dll']);
    expect(fakes.debug.terminals).toEqual([]);
  });
});
