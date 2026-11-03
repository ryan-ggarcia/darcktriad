import { TestBed } from '@angular/core/testing';
import { createFakes, Fakes, settle } from '../../testing/fakes';
import { Panel } from '../shared/panel';
import { TerminalPanel } from './terminal-panel';
import { Terminals } from './terminals';

describe('painel do terminal', () => {
  let fakes: Fakes;

  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  });

  async function render() {
    fakes = createFakes();
    TestBed.configureTestingModule({ providers: fakes.providers });
    const fixture = TestBed.createComponent(TerminalPanel);
    const terminals = TestBed.inject(Terminals);
    const page = fixture.nativeElement as HTMLElement;
    const stable = async () => {
      await settle();
      await fixture.whenStable();
    };
    return { page, terminals, stable };
  }

  it('lista os terminais pelo nome do shell, troca o visível e fecha pelo X', async () => {
    const { page, terminals, stable } = await render();
    await stable();
    expect(page.hidden).toBe(true);

    await terminals.create();
    fakes.terminals.shell = 'zsh';
    await terminals.create();
    await stable();

    expect(page.hidden).toBe(false);
    const names = () =>
      [...page.querySelectorAll('.terminal-name')].map((b) => b.textContent!.trim());
    expect(names()).toEqual(['bash', 'zsh']);
    const screens = [...page.querySelectorAll<HTMLElement>('.terminal-screen')];
    expect(screens.map((screen) => screen.hidden)).toEqual([true, false]);
    // A tela ativa abre dentro do painel.
    expect(fakes.screens.screens[1].opened?.closest('.terminal-screen')).toBe(screens[1]);

    page.querySelector<HTMLElement>('.terminal-name')!.click();
    await stable();
    expect(screens.map((screen) => screen.hidden)).toEqual([false, true]);
    expect(fakes.screens.screens[0].opened).not.toBeNull();

    const close = page.querySelector<HTMLButtonElement>('[title="Fechar terminal"]')!;
    expect(close.getAttribute('aria-label')).toBe('Fechar terminal bash');
    close.click();
    await stable();
    expect(names()).toEqual(['zsh']);
    expect(fakes.terminals.closed).toEqual([1]);
  });

  it('mostra no lugar da tela a mensagem de falha com o shell tentado', async () => {
    const { page, terminals, stable } = await render();
    fakes.terminals.createError = {
      kind: 'other',
      message: 'Não foi possível iniciar o terminal com /bin/zsh: x',
    };

    await terminals.create();
    await stable();

    expect(page.querySelector('[role=alert]')?.textContent).toContain('/bin/zsh');
  });

  it('todo botão tem dica, com o atalho quando há', async () => {
    const { page, terminals, stable } = await render();
    await terminals.create();
    await stable();

    for (const button of page.querySelectorAll('button')) {
      expect(button.title, button.outerHTML).not.toBe('');
    }
    expect(page.querySelector('[aria-label="Novo terminal"]')?.getAttribute('title')).toBe(
      'Novo terminal (Ctrl+Shift+`)',
    );
    expect(page.querySelector('[aria-label="Ocultar painel"]')?.getAttribute('title')).toBe(
      'Ocultar painel (Ctrl+`)',
    );
  });

  it('a altura mudada pelas setas fica gravada e vale na próxima abertura', async () => {
    localStorage.clear();
    const first = await render();
    await first.terminals.create();
    await first.stable();

    first.page
      .querySelector('.panel-sash')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await first.stable();
    expect(first.page.style.height).toBe('300px');
    expect(localStorage.getItem('panelHeight')).toBe('300');

    TestBed.resetTestingModule();
    const again = await render();
    await again.stable();
    expect(again.page.style.height).toBe('300px');
    localStorage.clear();
  });

  it('expandir ocupa o lugar dos editores e recolher volta', async () => {
    const { page, terminals, stable } = await render();
    await terminals.create();
    await stable();
    const toggle = () =>
      page.querySelector<HTMLButtonElement>('[aria-label$="painel"][aria-pressed]')!;

    expect(toggle().getAttribute('aria-label')).toBe('Expandir painel');
    toggle().click();
    await stable();
    expect(TestBed.inject(Panel).maximized()).toBe(true);
    expect(toggle().getAttribute('aria-label')).toBe('Recolher painel');
    toggle().click();
    await stable();
    expect(TestBed.inject(Panel).maximized()).toBe(false);
  });
});
