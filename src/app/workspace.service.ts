import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ChangeBatch, OpenedFolder, Path, RecentFolder, Session } from './ipc';

/** Pasta aberta, recentes, sessão e janela no núcleo Rust (docs/ipc.md). */
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
}
