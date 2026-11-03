import { TestBed } from '@angular/core/testing';
import { createFakes, FakeBuffer, Fakes, settle } from '../../testing/fakes';
import { Debugger } from '../debug/debugger';
import { EditorTabs } from '../editor/editor-tabs';
import { AppError } from '../ipc';
import { Project } from '../project/project';
import { Terminals, TerminalSession } from '../terminal/terminals';
import { amount, percent, UpdateNotice } from './update-notice';
import { Updates } from './updates';

const NEW_VERSION = { version: '0.8.0', notes: null };
const FAILURE: AppError = { kind: 'other', message: 'Não foi possível falar com o GitHub.' };

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: unknown): void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('atualização do app', () => {
  let fakes: Fakes;
  let updates: Updates;

  beforeEach(() => {
    fakes = createFakes();
    TestBed.configureTestingModule({ providers: fakes.providers });
    updates = TestBed.inject(Updates);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Verifica à mão e chega ao aviso "Atualização pronta". */
  async function readyToRestart(): Promise<void> {
    fakes.update.checkReply = NEW_VERSION;
    await updates.check();
    await updates.install();
    expect(updates.state()).toEqual({ kind: 'ready' });
  }

  async function dirtyTab(): Promise<FakeBuffer> {
    const tabs = TestBed.inject(EditorTabs);
    const tab = await tabs.newUntitled();
    const buffer = tab!.buffer as FakeBuffer;
    buffer.type('x');
    return buffer;
  }

  describe('verificação ao abrir', () => {
    async function runAutoCheck(): Promise<void> {
      vi.useFakeTimers();
      updates.start();
      expect(fakes.update.calls, 'não atrasa a abertura').toEqual([]);
      await vi.runAllTimersAsync();
    }

    it('com erro, não mostra nada: só uma linha no log', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      fakes.update.checkReply = FAILURE;

      await runAutoCheck();

      expect(fakes.update.calls).toEqual(['check']);
      expect(updates.state()).toBeNull();
      expect(warn).toHaveBeenCalledWith('Atualização:', FAILURE.message);
    });

    it('sem versão nova, não mostra nada', async () => {
      await runAutoCheck();

      expect(updates.state()).toBeNull();
    });

    it('com versão nova, mostra o aviso', async () => {
      fakes.update.checkReply = NEW_VERSION;

      await runAutoCheck();

      expect(updates.state()).toEqual({ kind: 'available', ...NEW_VERSION });
    });

    it('não sobrepõe a verificação que o usuário pediu nesse meio-tempo', async () => {
      fakes.update.checkReply = NEW_VERSION;
      vi.useFakeTimers();
      updates.start();
      const manual = updates.check();
      await vi.runAllTimersAsync();
      await manual;

      expect(fakes.update.calls).toEqual(['check']);
    });
  });

  describe('comando manual', () => {
    it('responde sempre: atualizado ou o erro', async () => {
      const check = updates.check();
      expect(updates.state()).toEqual({ kind: 'checking' });
      await check;
      expect(updates.state()).toEqual({ kind: 'upToDate' });

      fakes.update.checkReply = FAILURE;
      await updates.check();
      expect(updates.state()).toEqual({
        kind: 'failed',
        message: FAILURE.message,
        retry: 'check',
      });
    });

    it('"Tentar de novo" de uma verificação só verifica', async () => {
      fakes.update.checkReply = FAILURE;
      await updates.check();
      fakes.update.checkReply = NEW_VERSION;

      await updates.retry();

      expect(fakes.update.calls).toEqual(['check', 'check']);
      expect(updates.state()).toEqual({ kind: 'available', ...NEW_VERSION });
    });
  });

  it('"Depois" esconde sem gravar nada, e o comando traz o aviso de volta', async () => {
    fakes.update.checkReply = NEW_VERSION;
    await updates.check();

    updates.hide();

    expect(updates.state()).toBeNull();
    expect(fakes.workspace.sessions.size).toBe(0);
    await updates.check();
    expect(updates.state()?.kind).toBe('available');
  });

  describe('download', () => {
    it('um segundo clique não inicia outro download', async () => {
      fakes.update.checkReply = NEW_VERSION;
      await updates.check();
      const pending = deferred();
      fakes.update.installReply = pending.promise;

      void updates.install();
      void updates.install();
      pending.resolve();
      await settle();

      expect(fakes.update.calls).toEqual(['check', 'install']);
    });

    it('um progresso atrasado não desfaz o fim do download', async () => {
      await readyToRestart();

      fakes.update.progress({ downloaded: 1, total: 2 });

      expect(updates.state()).toEqual({ kind: 'ready' });
    });

    it('com o verificador em andamento, o comando não verifica por cima do download', async () => {
      fakes.update.checkReply = NEW_VERSION;
      await updates.check();
      fakes.update.installReply = deferred().promise;
      void updates.install();

      await updates.check();

      expect(fakes.update.calls).toEqual(['check', 'install']);
    });

    it('mostra o percentual; sem total, os bytes; no fim, a barra sem valor', () => {
      const installing = { kind: 'installing', version: '0.8.0' } as const;

      expect(amount({ ...installing, downloaded: 25, total: 100 })).toBe('25%');
      expect(percent({ ...installing, downloaded: 25, total: 100 })).toBe(25);
      expect(amount({ ...installing, downloaded: 0, total: null })).toBe('Iniciando…');
      expect(amount({ ...installing, downloaded: 3670016, total: null })).toContain('3,5 MB');
      expect(percent({ ...installing, downloaded: 3670016, total: null })).toBeNull();
      expect(percent({ ...installing, downloaded: 100, total: 100 })).toBeNull();
    });

    it('depois de um erro, verifica de novo antes de tentar outra vez', async () => {
      fakes.update.checkReply = NEW_VERSION;
      await updates.check();
      fakes.update.installReply = Promise.reject(FAILURE);
      await updates.install();
      expect(updates.state()).toEqual({
        kind: 'failed',
        message: FAILURE.message,
        retry: 'install',
      });

      fakes.update.installReply = Promise.resolve();
      await updates.retry();

      expect(fakes.update.calls).toEqual(['check', 'install', 'check', 'install']);
      expect(updates.state()).toEqual({ kind: 'ready' });
    });

    it('"Tentar de novo" com a verificação falhando continua oferecendo a instalação', async () => {
      fakes.update.checkReply = NEW_VERSION;
      await updates.check();
      fakes.update.installReply = Promise.reject(FAILURE);
      await updates.install();
      fakes.update.checkReply = { kind: 'other', message: 'Sem rede.' };

      await updates.retry();

      expect(updates.state()).toEqual({ kind: 'failed', message: 'Sem rede.', retry: 'install' });
    });

    it('"Tentar de novo" sem versão nova diz que está atualizado', async () => {
      fakes.update.checkReply = NEW_VERSION;
      await updates.check();
      fakes.update.installReply = Promise.reject(FAILURE);
      await updates.install();
      fakes.update.checkReply = null;

      await updates.retry();

      expect(fakes.update.calls).toEqual(['check', 'install', 'check']);
      expect(updates.state()).toEqual({ kind: 'upToDate' });
    });
  });

  describe('reiniciar', () => {
    it('sem nada pendente, reinicia sem perguntar, só depois do clique', async () => {
      await readyToRestart();
      expect(fakes.update.calls).not.toContain('restart');

      await updates.restart();

      expect(fakes.dialogs.asked).toEqual([]);
      expect(fakes.update.calls.at(-1)).toBe('restart');
    });

    it('com arquivo sem salvar, Cancelar não reinicia e o aviso continua', async () => {
      await readyToRestart();
      await dirtyTab();
      fakes.dialogs.answers.push('Cancelar');

      await updates.restart();

      expect(fakes.dialogs.asked[0].buttons).toEqual(['Salvar', 'Não salvar', 'Cancelar']);
      expect(fakes.update.calls).not.toContain('restart');
      expect(updates.state()).toEqual({ kind: 'ready' });
    });

    it('fechar a pergunta com Esc também não reinicia', async () => {
      await readyToRestart();
      await dirtyTab();
      fakes.dialogs.answers.push(null);

      await updates.restart();

      expect(fakes.update.calls).not.toContain('restart');
    });

    it('com arquivo sem salvar, "Não salvar" reinicia depois de gravar a sessão', async () => {
      await readyToRestart();
      await dirtyTab();
      fakes.dialogs.answers.push('Não salvar');

      await updates.restart();

      expect(fakes.update.calls.at(-1)).toBe('restart');
    });

    it('o que foi digitado enquanto a depuração encerrava ainda recebe a pergunta', async () => {
      await readyToRestart();
      const buffer = await dirtyTab();
      const debug = TestBed.inject(Debugger);
      const stopped = deferred();
      debug.state.set('running');
      vi.spyOn(debug, 'stop').mockReturnValue(stopped.promise);
      fakes.dialogs.answers.push('Encerrar e reiniciar', 'Não salvar', 'Cancelar');

      const restart = updates.restart();
      await settle();
      expect(updates.state()).toEqual({ kind: 'restarting' });
      buffer.type('y');
      stopped.resolve();
      await restart;

      expect(fakes.dialogs.asked.length).toBe(3);
      expect(fakes.update.calls).not.toContain('restart');
      expect(updates.state()).toEqual({ kind: 'ready' });
    });

    it('um segundo clique enquanto a pergunta está aberta não abre outra', async () => {
      await readyToRestart();
      TestBed.inject(Project).building.set(true);
      fakes.dialogs.answers.push('Cancelar');

      await Promise.all([updates.restart(), updates.restart()]);

      expect(fakes.dialogs.asked.length).toBe(1);
    });

    it('com compilação, pergunta; Cancelar não encerra nada', async () => {
      await readyToRestart();
      TestBed.inject(Project).building.set(true);
      fakes.dialogs.answers.push('Cancelar');

      await updates.restart();

      expect(fakes.dialogs.asked[0].detail).toContain('a compilação');
      expect(fakes.project.cancels).toBe(0);
      expect(fakes.update.calls).not.toContain('restart');
      expect(updates.state()).toEqual({ kind: 'ready' });
    });

    it('com compilação, confirmar cancela e só reinicia quando ela acabou', async () => {
      await readyToRestart();
      const build = deferred();
      fakes.project.buildReply = build.promise;
      TestBed.inject(Project).build();
      await settle();
      fakes.dialogs.answers.push('Encerrar e reiniciar');

      void updates.restart();
      await settle();

      expect(fakes.project.cancels).toBe(1);
      expect(fakes.update.calls).not.toContain('restart');
      build.resolve();
      await settle();
      expect(fakes.update.calls.at(-1)).toBe('restart');
    });

    it('com programa rodando e depuração, cita os dois e encerra a depuração', async () => {
      await readyToRestart();
      const debug = TestBed.inject(Debugger);
      debug.state.set('running');
      const stop = vi.spyOn(debug, 'stop').mockResolvedValue();
      TestBed.inject(Terminals).program.set({
        name: () => '▶ app',
      } as unknown as TerminalSession);
      fakes.dialogs.answers.push('Encerrar e reiniciar');

      await updates.restart();

      expect(fakes.dialogs.asked[0].detail).toBe(
        'Será encerrado: o programa app, a sessão de depuração.',
      );
      expect(stop).toHaveBeenCalledOnce();
      expect(fakes.update.calls.at(-1)).toBe('restart');
    });

    it('"Depois" esconde; o comando traz o aviso sem verificar nem baixar de novo', async () => {
      await readyToRestart();
      const calls = fakes.update.calls.length;

      updates.hide();
      expect(updates.state()).toBeNull();
      await updates.check();

      expect(updates.state()).toEqual({ kind: 'ready' });
      expect(fakes.update.calls.length).toBe(calls);
    });

    it('se o reinício falha (instalador do Windows), mostra o erro e baixa de novo', async () => {
      await readyToRestart();
      fakes.update.restartReply = Promise.reject(FAILURE);

      await updates.restart();

      expect(updates.state()).toEqual({
        kind: 'failed',
        message: FAILURE.message,
        retry: 'install',
      });
      fakes.update.calls.length = 0;
      await updates.retry();
      expect(fakes.update.calls).toEqual(['check', 'install']);
    });
  });

  describe('o aviso na tela', () => {
    function render(): HTMLElement {
      const fixture = TestBed.createComponent(UpdateNotice);
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    }

    function show(page: HTMLElement): void {
      TestBed.tick();
      expect(page.classList).toContain('banner');
    }

    const labels = (page: HTMLElement) =>
      [...page.querySelectorAll('button')].map((button) => button.textContent?.trim());

    it('sem aviso, não ocupa lugar, mas a região lida pelo leitor de tela já existe', () => {
      const page = render();

      expect(page.classList).not.toContain('banner');
      expect(page.querySelector('[role=status]')?.textContent).toBe('');
    });

    it('mostra a versão com Atualizar e Depois, sem pegar o foco e com dica nos botões', async () => {
      const page = render();
      document.body.appendChild(page);
      const editor = document.body.appendChild(document.createElement('textarea'));
      editor.focus();
      fakes.update.checkReply = NEW_VERSION;

      await updates.check();
      show(page);

      expect(page.querySelector('[role=status]')?.textContent).toBe('Dark Triad 0.8.0 disponível');
      expect(labels(page)).toEqual(['Atualizar', 'Depois']);
      for (const button of page.querySelectorAll('button')) expect(button.title).not.toBe('');
      expect(document.activeElement).toBe(editor);
      page.remove();
      editor.remove();
    });

    it('com notas vazias, não oferece "Ver novidades"', async () => {
      const page = render();
      for (const notes of [null, '', ' \n ']) {
        fakes.update.checkReply = { version: '0.8.0', notes };
        await updates.check();
        show(page);
        expect(page.querySelector('details'), String(notes)).toBeNull();
      }
    });

    it('mostra as notas como texto puro: HTML e Markdown não viram elementos', async () => {
      const notes = '**novo**\n<img src=x onerror="alert(1)"><script>alert(2)</script>';
      const page = render();
      fakes.update.checkReply = { version: '0.8.0', notes };

      await updates.check();
      show(page);

      const details = page.querySelector('details')!;
      expect(details.open).toBe(false);
      expect(details.querySelector('summary')?.textContent).toBe('Ver novidades');
      const text = details.querySelector('.update-notes-text')!;
      expect(text.textContent).toBe(notes);
      expect(text.children.length).toBe(0);
    });

    it('as notas ficam fora da região lida em voz alta', async () => {
      const page = render();
      fakes.update.checkReply = { version: '0.8.0', notes: 'Novidades' };

      await updates.check();
      show(page);

      expect(page.querySelector('[role=status] details')).toBeNull();
    });

    it('o progresso fica fora da região lida em voz alta, para não ler cada percentual', async () => {
      const page = render();
      fakes.update.checkReply = NEW_VERSION;
      await updates.check();
      fakes.update.installReply = deferred().promise;
      void updates.install();
      fakes.update.progress({ downloaded: 50, total: 200 });
      show(page);

      const progress = page.querySelector('progress')!;
      expect(progress.getAttribute('value')).toBe('25');
      expect(progress.getAttribute('aria-label')).toBe('Progresso da atualização');
      expect(page.textContent).toContain('25%');
      expect(page.querySelector('[role=status]')?.textContent).toBe('Baixando o Dark Triad 0.8.0');
      expect(labels(page)).toEqual([]);
    });

    it('no fim do download, a barra se mexe e o texto diz o que acontece', async () => {
      const page = render();
      fakes.update.checkReply = NEW_VERSION;
      await updates.check();
      fakes.update.installReply = deferred().promise;
      void updates.install();
      fakes.update.progress({ downloaded: 200, total: 200 });
      show(page);

      expect(page.querySelector('progress')?.hasAttribute('value')).toBe(false);
      expect(page.querySelector('[role=status]')?.textContent).toContain('Concluindo');
    });

    it('a pronta oferece Reiniciar agora e Depois; o erro, Tentar de novo e Fechar', async () => {
      const page = render();
      await readyToRestart();
      show(page);
      expect(page.querySelector('[role=status]')?.textContent).toBe('Atualização pronta');
      expect(labels(page)).toEqual(['Reiniciar agora', 'Depois']);

      fakes.update.restartReply = Promise.reject({ kind: 'other', message: 'Veja https://x/y' });
      await updates.restart();
      show(page);
      expect(page.querySelector('[role=status]')?.textContent).toBe('Veja https://x/y');
      expect(labels(page)).toEqual(['Tentar de novo', 'Fechar']);
      expect(page.classList).not.toContain('banner-info');
    });

    it('fechar o aviso devolve o foco ao editor', async () => {
      const page = render();
      fakes.update.checkReply = NEW_VERSION;
      await updates.check();
      show(page);
      const tabs = TestBed.inject(EditorTabs);
      const focus = vi.spyOn(tabs, 'requestFocus');

      [...page.querySelectorAll('button')].at(-1)!.click();
      TestBed.tick();

      expect(focus).toHaveBeenCalled();
      expect(page.classList).not.toContain('banner');
    });
  });
});
