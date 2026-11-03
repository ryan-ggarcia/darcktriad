import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  linkedSignal,
  viewChild,
} from '@angular/core';
import { Dialogs, Question } from './dialogs';

/** Mostra a pergunta atual de `Dialogs` num `<dialog>` modal (foco preso e Esc nativos). */
@Component({
  selector: 'app-dialog-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      class="dialog"
      aria-labelledby="dialog-message"
      aria-describedby="dialog-detail"
      (cancel)="$event.preventDefault(); answer(null)"
    >
      @if (shown(); as question) {
        <p id="dialog-message" class="dialog-message">{{ question.message }}</p>
        <p id="dialog-detail" class="dialog-detail">{{ question.detail }}</p>
        <div class="dialog-buttons">
          @for (button of question.buttons; track button) {
            <button
              type="button"
              [class.primary]="$first"
              [title]="button"
              (click)="answer(button)"
            >
              {{ button }}
            </button>
          }
        </div>
      }
    </dialog>
  `,
})
export class DialogHost {
  protected readonly dialogs = inject(Dialogs);
  /** A última pergunta continua no diálogo enquanto ele some (styles.css): sem ela, a caixa encolhe. */
  protected readonly shown = linkedSignal<Question | null, Question | null>({
    source: () => this.dialogs.current(),
    computation: (question, previous) => question ?? previous?.value ?? null,
  });
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    afterRenderEffect(() => {
      const dialog = this.dialog().nativeElement;
      if (!this.dialogs.current()) {
        if (dialog.open) dialog.close();
        return;
      }
      if (!dialog.open) dialog.showModal();
      dialog.querySelector('button')?.focus();
    });
  }

  protected answer(button: string | null): void {
    this.dialogs.current()?.answer(button);
  }
}
