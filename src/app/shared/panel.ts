import { Injectable, signal } from '@angular/core';

/** `debug` é o canal Depuração da Saída, com aba própria. */
export type PanelTab = 'problems' | 'output' | 'terminal' | 'debug';

/** O painel inferior: se aparece, qual aba mostra e se ocupa a área dos editores. */
@Injectable({ providedIn: 'root' })
export class Panel {
  readonly visible = signal(false);
  readonly tab = signal<PanelTab>('terminal');
  /** Expandido: o painel cobre os editores até ser recolhido. */
  readonly maximized = signal(false);
  /** O canal escolhido na Saída (CMake, dotnet, clangd, C#); nulo é o primeiro que houver. */
  readonly outputChannel = signal<string | null>(null);
  /** Sobe a cada pedido: o painel leva o foco para a aba à mostra. */
  readonly focusRequest = signal(0);

  show(tab: PanelTab): void {
    this.tab.set(tab);
    this.visible.set(true);
  }

  /** O atalho de uma aba: mostra e leva o foco até ela; com o foco já lá, esconde o painel. */
  toggle(tab: PanelTab): void {
    if (this.holdsFocus(tab)) {
      this.visible.set(false);
    } else {
      this.show(tab);
      this.requestFocus();
    }
  }

  /** A aba está à mostra e o foco não está em outra parte da janela. */
  holdsFocus(tab: PanelTab): boolean {
    const focused = document.activeElement;
    const elsewhere =
      focused && focused !== document.body && !document.querySelector('.panel')?.contains(focused);
    return this.visible() && this.tab() === tab && !elsewhere;
  }

  requestFocus(): void {
    this.focusRequest.update((count) => count + 1);
  }

  showOutput(channel: string | null): void {
    if (channel) this.outputChannel.set(channel);
    this.show('output');
  }
}
