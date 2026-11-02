import { Injectable } from '@angular/core';
import type * as Monaco from 'monaco-editor';
import { Eol } from '../ipc';
import { TextChange } from '../language/lsp';
import { loadMonaco } from './monaco-loader';
import { TextBuffer, TextBuffers } from './text-buffer';

/**
 * O trecho de `old` (de `start` até `end`) a trocar por `text` para virar `next`: tira o começo e o
 * fim iguais, sem cortar um `\r\n` nem um caractere de dois códigos. `null`: textos iguais.
 */
export function changedPart(
  old: string,
  next: string,
): { start: number; end: number; text: string } | null {
  if (old === next) return null;
  const max = Math.min(old.length, next.length);
  let start = 0;
  while (start < max && old[start] === next[start]) start++;
  if (start > 0 && splits(old, start)) start--;
  let tail = 0;
  while (tail < max - start && old.at(-1 - tail) === next.at(-1 - tail)) tail++;
  if (tail > 0 && splits(old, old.length - tail)) tail--;
  return { start, end: old.length - tail, text: next.slice(start, next.length - tail) };
}

/** Cortar `text` em `at` separaria um `\r\n` ou um par de códigos (ex.: emoji). */
function splits(text: string, at: number): boolean {
  const code = text.charCodeAt(at - 1);
  return (text[at - 1] === '\r' && text[at] === '\n') || (code >= 0xd800 && code <= 0xdbff);
}

export class MonacoBuffer implements TextBuffer {
  constructor(
    private readonly monaco: typeof Monaco,
    readonly model: Monaco.editor.ITextModel,
  ) {}

  getText(): string {
    return this.model.getValue();
  }

  setText(text: string): void {
    const edit = changedPart(this.model.getValue(), text.replace(/\r\n?|\n/g, this.model.getEOL()));
    if (!edit) return;
    const editors = this.monaco.editor.getEditors().filter((e) => e.getModel() === this.model);
    const states = editors.map((editor) => editor.saveViewState());
    const range = this.monaco.Range.fromPositions(
      this.model.getPositionAt(edit.start),
      this.model.getPositionAt(edit.end),
    );
    // Como edição (e não setValue), para o Ctrl+Z voltar ao texto anterior à recarga. Só o trecho
    // que mudou, como o VS Code: as decorações (pontos de parada) de fora seguem o texto.
    this.model.pushStackElement();
    this.model.pushEditOperations([], [{ range, text: edit.text }], () => null);
    this.model.pushStackElement();
    editors.forEach((editor, index) => editor.restoreViewState(states[index]));
  }

  setEol(eol: Eol): void {
    const { EndOfLineSequence } = this.monaco.editor;
    this.model.setEOL(eol === 'crlf' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF);
  }

  setLanguage(language: string): void {
    this.monaco.editor.setModelLanguage(this.model, language);
  }

  versionId(): number {
    return this.model.getAlternativeVersionId();
  }

  onEdit(listener: (changes: TextChange[]) => void): () => void {
    const subscription = this.model.onDidChangeContent(({ changes }) =>
      listener(
        changes.map(({ range, text }) => ({
          range: {
            start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
            end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
          },
          text,
        })),
      ),
    );
    return () => subscription.dispose();
  }

  dispose(): void {
    this.model.dispose();
  }
}

@Injectable()
export class MonacoBuffers extends TextBuffers {
  async create(text: string, eol: Eol, language: string, onChange: () => void) {
    const monaco = await loadMonaco();
    const buffer = new MonacoBuffer(monaco, monaco.editor.createModel(text, language));
    buffer.setEol(eol);
    buffer.model.onDidChangeContent(onChange);
    return buffer;
  }
}
