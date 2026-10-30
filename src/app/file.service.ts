import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { Eol, FileContent, Path } from './ipc';

/** Leitura e gravação de arquivos no núcleo Rust (docs/ipc.md, "Editor" e "Diálogos nativos"). */
@Injectable({ providedIn: 'root' })
export class FileService {
  read(path: Path): Promise<FileContent> {
    return invoke('read_file', { path });
  }

  /** Devolve a nova versão; `expectedVersion` nulo grava por cima do que estiver no disco. */
  save(
    path: Path,
    content: string,
    eol: Eol,
    bom: boolean,
    expectedVersion: string | null,
  ): Promise<string> {
    return invoke('save_file', { path, content, eol, bom, expectedVersion });
  }

  defaultEol(): Promise<Eol> {
    return invoke('default_eol');
  }

  pickFile(): Promise<Path | null> {
    return invoke('pick_file');
  }

  pickSavePath(directory: Path | null, fileName: string): Promise<Path | null> {
    return invoke('pick_save_path', { directory, fileName });
  }
}
