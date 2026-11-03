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
import { Icon } from './icon';

export interface MenuItem {
  label: string;
  /** Atalho, à direita. */
  shortcut?: string;
  /** Item de escolha (tema, material): a marca mostra o que vale. */
  checked?: boolean;
  /** Fica no menu, apagado, e não faz nada (comando que não vale agora). */
  disabled?: boolean;
  /** Dica no lugar do rótulo com o atalho (ex.: por que está apagado). */
  hint?: string;
  run?: () => unknown;
  /** Submenu (ex.: Pastas recentes). */
  items?: (MenuItem | null)[];
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
            [attr.role]="item.checked === undefined ? 'menuitem' : 'menuitemradio'"
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
            <span class="menu-label">{{ item.label }}</span>
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
        return;
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
