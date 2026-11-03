import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Breakpoints } from './debug/breakpoints';
import { DebugToolbar } from './debug/debug-toolbar';
import { DebugView } from './debug/debug-view';
import { Debugger } from './debug/debugger';
import { EditorArea } from './editor/editor-area';
import { EditorTabs } from './editor/editor-tabs';
import { loadMonaco } from './editor/monaco-loader';
import { Tab } from './editor/tab';
import { ExplorerTree } from './explorer/explorer-tree';
import { ExplorerView } from './explorer/explorer-view';
import { Languages } from './language/languages';
import { LanguageStatus } from './language/language-status';
import { MainMenu } from './main-menu';
import { LANGUAGE_NAMES } from './paths';
import { Problems } from './project/problems';
import { Project } from './project/project';
import { ProjectStatus } from './project/project-status';
import { ToolsView } from './project/tools-view';
import { QuickOpen } from './quick-open/quick-open';
import { Appearance } from './shared/appearance';
import { CommandId, Commands, TAB_NUMBERS } from './shared/commands';
import { DialogHost } from './shared/dialog-host';
import { Dialogs } from './shared/dialogs';
import { Icon } from './shared/icon';
import { Panel } from './shared/panel';
import { readSize, writeSetting } from './shared/settings';
import { SettingsMenu } from './shell/settings-menu';
import { TitleBar } from './shell/title-bar';
import { learnKeyLabel, loadKeyboardLayout, PLATFORM } from './shared/keybindings';
import { CurrentFolder } from './workspace/current-folder';
import { TerminalPanel } from './terminal/terminal-panel';
import { Terminals } from './terminal/terminals';
import { UpdateNotice } from './update/update-notice';
import { Updates } from './update/updates';
import { WelcomeView } from './workspace/welcome-view';
import { Workspace } from './workspace/workspace';

type Activity = 'explorer' | 'debug' | 'tools';

const SIDEBAR_KEY = 'sidebarWidth';
const SIDEBAR_MIN = 170;
const SIDEBAR_MAX = 640;

