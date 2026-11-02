import { bindingsFor } from './commands';
import {
  formatAccelerator,
  formatChord,
  learnKeyLabel,
  loadKeyboardLayout,
  parseChord,
  Platform,
  ShortcutDispatcher,
} from './keybindings';

function dispatcher(platform: Platform) {
  return new ShortcutDispatcher(bindingsFor(platform));
}

function key(code: string, modifiers: KeyboardEventInit = {}): KeyboardEvent {
  const name = code.startsWith('Key') ? code.slice(3).toLowerCase() : code;
  return new KeyboardEvent('keydown', { code, key: name, ...modifiers });
}

const command = (id: string) => ({ kind: 'command', id });

describe('atalhos', () => {
  it('reconhece atalhos simples e acordes do VS Code no Windows', () => {
    const keys = dispatcher('windows');

    expect(keys.handle(key('KeyS', { ctrlKey: true }))).toEqual(command('save'));
    expect(keys.handle(key('F4', { ctrlKey: true }))).toEqual(command('closeEditor'));
    expect(keys.handle(key('Tab', { ctrlKey: true, shiftKey: true }))).toEqual(
      command('recentEditorsBack'),
    );
    expect(keys.handle(key('KeyP', { ctrlKey: true, shiftKey: true }))).toEqual(
      command('showCommands'),
    );
    expect(keys.handle(key('F1'))).toEqual(command('showCommands'));
    expect(keys.handle(key('KeyG', { ctrlKey: true }))).toEqual(command('goToLine'));

    expect(keys.handle(key('KeyK', { ctrlKey: true }))?.kind).toBe('pending');
    expect(keys.handle(key('KeyS'))).toEqual(command('saveAll'));

    expect(keys.handle(key('KeyK', { ctrlKey: true }))?.kind).toBe('pending');
    expect(keys.handle(key('KeyF'))).toEqual(command('closeFolder'));
  });

  it('soltar e apertar o Ctrl no meio do acorde não o interrompe', () => {
    const keys = dispatcher('windows');

    keys.handle(key('KeyK', { ctrlKey: true }));
    expect(
      keys.handle(new KeyboardEvent('keydown', { code: 'ControlLeft', key: 'Control' })),
    ).toBeNull();
    expect(keys.handle(key('KeyO', { ctrlKey: true }))).toEqual(command('openFolder'));
  });

  it('a segunda tecla de um acorde inexistente é consumida, e a seguinte volta ao normal', () => {
    const keys = dispatcher('windows');

    keys.handle(key('KeyK', { ctrlKey: true }));
    expect(keys.handle(key('Escape'))).toEqual({ kind: 'unknown' });
    expect(keys.handle(key('KeyX'))).toBeNull();
  });

  it('ignora atalhos de comandos indisponíveis', () => {
    const keys = dispatcher('windows');

    expect(keys.handle(key('KeyS', { ctrlKey: true }), (id) => id !== 'save')).toBeNull();
    expect(keys.handle(key('KeyK', { ctrlKey: true }), (id) => id !== 'closeFolder')?.kind).toBe(
      'pending',
    );
    expect(keys.handle(key('KeyF'), (id) => id !== 'closeFolder')).toEqual({ kind: 'unknown' });
  });

  it('usa ⌘ no macOS e mantém o ⌃Tab e o ⌃G', () => {
    const keys = dispatcher('mac');

    expect(keys.handle(key('KeyS', { metaKey: true }))).toEqual(command('save'));
    expect(keys.handle(key('KeyS', { ctrlKey: true }))).toBeNull();
    expect(keys.handle(key('Tab', { ctrlKey: true }))).toEqual(command('recentEditors'));
    expect(keys.handle(key('KeyG', { ctrlKey: true }))).toEqual(command('goToLine'));
    expect(keys.handle(key('ArrowRight', { metaKey: true, altKey: true }))).toEqual(
      command('nextEditor'),
    );
  });

  it('mostra o atalho como o VS Code', () => {
    const chord = (text: string, platform: Platform) =>
      formatChord(parseChord(text, platform), platform);

    expect(chord('Mod+K Mod+O', 'windows')).toBe('Ctrl+K Ctrl+O');
    expect(chord('Mod+Shift+S', 'linux')).toBe('Ctrl+Shift+S');
    expect(chord('Mod+Shift+S', 'mac')).toBe('⇧⌘S');
    expect(chord('Mod+Alt+Right', 'mac')).toBe('⌥⌘→');
    expect(chord('Mod+/', 'windows')).toBe('Ctrl+/');
  });

  it('mostra o caractere que a tecla à esquerda do 1 produz no layout, como o VS Code', () => {
    const terminal = () => formatChord(parseChord('Ctrl+`', 'linux'), 'linux');
    const press = (keyText: string, modifiers: KeyboardEventInit = {}) =>
      learnKeyLabel(
        new KeyboardEvent('keydown', { code: 'Backquote', key: keyText, ...modifiers }),
      );

    expect(terminal()).toBe('Ctrl+`');
    press('Dead');
    press('"', { shiftKey: true });
    expect(terminal()).toBe('Ctrl+`');
    // ABNT2: a tecla física do Backquote escreve '.
    press("'", { ctrlKey: true });
    expect(terminal()).toBe("Ctrl+'");
    expect(localStorage.getItem('backquoteLabel')).toBe("'");
    press('`');
  });

  it('na abertura, sem o mapa do layout (WebKitGTK), usa o caractere aprendido antes', async () => {
    const terminal = () => formatChord(parseChord('Ctrl+`', 'linux'), 'linux');
    localStorage.setItem('backquoteLabel', "'");
    try {
      await loadKeyboardLayout();
      expect(terminal()).toBe("Ctrl+'");
    } finally {
      learnKeyLabel(new KeyboardEvent('keydown', { code: 'Backquote', key: '`' }));
      localStorage.clear();
    }
  });

  it('escreve o atalho do menu nativo no formato do Tauri', () => {
    const accelerator = (text: string, platform: Platform) =>
      formatAccelerator(parseChord(text, platform), platform);

    expect(accelerator('Mod+Shift+P', 'windows')).toBe('Ctrl+Shift+P');
    expect(accelerator('Mod+K Mod+O', 'linux')).toBe('Ctrl+K Ctrl+O');
    expect(accelerator('Mod+Shift+P', 'mac')).toBe('Shift+Cmd+KeyP');
    expect(accelerator('Ctrl+G', 'mac')).toBe('Ctrl+KeyG');
    expect(accelerator('F1', 'mac')).toBe('F1');
    // O menu do macOS não tem acordes: o item fica sem atalho.
    expect(accelerator('Mod+K Mod+W', 'mac')).toBeNull();
  });
});
