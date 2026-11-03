import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Icon } from './icon';
import { MenuDone, MenuItem, MenuList } from './menu-list';

/** Um botão de ícone que abre um menu (padrão ARIA de botão de menu); o foco volta para ele ao fechar. */
@Component({
  selector: 'app-menu-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, MenuList],
  host: {
    class: 'menu-button',
    '(document:mousedown)': 'closeOutside($event)',
    '(window:blur)': 'open.set(false)',
  },
  template: `
    <button
      #trigger
      type="button"
      [class]="'icon-button ' + buttonClass()"
      aria-haspopup="menu"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="label()"
      [title]="title() || label()"
      (click)="open.set(!open())"
    >
      <app-icon [name]="icon()" />
    </button>
    @if (open()) {
      <app-menu-list
        class="menu menu-popup"
        animate.leave="menu-leave"
        [attr.data-placement]="placement()"
        [items]="items()"
        [label]="label()"
        (done)="onDone($event)"
      />
    }
  `,
})
export class MenuButton {
  readonly items = input.required<(MenuItem | null)[]>();
  readonly label = input.required<string>();
  /** A dica do botão, quando diz mais que o rótulo (ex.: com o atalho). */
  readonly title = input('');
  readonly icon = input.required<string>();
  /** Onde o menu abre em relação ao botão. */
  readonly placement = input<'below-start' | 'below-end' | 'right-end'>('below-start');
  readonly buttonClass = input('');

  protected readonly open = signal(false);
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private readonly trigger = viewChild.required<ElementRef<HTMLElement>>('trigger');

  protected onDone(done: MenuDone): void {
    // ← e → não têm para onde ir fora de uma barra de menus.
    if (done.reason === 'left' || done.reason === 'right') return;
    this.open.set(false);
    if (done.reason !== 'tab') this.trigger().nativeElement.focus();
    if (done.reason === 'chosen') done.item.run?.();
  }

  protected closeOutside(event: MouseEvent): void {
    if (this.open() && !this.host.contains(event.target as Node)) this.open.set(false);
  }
}
