import { Injectable } from '@angular/core';
import type * as Monaco from 'monaco-editor';
import { Eol } from '../ipc';
import { TextChange } from '../language/lsp';
import { loadMonaco } from './monaco-loader';
import { TextBuffer, TextBuffers } from './text-buffer';

export class MonacoBuffer implements TextBuffer {
  constructor(
    private readonly monaco: typeof Monaco,
    readonly model: Monaco.editor.ITextModel,
  ) {}

  getText(): string {
    return this.model.getValue();
  }

  setText(text: string): void {
    const editors = this.monaco.editor.getEditors().filter((e) => e.getModel() === this.model);
    const states = editors.map((editor) => editor.saveViewState());
    // Como edição (e não setValue), para o Ctrl+Z voltar ao texto anterior à recarga.
    this.model.pushStackElement();
    this.model.pushEditOperations(
      [],
      [{ range: this.model.getFullModelRange(), text }],
      () => null,
    );
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
