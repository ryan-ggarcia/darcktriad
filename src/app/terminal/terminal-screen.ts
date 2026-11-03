import { effect, inject, Injectable, Injector } from '@angular/core';
import type { ITheme, Terminal } from '@xterm/xterm';
import { Appearance, CODE_FONT, Theme } from '../shared/appearance';

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

/**
 * O fundo é transparente: quem pinta é o painel (styles.css), opaco no modo sólido e translúcido no
 * vidro. As cores ANSI mantêm o significado e ficam legíveis no fundo de cada tema.
 */
const TERMINAL_THEMES: Record<Theme, ITheme> = {
  dark: {
    background: '#00000000',
    foreground: '#F5F3FF',
    cursor: '#A855FF',
    cursorAccent: '#0D0919',
    selectionBackground: '#7825F566',
    scrollbarSliderBackground: '#A855FF33',
    scrollbarSliderHoverBackground: '#A855FF59',
    scrollbarSliderActiveBackground: '#A855FF80',
    black: '#2a2438',
    red: '#f47174',
    green: '#7ee2a8',
    yellow: '#e8c95d',
    blue: '#7aa7ff',
    magenta: '#c792ea',
    cyan: '#6fd3e0',
    white: '#e2dcef',
    brightBlack: '#8f83b0',
    brightRed: '#ff9a9c',
    brightGreen: '#a5f0c5',
    brightYellow: '#f5de8a',
    brightBlue: '#a5c4ff',
    brightMagenta: '#ddb8f5',
    brightCyan: '#9ae6ef',
    brightWhite: '#ffffff',
  },
  light: {
    background: '#00000000',
    foreground: '#1B1433',
    cursor: '#7825F5',
    cursorAccent: '#FFFFFF',
    selectionBackground: '#7825F533',
    scrollbarSliderBackground: '#7825F533',
    scrollbarSliderHoverBackground: '#7825F559',
    scrollbarSliderActiveBackground: '#7825F580',
    black: '#1B1433',
    red: '#C4262B',
    green: '#18794E',
    yellow: '#8A5A00',
    blue: '#1F5FCF',
    magenta: '#8E2DB8',
    cyan: '#0E6E86',
    white: '#5A4E78',
    brightBlack: '#6F6491',
    brightRed: '#B3141A',
    brightGreen: '#126B43',
    brightYellow: '#7A4F00',
    brightBlue: '#1A52B5',
    brightMagenta: '#7B21A3',
    brightCyan: '#0B5F74',
    brightWhite: '#3E355C',
  },
};

export abstract class TerminalScreens {
  abstract create(): Promise<TerminalScreen>;
}

/** Carrega o xterm.js sob demanda, fora do pacote inicial, como o Monaco. */
@Injectable()
export class XtermScreens extends TerminalScreens {
  private readonly appearance = inject(Appearance);
  private readonly injector = inject(Injector);

  async create(): Promise<TerminalScreen> {
    // O xterm mede a largura da letra ao abrir: com a fonte ainda carregando, as colunas saem erradas.
    await document.fonts?.load(`14px ${CODE_FONT}`).catch(() => undefined);
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]);
    const terminal = new Terminal({
      scrollback: 10_000,
      fontSize: 14,
      fontFamily: `${CODE_FONT}, Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace`,
      allowTransparency: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    const theme = effect(
      () => (terminal.options.theme = TERMINAL_THEMES[this.appearance.theme()]),
      {
        injector: this.injector,
      },
    );
    const dispose = terminal.dispose.bind(terminal);
    return Object.assign(terminal, {
      fit: () => fitAddon.fit(),
      dispose: () => {
        theme.destroy();
        dispose();
      },
    });
  }
}
