import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { Commands } from '../shared/commands';
import { Icon } from '../shared/icon';
import { Terminals, TerminalSession } from './terminals';

const MIN_HEIGHT = 100;
/** Espaço que sobra para os editores quando o painel cresce. */
const EDITOR_MIN_HEIGHT = 150;

/**
 * O painel inferior, por enquanto só com a aba Terminal (Problemas e Saída chegam com as specs
 * deles): a tela do terminal ativo e a lista de terminais à direita.
 */
@Component({
  selector: 'app-terminal-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: {
    class: 'panel',
    role: 'region',
    'aria-label': 'Painel',
    '[hidden]': '!terminals.visible()',
    '[style.height.px]': 'height()',
  },
  templateUrl: './terminal-panel.html',
})
export class TerminalPanel {
  protected readonly terminals = inject(Terminals);
  protected readonly commands = inject(Commands);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly height = signal(280);
  private readonly area = viewChild.required<ElementRef<HTMLElement>>('area');
  private readonly hosts = viewChildren<ElementRef<HTMLElement>>('screen');

  constructor() {
    // Mostrar o painel ou trocar de terminal: a tela aparece ajustada e com o foco.
    effect(() => {
      const session = this.terminals.active();
      if (!this.terminals.visible() || !session) return;
      untracked(() => afterNextRender(() => this.show(session), { injector: this.injector }));
    });
    afterNextRender(() => {
      const observer = new ResizeObserver(() => this.fitActive());
      observer.observe(this.area().nativeElement);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  protected startResize(event: PointerEvent): void {
    const sash = event.currentTarget as HTMLElement;
    const startY = event.clientY;
    const startHeight = this.height();
    sash.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent) => this.resizeTo(startHeight + startY - moved.clientY);
    sash.addEventListener('pointermove', move);
    const stop = () => sash.removeEventListener('pointermove', move);
    sash.addEventListener('lostpointercapture', stop, { once: true });
  }

  protected resizeTo(height: number): void {
    const max = window.innerHeight - EDITOR_MIN_HEIGHT;
    this.height.set(Math.round(Math.max(MIN_HEIGHT, Math.min(height, max))));
  }

  private show(session: TerminalSession): void {
    const host = this.hostOf(session);
    if (!host) return;
    if (!host.firstChild) session.screen.open(host);
    this.fit(session, host);
    session.screen.focus();
  }

  private fitActive(): void {
    const session = this.terminals.active();
    const host = session && this.hostOf(session);
    if (host?.firstChild) this.fit(session!, host);
  }

  /** Escondido, o elemento mede zero, e o ajuste mandaria ao processo um tamanho de 1 linha. */
  private fit(session: TerminalSession, host: HTMLElement): void {
    if (host.clientWidth && host.clientHeight) session.screen.fit();
  }

  private hostOf(session: TerminalSession): HTMLElement | undefined {
    return this.hosts()[this.terminals.sessions().indexOf(session)]?.nativeElement;
  }
}
