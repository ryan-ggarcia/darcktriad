import { effect, Injector, untracked } from '@angular/core';
import type * as Monaco from 'monaco-editor';
import { EditorTabs } from '../editor/editor-tabs';
import { MonacoBuffer } from '../editor/monaco-buffers';
import { Language } from '../ipc';
import { Problems } from '../project/problems';
import { Languages, LANGUAGES } from './languages';
import { LspClient } from './lsp-client';
import { Range } from './lsp';

type MonacoApi = typeof Monaco;
let connected = false;
type Model = Monaco.editor.ITextModel;

/** As linguagens do Monaco atendidas por cada servidor. */
const MONACO_IDS: Record<Language, string[]> = { cpp: ['c', 'cpp'], csharp: ['csharp'] };

/** `CompletionItemKind` do LSP (1 = Text…), na ordem, com os nomes do enum do Monaco. */
const KINDS = [
  'Text',
  'Method',
  'Function',
  'Constructor',
  'Field',
  'Variable',
  'Class',
  'Interface',
  'Module',
  'Property',
  'Unit',
  'Value',
  'Enum',
  'Keyword',
  'Snippet',
  'Color',
  'File',
  'Reference',
  'Folder',
  'EnumMember',
  'Constant',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter',
] as const;

type Markup = string | { kind?: string; language?: string; value: string };

interface CompletionItem {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  detail?: string;
  documentation?: Markup;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: { newText: string; range?: Range; insert?: Range; replace?: Range };
  additionalTextEdits?: { range: Range; newText: string }[];
  commitCharacters?: string[];
}

/** A sugestão do Monaco guarda o item do LSP para o `completionItem/resolve`. */
type Suggestion = Monaco.languages.CompletionItem & { lsp: CompletionItem };

/**
 * Liga os servidores ao Monaco, uma vez por janela: autocomplete, dicas de parâmetros, hover
 * e os marcadores dos Problemas nas abas. F12 e Ctrl+clique são do `Languages`.
 */
export function connectMonaco(monaco: MonacoApi, injector: Injector): void {
  if (connected) return;
  connected = true;
  const languages = injector.get(Languages);
  const tabs = injector.get(EditorTabs);
  const problems = injector.get(Problems);

  const uriOf = (model: Model) => {
    const tab = tabs.tabs().find((item) => (item.buffer as MonacoBuffer | null)?.model === model);
    return tab ? (languages.documentOf(tab)?.uri ?? null) : null;
  };

  // Os marcadores saem dos Problemas: um build ou o CMake também sublinham.
  effect(
    () => {
      const items = problems.items();
      for (const tab of tabs.tabs()) {
        const buffer = tab.buffer;
        if (!(buffer instanceof MonacoBuffer) || buffer.model.isDisposed()) continue;
        const markers = items.filter((item) => item.file === tab.path());
        monaco.editor.setModelMarkers(buffer.model, 'problems', markers);
      }
    },
    { injector },
  );

  // Cada processo novo anuncia os próprios gatilhos: os provedores são refeitos com ele.
  for (const language of LANGUAGES) {
    effect(
      (onCleanup) => {
        const client = languages.client(language);
        if (!client) return;
        const registered = untracked(() => registerProviders(monaco, client, language, uriOf));
        onCleanup(() => registered.forEach((item) => item.dispose()));
      },
      { injector },
    );
  }
}

