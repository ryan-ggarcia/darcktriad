import { Injectable } from '@angular/core';
import type { Terminal } from '@xterm/xterm';

/** A tela de um terminal. Em produção é o xterm.js; nos testes, um falso em memória. */
export type TerminalScreen = Pick<
  Terminal,
  | 'cols'
  | 'rows'
  | 'buffer'
  | 'onData'
  | 'onResize'
  | 'attachCustomKeyEventHandler'
  | 'open'
  | 'write'
  | 'focus'
  | 'hasSelection'
  | 'getSelection'
  | 'paste'
  | 'scrollPages'
  | 'dispose'
> & {
  /** Ajusta colunas e linhas ao tamanho do elemento em que a tela foi aberta. */
  fit(): void;
};

/** O fundo é igual a --bg em styles.css. As cores ANSI mantêm o significado, mais legíveis nele. */
const TERMINAL_THEME = {
  background: '#0c0915',
  foreground: '#e2dcef',
  cursor: '#c4b5fd',
  cursorAccent: '#0c0915',
  selectionBackground: '#6d3fd080',
  scrollbarSliderBackground: '#7c5cc44d',
  scrollbarSliderHoverBackground: '#7c5cc480',
  scrollbarSliderActiveBackground: '#a78bfa99',
  black: '#2a2438',
  red: '#f47174',
  green: '#7ee2a8',
  yellow: '#e8c95d',
  blue: '#7aa7ff',
  magenta: '#c792ea',
  cyan: '#6fd3e0',
  white: '#e2dcef',
  brightBlack: '#8a7ea3',
  brightRed: '#ff9a9c',
  brightGreen: '#a5f0c5',
  brightYellow: '#f5de8a',
  brightBlue: '#a5c4ff',
  brightMagenta: '#ddb8f5',
  brightCyan: '#9ae6ef',
  brightWhite: '#ffffff',
};

export abstract class TerminalScreens {
  abstract create(): Promise<TerminalScreen>;
}

/** Carrega o xterm.js sob demanda, fora do pacote inicial, como o Monaco. */
@Injectable()
export class XtermScreens extends TerminalScreens {
  async create(): Promise<TerminalScreen> {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]);
    const terminal = new Terminal({
      scrollback: 10_000,
      fontSize: 14,
      fontFamily:
        "Menlo, Monaco, Consolas, 'Droid Sans Mono', 'Adwaita Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Ubuntu Mono', 'Courier New', monospace",
      theme: TERMINAL_THEME,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    return Object.assign(terminal, { fit: () => fitAddon.fit() });
  }
}
