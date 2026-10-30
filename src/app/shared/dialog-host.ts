import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { Dialogs } from './dialogs';

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
      @if (dialogs.current(); as question) {
        <p id="dialog-message" class="dialog-message">{{ question.message }}</p>
        <p id="dialog-detail" class="dialog-detail">{{ question.detail }}</p>
        <div class="dialog-buttons">
          @for (button of question.buttons; track button) {
            <button type="button" [class.primary]="$first" (click)="answer(button)">
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
