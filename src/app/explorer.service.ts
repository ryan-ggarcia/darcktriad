import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { Entry, Path } from './ipc';

/** Arquivos e pastas no núcleo Rust (docs/ipc.md, "Explorador"). */
@Injectable({ providedIn: 'root' })
export class ExplorerService {
  list(path: Path): Promise<Entry[]> {
    return invoke('list_dir', { path });
  }

  createFile(parent: Path, name: string): Promise<Path> {
    return invoke('create_file', { parent, name });
  }

  createDir(parent: Path, name: string): Promise<Path> {
    return invoke('create_dir', { parent, name });
  }

  rename(path: Path, newName: string): Promise<Path> {
    return invoke('rename_entry', { path, newName });
  }

  moveToTrash(path: Path): Promise<void> {
    return invoke('move_to_trash', { path });
  }

  deletePermanently(path: Path): Promise<void> {
    return invoke('delete_permanently', { path });
  }
}
