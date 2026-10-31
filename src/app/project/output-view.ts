import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { Panel } from '../shared/panel';
import { OutputChannels } from './output-channels';

/** A aba Saída, no canal escolhido (CMake, dotnet, clangd, C#): a saída ao vivo, que rola sozinha enquanto o usuário está no fim. */
@Component({
  selector: 'app-output-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'output-view' },
  template: `
    @if (text()) {
      <pre
        #log
        class="output-log"
        tabindex="0"
        [attr.aria-label]="'Saída: canal ' + output.current()"
        (scroll)="onScroll(log)"
        >{{ text() }}</pre>
    } @else {
      <p class="panel-empty">
        Nada na Saída ainda. A saída aparece quando o projeto (CMake ou .NET) configura ou um
        servidor de linguagem (clangd, C#) inicia.
      </p>
    }
  `,
})
export class OutputView {
  protected readonly output = inject(OutputChannels);
  private readonly panel = inject(Panel);
  private readonly log = viewChild<ElementRef<HTMLElement>>('log');
  protected readonly text = computed(() => this.output.lines().join('\n'));
  private following = true;

  constructor() {
    afterRenderEffect(() => {
      this.text();
      const log = this.log()?.nativeElement;
      if (log && this.panel.visible() && this.panel.tab() === 'output' && this.following) {
        log.scrollTop = log.scrollHeight;
      }
    });
  }

  protected onScroll(log: HTMLElement): void {
    this.following = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  }
}
