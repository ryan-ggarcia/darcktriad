import { Injectable, signal } from '@angular/core';
import { Path } from '../ipc';

/** A pasta aberta na janela. Quem a troca é o `Workspace`; abas e árvore só leem. */
@Injectable({ providedIn: 'root' })
export class CurrentFolder {
  readonly path = signal<Path | null>(null);
  /** Não nulo: o núcleo não conseguiu observar a pasta (docs/ipc.md, `open_folder`). */
  readonly watchError = signal<string | null>(null);
}
