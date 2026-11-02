import { Injectable } from '@angular/core';
import { Channel, invoke } from '@tauri-apps/api/core';
import { DebugEvent, DebugLaunch, Path, TerminalEvent, TerminalInfo } from './ipc';

/** A depuração do núcleo Rust (docs/ipc.md, Depuração). Quem fala DAP é a interface. */
@Injectable({ providedIn: 'root' })
export class DebugService {
  /** Compila o alvo ativo e inicia o adaptador; null se a compilação falhou ou foi cancelada. */
  start(onEvent: (event: DebugEvent) => void): Promise<DebugLaunch | null> {
    const channel = new Channel<DebugEvent>();
    channel.onmessage = onEvent;
    return invoke('debug_start', { onEvent: channel });
  }

  send(message: string): Promise<void> {
    return invoke('debug_send', { message });
  }

  /** O pedido reverso `runInTerminal`: roda o programa no terminal `🐞 <alvo>`. */
  runInTerminal(
    args: string[],
    cwd: Path,
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalInfo> {
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = onEvent;
    return invoke('debug_run_in_terminal', { args, cwd, cols, rows, onEvent: channel });
  }

  /** Encerra à força o adaptador e o programa; vale mesmo sem sessão. */
  stop(): Promise<void> {
    return invoke('debug_stop');
  }
}
