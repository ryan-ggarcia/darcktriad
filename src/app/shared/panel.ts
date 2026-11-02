import { Injectable, signal } from '@angular/core';

export type PanelTab = 'problems' | 'output' | 'terminal';

/** O painel inferior: se aparece e qual aba mostra (Problemas, Saída ou Terminal). */
@Injectable({ providedIn: 'root' })
export class Panel {
  readonly visible = signal(false);
  readonly tab = signal<PanelTab>('terminal');
  /** O canal escolhido na Saída (CMake, dotnet, clangd, C#); nulo é o primeiro que houver. */
  readonly outputChannel = signal<string | null>(null);

  show(tab: PanelTab): void {
    this.tab.set(tab);
    this.visible.set(true);
  }

  /** Mostra a aba; se ela já está à mostra, esconde o painel. */
  toggle(tab: PanelTab): void {
    if (this.visible() && this.tab() === tab) this.visible.set(false);
    else this.show(tab);
  }

  showOutput(channel: string | null): void {
    if (channel) this.outputChannel.set(channel);
    this.show('output');
  }
}
