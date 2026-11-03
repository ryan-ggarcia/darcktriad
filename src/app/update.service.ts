import { Injectable } from '@angular/core';
import { Channel, invoke } from '@tauri-apps/api/core';
import { AvailableUpdate, UpdateProgress } from './ipc';

/** A atualização do app no núcleo Rust (docs/ipc.md, Atualização do app). */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  check(): Promise<AvailableUpdate | null> {
    return invoke('update_check');
  }

  install(onEvent: (progress: UpdateProgress) => void): Promise<void> {
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = onEvent;
    return invoke('update_install', { onEvent: channel });
  }

  /** Normalmente não responde: o app já saiu. Não passa pelo `onCloseRequested`. */
  restart(): Promise<void> {
    return invoke('update_restart');
  }
}
