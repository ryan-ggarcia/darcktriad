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
      theme: { background: '#181818', foreground: '#cccccc' },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    return Object.assign(terminal, { fit: () => fitAddon.fit() });
  }
}
