import {
  bindingsFor,
  defaultKeys,
  formatChord,
  parseStroke,
  Platform,
  ShortcutDispatcher,
} from './keybindings';

function dispatcher(platform: Platform): ShortcutDispatcher {
  return new ShortcutDispatcher(bindingsFor(defaultKeys(platform), platform));
}

function key(code: string, modifiers: KeyboardEventInit = {}): KeyboardEvent {
  const name = code.startsWith('Key') ? code.slice(3).toLowerCase() : code;
  return new KeyboardEvent('keydown', { code, key: name, ...modifiers });
}

describe('atalhos', () => {
  it('reconhece atalhos simples e acordes do VS Code no Windows', () => {
    const keys = dispatcher('windows');

    expect(keys.handle(key('KeyS', { ctrlKey: true }))).toBe('save');
    expect(keys.handle(key('F4', { ctrlKey: true }))).toBe('closeEditor');
    expect(keys.handle(key('Tab', { ctrlKey: true, shiftKey: true }))).toBe('recentEditorsBack');

    expect(keys.handle(key('KeyK', { ctrlKey: true }))).toBe('consume');
    expect(keys.handle(key('KeyS'))).toBe('saveAll');

    expect(keys.handle(key('KeyK', { ctrlKey: true }))).toBe('consume');
    expect(keys.handle(key('KeyF'))).toBe('closeFolder');
  });

  it('soltar e apertar o Ctrl no meio do acorde não o interrompe', () => {
    const keys = dispatcher('windows');

    keys.handle(key('KeyK', { ctrlKey: true }));
    expect(
      keys.handle(new KeyboardEvent('keydown', { code: 'ControlLeft', key: 'Control' })),
    ).toBeNull();
    expect(keys.handle(key('KeyO', { ctrlKey: true }))).toBe('openFolder');
  });

  it('a segunda tecla de um acorde inexistente é consumida, e a seguinte volta ao normal', () => {
    const keys = dispatcher('windows');

    keys.handle(key('KeyK', { ctrlKey: true }));
    expect(keys.handle(key('KeyX'))).toBe('consume');
    expect(keys.handle(key('KeyX'))).toBeNull();
  });

  it('usa ⌘ no macOS e mantém o ⌃Tab', () => {
    const keys = dispatcher('mac');

    expect(keys.handle(key('KeyS', { metaKey: true }))).toBe('save');
    expect(keys.handle(key('KeyS', { ctrlKey: true }))).toBeNull();
    expect(keys.handle(key('Tab', { ctrlKey: true }))).toBe('recentEditors');
    expect(keys.handle(key('ArrowRight', { metaKey: true, altKey: true }))).toBe('nextEditor');
  });

  it('mostra o atalho como o VS Code', () => {
    const chord = (text: string, platform: Platform) =>
      formatChord(
        text.split(' ').map((part) => parseStroke(part, platform)),
        platform,
      );

    expect(chord('Mod+K Mod+O', 'windows')).toBe('Ctrl+K Ctrl+O');
    expect(chord('Mod+Shift+S', 'linux')).toBe('Ctrl+Shift+S');
    expect(chord('Mod+Shift+S', 'mac')).toBe('⇧⌘S');
    expect(chord('Mod+Alt+Right', 'mac')).toBe('⌥⌘→');
  });
});
