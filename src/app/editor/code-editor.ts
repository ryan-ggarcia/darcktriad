import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import type * as Monaco from 'monaco-editor';
import { Commands } from '../shared/commands';
import { KeyStroke, PLATFORM } from '../shared/keybindings';
import { EditorTabs } from './editor-tabs';
import { MonacoBuffer } from './monaco-buffers';
import { loadMonaco } from './monaco-loader';
import { Tab } from './tab';

/** Uma instância do Monaco para todas as abas: trocar de aba troca o modelo e a posição. */
@Component({
  selector: 'app-code-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'code-editor' },
  template: '',
})
export class CodeEditor {
  /** A aba de texto ativa; nula quando a aba ativa não é texto. */
  readonly tab = input<Tab | null>(null);

  private readonly tabs = inject(EditorTabs);
  private readonly commands = inject(Commands);
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private readonly editor = signal<Monaco.editor.IStandaloneCodeEditor | null>(null);
  private readonly viewStates = new WeakMap<Tab, Monaco.editor.ICodeEditorViewState | null>();
  private shown: Tab | null = null;
  private destroyed = false;

  constructor() {
    afterNextRender(() => void this.create());
    effect(() => {
      const editor = this.editor();
      const tab = this.tab();
      if (editor) untracked(() => this.show(editor, tab));
    });
    // Também ao terminar de criar o editor: o pedido de foco (ex.: Ctrl+N) pode chegar antes.
    effect(() => {
      this.tabs.focusRequests();
      this.editor()?.focus();
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.editor()?.dispose();
    });
  }

  private async create(): Promise<void> {
    const monaco = await loadMonaco();
    if (this.destroyed) return;
    const editor = monaco.editor.create(this.host, {
      model: null,
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 14,
      readOnlyMessage: { value: 'Codificação não suportada nesta versão: somente leitura' },
    });
    // Os atalhos da IDE também valem com o foco no texto, inclusive os acordes Ctrl+K.
    for (const { id, chord } of this.commands.bindings) {
      editor.addCommand(toMonacoKeybinding(monaco, chord), () => this.commands.run(id));
    }
    editor.onDidChangeCursorPosition(({ position }) =>
      this.tabs.cursor.set({ line: position.lineNumber, column: position.column }),
    );
    this.editor.set(editor);
  }

  private show(editor: Monaco.editor.IStandaloneCodeEditor, tab: Tab | null): void {
    if (this.shown) this.viewStates.set(this.shown, editor.saveViewState());
    this.shown = tab;
    if (tab?.view.kind !== 'text') {
      editor.setModel(null);
      return;
    }
    editor.setModel((tab.view.buffer as MonacoBuffer).model);
    editor.updateOptions({ readOnly: tab.view.readOnly });
    const state = this.viewStates.get(tab);
    if (state) editor.restoreViewState(state);
    const position = editor.getPosition();
    this.tabs.cursor.set(position && { line: position.lineNumber, column: position.column });
  }
}

/** No Monaco, `CtrlCmd` é ⌘ no macOS e Ctrl nos outros; `WinCtrl` é o outro dos dois. */
function toMonacoKeybinding(monaco: typeof Monaco, chord: KeyStroke[]): number {
  const { KeyMod, KeyCode } = monaco;
  const mac = PLATFORM === 'mac';
  const [first, second] = chord.map(
    (stroke) =>
      (stroke.ctrl ? (mac ? KeyMod.WinCtrl : KeyMod.CtrlCmd) : 0) |
      (stroke.meta ? (mac ? KeyMod.CtrlCmd : KeyMod.WinCtrl) : 0) |
      (stroke.shift ? KeyMod.Shift : 0) |
      (stroke.alt ? KeyMod.Alt : 0) |
      KeyCode[stroke.code.replace(/^Arrow(\w+)$/, '$1Arrow') as keyof typeof KeyCode],
  );
  return second === undefined ? first : KeyMod.chord(first, second);
}
