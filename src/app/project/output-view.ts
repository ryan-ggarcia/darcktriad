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
import { Project } from './project';

/** A aba Saída, no canal do projeto (CMake ou dotnet): a saída ao vivo, que rola sozinha enquanto o usuário está no fim. */
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
        [attr.aria-label]="'Saída: canal ' + project.channel()"
        (scroll)="onScroll(log)"
        >{{ text() }}</pre>
    } @else {
      <p class="panel-empty">
        Nada na Saída ainda. A saída aparece quando o projeto (CMake ou .NET) configura.
      </p>
    }
  `,
})
export class OutputView {
  protected readonly project = inject(Project);
  private readonly panel = inject(Panel);
  private readonly log = viewChild<ElementRef<HTMLElement>>('log');
  protected readonly text = computed(() => this.project.output().join('\n'));
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
