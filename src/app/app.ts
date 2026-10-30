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
import { Tab } from './editor/tab';
import { ExplorerView } from './explorer/explorer-view';
import { LANGUAGE_NAMES } from './paths';
import { Commands } from './shared/commands';
import { DialogHost } from './shared/dialog-host';
import { Dialogs } from './shared/dialogs';
import { Icon } from './shared/icon';
import { PLATFORM } from './shared/keybindings';
import { WelcomeView } from './workspace/welcome-view';
import { Workspace } from './workspace/workspace';

/** A janela: barra de atividades, explorador, editores e barra de status (docs/specs/README.md). */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogHost, EditorArea, ExplorerView, Icon, WelcomeView],
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
  private readonly dialogs = inject(Dialogs);
  private readonly injector = inject(Injector);
  private readonly explorer = viewChild(ExplorerView);

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
    const mac = PLATFORM === 'mac';
    const withActive = (action: (tab: Tab) => unknown) => () => {
      const tab = this.tabs.active();
      if (tab) action(tab);
    };
    this.commands.register({
      newFile: () => this.tabs.newUntitled(),
      openFile: () => (mac ? this.workspace.openFileOrFolder() : this.workspace.openFileDialog()),
      openFolder: () =>
        mac ? this.workspace.openFileOrFolder() : this.workspace.openFolderDialog(),
      closeFolder: () => this.workspace.closeFolder(),
      save: withActive((tab) => this.tabs.save(tab)),
      saveAs: withActive((tab) => this.tabs.saveAs(tab)),
      saveAll: () => this.tabs.saveAll(),
      closeEditor: withActive((tab) => this.tabs.close(tab)),
      closeAllEditors: () => this.tabs.closeAll(),
      nextEditor: () => this.tabs.activateNext(1),
      previousEditor: () => this.tabs.activateNext(-1),
      recentEditors: () => this.tabs.cycleRecent(1),
      recentEditorsBack: () => this.tabs.cycleRecent(-1),
      showExplorer: () => this.showExplorer(),
      toggleSidebar: () => this.sidebarVisible.update((visible) => !visible),
    });
    void this.workspace.start();
  }

  protected onKeydown(event: KeyboardEvent): void {
    // Recarregar a página (F5, Ctrl+R) apagaria as edições não salvas.
    if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.code === 'KeyR')) {
      event.preventDefault();
    }
    // Com uma pergunta aberta, só ela responde ao teclado.
    if (this.dialogs.current()) return;
    if (event.key === 'Escape' && this.tabs.switcher()) {
      event.preventDefault();
      this.tabs.cancelSwitcher();
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
}
