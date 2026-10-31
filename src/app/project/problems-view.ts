import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { EditorTabs } from '../editor/editor-tabs';
import { Problem } from '../ipc';
import { isWithin, relativeTo } from '../paths';
import { Project } from './project';

/** A aba Problemas: os erros da configuração do projeto (CMake ou .NET); clicar leva à linha. */
@Component({
  selector: 'app-problems-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'problems-view' },
  template: `
    @let problems = project.state().problems;
    @if (problems.length) {
      <ul class="problem-list" aria-label="Problemas">
        @for (problem of problems; track problem) {
          @let location = locationOf(problem);
          <li>
            <button
              type="button"
              class="problem"
              [title]="'Abrir ' + problem.file + ' na linha ' + problem.line"
              (click)="open(problem)"
            >
              <span class="problem-mark" aria-hidden="true">✗</span>
              <span class="problem-location">{{ location }}</span>
              <span class="problem-message">{{ problem.message }}</span>
            </button>
          </li>
        }
      </ul>
    } @else {
      <p class="panel-empty">Nenhum problema encontrado.</p>
    }
  `,
})
export class ProblemsView {
  protected readonly project = inject(Project);
  private readonly tabs = inject(EditorTabs);

  protected locationOf({ file, line }: Problem): string {
    const root = this.project.state().root;
    return `${root && isWithin(file, root) ? relativeTo(file, root) : file}:${line}`;
  }

  protected async open({ file, line }: Problem): Promise<void> {
    const tab = await this.tabs.open(file);
    if (tab?.view.kind === 'text') this.tabs.goTo.set({ line, column: 1 });
  }
}
