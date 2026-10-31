import { Eol } from '../ipc';
import { TextChange } from '../language/lsp';

/** O texto de uma aba. Em produção é um modelo do Monaco; nos testes, um falso em memória. */
export interface TextBuffer {
  getText(): string;
  /** Troca todo o texto (recarregar do disco), mantendo cursor e rolagem quando possível. */
  setText(text: string): void;
  setEol(eol: Eol): void;
  setLanguage(language: string): void;
  /** Muda a cada edição e volta ao valor anterior quando a edição é desfeita. */
  versionId(): number;
  /** Cada edição, com os trechos no formato do LSP (base 0, no texto de antes). */
  onEdit(listener: (changes: TextChange[]) => void): () => void;
  dispose(): void;
}

export abstract class TextBuffers {
  /** `onChange` é chamado a cada edição, depois da criação. */
  abstract create(
    text: string,
    eol: Eol,
    language: string,
    onChange: () => void,
  ): Promise<TextBuffer>;
}
