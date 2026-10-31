import { TestBed } from '@angular/core/testing';
import { createFakes, Fakes, settle } from '../../testing/fakes';
import { Commands } from '../shared/commands';
import { exitMessage, Terminals } from './terminals';

describe('terminais', () => {
  let fakes: Fakes;
  let terminals: Terminals;

  beforeEach(() => {
    fakes = createFakes();
    TestBed.configureTestingModule({ providers: fakes.providers });
    terminals = TestBed.inject(Terminals);
  });

  async function create() {
    await terminals.create();
    return { session: terminals.active()!, screen: fakes.screens.screens.at(-1)! };
  }

  it('Ctrl+`: sem terminais cria um; de novo esconde; de novo mostra o mesmo', async () => {
    terminals.toggle();
    terminals.toggle();
    terminals.toggle();
    await settle();

    expect(terminals.visible()).toBe(true);
    expect(terminals.sessions().length).toBe(1);
    expect(fakes.terminals.created).toEqual([{ id: 1, cols: 80, rows: 24 }]);
    expect(terminals.active()?.name()).toBe('bash');

    terminals.toggle();
    expect(terminals.visible()).toBe(false);
    terminals.toggle();
    expect(terminals.visible()).toBe(true);
    expect(terminals.sessions().length).toBe(1);
  });

  it('liga a tela ao shell: saída, teclas e tamanho', async () => {
    const { screen } = await create();

    fakes.terminals.events.get(1)!({ kind: 'output', data: '\x1b[32mação ✓\x1b[0m' });
    screen.type('ls\r');
    screen.fitSize = { cols: 120, rows: 30 };
    screen.fit();

    expect(screen.text).toBe('\x1b[32mação ✓\x1b[0m');
    expect(fakes.terminals.writes).toEqual([{ id: 1, data: 'ls\r' }]);
    expect(fakes.terminals.resizes).toEqual([{ id: 1, cols: 120, rows: 30 }]);
  });

  it('a tela ajustada antes da resposta do núcleo manda o tamanho novo logo depois', async () => {
    const resolve = fakes.terminals.holdCreate();

    const done = terminals.create();
    await settle();
    const screen = fakes.screens.screens[0];
    screen.fitSize = { cols: 100, rows: 20 };
    screen.fit();
    resolve();
    await done;

    expect(fakes.terminals.created).toEqual([{ id: 1, cols: 80, rows: 24 }]);
    expect(fakes.terminals.resizes).toEqual([{ id: 1, cols: 100, rows: 20 }]);
  });

  it('guarda o que a tela manda antes da resposta do núcleo e envia tudo de uma vez, primeiro', async () => {
    const release = fakes.terminals.holdCreate();

    const done = terminals.create();
    await settle();
    const screen = fakes.screens.screens[0];
    // O ConPTY pergunta a posição do cursor antes da resposta; o xterm.js responde pelo onData.
    fakes.terminals.events.get(1)!({ kind: 'output', data: '\x1b[6n' });
    screen.type('\x1b[1;1R');
    screen.type('ls');
    expect(fakes.terminals.writes).toEqual([]);
    release();
    await done;
    screen.type('\r');

    expect(fakes.terminals.writes).toEqual([
      { id: 1, data: '\x1b[1;1Rls' },
      { id: 1, data: '\r' },
    ]);
  });

  it('descarta o guardado se a criação falhar ou o terminal fechar antes da resposta', async () => {
    const release = fakes.terminals.holdCreate();
    const done = terminals.create();
    await settle();
    fakes.screens.screens[0].type('a');
    terminals.close(terminals.active()!);
    release();
    await done;

    fakes.terminals.createError = { kind: 'other', message: 'falhou' };
    const { screen } = await create();
    screen.type('b');

    expect(fakes.terminals.writes).toEqual([]);
    expect(fakes.terminals.closed).toEqual([1]);
  });

  it('se o xterm.js não carregar, avisa no console e não deixa painel vazio aberto', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fakes.screens.create = () => Promise.reject(new Error('chunk não carregou'));

    await terminals.create();

    expect(warn).toHaveBeenCalled();
    expect(terminals.visible()).toBe(false);
    expect(terminals.sessions()).toEqual([]);
  });

  it('shell encerrado: mostra o código, fica na lista e não recebe mais teclas', async () => {
    const { screen } = await create();

    fakes.terminals.events.get(1)!({ kind: 'exited', code: 3 });
    screen.type('x');

    expect(screen.text).toContain('Processo encerrado com código 3');
    expect(terminals.sessions().length).toBe(1);
    expect(fakes.terminals.writes).toEqual([]);
    expect(exitMessage(null)).toBe('Processo encerrado');
  });

  it('Ctrl+Shift+` cria outro e o ativa; o X fecha o escolhido e ativa o vizinho', async () => {
    const first = await create();
    const second = await create();
    const third = await create();
    expect(terminals.active()).toBe(third.session);

    terminals.close(second.session);
    // Depois do close o núcleo ainda manda o `exited`, que é ignorado.
    fakes.terminals.events.get(2)!({ kind: 'exited', code: null });

    expect(fakes.terminals.closed).toEqual([2]);
    expect(second.screen.disposed).toBe(true);
    expect(second.screen.text).toBe('');
    expect(terminals.sessions()).toEqual([first.session, third.session]);
    expect(terminals.active()).toBe(third.session);

    terminals.close(third.session);
    expect(terminals.active()).toBe(first.session);
    terminals.close(first.session);
    expect(terminals.active()).toBeNull();
    expect(terminals.visible()).toBe(false);
  });

  it('falha ao criar: guarda a mensagem do núcleo e a IDE segue', async () => {
    fakes.terminals.createError = {
      kind: 'notFound',
      message: 'Não foi possível iniciar o terminal com /bin/zsh: não encontrado',
    };

    const { session } = await create();

    expect(session.error()).toContain('/bin/zsh');
    expect(terminals.visible()).toBe(true);
  });

  it('deixa subir para a IDE só os atalhos dela; os do processo param no terminal', async () => {
    const { screen } = await create();
    const press = (code: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { code, cancelable: true, ...init });
      const stop = vi.spyOn(event, 'stopPropagation');
      return { toShell: screen.keyHandler(event), stopped: stop.mock.calls.length > 0 };
    };

    expect(press('KeyP', { ctrlKey: true, shiftKey: true })).toEqual({
      toShell: false,
      stopped: false,
    });
    expect(press('KeyA')).toEqual({ toShell: true, stopped: true });

    // A segunda tecla de um acorde Ctrl+K vai para a IDE.
    const commands = TestBed.inject(Commands);
    commands.register({ openFolder: () => undefined });
    commands.handleKey(new KeyboardEvent('keydown', { code: 'KeyK', ctrlKey: true }));
    expect(press('KeyO', { ctrlKey: true }).toShell).toBe(false);
  });
});
