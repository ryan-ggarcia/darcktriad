import { effect, Injector } from '@angular/core';
import type * as Monaco from 'monaco-editor';
import { EditorTabs } from '../editor/editor-tabs';
import { MonacoBuffer } from '../editor/monaco-buffers';
import { Breakpoints } from './breakpoints';
import { Debugger } from './debugger';

type Model = Monaco.editor.ITextModel;

export const UNBOUND_HINT =
  'Ponto de parada não vinculado: esta linha não gerou código ou não tem símbolos de depuração';

let connected = false;

/**
 * As bolinhas dos pontos de parada e a linha atual (fundo amarelo e seta) em todas as abas. As
 * bolinhas são decorações do Monaco: acompanham o texto, e a linha nova volta para a lista.
 */
export function connectDebugDecorations(monaco: typeof Monaco, injector: Injector): void {
  if (connected) return;
  connected = true;
  const tabs = injector.get(EditorTabs);
  const breakpoints = injector.get(Breakpoints);
  const debug = injector.get(Debugger);
  /** As decorações de cada modelo; `lines` são as linhas dos pontos, na ordem dos `ids`. */
  const shown = new WeakMap<Model, { ids: string[]; lines: number[]; file: string }>();

  const track = (model: Model) => {
    const entry = { ids: [] as string[], lines: [] as number[], file: '' };
    shown.set(model, entry);
    // Recarregar do disco troca só o trecho que mudou (MonacoBuffer.setText): as bolinhas seguem.
    model.onDidChangeContent(() => {
      const moves: [number, number][] = [];
      entry.lines.forEach((line, i) => {
        const now = model.getDecorationRange(entry.ids[i])?.startLineNumber;
        if (now && now !== line) moves.push([line, now]);
      });
      if (moves.length) breakpoints.relocate(entry.file, moves);
    });
    return entry;
  };

  effect(
    () => {
      const list = breakpoints.list();
      const current = debug.currentLine();
      for (const tab of tabs.tabs()) {
        const file = tab.path();
        const buffer = tab.buffer;
        if (!file || !(buffer instanceof MonacoBuffer) || buffer.model.isDisposed()) continue;
        const { model } = buffer;
        const entry = shown.get(model) ?? track(model);
        const points = list.filter((item) => item.file === file);
        const decorations: Monaco.editor.IModelDeltaDecoration[] = points.map((item) => {
          const line = Math.min(item.line, model.getLineCount());
          const unbound = item.verified === false;
          return {
            // A linha inteira: Enter no começo dela empurra a bolinha junto com o texto.
            range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
            options: {
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              glyphMarginClassName: unbound ? 'debug-breakpoint-unbound' : 'debug-breakpoint',
              glyphMarginHoverMessage: { value: unbound ? UNBOUND_HINT : 'Ponto de parada (F9)' },
            },
          };
        });
        const lines = points.map((item) => item.line);
        if (current?.file === file) {
          decorations.push({
            range: new monaco.Range(current.line, 1, current.line, 1),
            options: {
              isWholeLine: true,
              className: 'debug-current-line',
              glyphMarginClassName: 'debug-current-arrow',
              glyphMarginHoverMessage: { value: 'Linha atual do programa pausado' },
            },
          });
        }
        entry.ids = model.deltaDecorations(entry.ids, decorations);
        entry.lines = lines;
        entry.file = file;
      }
    },
    { injector },
  );
}

/** Clicar na margem à esquerda dos números alterna o ponto de parada, como o F9. */
export function toggleOnGutterClick(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  injector: Injector,
): void {
  const tabs = injector.get(EditorTabs);
  const breakpoints = injector.get(Breakpoints);
  editor.onMouseDown(({ target, event }) => {
    if (target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const file = tabs.active()?.path();
    if (!event.leftButton || !file || !target.position) return;
    breakpoints.toggle(file, target.position.lineNumber);
  });
}
