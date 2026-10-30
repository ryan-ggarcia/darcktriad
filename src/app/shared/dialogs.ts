import { computed, Injectable, signal } from '@angular/core';

export interface Question {
  message: string;
  detail: string;
  buttons: string[];
  answer(button: string | null): void;
}

/** Perguntas modais (salvar, sobrescrever, excluir). Uma por vez, na ordem em que chegam. */
@Injectable({ providedIn: 'root' })
export class Dialogs {
  private readonly queue = signal<Question[]>([]);
  readonly current = computed<Question | null>(() => this.queue()[0] ?? null);

  /** Resolve com o rótulo do botão escolhido, ou `null` se o usuário fechou com Esc. */
  ask(message: string, buttons: string[], detail = ''): Promise<string | null> {
    return new Promise((resolve) => {
      const question: Question = {
        message,
        detail,
        buttons,
        answer: (button) => {
          this.queue.update((queue) => queue.filter((item) => item !== question));
          resolve(button);
        },
      };
      this.queue.update((queue) => [...queue, question]);
    });
  }

  async tell(message: string, detail = ''): Promise<void> {
    await this.ask(message, ['OK'], detail);
  }
}
