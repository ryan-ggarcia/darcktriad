import { Injectable } from '@angular/core';
import type * as Monaco from 'monaco-editor';
import { Eol } from '../ipc';
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
