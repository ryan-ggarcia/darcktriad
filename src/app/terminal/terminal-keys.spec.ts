import { Platform } from '../shared/keybindings';
import { TerminalKeyState, terminalKey } from './terminal-keys';

function key(code: string, modifiers: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { code, ...modifiers });
}

const idle: TerminalKeyState = { hasSelection: false, altBuffer: false, chordWaiting: false };

function route(platform: Platform, event: KeyboardEvent, state: Partial<TerminalKeyState> = {}) {
  return terminalKey(event, platform, { ...idle, ...state });
}

describe('teclas com o foco no terminal', () => {
  it('as abas por número: Alt no Windows e no Linux, ⌃ no macOS; AltGr fica com o shell', () => {
    expect(route('mac', key('Digit1', { ctrlKey: true }))).toBe('page');
    expect(route('mac', key('Digit1', { altKey: true }))).toBe('shell');
    expect(route('windows', key('Digit1', { ctrlKey: true, altKey: true }))).toBe('shell');
  });

  it('manda à IDE só os atalhos da lista da spec, e o resto ao processo', () => {
    for (const platform of ['windows', 'linux'] as const) {
      expect(route(platform, key('KeyP', { ctrlKey: true }))).toBe('page');
      expect(route(platform, key('KeyP', { ctrlKey: true, shiftKey: true }))).toBe('page');
      expect(route(platform, key('Backquote', { ctrlKey: true }))).toBe('page');
      expect(route(platform, key('Backquote', { ctrlKey: true, shiftKey: true }))).toBe('page');
      expect(route(platform, key('KeyB', { ctrlKey: true }))).toBe('page');
      expect(route(platform, key('KeyK', { ctrlKey: true }))).toBe('page');
      expect(route(platform, key('F5', { ctrlKey: true }))).toBe('page');
      expect(route(platform, key('F11', { shiftKey: true }))).toBe('page');
      expect(route(platform, key('KeyJ', { ctrlKey: true }))).toBe('page');
      expect(route(platform, key('Digit0', { ctrlKey: true }))).toBe('page');
      expect(route(platform, key('Digit1', { ctrlKey: true }))).toBe('page');
      expect(route(platform, key('F6'))).toBe('page');
      expect(route(platform, key('F6', { shiftKey: true }))).toBe('page');
      expect(route(platform, key('PageDown', { ctrlKey: true }))).toBe('page');
      expect(route(platform, key('Tab', { ctrlKey: true }))).toBe('page');
      expect(route(platform, key('KeyM', { ctrlKey: true, shiftKey: true }))).toBe('page');

      expect(route(platform, key('KeyC', { ctrlKey: true }))).toBe('shell');
      expect(route(platform, key('KeyD', { ctrlKey: true }))).toBe('shell');
      expect(route(platform, key('KeyS', { ctrlKey: true }))).toBe('shell');
      expect(route(platform, key('KeyA', { altKey: true }))).toBe('shell');
      expect(route(platform, key('KeyF', { altKey: true }))).toBe('shell');
      expect(route(platform, key('Digit1', { altKey: true }))).toBe('page');
      expect(route(platform, key('Digit9', { altKey: true }))).toBe('page');
      expect(route(platform, key('Digit0', { altKey: true }))).toBe('shell');
      expect(route(platform, key('ArrowUp'))).toBe('shell');
      expect(route(platform, key('Tab'))).toBe('shell');
      expect(route(platform, key('F12'))).toBe('shell');
    }
  });

  it('com um acorde Ctrl+K esperando, a segunda tecla também vai para a IDE', () => {
    expect(route('linux', key('KeyO', { ctrlKey: true }), { chordWaiting: true })).toBe('page');
    expect(route('linux', key('KeyF'), { chordWaiting: true })).toBe('page');
  });

  it('no Windows, Ctrl+C copia só com seleção e Ctrl+V cola pelo navegador', () => {
    expect(route('windows', key('KeyC', { ctrlKey: true }), { hasSelection: true })).toBe('copy');
    expect(route('windows', key('KeyC', { ctrlKey: true }))).toBe('shell');
    expect(route('windows', key('KeyV', { ctrlKey: true }))).toBe('page');
  });

  it('no Linux, copia e cola com Ctrl+Shift+C / Ctrl+Shift+V', () => {
    const copy = key('KeyC', { ctrlKey: true, shiftKey: true });
    expect(route('linux', copy)).toBe('copy');
    expect(route('linux', key('KeyV', { ctrlKey: true, shiftKey: true }))).toBe('paste');
    expect(route('linux', key('KeyC', { ctrlKey: true }), { hasSelection: true })).toBe('shell');
    expect(route('linux', key('KeyV', { ctrlKey: true }))).toBe('shell');
  });

  it('no macOS, ⌘ vale pelo Ctrl, ⌃` é da IDE e PageUp rola fora de programas de tela cheia', () => {
    expect(route('mac', key('KeyP', { metaKey: true }))).toBe('page');
    expect(route('mac', key('Backquote', { ctrlKey: true }))).toBe('page');
    expect(route('mac', key('KeyC', { metaKey: true }))).toBe('page');
    expect(route('mac', key('KeyV', { metaKey: true }))).toBe('page');
    expect(route('mac', key('KeyC', { ctrlKey: true }))).toBe('shell');
    expect(route('mac', key('KeyP', { ctrlKey: true }))).toBe('shell');

    expect(route('mac', key('PageUp'))).toBe('pageUp');
    expect(route('mac', key('PageDown'))).toBe('pageDown');
    expect(route('mac', key('PageUp'), { altBuffer: true })).toBe('shell');
    expect(route('linux', key('PageUp'))).toBe('shell');
  });
});