/** Os provedores de um processo do servidor, com os caracteres de gatilho que ele anunciou. */
function registerProviders(
  monaco: MonacoApi,
  client: LspClient,
  language: Language,
  uriOf: (model: Model) => string | null,
): Monaco.IDisposable[] {
  const ids = MONACO_IDS[language];
  const { completionProvider, signatureHelpProvider, hoverProvider } = client.capabilities;
  const at = (model: Model, position: Monaco.Position) => {
    const uri = uriOf(model);
    return (
      uri && {
        textDocument: { uri },
        position: { line: position.lineNumber - 1, character: position.column - 1 },
      }
    );
  };
  const disposables: Monaco.IDisposable[] = [];

  if (completionProvider) {
    disposables.push(
      monaco.languages.registerCompletionItemProvider(ids, {
        triggerCharacters: completionProvider.triggerCharacters,
        async provideCompletionItems(model, position, context, token) {
          const params = at(model, position);
          if (!params) return null;
          const result = await client.request<
            CompletionItem[] | { isIncomplete?: boolean; items: CompletionItem[] }
          >(
            'textDocument/completion',
            {
              ...params,
              // O Monaco conta de 0 (Invoke); o LSP, de 1 (Invoked).
              context: {
                triggerKind: context.triggerKind + 1,
                triggerCharacter: context.triggerCharacter,
              },
            },
            abortOn(token),
          );
          if (!result) return null;
          const word = model.getWordUntilPosition(position);
          const range = new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          );
          const items = Array.isArray(result) ? result : result.items;
          return {
            incomplete: !Array.isArray(result) && !!result.isIncomplete,
            suggestions: items.map((item) =>
              toSuggestion(
                monaco,
                item,
                range,
                language === 'cpp' ? { model, position } : undefined,
              ),
            ),
          };
        },
        resolveCompletionItem: completionProvider.resolveProvider
          ? async (suggestion, token) => {
              const { lsp } = suggestion as Suggestion;
              const resolved = await client.request<CompletionItem>(
                'completionItem/resolve',
                lsp,
                abortOn(token),
              );
              if (!resolved) return suggestion;
              return {
                ...suggestion,
                detail: resolved.detail ?? suggestion.detail,
                documentation: markdown(resolved.documentation) ?? suggestion.documentation,
              };
            }
          : undefined,
      }),
    );
  }

  if (signatureHelpProvider) {
    disposables.push(
      monaco.languages.registerSignatureHelpProvider(ids, {
        signatureHelpTriggerCharacters: signatureHelpProvider.triggerCharacters,
        signatureHelpRetriggerCharacters: signatureHelpProvider.retriggerCharacters,
        async provideSignatureHelp(model, position, token, context) {
          const params = at(model, position);
          if (!params) return null;
          // `SignatureHelpTriggerKind` tem os mesmos números no Monaco e no LSP.
          const help = await client.request<SignatureHelp>(
            'textDocument/signatureHelp',
            {
              ...params,
              context: {
                triggerKind: context.triggerKind,
                triggerCharacter: context.triggerCharacter,
                isRetrigger: context.isRetrigger,
                activeSignatureHelp: context.activeSignatureHelp,
              },
            },
            abortOn(token),
          );
          if (!help?.signatures.length) return null;
          return {
            value: {
              activeSignature: help.activeSignature ?? 0,
              activeParameter: help.activeParameter ?? 0,
              signatures: help.signatures.map((signature) => ({
                label: signature.label,
                documentation: markdown(signature.documentation),
                activeParameter: signature.activeParameter,
                parameters: (signature.parameters ?? []).map((parameter) => ({
                  label: parameter.label,
                  documentation: markdown(parameter.documentation),
                })),
              })),
            },
            dispose: () => undefined,
          };
        },
      }),
    );
  }

  if (hoverProvider) {
    disposables.push(
      monaco.languages.registerHoverProvider(ids, {
        async provideHover(model, position, token) {
          const params = at(model, position);
          if (!params) return null;
          const hover = await client.request<{ contents: Markup | Markup[]; range?: Range }>(
            'textDocument/hover',
            params,
            abortOn(token),
          );
          if (!hover) return null;
          const contents = (Array.isArray(hover.contents) ? hover.contents : [hover.contents])
            .map(markdown)
            .filter((item) => item !== undefined && item.value !== '');
          return contents.length
            ? {
                contents: contents as Monaco.IMarkdownString[],
                range: hover.range && toRange(monaco, hover.range),
              }
            : null;
        },
      }),
    );
  }
  return disposables;
}

interface SignatureHelp {
  signatures: {
    label: string;
    documentation?: Markup;
    activeParameter?: number;
    parameters?: { label: string | [number, number]; documentation?: Markup }[];
  }[];
  activeSignature?: number;
  activeParameter?: number;
}

/**
 * `typed` (só no clangd): o filterText vira o texto já digitado no range, como no vscode-clangd.
 * O clangd filtra do lado dele; assim todo item empata na pontuação do Monaco e vale o sortText.
 * O Roslyn manda a lista inteira e precisa do filtro do cliente.
 */
export function toSuggestion(
  monaco: MonacoApi,
  item: CompletionItem,
  wordRange: Monaco.IRange,
  typed?: { model: Pick<Model, 'getValueInRange'>; position: Monaco.IPosition },
): Suggestion {
  const { CompletionItemKind, CompletionItemInsertTextRule } = monaco.languages;
  const edit = item.textEdit;
  const range = edit?.range
    ? toRange(monaco, edit.range)
    : edit?.insert && edit.replace
      ? { insert: toRange(monaco, edit.insert), replace: toRange(monaco, edit.replace) }
      : wordRange;
  return {
    label: item.labelDetails
      ? {
          label: item.label,
          detail: item.labelDetails.detail,
          description: item.labelDetails.description,
        }
      : item.label,
    kind: CompletionItemKind[KINDS[(item.kind ?? 1) - 1] ?? 'Text'],
    detail: item.detail,
    documentation: markdown(item.documentation),
    sortText: item.sortText,
    filterText: typed
      ? typedIn(monaco, typed, 'replace' in range ? range.replace : range)
      : item.filterText,
    preselect: item.preselect,
    insertText: edit?.newText ?? item.insertText ?? item.label,
    insertTextRules:
      item.insertTextFormat === 2 ? CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range,
    commitCharacters: item.commitCharacters,
    additionalTextEdits: item.additionalTextEdits?.map((change) => ({
      range: toRange(monaco, change.range),
      text: change.newText,
    })),
    lsp: item,
  };
}

/** `MarkupContent` ou `MarkedString` do LSP → Markdown do Monaco. */
function markdown(content: Markup | undefined): Monaco.IMarkdownString | undefined {
  if (content === undefined) return undefined;
  if (typeof content === 'string') return { value: content };
  if (content.language) return { value: `\`\`\`${content.language}\n${content.value}\n\`\`\`` };
  return { value: content.value };
}

function toRange(monaco: MonacoApi, { start, end }: Range): Monaco.Range {
  return new monaco.Range(start.line + 1, start.character + 1, end.line + 1, end.character + 1);
}

/** O cancelamento do Monaco (texto novo, cursor saiu) vira `$/cancelRequest`. */
function abortOn(token: Monaco.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

/** O texto do início do range até o cursor. */
function typedIn(
  monaco: MonacoApi,
  { model, position }: { model: Pick<Model, 'getValueInRange'>; position: Monaco.IPosition },
  { startLineNumber, startColumn }: Monaco.IRange,
): string {
  return model.getValueInRange(
    new monaco.Range(startLineNumber, startColumn, position.lineNumber, position.column),
  );
}
