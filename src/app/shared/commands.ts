import { Injectable } from '@angular/core';
import {
  bindingsFor,
  CommandId,
  defaultKeys,
  formatChord,
  PLATFORM,
  ShortcutDispatcher,
} from './keybindings';

/** Comandos com atalho: a janela e o Monaco despacham por aqui, e as dicas leem o atalho. */
@Injectable({ providedIn: 'root' })
export class Commands {
  readonly bindings = bindingsFor(defaultKeys(PLATFORM), PLATFORM);
  private readonly dispatcher = new ShortcutDispatcher(this.bindings);
  private handlers: Partial<Record<CommandId, () => unknown>> = {};

  register(handlers: Record<CommandId, () => unknown>): void {
    this.handlers = handlers;
  }

  run(id: CommandId): void {
    this.handlers[id]?.();
  }

  /** Trata uma tecla vinda de fora do editor; `true` se ela foi consumida. */
  handleKey(event: KeyboardEvent): boolean {
    const result = this.dispatcher.handle(event);
    if (result && result !== 'consume') this.run(result);
    return result !== null;
  }

  /** Atalho principal do comando, para dicas e menus; vazio se não houver. */
  shortcut(id: CommandId): string {
    const binding = this.bindings.find((item) => item.id === id);
    return binding ? formatChord(binding.chord, PLATFORM) : '';
  }

  /** Rótulo com o atalho entre parênteses: "Abrir pasta (Ctrl+K Ctrl+O)". */
  hint(label: string, id: CommandId): string {
    const shortcut = this.shortcut(id);
    return shortcut ? `${label} (${shortcut})` : label;
  }
}
