import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Commands } from '../shared/commands';
import { Panel } from '../shared/panel';
import { Project } from './project';

/** A parte esquerda da barra de status: tipo do projeto, configuração e alvo (docs/specs/projeto.md). */
@Component({
  selector: 'app-project-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'status-project' },
  template: `
    @let state = project.state();
    @if (state.root) {
      @if (project.channel()) {
        <span role="status">
          <button
            type="button"
            class="status-item"
            [class.status-error]="state.status.kind === 'failed'"
            [title]="kindHint()"
            (click)="panel.showOutput(project.channel())"
          >
            {{ kindLabel() }}
          </button>
        </span>
        @if (state.config) {
          <span class="status-separator" aria-hidden="true">·</span>
          <button
            type="button"
            class="status-item status-pick"
            [attr.aria-label]="'Configuração: ' + state.config"
            [title]="'Configuração ativa: ' + state.config + '. Clique para trocar.'"
            (click)="commands.run('selectConfig')"
          >
            {{ state.config }}
          </button>
        }
        @if (state.target) {
          <span class="status-separator" aria-hidden="true">·</span>
          <button
            type="button"
            class="status-item status-pick"
            [attr.aria-label]="'Alvo: ' + state.target"
            [title]="'Programa que vai rodar: ' + state.target + '. Clique para trocar.'"
            (click)="commands.run('selectTarget')"
          >
            ▶ {{ state.target }}
          </button>
        }
      } @else {
        <span
          class="status-item"
          title="Para compilar, a pasta precisa de um CMakeLists.txt (C/C++) ou de um .csproj (C#)."
        >
          Sem projeto (só edição)
        </span>
      }
    }
  `,
})
export class ProjectStatus {
  protected readonly project = inject(Project);
  protected readonly commands = inject(Commands);
  protected readonly panel = inject(Panel);

  private readonly kind = computed(() => (this.project.channel() === 'dotnet' ? '.NET' : 'CMake'));

  protected readonly kindLabel = computed(() => {
    const status = this.project.state().status.kind;
    if (status === 'configuring') return `${this.kind()}: configurando…`;
    return status === 'failed' ? `${this.kind()}: erro (ver Saída)` : this.kind();
  });

  protected readonly kindHint = computed(() => {
    const status = this.project.state().status;
    const show = `Clique para ver a saída no canal ${this.project.channel()}.`;
    return status.kind === 'failed'
      ? `${status.message} ${show}`
      : `Projeto ${this.kind()}. ${show}`;
  });
}
