import type * as Monaco from 'monaco-editor';
import { toSuggestion } from './monaco-language';

class FakeRange {
  constructor(
    readonly startLineNumber: number,
    readonly startColumn: number,
    readonly endLineNumber: number,
    readonly endColumn: number,
  ) {}
}

const monaco = {
  Range: FakeRange,
  languages: { CompletionItemKind: {}, CompletionItemInsertTextRule: {} },
} as unknown as typeof Monaco;

describe('toSuggestion', () => {
  // Linha `  std::str|`: "str" vai da coluna 8 até o cursor na 11.
  const line = '  std::str';
  const position = { lineNumber: 1, column: 11 };
  const model = {
    getValueInRange: (r: Monaco.IRange) => line.slice(r.startColumn - 1, r.endColumn - 1),
  };
  const lsp = { line: 0, character: 7 };
  const textEdit = (newText: string) => ({
    newText,
    range: { start: lsp, end: { line: 0, character: 10 } },
  });
  const items = [
    {
      label: 'string_literals',
      sortText: '42',
      filterText: 'string_literals',
      textEdit: textEdit('string_literals'),
    },
    { label: 'string', sortText: '07', filterText: 'string', textEdit: textEdit('string') },
  ];
  const wordRange = new FakeRange(1, 8, 1, 11);

  it('clangd: filterText = texto digitado, e a ordem fica com o sortText do servidor', () => {
    const suggestions = items.map((item) =>
      toSuggestion(monaco, item, wordRange, { model, position }),
    );
    expect(suggestions.map((s) => s.filterText)).toEqual(['str', 'str']);
    // Com a pontuação empatada, o Monaco desempata pelo sortText.
    const sorted = [...suggestions].sort((a, b) => a.sortText!.localeCompare(b.sortText!));
    expect(sorted.map((s) => s.label)).toEqual(['string', 'string_literals']);
  });

  it('clangd com insert/replace: usa o início do replace', () => {
    const item = {
      label: 'string',
      textEdit: {
        newText: 'string',
        insert: { start: lsp, end: { line: 0, character: 10 } },
        replace: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
      },
    };
    expect(toSuggestion(monaco, item, wordRange, { model, position }).filterText).toBe(':str');
  });

  it('Roslyn: mantém o filterText do servidor', () => {
    expect(items.map((item) => toSuggestion(monaco, item, wordRange).filterText)).toEqual([
      'string_literals',
      'string',
    ]);
  });
});
