import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
} from '@angular/core';
import { MenuEntry } from '../ipc';
import { MainMenu } from '../main-menu';
import { Commands, isCommandId } from '../shared/commands';
import { Dialogs } from '../shared/dialogs';
import { MenuDone, MenuItem, MenuList } from '../shared/menu-list';

/** A letra do Alt+letra de cada menu; sublinhada enquanto o Alt está apertado. */
const MNEMONICS: Record<string, string> = {
  Arquivo: 'a',
  Editar: 'e',
  Ver: 'v',
  Ir: 'i',
  Executar: 'x',
  Ajuda: 'j',
};

/**
 * Os menus Arquivo, Editar… na barra da janela, no Windows e no Linux (padrão ARIA `menubar`).
 * Alt sozinho ou F10 foca a barra; Alt+letra abre um menu; setas andam e abrem; Enter escolhe;
 * Esc volta para onde estava.
 */
@Component({
  selector: 'app-menu-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MenuList],
  host: {
    class: 'menu-bar',
    role: 'menubar',
    'aria-label': 'Menu principal',
    '(keydown)': 'onKeydown($event)',
    '(document:mousedown)': 'closeOutside($event)',
    '[class.mnemonics]': 'altHeld()',
    '(window:blur)': 'open.set(null); altHeld.set(false)',
  },
  template: `
    @for (menu of menus(); track menu.label; let i = $index) {
      <div class="menu-bar-item">
        <button
          type="button"
          class="menu-bar-button"
          role="menuitem"
          aria-haspopup="menu"
          [class.open]="open() === i"
          [attr.aria-expanded]="open() === i"
          [attr.tabindex]="i === current() ? 0 : -1"
          [attr.aria-keyshortcuts]="'Alt+' + menu.mnemonic.toUpperCase()"
          [title]="'Menu ' + menu.label + ' (Alt+' + menu.mnemonic.toUpperCase() + ')'"
          (mousedown)="$event.preventDefault()"
          (click)="toggle(i)"
          (mouseenter)="hover(i)"
        >
          @let at = menu.label.toLowerCase().indexOf(menu.mnemonic);
          {{ menu.label.slice(0, at) }}<span class="mnemonic">{{ menu.label[at] }}</span
          >{{ menu.label.slice(at + 1) }}
        </button>
        @if (open() === i) {
          <app-menu-list
            class="menu menu-popup"
            animate.leave="menu-leave"
            [items]="menu.items"
            [label]="menu.label"
            [focusOnOpen]="focusOnOpen"
            (done)="onDone($event)"
          />
        }
      </div>
    }
  `,
})
export class MenuBar {
  private readonly mainMenu = inject(MainMenu);
  private readonly commands = inject(Commands);
  private readonly dialogs = inject(Dialogs);
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private readonly destroyRef = inject(DestroyRef);

  /** Lê a disponibilidade dos comandos: itens que não valem agora aparecem apagados. */
  protected readonly menus = computed(() =>
    this.mainMenu.entries().flatMap((entry) =>
      entry.kind === 'submenu'
        ? [
            {
              label: entry.label,
              mnemonic: MNEMONICS[entry.label],
              items: this.toItems(entry.items),
            },
          ]
        : [],
    ),
  );
  protected readonly open = signal<number | null>(null);
  protected readonly altHeld = signal(false);
  /** O menu que recebe o Tab dentro da barra (tabindex móvel). */
  protected readonly current = signal(0);
  protected focusOnOpen: 'first' | 'last' = 'first';
  /** Onde o foco estava antes de entrar na barra: volta para lá ao sair. */
  private returnFocus: HTMLElement | null = null;

