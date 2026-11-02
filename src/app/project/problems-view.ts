import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { EditorTabs } from '../editor/editor-tabs';
import { Path } from '../ipc';
import { Panel } from '../shared/panel';
import { MarkerSeverity } from '../language/lsp';
import { basename, dirname, isWithin, relativeTo } from '../paths';
import { CurrentFolder } from '../workspace/current-folder';
import { ProblemItem, Problems } from './problems';
import { BUILD_CHANNEL } from './project';

const SEVERITIES: Record<number, { icon: string; name: string; css: string }> = {
  [MarkerSeverity.Error]: { icon: '⊗', name: 'Erro', css: 'severity-error' },
  [MarkerSeverity.Warning]: { icon: '⚠', name: 'Aviso', css: 'severity-warning' },
  [MarkerSeverity.Info]: { icon: 'ⓘ', name: 'Informação', css: 'severity-info' },
};

/**
 * A aba Problemas: erros e avisos de todas as fontes (servidores de linguagem, CMake/dotnet),
 * agrupados por arquivo; clicar leva à linha e à coluna.
 */
@Component({
  selector: 'app-problems-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'problems-view' },
  template: `
    @if (problems.groups().length) {
      <ul class="problem-list" aria-label="Problemas">
        @for (group of problems.groups(); track group.file) {
          <li class="problem-group">
            <div class="problem-file" [title]="group.file ?? 'Compilação'">
              <span class="problem-file-name">{{ name(group.file) }}</span>
              <span class="problem-dir">{{ folderOf(group.file) }}</span>
              <span class="panel-badge" [attr.aria-label]="group.items.length + ' problemas'">{{
                group.items.length
              }}</span>
            </div>
            <ul class="problem-items">
              @for (item of group.items; track $index) {
                @let severity = severityOf(item);
                <li>
                  <button
                    type="button"
                    class="problem"
                    [attr.aria-label]="describe(item)"
                    [title]="titleOf(item)"
                    (click)="open(item)"
                  >
                    <span class="problem-mark" [class]="severity.css" aria-hidden="true">{{
                      severity.icon
                    }}</span>
                    <span class="problem-message">{{ item.message }}</span>
                    <span class="problem-source">{{ sourceOf(item) }}</span>
                    <span class="problem-location">{{ locationOf(item) }}</span>
                  </button>
                </li>
              }
            </ul>
          </li>
        }
      </ul>
    } @else {
      <p class="panel-empty">Nenhum problema encontrado.</p>
    }
  `,
})
export class ProblemsView {
  protected readonly problems = inject(Problems);
  private readonly tabs = inject(EditorTabs);
  private readonly folder = inject(CurrentFolder);
  private readonly panel = inject(Panel);

  /** Sem arquivo, o item de reserva da compilação ("Veja a Saída"). */
  protected name(file: Path | null): string {
    return file ? basename(file) : 'Compilação';
  }

  /** A pasta do arquivo, relativa à pasta aberta quando está dentro dela. */
  protected folderOf(file: Path | null): string {
    if (!file) return '';
    const root = this.folder.path();
    const dir = dirname(file);
    if (!root || !isWithin(file, root)) return dir;
    return dir === root ? '' : relativeTo(dir, root);
  }

  protected severityOf(item: ProblemItem) {
    return SEVERITIES[item.severity] ?? SEVERITIES[MarkerSeverity.Info];
  }

  protected sourceOf({ source, code }: ProblemItem): string {
    return code ? `${source}(${code})` : source;
  }

  protected locationOf(item: ProblemItem): string {
    return item.file ? `${item.startLineNumber}:${item.startColumn}` : '';
  }

  protected titleOf({ file, startLineNumber }: ProblemItem): string {
    return file
      ? `Abrir ${file} na linha ${startLineNumber}`
      : `Ver a saída da compilação (canal ${BUILD_CHANNEL})`;
  }

  protected describe(item: ProblemItem): string {
    const where = item.file ? `, linha ${item.startLineNumber}, coluna ${item.startColumn}` : '';
    return `${this.severityOf(item).name}: ${item.message}. ${this.sourceOf(item)}${where}`;
  }

  protected async open(item: ProblemItem): Promise<void> {
    if (!item.file) return this.panel.showOutput(BUILD_CHANNEL);
    await this.tabs.openAt(item.file, { line: item.startLineNumber, column: item.startColumn });
  }
}