/**
 * A janela: barra superior, barra de atividades, barra lateral, editores, painel inferior e barra
 * de status (docs/specs/README.md).
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DebugToolbar,
    DebugView,
    DialogHost,
    EditorArea,
    ExplorerView,
    Icon,
    LanguageStatus,
    ProjectStatus,
    QuickOpen,
    SettingsMenu,
    TerminalPanel,
    TitleBar,
    ToolsView,
    UpdateNotice,
    WelcomeView,
  ],
  host: {
    '(window:keydown)': 'onKeydown($event)',
    '(window:keyup)': 'onKeyup($event)',
    '(window:blur)': 'tabs.cancelSwitcher()',
    '[class.panel-maximized]': 'panel.visible() && panel.maximized()',
  },
  templateUrl: './app.html',
})
export class App {
  protected readonly tabs = inject(EditorTabs);
  protected readonly commands = inject(Commands);
  private readonly workspace = inject(Workspace);
  private readonly folder = inject(CurrentFolder);
  private readonly tree = inject(ExplorerTree);
  private readonly terminals = inject(Terminals);
  private readonly project = inject(Project);
  private readonly languages = inject(Languages);
  protected readonly debug = inject(Debugger);
  private readonly breakpoints = inject(Breakpoints);
  protected readonly problems = inject(Problems);
  protected readonly panel = inject(Panel);
  private readonly appearance = inject(Appearance);
  private readonly dialogs = inject(Dialogs);
  private readonly updates = inject(Updates);
  private readonly injector = inject(Injector);
  private readonly explorer = viewChild(ExplorerView);
  private readonly quickOpen = viewChild.required(QuickOpen);
  private readonly toolsView = viewChild.required(ToolsView);

  protected readonly sidebarVisible = signal(true);
  /** O que a barra lateral mostra: o Explorador ou Executar e Depurar. */
  protected readonly sidebarView = signal<'explorer' | 'debug'>('explorer');
  /** Lembrada entre aberturas. */
  protected readonly sidebarWidth = signal(readSize(SIDEBAR_KEY, 260, SIDEBAR_MIN, SIDEBAR_MAX));
  protected readonly activities: {
    id: Activity;
    label: string;
    icon: string;
    command: CommandId;
  }[] = [
    { id: 'explorer', label: 'Explorador', icon: 'files', command: 'showExplorer' },
    { id: 'debug', label: 'Executar e Depurar', icon: 'run-debug', command: 'showDebug' },
    {
      id: 'tools',
      label: 'Ferramentas: verificar e instalar',
      icon: 'tools',
      command: 'checkTools',
    },
  ];
  protected readonly status = computed(() => {
    const tab = this.tabs.active();
    if (tab?.view.kind !== 'text') return null;
    const cursor = this.tabs.cursor();
    return {
      position: cursor ? `Ln ${cursor.line}, Col ${cursor.column}` : '',
      // shortcut: lida junto com o cursor e a aba; o editor só a detecta de novo ao abrir ou recarregar.
      indentation: tab.view.buffer.indentation(),
      encoding: tab.bom ? 'UTF-8 com BOM' : 'UTF-8',
      language: LANGUAGE_NAMES[tab.language()],
      eol: tab.eol() === 'crlf' ? 'CRLF' : 'LF',
    };
  });

  constructor() {
    this.appearance.start();
    this.registerCommands();
    // Roda antes de o painel sumir da tela: se o foco estava nele, volta para o editor.
    effect(() => {
      const focusedPanel = document.querySelector('.panel')?.contains(document.activeElement);
      if (!this.panel.visible() && focusedPanel && untracked(this.tabs.active)) {
        this.tabs.focusPending.set(true);
      }
    });
    void loadKeyboardLayout();
    inject(MainMenu).start();
    void this.project.start();
    this.updates.start();
    void this.workspace.start().then(() => {
      // Com a tela pronta, carrega o Monaco no tempo ocioso: o primeiro arquivo abre tão rápido quanto os outros.
      // shortcut: sem requestIdleCallback (WebKit antigo no macOS/Linux) não pré-carrega; usar setTimeout se lá medir lento.
      globalThis.requestIdleCallback?.(() => void loadMonaco());
    });
  }

  protected onKeydown(event: KeyboardEvent): void {
    learnKeyLabel(event);
    // Recarregar a página (F5, Ctrl+R) apagaria as edições não salvas.
    if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.code === 'KeyR')) {
      event.preventDefault();
    }
    // Com uma pergunta aberta, só ela responde ao teclado.
    if (this.dialogs.current()) return;
    if (this.tabs.switcher() && (event.key === 'Escape' || event.key === 'Enter')) {
      event.preventDefault();
      if (event.key === 'Enter') this.tabs.commitSwitcher();
      else this.tabs.cancelSwitcher();
    } else if (this.commands.handleKey(event)) {
      event.preventDefault();
    }
  }

  /** Ctrl+Tab: soltar o Ctrl abre a aba escolhida na lista. */
  protected onKeyup(event: KeyboardEvent): void {
    if (event.key === 'Control' && this.tabs.switcher()) this.tabs.commitSwitcher();
  }

  /** Ctrl+J: esconde o painel; escondido, mostra a última aba. */
  private togglePanel(): void {
    const tab = this.panel.tab();
    if (this.panel.visible()) this.panel.visible.set(false);
    else if (tab === 'terminal') this.terminals.toggle();
    else this.panel.toggle(tab);
  }

  private focusSidebar(): void {
    this.sidebarVisible.set(true);
    afterNextRender(
      () => {
        this.explorer()?.focus();
        focusInside('.sidebar');
      },
      { injector: this.injector },
    );
  }

  private focusEditor(): void {
    this.panel.maximized.set(false);
    if (this.tabs.active()) this.tabs.focusPending.set(true);
    else afterNextRender(() => focusInside('.main'), { injector: this.injector });
  }

  /** F6 / Shift+F6: a próxima área à mostra (barra lateral, editores, painel). */
  private focusPart(offset: 1 | -1): void {
    const parts = [
      { selector: '.sidebar', shown: this.sidebarVisible(), focus: () => this.focusSidebar() },
      {
        selector: '.main',
        shown: !this.panel.visible() || !this.panel.maximized(),
        focus: () => this.focusEditor(),
      },
      {
        selector: '.panel',
        shown: this.panel.visible(),
        focus: () => this.panel.requestFocus(),
      },
    ].filter((part) => part.shown);
    const current = parts.findIndex((part) =>
      document.querySelector(part.selector)?.contains(document.activeElement),
    );
    parts[current < 0 ? 0 : (current + offset + parts.length) % parts.length].focus();
  }

  protected showExplorer(): void {
    this.sidebarView.set('explorer');
    this.sidebarVisible.set(true);
    afterNextRender(() => this.explorer()?.focus(), { injector: this.injector });
  }

  /** O botão da barra de atividades: mostra a visão, ou esconde a barra se ela já está à mostra. */
  protected toggleView(view: 'explorer' | 'debug'): void {
    if (this.sidebarVisible() && this.sidebarView() === view) this.sidebarVisible.set(false);
    else if (view === 'explorer') this.showExplorer();
    else this.showDebug();
  }

  protected isActive(activity: Activity): boolean {
    if (activity === 'tools') return false;
    return this.sidebarVisible() && this.sidebarView() === activity;
  }

  protected activate(activity: Activity): void {
    if (activity === 'explorer' || activity === 'debug') this.toggleView(activity);
    else this.commands.run('checkTools');
  }

  protected startSidebarResize(event: PointerEvent): void {
    const sash = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startWidth = this.sidebarWidth();
    sash.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent) => this.resizeSidebar(startWidth + moved.clientX - startX);
    sash.addEventListener('pointermove', move);
    const stop = () => {
      sash.removeEventListener('pointermove', move);
      writeSetting(SIDEBAR_KEY, String(this.sidebarWidth()));
    };
    sash.addEventListener('lostpointercapture', stop, { once: true });
  }

  /** Pelas setas: muda e já lembra. */
  protected nudgeSidebar(offset: number): void {
    this.resizeSidebar(this.sidebarWidth() + offset);
    writeSetting(SIDEBAR_KEY, String(this.sidebarWidth()));
  }

  private resizeSidebar(width: number): void {
    const max = Math.min(SIDEBAR_MAX, window.innerWidth / 2);
    this.sidebarWidth.set(Math.round(Math.max(SIDEBAR_MIN, Math.min(width, max))));
  }

  protected showDebug(): void {
    this.sidebarView.set('debug');
    this.sidebarVisible.set(true);
  }

  private registerCommands(): void {
    const mac = PLATFORM === 'mac';
    const withActive = (action: (tab: Tab) => unknown) => () => {
      const tab = this.tabs.active();
      if (tab) action(tab);
    };
    // As ações do explorador precisam da barra lateral à mostra para o campo de nome aparecer.
    const inExplorer = (action: () => unknown) => () => {
      this.sidebarView.set('explorer');
      this.sidebarVisible.set(true);
      action();
    };
    this.commands.setConditions({
      editorOpen: () => this.tabs.active() !== null,
      textEditor: () => this.tabs.active()?.view.kind === 'text',
      folderOpen: () => this.folder.path() !== null,
      project: () => this.project.channel() !== null,
      debugging: () => this.debug.state() !== null,
      debugPaused: () => this.debug.state() === 'paused',
      // Também no início: o F6 fica guardado até o programa rodar.
      debugRunning: () => this.debug.state() === 'running' || this.debug.state() === 'starting',
      glass: () => this.appearance.glassSupported(),
    });
    this.commands.register({
      newFile: () => this.tabs.newUntitled(),
      openFile: () => (mac ? this.workspace.openFileOrFolder() : this.workspace.openFileDialog()),
      openFolder: () => this.workspace.openFolderDialog(),
      closeFolder: () => this.workspace.closeFolder(),
      save: withActive((tab) => this.tabs.save(tab)),
      saveAs: withActive((tab) => this.tabs.saveAs(tab)),
      saveAll: () => this.tabs.saveAll(),
      quit: () => this.workspace.quit(),
      closeEditor: withActive((tab) => this.tabs.close(tab)),
      closeAllEditors: () => this.tabs.closeAll(),
      nextEditor: () => this.tabs.activateNext(1),
      previousEditor: () => this.tabs.activateNext(-1),
      ...Object.fromEntries(
        TAB_NUMBERS.map((number) => [`openTab${number}`, () => this.tabs.activateAt(number - 1)]),
      ),
      recentEditors: () => this.tabs.cycleRecent(1),
      recentEditorsBack: () => this.tabs.cycleRecent(-1),
      showCommands: () => this.quickOpen().show('>'),
      quickOpen: () => this.quickOpen().show(''),
      goToLine: () => this.quickOpen().show(':'),
      keyboardShortcuts: () => this.quickOpen().show('>', true),
      showExplorer: () => this.showExplorer(),
      toggleSidebar: () => this.sidebarVisible.update((visible) => !visible),
      togglePanel: () => this.togglePanel(),
      focusSidebar: () => this.focusSidebar(),
      focusEditor: () => this.focusEditor(),
      focusNextPart: () => this.focusPart(1),
      focusPreviousPart: () => this.focusPart(-1),
      explorerNewFile: inExplorer(() => this.tree.startCreate('file')),
      explorerNewFolder: inExplorer(() => this.tree.startCreate('dir')),
      explorerRefresh: () => this.tree.refresh(),
      explorerCollapseAll: () => this.tree.collapseAll(),
      toggleTerminal: () => this.terminals.toggle(),
      newTerminal: () => this.terminals.create(),
      selectConfig: () => this.pickConfig(),
      selectTarget: () => this.pickTarget(),
      reconfigure: () => this.project.reconfigure(),
      checkTools: () => this.toolsView().show(),
      checkUpdates: () => this.updates.check(),
      goToDefinition: () => this.languages.goToDefinition((pick) => this.quickOpen().pick(pick)),
      navigateBack: () => this.tabs.back(),
      navigateForward: () => this.tabs.forward(),
      showProblems: () => this.panel.toggle('problems'),
      nextProblem: () => this.goToProblem(1),
      previousProblem: () => this.goToProblem(-1),
      restartCpp: () => this.languages.restart('cpp'),
      restartCsharp: () => this.languages.restart('csharp'),
      build: () => this.project.build(),
      run: () => this.terminals.run(),
      stop: () => (this.debug.state() ? this.debug.stop() : this.terminals.stop()),
      cancelBuild: () => this.project.cancelBuild(),
      toggleOutput: () => this.panel.toggle('output'),
      debugStart: () => {
        // Como no VS Code, a visão Executar e Depurar aparece ao iniciar.
        if (!this.debug.state()) this.showDebug();
        void this.debug.start();
      },
      debugPause: () => this.debug.pause(),
      debugRestart: () => this.debug.restart(),
      debugStepOver: () => this.debug.stepOver(),
      debugStepInto: () => this.debug.stepInto(),
      debugStepOut: () => this.debug.stepOut(),
      toggleBreakpoint: withActive((tab) => {
        const path = tab.path();
        const cursor = this.tabs.cursor();
        if (path && cursor) this.breakpoints.toggle(path, cursor.line);
      }),
      removeAllBreakpoints: () => this.breakpoints.removeAll(),
      showDebug: () => this.showDebug(),
      toggleTheme: () => this.appearance.toggleTheme(),
      toggleMaterial: () => this.appearance.toggleMaterial(),
      toggleFormatOnSave: () => this.languages.toggleFormatOnSave(),
    });
  }

  /** F8 / Shift+F8: o próximo problema, passando de arquivo em arquivo. */
  private goToProblem(offset: 1 | -1): void {
    const path = this.tabs.active()?.path();
    const cursor = this.tabs.cursor();
    const item = this.problems.next(path && cursor ? { file: path, ...cursor } : null, offset);
    if (item?.file) {
      const position = { line: item.startLineNumber, column: item.startColumn };
      void this.tabs.openAt(item.file, position, false);
    }
  }

  private pickConfig(): void {
    const { configs, config } = this.project.state();
    this.quickOpen().pick({
      title: 'Selecionar configuração',
      options: configs,
      current: config,
      // Com presets, a lista vem do `cmake --list-presets`, na primeira configuração.
      empty: 'Nenhuma configuração ainda: a lista aparece depois que o projeto configura.',
      accept: (choice) => this.project.selectConfig(choice),
    });
  }

  private pickTarget(): void {
    const { targets, target, status } = this.project.state();
    this.quickOpen().pick({
      title: 'Selecionar alvo',
      options: targets.map((item) => item.name),
      current: target,
      empty:
        status.kind === 'configuring'
          ? 'O projeto está configurando: os alvos aparecem quando ele terminar.'
          : this.project.configureFailed()
            ? 'A configuração falhou: veja a Saída.'
            : status.kind === 'failed'
              ? status.message
              : 'Nenhum programa executável neste projeto.',
      accept: (choice) => this.project.selectTarget(choice),
    });
  }
}

/** Leva o foco ao primeiro controle da área, se ele ainda não estiver nela. */
function focusInside(selector: string): void {
  const area = document.querySelector(selector);
  if (area?.contains(document.activeElement)) return;
  area?.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"], input')?.focus();
}
