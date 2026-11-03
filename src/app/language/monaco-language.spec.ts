import type * as Monaco from 'monaco-editor';
import type { LspClient } from './lsp-client';
import { registerProviders, toSuggestion } from './monaco-language';

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

describe('formatação', () => {
  type Provider = (...args: unknown[]) => Promise<unknown>;
  const token = { isCancellationRequested: false, onCancellationRequested: () => undefined };
  const options = { tabSize: 2, insertSpaces: true };
  const model = {} as Monaco.editor.ITextModel;

  function setup(capabilities: LspClient['capabilities'], uri: string | null = 'file:///a.cpp') {
    const calls: { method: string; params: unknown }[] = [];
    const providers: Record<string, Provider> = {};
    const fake = {
      Range: FakeRange,
      languages: {
        registerDocumentFormattingEditProvider: (_: string[], item: Record<string, Provider>) => {
          providers['document'] = item['provideDocumentFormattingEdits'];
          return { dispose: () => undefined };
        },
        registerDocumentRangeFormattingEditProvider: (
          _: string[],
          item: Record<string, Provider>,
        ) => {
          providers['range'] = item['provideDocumentRangeFormattingEdits'];
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    const client = {
      capabilities,
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return [
          {
            range: { start: { line: 0, character: 1 }, end: { line: 2, character: 3 } },
            newText: 'x',
          },
        ];
      },
    } as unknown as LspClient;
    registerProviders(fake, client, 'cpp', () => uri);
    return { calls, providers };
  }

  it('só registra o que o servidor anuncia', () => {
    expect(Object.keys(setup({}).providers)).toEqual([]);
    expect(Object.keys(setup({ documentFormattingProvider: true }).providers)).toEqual([
      'document',
    ]);
  });

  it('documento: manda o arquivo e as opções do editor e devolve as edições no formato do Monaco', async () => {
    const { calls, providers } = setup({ documentFormattingProvider: true });

    const edits = await providers['document'](model, options, token);

    expect(calls).toEqual([
      {
        method: 'textDocument/formatting',
        params: { textDocument: { uri: 'file:///a.cpp' }, options },
      },
    ]);
    expect(edits).toEqual([{ range: new FakeRange(1, 2, 3, 4), text: 'x' }]);
  });

  it('seleção: o trecho vai contado do zero, como o LSP pede', async () => {
    const { calls, providers } = setup({ documentRangeFormattingProvider: true });

    await providers['range'](model, new FakeRange(2, 3, 4, 5), options, token);

    expect(calls[0].method).toBe('textDocument/rangeFormatting');
    expect((calls[0].params as { range: unknown }).range).toEqual({
      start: { line: 1, character: 2 },
      end: { line: 3, character: 4 },
    });
  });

  it('arquivo fora do servidor: não pede nada', async () => {
    const { calls, providers } = setup({ documentFormattingProvider: true }, null);

    expect(await providers['document'](model, options, token)).toBeNull();
    expect(calls).toEqual([]);
  });
});

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
