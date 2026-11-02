import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Breakpoint,
  ChangeBatch,
  MenuEntry,
  OpenedFolder,
  Path,
  ProjectFiles,
  RecentFolder,
  Session,
} from './ipc';

/** Pasta aberta, recentes, sessão, índice do Abrir rápido, janela e menu no núcleo Rust (docs/ipc.md). */
@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  openFolder(path: Path): Promise<OpenedFolder> {
    return invoke('open_folder', { path });
  }

  closeFolder(): Promise<void> {
    return invoke('close_folder');
  }

  recentFolders(): Promise<RecentFolder[]> {
    return invoke('recent_folders');
  }

  removeRecentFolder(path: Path): Promise<void> {
    return invoke('remove_recent_folder', { path });
  }

  saveSession(session: Session): Promise<void> {
    return invoke('save_session', { session });
  }

  saveBreakpoints(breakpoints: Breakpoint[]): Promise<void> {
    return invoke('save_breakpoints', { breakpoints });
  }

  pickFolder(): Promise<Path | null> {
    return invoke('pick_folder');
  }

  onFsChanged(handler: (batch: ChangeBatch) => void): Promise<UnlistenFn> {
    return listen<ChangeBatch>('fs-changed', (event) => handler(event.payload));
  }

  /** `handler` devolve `false` para manter a janela aberta. */
  onCloseRequested(handler: () => Promise<boolean>): Promise<UnlistenFn> {
    return getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await handler())) event.preventDefault();
    });
  }

  /** Fecha a janela sem passar por `onCloseRequested`: chame depois de perguntar. */
  destroyWindow(): Promise<void> {
    return getCurrentWindow().destroy();
  }

  projectFiles(): Promise<ProjectFiles> {
    return invoke('project_files');
  }

  onProjectFilesChanged(handler: () => void): Promise<UnlistenFn> {
    return listen('project-files-changed', () => handler());
  }

  setMenu(items: MenuEntry[]): Promise<void> {
    return invoke('set_menu', { items });
  }

  onMenuCommand(handler: (id: string) => void): Promise<UnlistenFn> {
    return listen<string>('menu-command', (event) => handler(event.payload));
  }
}
