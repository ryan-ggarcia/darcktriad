import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { EditorArea } from './editor/editor-area';
import { EditorTabs } from './editor/editor-tabs';
import { loadMonaco } from './editor/monaco-loader';
import { Tab } from './editor/tab';
import { ExplorerTree } from './explorer/explorer-tree';
import { ExplorerView } from './explorer/explorer-view';
import { MainMenu } from './main-menu';
import { LANGUAGE_NAMES } from './paths';
import { Project } from './project/project';
import { ProjectStatus } from './project/project-status';
import { ToolsView } from './project/tools-view';
import { QuickOpen } from './quick-open/quick-open';
import { Commands } from './shared/commands';
import { DialogHost } from './shared/dialog-host';
import { Dialogs } from './shared/dialogs';
import { Icon } from './shared/icon';
import { PLATFORM } from './shared/keybindings';
import { CurrentFolder } from './workspace/current-folder';
import { TerminalPanel } from './terminal/terminal-panel';
import { Terminals } from './terminal/terminals';
import { WelcomeView } from './workspace/welcome-view';
import { Workspace } from './workspace/workspace';

/** A janela: barra de atividades, explorador, editores, painel inferior e barra de status (docs/specs/README.md). */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DialogHost,
    EditorArea,
    ExplorerView,
    Icon,
    ProjectStatus,
    QuickOpen,
    TerminalPanel,
    ToolsView,
    WelcomeView,
  ],
  host: {
    '(window:keydown)': 'onKeydown($event)',
    '(window:keyup)': 'onKeyup($event)',
    '(window:blur)': 'tabs.cancelSwitcher()',
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
  private readonly dialogs = inject(Dialogs);
  private readonly injector = inject(Injector);
  private readonly explorer = viewChild(ExplorerView);
  private readonly quickOpen = viewChild.required(QuickOpen);
  private readonly toolsView = viewChild.required(ToolsView);

  protected readonly sidebarVisible = signal(true);
  protected readonly status = computed(() => {
    const tab = this.tabs.active();
    if (tab?.view.kind !== 'text') return null;
    const cursor = this.tabs.cursor();
    return {
      position: cursor ? `Ln ${cursor.line}, Col ${cursor.column}` : '',
      language: LANGUAGE_NAMES[tab.language()],
      eol: tab.eol() === 'crlf' ? 'CRLF' : 'LF',
    };
  });

  constructor() {
    this.registerCommands();
    inject(MainMenu).start();
    void this.project.start();
    void this.workspace.start().then(() => {
      // Com a tela pronta, carrega o Monaco no tempo ocioso: o primeiro arquivo abre tão rápido quanto os outros.
      // shortcut: sem requestIdleCallback (WebKit antigo no macOS/Linux) não pré-carrega; usar setTimeout se lá medir lento.
      globalThis.requestIdleCallback?.(() => void loadMonaco());
    });
  }

  protected onKeydown(event: KeyboardEvent): void {
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

  protected showExplorer(): void {
    this.sidebarVisible.set(true);
    afterNextRender(() => this.explorer()?.focus(), { injector: this.injector });
  }

  private registerCommands(): void {
    const mac = PLATFORM === 'mac';
    const withActive = (action: (tab: Tab) => unknown) => () => {
      const tab = this.tabs.active();
      if (tab) action(tab);
    };
    // As ações do explorador precisam da barra lateral à mostra para o campo de nome aparecer.
    const inExplorer = (action: () => unknown) => () => {
      this.sidebarVisible.set(true);
      action();
    };
    this.commands.setConditions({
      editorOpen: () => this.tabs.active() !== null,
      textEditor: () => this.tabs.active()?.view.kind === 'text',
      folderOpen: () => this.folder.path() !== null,
      cmakeProject: () => this.project.isCMake(),
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
      recentEditors: () => this.tabs.cycleRecent(1),
      recentEditorsBack: () => this.tabs.cycleRecent(-1),
      showCommands: () => this.quickOpen().show('>'),
      quickOpen: () => this.quickOpen().show(''),
      goToLine: () => this.quickOpen().show(':'),
      keyboardShortcuts: () => this.quickOpen().show('>', true),
      showExplorer: () => this.showExplorer(),
      toggleSidebar: () => this.sidebarVisible.update((visible) => !visible),
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
    });
  }

  private pickConfig(): void {
    const { configs, config } = this.project.state();
    this.quickOpen().pick({
      title: 'Selecionar configuração',
      options: configs,
      current: config,
      // Com presets, a lista vem do `cmake --list-presets`, na primeira configuração.
      empty: 'Nenhuma configuração ainda: a lista aparece depois que o CMake configura.',
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
          ? 'O CMake está configurando: os alvos aparecem quando ele terminar.'
          : status.kind === 'failed'
            ? 'A configuração falhou: veja a Saída.'
            : 'Nenhum programa executável neste projeto.',
      accept: (choice) => this.project.selectTarget(choice),
    });
  }
}
