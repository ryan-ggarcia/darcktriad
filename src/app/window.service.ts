import { Injectable } from '@angular/core';
import { UnlistenFn } from '@tauri-apps/api/event';
import { Effect, EffectState, getCurrentWindow } from '@tauri-apps/api/window';
import { PLATFORM } from './shared/keybindings';

/** A janela sem moldura: botões, tema e vidro (docs/ipc.md, Janela). */
@Injectable({ providedIn: 'root' })
export class WindowService {
  minimize(): Promise<void> {
    return getCurrentWindow().minimize();
  }

  toggleMaximize(): Promise<void> {
    return getCurrentWindow().toggleMaximize();
  }

  isMaximized(): Promise<boolean> {
    return getCurrentWindow().isMaximized();
  }

  /** Não há evento de maximizar: o ícone □/❐ é relido a cada mudança de tamanho. */
  onResized(handler: () => void): Promise<UnlistenFn> {
    return getCurrentWindow().onResized(() => handler());
  }

  /** Passa pelo `onCloseRequested`, que pergunta sobre os arquivos não salvos. */
  close(): Promise<void> {
    return getCurrentWindow().close();
  }

  setTheme(theme: 'dark' | 'light'): Promise<void> {
    return getCurrentWindow().setTheme(theme);
  }

  /** Liga ou desliga o desfoque da janela; no Linux não faz nada. */
  setGlass(on: boolean): Promise<void> {
    const window = getCurrentWindow();
    if (!on) return window.clearEffects();
    return window.setEffects(
      PLATFORM === 'mac'
        ? { effects: [Effect.UnderWindowBackground], state: EffectState.Active }
        : // Acrylic: desfoca o que está atrás. A cor vem do sistema e acompanha setTheme.
          { effects: [Effect.Acrylic] },
    );
  }
}
