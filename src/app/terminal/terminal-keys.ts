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
  'Mod+Shift+F5',
  'F6',
  'F9',
  'F10',
  'F11',
  'Shift+F11',
  'Mod+B',
  'Mod+J',
  'Mod+0',
  'Mod+1',
  'Shift+F6',
  'Mod+PageDown',
  'Mod+PageUp',
  'Ctrl+Tab',
  'Ctrl+Shift+Tab',
  'Mod+Shift+E',
  'Mod+Shift+D',
  'Mod+Shift+M',
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

/** Alt+1 a Alt+9 (⌃1 a ⌃9 no macOS, onde ⌥ com número escreve um caractere). */
function isTabNumber(is: (text: string) => boolean, platform: Platform): boolean {
  const modifier = platform === 'mac' ? 'Ctrl' : 'Alt';
  return [1, 2, 3, 4, 5, 6, 7, 8, 9].some((number) => is(`${modifier}+${number}`));
}

export function terminalKey(
  event: KeyboardEvent,
  platform: Platform,
  state: TerminalKeyState,
): TerminalKey {
  const is = (text: string) => matches(event, parseStroke(text, platform));
  if (state.chordWaiting || IDE_KEYS.some(is) || isTabNumber(is, platform)) return 'page';
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
