import { effect, inject, Injectable, Injector, signal, untracked } from '@angular/core';
import { WindowService } from '../window.service';
import { PLATFORM } from './keybindings';
import { readSetting, writeSetting } from './settings';

export type Theme = 'dark' | 'light';
/** A fonte do código no editor e no terminal (public/fonts, licença OFL). */
export const CODE_FONT = "'JetBrains Mono'";
export type Material = 'glass' | 'solid';

/** O Acrylic só é fluido a partir do Windows 11 22H2 (`platformVersion` 14); antes, a janela fica lenta. */
export async function hasFluidAcrylic(): Promise<boolean> {
  const data = (
    navigator as {
      userAgentData?: {
        getHighEntropyValues?(hints: string[]): Promise<{ platformVersion?: string }>;
      };
    }
  ).userAgentData;
  const values = await data?.getHighEntropyValues?.(['platformVersion']).catch(() => null);
  return Number(values?.platformVersion?.split('.')[0]) >= 14;
}

function storedMaterial(): Material | null {
  const stored = readSetting('material');
  return stored === 'glass' || stored === 'solid' ? stored : null;
}

/**
 * Tema (escuro/claro) e material (vidro/sólido) da IDE inteira: interface, editor, terminal e janela.
 * O tema vale antes da primeira pintura (public/boot.js lê a mesma chave). O vidro só aparece com o
 * efeito da janela já ligado; antes disso, e no modo sólido, o fundo é opaco (docs/ipc.md, Janela).
 */
@Injectable({ providedIn: 'root' })
export class Appearance {
  private readonly window = inject(WindowService);
  private readonly injector = inject(Injector);

  readonly theme = signal<Theme>(readSetting('theme') === 'light' ? 'light' : 'dark');
  /** A escolha do usuário. No Linux o vidro não desfoca e depende do compositor: começa sólido. */
  readonly material = signal<Material>(
    storedMaterial() ?? (PLATFORM === 'linux' ? 'solid' : 'glass'),
  );
  /** No Windows, só se sabe depois de perguntar a versão do sistema. */
  readonly glassSupported = signal(PLATFORM !== 'windows');
  /** O vidro que está na tela agora, com o efeito da janela ligado. */
  readonly glass = signal(false);
  private applying: Promise<unknown> = Promise.resolve();

  start(): void {
    const root = document.documentElement;
    // O vidro do Linux não desfoca: styles.css o deixa mais opaco.
    root.dataset['platform'] = PLATFORM;
    effect(
      () => {
        const theme = this.theme();
        root.dataset['theme'] = theme;
        writeSetting('theme', theme);
        this.window
          .setTheme(theme)
          .catch((error) => console.warn('Falha no tema da janela', error));
      },
      { injector: this.injector },
    );
    effect(
      () => {
        writeSetting('material', this.material());
        const glass = this.material() === 'glass' && this.glassSupported();
        // Em fila: trocar rápido não pode deixar o fundo transparente com o efeito desligado.
        untracked(() => (this.applying = this.applying.then(() => this.apply(glass))));
      },
      { injector: this.injector },
    );
    if (PLATFORM === 'windows') void hasFluidAcrylic().then((yes) => this.glassSupported.set(yes));
  }

  toggleTheme(): void {
    this.theme.update((theme) => (theme === 'dark' ? 'light' : 'dark'));
  }

  toggleMaterial(): void {
    this.material.update((material) => (material === 'glass' ? 'solid' : 'glass'));
  }

  /** O efeito sempre por baixo: liga antes de clarear o fundo, e o fundo fica opaco antes de desligar. */
  private async apply(glass: boolean): Promise<void> {
    const root = document.documentElement;
    if (glass) {
      try {
        await this.window.setGlass(true);
      } catch (error) {
        console.warn('Falha ao ligar o vidro da janela', error);
        return;
      }
      root.dataset['material'] = 'glass';
      this.glass.set(true);
    } else {
      root.dataset['material'] = 'solid';
      this.glass.set(false);
      await this.window.setGlass(false).catch(() => undefined);
    }
  }
}
