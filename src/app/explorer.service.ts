import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

/** Explorador de arquivos do núcleo Rust (comando `list_dir`). */
@Injectable({ providedIn: 'root' })
export class ExplorerService {
  list(path: string): Promise<Entry[]> {
    return invoke<Entry[]>('list_dir', { path });
  }
}
