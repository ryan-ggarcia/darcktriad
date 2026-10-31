import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { errorMessage, ToolCheck } from '../ipc';
import { ProjectService } from '../project.service';
import { Icon } from '../shared/icon';

/** O que aparece ao lado do nome: onde está e a versão, ou por que não serve. */
export function toolSummary({ status, minimum }: ToolCheck): string {
  if (status.kind === 'missing') return 'não encontrado';
  const where = `${status.path}${status.version ? ` (${status.version})` : ''}`;
  return status.kind === 'present' ? where : `versão antiga (mínimo ${minimum ?? '?'}): ${where}`;
}

/** Ferramentas: Verificar e instalar (docs/specs/projeto.md): uma linha por ferramenta. */
@Component({
  selector: 'app-tools-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <dialog #dialog class="dialog tools" aria-labelledby="tools-title">
      <header class="tools-header">
        <h2 id="tools-title" class="tools-title">Ferramentas</h2>
        <button
          type="button"
          title="Procurar as ferramentas de novo: PATH, caminhos conhecidos e a pasta de ferramentas da IDE"
          [disabled]="checking()"
          (click)="check()"
        >
          Verificar de novo
        </button>
        <button
          type="button"
          class="icon-button"
          aria-label="Fechar"
          title="Fechar (Esc)"
          autofocus
          (click)="dialog.close()"
        >
          <app-icon name="close" />
        </button>
      </header>
      <p class="tools-status" role="status">{{ checking() ? 'Verificando…' : '' }}</p>
      @if (error(); as error) {
        <p class="tools-error" role="alert">
          Não foi possível verificar as ferramentas. {{ error }}
        </p>
      }
      <ul class="tool-list" aria-label="Ferramentas">
        @for (tool of tools(); track tool.program) {
          @let ok = tool.status.kind === 'present';
          <li class="tool" [class.tool-bad]="!ok">
            <span class="tool-mark" aria-hidden="true">{{ ok ? '✓' : '✗' }}</span>
            <div class="tool-body">
              <p class="tool-line">
                <strong>{{ tool.program }}</strong>
                <span class="tool-summary">{{ summary(tool) }}</span>
              </p>
              @if (!ok) {
                <p class="tool-line">Para quê: {{ tool.purpose }}</p>
                <p class="tool-install">Como instalar: {{ tool.install }}</p>
              }
            </div>
          </li>
        }
      </ul>
    </dialog>
  `,
})
export class ToolsView {
  private readonly service = inject(ProjectService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  protected readonly tools = signal<ToolCheck[]>([]);
  protected readonly checking = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly summary = toolSummary;

  show(): void {
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) dialog.showModal();
    void this.check();
  }

  protected async check(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    this.error.set(null);
    try {
      this.tools.set(await this.service.checkTools());
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.checking.set(false);
    }
  }
}
