import { effect, inject, Injectable, Injector } from '@angular/core';
import { MenuEntry, RecentFolder } from './ipc';
import { bindingsFor, CommandId, COMMANDS, Commands, isCommandId } from './shared/commands';
import { formatAccelerator, Platform, PLATFORM } from './shared/keybindings';
import { WorkspaceService } from './workspace.service';
import { Workspace } from './workspace/workspace';

const RECENT_FOLDER = 'recentFolder:';

type Item = CommandId | '-' | 'recentFolders';

/**
 * Os menus da spec, só com os comandos que já existem; Executar e os painéis Problemas e Saída
 * entram quando os comandos deles chegarem ao registro.
 */
const MENUS: [string, Item[]][] = [
  [
    'Arquivo',
    [
      'newFile',
      'openFile',
      'openFolder',
      'recentFolders',
      '-',
      'save',
      'saveAs',
      'saveAll',
      '-',
      'closeEditor',
      'closeFolder',
      '-',
      'quit',
    ],
  ],
  [
    'Editar',
    [
      'undo',
      'redo',
      '-',
      'cut',
      'copy',
      'paste',
      'selectAll',
      '-',
      'find',
      'replace',
      '-',
      'commentLine',
    ],
  ],
  ['Ver', ['showCommands', 'quickOpen', '-', 'showExplorer', 'toggleTerminal', 'toggleSidebar']],
  ['Ajuda', ['keyboardShortcuts']],
];

/** O menu nativo a partir do registro: rótulo sem a categoria, atalho do sistema e `role`. */
export function buildMenu(recents: RecentFolder[], platform: Platform): MenuEntry[] {
  const bindings = bindingsFor(platform);
  const entry = (item: Item): MenuEntry | null => {
    if (item === '-') return { kind: 'separator' };
    if (item === 'recentFolders') {
      return recents.length
        ? {
            kind: 'submenu',
            label: 'Pastas recentes',
            items: recents.map((recent) => ({
              kind: 'command',
              id: RECENT_FOLDER + recent.path,
              label: recent.exists ? recent.path : `${recent.path} (não existe mais)`,
            })),
          }
        : null;
    }
    // No macOS, o Sair fica no menu do app, que o núcleo monta.
    if (item === 'quit' && platform === 'mac') return null;
    const { title, role } = COMMANDS[item];
    const binding = bindings.find((candidate) => candidate.id === item);
    return {
      kind: 'command',
      id: item,
      label: title.slice(title.indexOf(': ') + 2),
      accelerator: binding ? formatAccelerator(binding.chord, platform) : null,
      ...(role && { role }),
    };
  };
  return MENUS.map(([label, items]) => ({
    kind: 'submenu',
    label,
    items: withoutLoneSeparators(items.map(entry).filter((item) => item !== null)),
  }));
}

function withoutLoneSeparators(items: MenuEntry[]): MenuEntry[] {
  return items.filter(
    (item, i) =>
      item.kind !== 'separator' ||
      (i > 0 && i < items.length - 1 && items[i + 1].kind !== 'separator'),
  );
}

/** Liga o menu nativo (docs/ipc.md, `set_menu` e `menu-command`) ao registro de comandos. */
@Injectable({ providedIn: 'root' })
export class MainMenu {
  private readonly service = inject(WorkspaceService);
  private readonly workspace = inject(Workspace);
  private readonly commands = inject(Commands);
  private readonly injector = inject(Injector);

  /** Monta o menu agora e de novo quando as pastas recentes mudam. */
  start(): void {
    effect(
      () => {
        this.service
          .setMenu(buildMenu(this.workspace.recents(), PLATFORM))
          .catch((error) => console.warn('Falha ao montar o menu', error));
      },
      { injector: this.injector },
    );
    void this.service.onMenuCommand((id) => this.run(id));
  }

  private run(id: string): void {
    if (id.startsWith(RECENT_FOLDER)) {
      const path = id.slice(RECENT_FOLDER.length);
      const recent = this.workspace.recents().find((item) => item.path === path);
      if (recent) void this.workspace.openRecent(recent);
    } else if (isCommandId(id)) {
      this.commands.run(id);
    }
  }
}
