import { Injectable } from '@angular/core';
import { Channel, invoke } from '@tauri-apps/api/core';
import { Language, LanguageEvent } from './ipc';

/** Os servidores de linguagem do núcleo Rust (docs/ipc.md, Linguagem). Quem fala LSP é a interface. */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  /** `onEvent` já recebe o estado `starting`, que chega antes da resposta. */
  start(language: Language, onEvent: (event: LanguageEvent) => void): Promise<void> {
    const channel = new Channel<LanguageEvent>();
    channel.onmessage = onEvent;
    return invoke('language_start', { language, onEvent: channel });
  }

  send(language: Language, message: string): Promise<void> {
    return invoke('language_send', { language, message });
  }

  restart(language: Language): Promise<void> {
    return invoke('language_restart', { language });
  }

  stop(language: Language): Promise<void> {
    return invoke('language_stop', { language });
  }
}
