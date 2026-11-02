import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  EnvironmentInjector,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import type * as Monaco from 'monaco-editor';
import { connectDebugDecorations, toggleOnGutterClick } from '../debug/debug-decorations';
import { connectMonaco } from '../language/monaco-language';
import { CommandId, COMMANDS, Commands } from '../shared/commands';
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
  /** O da janela: os provedores e marcadores seguem valendo sem nenhuma aba aberta. */
  private readonly rootInjector = inject(EnvironmentInjector);
  private readonly editor = signal<Monaco.editor.IStandaloneCodeEditor | null>(null);
  private readonly viewStates = new WeakMap<Tab, Monaco.editor.ICodeEditorViewState | null>();
  private shown: Tab | null = null;
  private destroyed = false;
  private readonly cleanup: (() => void)[] = [];

  constructor() {
    afterNextRender(() => void this.create());
    effect(() => {
      const editor = this.editor();
      const tab = this.tab();
      if (editor) untracked(() => this.show(editor, tab));
    });
    // Só foca quando pedido; o pedido (ex.: Ctrl+N) pode chegar antes de o editor existir.
    effect(() => {
      const editor = this.editor();
      if (editor && this.tabs.focusPending()) {
        this.tabs.focusPending.set(false);
        editor.focus();
      }
    });
    // Codificação não suportada, ou aberto por "Ir para definição" fora da pasta.
    effect(() => {
      const editor = this.editor();
      const tab = this.tab();
      if (!editor || tab?.view.kind !== 'text') return;
      const outside = tab.outsideProject();
      editor.updateOptions({
        readOnly: tab.view.readOnly || outside,
        readOnlyMessage: {
          value: outside
            ? 'Fora do projeto: somente leitura'
            : 'Codificação não suportada nesta versão: somente leitura',
        },
      });
    });
    effect(() => {
      const editor = this.editor();
      const target = this.tabs.goTo();
      if (editor && target) untracked(() => this.goTo(editor, target));
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.cleanup.forEach((dispose) => dispose());
      this.editor()?.dispose();
    });
  }

  /** Ctrl+G: fora do arquivo vai para a última linha; a linha fica no meio da tela. */
  private goTo(
    editor: Monaco.editor.IStandaloneCodeEditor,
    target: { line: number; column: number },
  ): void {
    this.tabs.goTo.set(null);
    const model = editor.getModel();
    if (!model) return;
    // Só a linha é limitada antes: o Monaco mandaria a linha 9999 para o fim da última linha.
    const lineNumber = Math.min(target.line, model.getLineCount());
    const position = model.validatePosition({ lineNumber, column: target.column });
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    editor.focus();
  }

  private async create(): Promise<void> {
    const monaco = await loadMonaco();
    if (this.destroyed) return;
    const editor = monaco.editor.create(this.host, {
      model: null,
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 14,
      // A margem das bolinhas dos pontos de parada e da seta da linha atual.
      glyphMargin: true,
    });
    connectMonaco(monaco, this.rootInjector);
    connectDebugDecorations(monaco, this.rootInjector);
    toggleOnGutterClick(monaco, editor, this.rootInjector);
    // Ctrl+clique (⌘+clique no macOS) faz o mesmo que F12.
    editor.onMouseDown(({ event, target }) => {
      const modifier = PLATFORM === 'mac' ? event.metaKey : event.ctrlKey;
      if (!modifier || !event.leftButton || !target.position) return;
      if (target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return;
      editor.setPosition(target.position);
      this.commands.run('goToDefinition');
    });
    // Os atalhos da IDE também valem com o foco no texto, inclusive os acordes Ctrl+K. Os de
    // edição (Ctrl+C, Ctrl+Z…) ficam com o Monaco.
    for (const { id, chord } of this.commands.bindings) {
      if (COMMANDS[id].native) continue;
      editor.addCommand(toMonacoKeybinding(monaco, chord), () => this.commands.run(id));
    }
    // O F1 e o item "Command Palette" do menu de contexto abrem a paleta da IDE, não a do Monaco.
    const palette = monaco.editor.addCommand({
      id: 'editor.action.quickCommand',
      run: () => this.commands.run('showCommands'),
    });
    this.cleanup.push(() => palette.dispose(), this.commands.register(editorCommands(editor)));
    this.showChordsInStatusBar(editor);
    editor.onDidChangeCursorPosition(({ position }) =>
      this.tabs.cursor.set({ line: position.lineNumber, column: position.column }),
    );
    this.editor.set(editor);
  }

  /**
   * Com o foco no texto, os acordes são do Monaco (que também tem os dele, como Ctrl+K Ctrl+C);
   * as mensagens que ele daria vão para a barra de status da IDE.
   * shortcut: o Monaco não expõe o acorde em andamento; isto troca o `status` do serviço de
   * notificações interno dele. Se uma versão nova mudar esses nomes, a barra deixa de mostrar
   * acordes digitados no editor (o resto segue funcionando); conferir ao atualizar o Monaco.
   */
  private showChordsInStatusBar(editor: Monaco.editor.IStandaloneCodeEditor): void {
    const notifications = (editor as unknown as MonacoInternals)._standaloneKeybindingService
      ?._notificationService;
    if (!notifications) return;
    notifications.status = (message, options) => {
      // "Não é um comando" vem com prazo para sumir; "(Ctrl+K) foi pressionado" vem sem.
      if (options?.hideAfter) {
        this.commands.chordFailed();
        return { close: () => undefined };
      }
      const first = /^\((.+)\)/.exec(message)?.[1];
      return { close: first ? this.commands.chordPending(first) : () => undefined };
    };
  }

  private show(editor: Monaco.editor.IStandaloneCodeEditor, tab: Tab | null): void {
    if (this.shown) this.viewStates.set(this.shown, editor.saveViewState());
    this.shown = tab;
    if (tab?.view.kind !== 'text') {
      editor.setModel(null);
      return;
    }
    editor.setModel((tab.view.buffer as MonacoBuffer).model);
    const state = this.viewStates.get(tab);
    if (state) editor.restoreViewState(state);
    const position = editor.getPosition();
    this.tabs.cursor.set(position && { line: position.lineNumber, column: position.column });
  }
}

interface MonacoInternals {
  _standaloneKeybindingService?: {
    _notificationService?: {
      status(message: string, options?: { hideAfter?: number }): { close(): void };
    };
  };
}

/** Comandos do menu Editar, executados pelas ações do próprio Monaco no editor. */
function editorCommands(
  editor: Monaco.editor.IStandaloneCodeEditor,
): Partial<Record<CommandId, () => void>> {
  const action = (id: string) => () => {
    editor.focus();
    editor.trigger('menu', id, null);
  };
  return {
    undo: action('undo'),
    redo: action('redo'),
    cut: action('editor.action.clipboardCutAction'),
    copy: action('editor.action.clipboardCopyAction'),
    paste: action('editor.action.clipboardPasteAction'),
    selectAll: action('editor.action.selectAll'),
    find: action('actions.find'),
    replace: action('editor.action.startFindReplaceAction'),
    commentLine: action('editor.action.commentLine'),
    triggerSuggest: action('editor.action.triggerSuggest'),
    triggerParameterHints: action('editor.action.triggerParameterHints'),
    showHover: action('editor.action.showHover'),
  };
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
