import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { fold } from './fuzzy';
import { Icon } from './icon';

export interface MenuItem {
  label: string;
  /** Atalho, à direita. */
  shortcut?: string;
  /** Item de escolha (tema, material): a marca mostra o que vale. */
  checked?: boolean;
  /** A marca liga e desliga sozinha, sem ser uma entre várias opções. */
  toggle?: boolean;
  /** Fica no menu, apagado, e não faz nada (comando que não vale agora). */
  disabled?: boolean;
  /** Dica no lugar do rótulo com o atalho (ex.: por que está apagado). */
  hint?: string;
  run?: () => unknown;
  /** Submenu (ex.: Pastas recentes). */
  items?: (MenuItem | null)[];
}

/**
 * A posição da letra de cada item: a primeira livre entre as iniciais das palavras e, depois,
 * entre as outras letras; -1 sem letra livre.
 */
export function mnemonicPositions(labels: (string | null)[]): number[] {
  const taken = new Set<string>();
  return labels.map((label) => {
    if (!label) return -1;
    const letters = [...label.matchAll(/[\p{L}\d]/gu)].map((match) => match.index);
    const initials = letters.filter((at) => at === 0 || !/[\p{L}\d]/u.test(label[at - 1]));
    const at = [...initials, ...letters].find((position) => !taken.has(fold(label[position])));
    if (at === undefined) return -1;
    taken.add(fold(label[at]));
    return at;
  });
}

/** Como o menu fechou: o dono devolve o foco, roda o item escolhido ou abre o menu vizinho. */
export type MenuDone =
  { reason: 'chosen'; item: MenuItem } | { reason: 'escape' | 'tab' | 'left' | 'right' };

/**
 * Uma lista de menu (padrão ARIA `menu`): setas, Home/End, Enter/Espaço, → abre o submenu, ← e Esc
 * voltam. `null` em `items` é um separador.
 */
@Component({
  selector: 'app-menu-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { role: 'menu', '[attr.aria-label]': 'label()', '(keydown)': 'onKeydown($event)' },
  template: `
    @for (item of items(); track $index; let i = $index) {
      @if (item) {
        <div class="menu-row" role="none">
          <button
            type="button"
            class="menu-item"
            tabindex="-1"
            [attr.data-index]="i"
            [attr.role]="
              item.toggle
                ? 'menuitemcheckbox'
                : item.checked === undefined
                  ? 'menuitem'
                  : 'menuitemradio'
            "
            [attr.aria-keyshortcuts]="parts()[i][1].toUpperCase() || null"
            [attr.aria-checked]="item.checked ?? null"
            [attr.aria-disabled]="item.disabled || null"
            [attr.aria-haspopup]="item.items ? 'menu' : null"
            [attr.aria-expanded]="item.items ? submenu()?.index === i : null"
            [title]="
              item.hint ?? (item.shortcut ? item.label + ' (' + item.shortcut + ')' : item.label)
            "
            (click)="choose(i)"
            (mouseenter)="hover(i, $any($event.currentTarget))"
          >
            @if (checks()) {
              <span class="menu-check" aria-hidden="true">{{ item.checked ? '✓' : '' }}</span>
            }
            <span class="menu-label"
              >{{ parts()[i][0] }}<span class="mnemonic">{{ parts()[i][1] }}</span
              >{{ parts()[i][2] }}</span
            >
            @if (item.shortcut) {
              <kbd class="menu-shortcut">{{ item.shortcut }}</kbd>
            }
            @if (item.items) {
              <app-icon class="menu-arrow" name="chevron-right" />
            }
          </button>
          @if (item.items && submenu()?.index === i) {
            <app-menu-list
              class="menu submenu"
              animate.leave="menu-leave"
              [items]="item.items"
              [label]="item.label"
              [focusOnOpen]="submenu()!.focus"
              (done)="onSubmenuDone($event)"
            />
          }
        </div>
      } @else {
        <div class="menu-separator" role="separator"></div>
      }
    }
  `,
})
export class MenuList {
  readonly items = input.required<(MenuItem | null)[]>();
  readonly label = input.required<string>();
  /** O item que recebe o foco ao abrir; nulo deixa o foco onde está (submenu aberto pelo mouse). */
  readonly focusOnOpen = input<'first' | 'last' | null>('first');
  readonly done = output<MenuDone>();

