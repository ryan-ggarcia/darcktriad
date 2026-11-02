import { matches, parseStroke, Platform } from '../shared/keybindings';

/**
 * Teclas que vão para a IDE mesmo com o foco no terminal (docs/specs/terminal.md, Teclado).
 * `Mod+K` é a primeira tecla dos acordes Ctrl+K; a segunda também vai, porque o acorde espera.
 */
const IDE_KEYS = [
  'Mod+Shift+P',
  'Mod+P',
  'Ctrl+`',
  'Ctrl+Shift+`',
  'F1',
  'Mod+Shift+B',
  'F5',
  'Ctrl+F5',
  'Shift+F5',
  'F9',
  'F10',
  'F11',
  'Shift+F11',
  'Mod+B',
  'Mod+Shift+U',
  'Mod+K',
];

/**
 * O destino de uma tecla com o foco no terminal:
 * - `shell`: o xterm.js a manda ao processo;
 * - `page`: segue para a página, onde o despachante da IDE a trata, ou o navegador faz a ação
 *   nativa (colar no Windows; copiar e colar do menu Editar no macOS);
 * - `copy`, `paste`, `pageUp`, `pageDown`: a interface faz a ação.
 */
export type TerminalKey = 'shell' | 'page' | 'copy' | 'paste' | 'pageUp' | 'pageDown';

export interface TerminalKeyState {
  hasSelection: boolean;
  /** Programa de tela cheia (vim, htop): PageUp/PageDown são dele. */
  altBuffer: boolean;
  /** O despachante espera a segunda tecla de um acorde. */
  chordWaiting: boolean;
}

export function terminalKey(
  event: KeyboardEvent,
  platform: Platform,
  state: TerminalKeyState,
): TerminalKey {
  const is = (text: string) => matches(event, parseStroke(text, platform));
  if (state.chordWaiting || IDE_KEYS.some(is)) return 'page';
  if (platform === 'windows') {
    if (is('Ctrl+C') && state.hasSelection) return 'copy';
    if (is('Ctrl+V')) return 'page';
  } else if (platform === 'linux') {
    if (is('Ctrl+Shift+C')) return 'copy';
    if (is('Ctrl+Shift+V')) return 'paste';
  } else {
    if (is('Mod+C') || is('Mod+V')) return 'page';
    // No Windows e no Linux, o próprio xterm.js rola com Shift+PageUp/PageDown.
    if (!state.altBuffer && is('PageUp')) return 'pageUp';
    if (!state.altBuffer && is('PageDown')) return 'pageDown';
  }
  return 'shell';
}
