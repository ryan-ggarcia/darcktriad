import { TestBed } from '@angular/core/testing';
import { createFakes, settle } from '../../testing/fakes';
import { Commands } from '../shared/commands';
import { MenuBar } from './menu-bar';

describe('MenuBar', () => {
  let page: HTMLElement;
  let editor: HTMLTextAreaElement;
  let opened: string[];

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: createFakes().providers });
    // Antes da barra: ela lê a disponibilidade dos comandos ao montar os menus.
    opened = [];
    TestBed.inject(Commands).register({ openFolder: () => opened.push('openFolder') });
    const fixture = TestBed.createComponent(MenuBar);
    page = fixture.nativeElement as HTMLElement;
    document.body.appendChild(page);
    editor = document.body.appendChild(document.createElement('textarea'));
    await fixture.whenStable();
    editor.focus();
  });

  afterEach(() => {
    page.remove();
    editor.remove();
  });

  const focused = () => document.activeElement as HTMLElement;
  const text = () => focused().textContent?.trim();

  async function press(key: string, target: EventTarget = focused()): Promise<void> {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    TestBed.tick();
    await settle();
    TestBed.tick();
  }

  it('tem os menus do registro com os papéis de acessibilidade', () => {
    expect(page.getAttribute('role')).toBe('menubar');
    const buttons = [...page.querySelectorAll('[role=menuitem]')].map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['Arquivo', 'Editar', 'Ver', 'Ir', 'Executar', 'Ajuda']);
  });

  it('F10 entra na barra; setas trocam de menu; ↓ abre; Enter executa e devolve o foco', async () => {
    await press('F10', window);
    expect(text()).toBe('Arquivo');
    await press('ArrowRight');
    expect(text()).toBe('Editar');
    await press('ArrowLeft');
    expect(text()).toBe('Arquivo');

    await press('ArrowDown');
    expect(page.querySelector('[role=menu]')?.getAttribute('aria-label')).toBe('Arquivo');
    expect(focused().getAttribute('role')).toBe('menuitem');
    expect(focused().textContent).toContain('Novo arquivo');
    expect(focused().querySelector('.menu-shortcut')?.textContent).toBe('Ctrl+N');
    await press('ArrowDown');
    await press('ArrowDown');
    expect(focused().textContent).toContain('Abrir pasta');
    await press('Enter');

    expect(opened).toEqual(['openFolder']);
    expect(page.querySelector('[role=menu]')).toBeNull();
    expect(focused()).toBe(editor);
  });

  it('Esc fecha o menu e volta ao botão; outro Esc sai da barra e volta ao editor', async () => {
    await press('F10', window);
    await press('Enter');
    expect(page.querySelector('[role=menu]')).not.toBeNull();

    await press('Escape');
    expect(page.querySelector('[role=menu]')).toBeNull();
    expect(text()).toBe('Arquivo');

    await press('Escape');
    expect(focused()).toBe(editor);
  });

  it('sem nada com foco antes, Esc tira o foco da barra (o body não recebe foco)', async () => {
    editor.blur();
    await press('F10', window);
    expect(text()).toBe('Arquivo');

    await press('Escape');
    expect(focused()).toBe(document.body);
  });

  it('Alt sozinho entra na barra; Alt com outra tecla não', async () => {
    const alt = (type: string, init: KeyboardEventInit = {}) =>
      window.dispatchEvent(new KeyboardEvent(type, { key: 'Alt', altKey: true, ...init }));

    alt('keydown');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', altKey: true }));
    alt('keyup');
    expect(focused()).toBe(editor);

    alt('keydown');
    alt('keyup');
    expect(text()).toBe('Arquivo');
  });

  describe('Alt+letra', () => {
    const alt = async (key: string) => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }),
      );
      TestBed.tick();
      await settle();
      TestBed.tick();
    };
    const openMenu = () => page.querySelector('[role=menu]')?.getAttribute('aria-label');

    it('cada menu tem uma letra só dele, presente no nome', () => {
      const buttons = [...page.querySelectorAll<HTMLElement>('.menu-bar-button')];
      const letters = buttons.map((button) =>
        button.querySelector('.mnemonic')?.textContent?.toLowerCase(),
      );
      expect(buttons.map((button) => button.textContent?.trim())).toEqual([
        'Arquivo',
        'Editar',
        'Ver',
        'Ir',
        'Executar',
        'Ajuda',
      ]);
      expect(letters).toEqual(['a', 'e', 'v', 'i', 'x', 'j']);
      expect(buttons[4].getAttribute('aria-keyshortcuts')).toBe('Alt+X');
    });

    it('abre o menu da letra; Esc volta ao botão; outro Esc, ao editor', async () => {
      await alt('x');
      expect(openMenu()).toBe('Executar');
      await alt('a');
      expect(openMenu()).toBe('Arquivo');

      await press('Escape');
      expect(openMenu()).toBeUndefined();
      await press('Escape');
      expect(focused()).toBe(editor);
    });

    it('a letra fica sublinhada só enquanto o Alt está apertado', async () => {
      await alt('Alt');
      expect(page.classList).toContain('mnemonics');
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
      TestBed.tick();
      expect(page.classList).not.toContain('mnemonics');
    });

    it('no terminal, Alt+letra é do shell', async () => {
      const xterm = document.body.appendChild(document.createElement('div'));
      xterm.className = 'xterm';
      const input = xterm.appendChild(document.createElement('textarea'));
      input.focus();

      await alt('a');
      expect(openMenu()).toBeUndefined();
      expect(page.classList).not.toContain('mnemonics');
      xterm.remove();
    });

    it('com o foco na barra, a letra sozinha abre o menu; dentro dele, a letra do item o escolhe', async () => {
      await press('F10', window);
      await press('a');
      expect(openMenu()).toBe('Arquivo');
      const open = [...page.querySelectorAll<HTMLElement>('[role=menu] .menu-item')].find((item) =>
        item.textContent?.includes('Abrir pasta'),
      )!;
      expect(open.querySelector('.mnemonic')?.textContent).toBe('p');

      await press('p');
      expect(opened).toEqual(['openFolder']);
      expect(openMenu()).toBeUndefined();
    });

    it('a letra de um item que não vale agora não executa e o menu fica aberto', async () => {
      await alt('a');
      await press('s');
      expect(opened).toEqual([]);
      expect(openMenu()).toBe('Arquivo');
    });
  });

  it('item que não vale agora fica apagado e não executa', async () => {
    const run = vi.spyOn(TestBed.inject(Commands), 'run');
    await press('F10', window);
    await press('Enter');

    const save = [...page.querySelectorAll<HTMLElement>('[role=menuitem]')].find(
      (item) => item.querySelector('.menu-label')?.textContent === 'Salvar',
    )!;
    expect(save.getAttribute('aria-disabled')).toBe('true');
    save.click();
    TestBed.tick();

    expect(run).not.toHaveBeenCalled();
  });
});
