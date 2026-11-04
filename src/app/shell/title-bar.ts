import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { Appearance } from '../shared/appearance';
import { Commands } from '../shared/commands';
import { Icon } from '../shared/icon';
import { PLATFORM } from '../shared/keybindings';
import { WindowService } from '../window.service';
import { MenuBar } from './menu-bar';
import { SettingsMenu } from './settings-menu';

/**
 * A barra única da janela: logo, menus (HTML no Windows e no Linux), busca, tema, configurações e
 * os botões da janela. No macOS, as bolinhas são do sistema, à esquerda, e o menu é o nativo.
 */
@Component({
  selector: 'app-title-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, MenuBar, SettingsMenu],
  host: {
    class: 'title-bar',
    // Arrasta pelo que não é botão nem menu; duplo clique maximiza (docs/ipc.md, Janela).
    'data-tauri-drag-region': 'deep',
    '[class.mac]': '!ownChrome',
  },
  template: `
    <app-icon class="title-logo" name="logo" />
    <span class="title-name">Dark Triad</span>
    @if (ownChrome) {
      <app-menu-bar data-tauri-drag-region="false" />
    }
    <div class="title-center">
      <button
        type="button"
        class="title-search"
        [title]="
          commands.hint('Abrir rápido: arquivos do projeto; digite > para comandos', 'quickOpen')
        "
        (click)="commands.run('quickOpen')"
      >
        <app-icon name="search" />
        <span class="title-search-text">Pesquisar arquivos e comandos</span>
        <kbd>{{ commands.shortcut('quickOpen') }}</kbd>
      </button>
    </div>
    <div class="title-actions" data-tauri-drag-region="false">
      <button
        type="button"
        class="icon-button title-action"
        [attr.aria-label]="themeHint()"
        [title]="themeHint()"
        (click)="appearance.toggleTheme()"
      >
        <app-icon name="color-mode" />
      </button>
      <app-settings-menu buttonClass="title-action" placement="below-end" />
    </div>
    @if (ownChrome) {
      <div class="window-controls" role="group" aria-label="Janela">
        <button
          type="button"
          class="window-button"
          aria-label="Minimizar"
          title="Minimizar"
          (click)="window.minimize()"
        >
          <app-icon name="window-minimize" />
        </button>
        <button
          type="button"
          class="window-button"
          [attr.aria-label]="maximized() ? 'Restaurar' : 'Maximizar'"
          [title]="maximized() ? 'Restaurar' : 'Maximizar'"
          (click)="window.toggleMaximize()"
        >
          <app-icon [name]="maximized() ? 'window-restore' : 'window-maximize'" />
        </button>
        <button
          type="button"
          class="window-button window-close"
          aria-label="Fechar"
          title="Fechar"
          (click)="window.close()"
        >
          <app-icon name="window-close" />
        </button>
      </div>
    }
  `,
})
export class TitleBar {
  protected readonly commands = inject(Commands);
  protected readonly appearance = inject(Appearance);
  protected readonly window = inject(WindowService);
  /** Windows e Linux: janela sem moldura, com menus e botões desenhados aqui. */
  protected readonly ownChrome = PLATFORM !== 'mac';
  protected readonly maximized = signal(false);
  protected readonly themeHint = computed(() =>
    this.appearance.theme() === 'dark' ? 'Mudar para o tema claro' : 'Mudar para o tema escuro',
  );

  constructor() {
    if (!this.ownChrome) return;
    let queued = false;
    // Um pedido por quadro: arrastar a borda dispara dezenas de `onResized`.
    const refresh = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        this.window.isMaximized().then(
          (maximized) => this.maximized.set(maximized),
          () => undefined,
        );
      });
    };
    refresh();
    const unlisten = this.window.onResized(refresh);
    inject(DestroyRef).onDestroy(() => void unlisten.then((stop) => stop()));
  }
}