  protected readonly submenu = signal<{ index: number; focus: 'first' | null } | null>(null);
  protected readonly checks = computed(() =>
    this.items().some((item) => item?.checked !== undefined),
  );
  /** Cada rótulo em três partes: antes da letra, a letra (vazia se não houver) e depois. */
  protected readonly parts = computed(() => {
    const labels = this.items().map((item) => item?.label ?? null);
    const positions = mnemonicPositions(labels);
    return labels.map((label, index) => {
      const at = positions[index];
      return at < 0
        ? [label ?? '', '', '']
        : [label!.slice(0, at), label![at], label!.slice(at + 1)];
    });
  });
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;

  constructor() {
    afterNextRender(() => {
      const at = this.focusOnOpen();
      if (at) this.focusAt(at === 'first' ? 0 : this.buttons().length - 1);
    });
  }

  protected choose(index: number): void {
    const item = this.items()[index];
    if (!item || item.disabled) return;
    if (item.items) this.submenu.set({ index, focus: 'first' });
    else this.done.emit({ reason: 'chosen', item });
  }

  protected hover(index: number, button: HTMLElement): void {
    button.focus({ preventScroll: true });
    this.submenu.set(this.items()[index]?.items ? { index, focus: null } : null);
  }

  protected onSubmenuDone(done: MenuDone): void {
    const index = this.submenu()!.index;
    if (done.reason === 'left' || done.reason === 'escape') {
      this.submenu.set(null);
      this.buttons()
        .find((button) => Number(button.dataset['index']) === index)
        ?.focus();
    } else {
      this.done.emit(done);
    }
  }

  private chooseByLetter(key: string): boolean {
    const letter = fold(key);
    const index = this.parts().findIndex((parts) => parts[1] && fold(parts[1]) === letter);
    if (index < 0) return false;
    this.choose(index);
    return true;
  }

  protected onKeydown(event: KeyboardEvent): void {
    const buttons = this.buttons();
    const current = buttons.indexOf(document.activeElement as HTMLElement);
    const index = Number(buttons[current]?.dataset['index']);
    switch (event.key) {
      case 'ArrowDown':
        this.focusAt((current + 1) % buttons.length);
        break;
      case 'ArrowUp':
        this.focusAt(current <= 0 ? buttons.length - 1 : current - 1);
        break;
      case 'Home':
        this.focusAt(0);
        break;
      case 'End':
        this.focusAt(buttons.length - 1);
        break;
      case 'Enter':
      case ' ':
        if (current >= 0) this.choose(index);
        break;
      case 'ArrowRight':
        if (current >= 0 && this.items()[index]?.items) this.choose(index);
        else this.done.emit({ reason: 'right' });
        break;
      case 'ArrowLeft':
        this.done.emit({ reason: 'left' });
        break;
      case 'Escape':
        this.done.emit({ reason: 'escape' });
        break;
      case 'Tab':
        this.done.emit({ reason: 'tab' });
        break;
      default:
        // A letra do item o escolhe, como nos menus do sistema; item apagado não faz nada.
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        if (!this.chooseByLetter(event.key)) return;
    }
    // Um submenu trata a tecla e ela não chega ao menu de fora nem aos atalhos da IDE.
    event.preventDefault();
    event.stopPropagation();
  }

  private focusAt(position: number): void {
    this.buttons()[position]?.focus();
  }

  /** Os itens desta lista, sem os do submenu aberto. */
  private buttons(): HTMLElement[] {
    return [...this.host.querySelectorAll<HTMLElement>(':scope > .menu-row > .menu-item')];
  }
}
