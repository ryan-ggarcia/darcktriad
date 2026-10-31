import { Injectable } from '@angular/core';
import { Channel, invoke } from '@tauri-apps/api/core';
import { TerminalEvent, TerminalInfo } from './ipc';

/** Os terminais do núcleo Rust (docs/ipc.md, Terminal). */
@Injectable({ providedIn: 'root' })
export class TerminalService {
  /** `onEvent` já recebe a saída que chegar antes da resposta. */
  create(
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalInfo> {
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = onEvent;
    return invoke('terminal_create', { cols, rows, onEvent: channel });
  }

  write(id: number, data: string): Promise<void> {
    return invoke('terminal_write', { id, data });
  }

  resize(id: number, cols: number, rows: number): Promise<void> {
    return invoke('terminal_resize', { id, cols, rows });
  }

  close(id: number): Promise<void> {
    return invoke('terminal_close', { id });
  }
}
