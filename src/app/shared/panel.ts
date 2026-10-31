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

  showOutput(channel: string | null): void {
    if (channel) this.outputChannel.set(channel);
    this.show('output');
  }
}