  constructor() {
    afterNextRender(() => {
      // Na captura: o editor e o terminal tratam as teclas e não as deixam subir até a janela.
      let altAlone = false;
      const down = (event: KeyboardEvent) => {
        altAlone = event.key === 'Alt' && !event.ctrlKey && !event.shiftKey && !event.metaKey;
        const plain = !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
        // No terminal, Alt+letra é do shell (Alt+F, Alt+B), como no VS Code.
        const mnemonic =
          event.altKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.metaKey &&
          !(document.activeElement as Element | null)?.closest('.xterm');
        this.altHeld.set(mnemonic);
        if (mnemonic && this.openByLetter(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        // Pausado na depuração, o F10 é "Passar por cima", como no VS Code.
        if (event.key === 'F10' && plain && !this.commands.isAvailable('debugStepOver')) {
          event.preventDefault();
          event.stopPropagation();
          this.toggleFocus();
        }
      };
      const up = (event: KeyboardEvent) => {
        if (event.key === 'Alt') this.altHeld.set(false);
        if (event.key === 'Alt' && altAlone) {
          event.preventDefault();
          this.toggleFocus();
        }
        altAlone = false;
      };
      // Alt+clique no editor (vários cursores) não é Alt sozinho.
      const pointer = () => (altAlone = false);
      window.addEventListener('keydown', down, true);
      window.addEventListener('keyup', up, true);
      window.addEventListener('pointerdown', pointer, true);
      this.destroyRef.onDestroy(() => {
        window.removeEventListener('keydown', down, true);
        window.removeEventListener('keyup', up, true);
        window.removeEventListener('pointerdown', pointer, true);
      });
    });
  }

  /** Alt ou F10: entra na barra pelo primeiro menu; de novo, volta para onde estava. */
  toggleFocus(): void {
    if (this.dialogs.current()) return;
    if (this.host.contains(document.activeElement)) {
      this.leave();
      return;
    }
    this.remember();
    this.current.set(0);
    this.buttons()[0]?.focus();
  }

  protected toggle(index: number): void {
    if (this.open() === index) {
      this.leave();
      return;
    }
    this.remember();
    this.show(index, 'first');
  }

  /** Com um menu aberto, passar o mouse em outro o abre, como nos menus do sistema. */
  protected hover(index: number): void {
    if (this.open() !== null && this.open() !== index) this.show(index, 'first');
  }

  protected onKeydown(event: KeyboardEvent): void {
    // As teclas dos itens são tratadas pela lista do menu aberto.
    if (!(event.target as Element).classList.contains('menu-bar-button')) return;
    const count = this.menus().length;
    const index = this.current();
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowLeft':
        this.move((index + (event.key === 'ArrowRight' ? 1 : -1) + count) % count);
        break;
      case 'Home':
        this.move(0);
        break;
      case 'End':
        this.move(count - 1);
        break;
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        this.show(index, 'first');
        break;
      case 'ArrowUp':
        this.show(index, 'last');
        break;
      case 'Escape':
      case 'Tab':
        this.leave();
        break;
      default:
        if (event.ctrlKey || event.metaKey || !this.openByLetter(event.key)) return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  protected onDone(done: MenuDone): void {
    const count = this.menus().length;
    const index = this.open() ?? this.current();
    switch (done.reason) {
      case 'left':
      case 'right':
        this.show((index + (done.reason === 'right' ? 1 : -1) + count) % count, 'first');
        break;
      case 'escape':
        this.open.set(null);
        this.buttons()[index]?.focus();
        break;
      case 'tab':
        this.leave();
        break;
      case 'chosen':
        // O foco volta antes: "Copiar" e "Colar" agem no editor que estava com ele.
        this.leave();
        done.item.run?.();
    }
  }

  protected closeOutside(event: MouseEvent): void {
    if (this.open() !== null && !this.host.contains(event.target as Node)) this.open.set(null);
  }

  /** Abre o menu da letra; `false` se nenhum usa essa letra ou há uma pergunta aberta. */
  private openByLetter(key: string): boolean {
    if (this.dialogs.current()) return false;
    const index = this.menus().findIndex((menu) => menu.mnemonic === key.toLowerCase());
    if (index < 0) return false;
    this.remember();
    this.show(index, 'first');
    return true;
  }

  private show(index: number, focus: 'first' | 'last'): void {
    this.focusOnOpen = focus;
    this.current.set(index);
    this.open.set(index);
  }

  /** Só anda pela barra; com um menu aberto, abre o vizinho no lugar dele. */
  private move(index: number): void {
    if (this.open() !== null) {
      this.show(index, 'first');
      return;
    }
    this.current.set(index);
    this.buttons()[index]?.focus();
  }

  private leave(): void {
    this.open.set(null);
    const target = this.returnFocus;
    this.returnFocus = null;
    if (target?.isConnected) target.focus();
    // O body não recebe foco: sem outro lugar para onde voltar, o foco só sai da barra.
    if (this.host.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  private remember(): void {
    if (!this.host.contains(document.activeElement)) {
      this.returnFocus = document.activeElement as HTMLElement | null;
    }
  }

  private buttons(): HTMLElement[] {
    return [...this.host.querySelectorAll<HTMLElement>('.menu-bar-button')];
  }

  private toItems(entries: MenuEntry[]): (MenuItem | null)[] {
    return entries.map((entry) => {
      if (entry.kind === 'separator') return null;
      if (entry.kind === 'submenu') return { label: entry.label, items: this.toItems(entry.items) };
      const { id } = entry;
      return {
        label: entry.label,
        shortcut: entry.accelerator ?? undefined,
        disabled: isCommandId(id) && !this.commands.isAvailable(id),
        run: () => this.mainMenu.run(id),
      };
    });
  }
}
