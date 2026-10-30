import { computed, signal, WritableSignal } from '@angular/core';
import { Eol, Path } from '../ipc';
import { basename, languageOf } from '../paths';
import { TextBuffer } from './text-buffer';

/** O que a aba mostra: texto no editor, ou só um aviso (binário, grande demais). */
export type TabView =
  | { kind: 'text'; buffer: TextBuffer; readOnly: boolean }
  | { kind: 'binary' }
  | { kind: 'tooLarge'; size: number };

/** Uma aba aberta. `path` nulo é um arquivo sem título (Ctrl+N). */
export class Tab {
  readonly path: WritableSignal<Path | null>;
  readonly name = computed(() => {
    const path = this.path();
    return path ? basename(path) : this.untitledName;
  });
  readonly language = computed(() => languageOf(this.path()));
  readonly dirty = signal(false);
  /** O arquivo sumiu do disco; o texto continua na aba, e salvar o recria. */
  readonly deleted = signal(false);
  /** O disco mudou enquanto a aba tinha alterações: a faixa pede uma escolha. */
  readonly changedOnDisk = signal(false);
  readonly eol: WritableSignal<Eol>;
  /** `version` da última leitura ou gravação; nula em arquivo sem título. */
  version: string | null = null;
  bom = false;
  /** `versionId` do texto que está no disco. */
  savedVersionId = 0;
  /** Fila de gravações: o núcleo recusa duas gravações paralelas do mesmo arquivo. */
  saving: Promise<unknown> = Promise.resolve();

  constructor(
    path: Path | null,
    readonly untitledName: string,
    readonly view: TabView,
    eol: Eol,
  ) {
    this.path = signal(path);
    this.eol = signal(eol);
  }

  get buffer(): TextBuffer | null {
    return this.view.kind === 'text' ? this.view.buffer : null;
  }

  refreshDirty(): void {
    const buffer = this.buffer;
    this.dirty.set(buffer !== null && buffer.versionId() !== this.savedVersionId);
  }
}
