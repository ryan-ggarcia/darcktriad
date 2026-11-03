import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
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
import { OutputView } from '../project/output-view';
import { ProblemsView } from '../project/problems-view';
import { OutputChannels } from '../project/output-channels';
import { Problems } from '../project/problems';
import { Commands } from '../shared/commands';
import { Icon } from '../shared/icon';
import { Panel } from '../shared/panel';
import { readSize, writeSetting } from '../shared/settings';
import { Terminals, TerminalSession } from './terminals';

const MIN_HEIGHT = 100;
const HEIGHT_KEY = 'panelHeight';
/** Espaço que sobra para os editores quando o painel cresce. */
const EDITOR_MIN_HEIGHT = 150;

/**
 * O painel inferior, com as abas Problemas, Saída (canais CMake, dotnet, clangd e C#) e Terminal: na do terminal, a
 * tela do terminal ativo e a lista de terminais à direita.
 */
@Component({
  selector: 'app-terminal-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, OutputView, ProblemsView],
  host: {
    class: 'panel',
    role: 'region',
    'aria-label': 'Painel',
    '[hidden]': '!panel.visible()',
    '[style.height.px]': 'height()',
  },
  templateUrl: './terminal-panel.html',
})
export class TerminalPanel {
  protected readonly terminals = inject(Terminals);
  protected readonly commands = inject(Commands);
  protected readonly panel = inject(Panel);
  protected readonly output = inject(OutputChannels);
  private readonly problems = inject(Problems);
  protected readonly problemCount = computed(() => this.problems.items().length);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  /** Lembrada entre aberturas. */
  protected readonly height = signal(readSize(HEIGHT_KEY, 280, MIN_HEIGHT, 2000));
  private readonly area = viewChild.required<ElementRef<HTMLElement>>('area');
  private readonly hosts = viewChildren<ElementRef<HTMLElement>>('screen');

  constructor() {
    // Mostrar o painel ou trocar de terminal: a tela aparece ajustada e com o foco.
    effect(() => {
      const session = this.terminals.active();
      if (!this.panel.visible() || this.panel.tab() !== 'terminal' || !session) return;
      untracked(() => afterNextRender(() => this.show(session), { injector: this.injector }));
    });
    effect(() => {
      if (!this.panel.focusRequest()) return;
      untracked(() => afterNextRender(() => this.focusTab(), { injector: this.injector }));
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
    const stop = () => {
      sash.removeEventListener('pointermove', move);
      this.saveHeight();
    };
    sash.addEventListener('lostpointercapture', stop, { once: true });
  }

  protected resizeTo(height: number): void {
    const max = window.innerHeight - EDITOR_MIN_HEIGHT;
    this.height.set(Math.round(Math.max(MIN_HEIGHT, Math.min(height, max))));
  }

  /** Pelas setas: muda e já lembra. */
  protected nudge(offset: number): void {
    this.resizeTo(this.height() + offset);
    this.saveHeight();
  }

  private saveHeight(): void {
    writeSetting(HEIGHT_KEY, String(this.height()));
  }

  private show(session: TerminalSession): void {
    const host = this.hostOf(session);
    if (!host) return;
    if (!host.firstChild) session.screen.open(host);
    this.fit(session, host);
    session.screen.focus();
  }

  /** O terminal, ou o botão da aba nas que não têm campo próprio. */
  private focusTab(): void {
    const session = this.terminals.active();
    if (this.panel.tab() === 'terminal' && session) session.screen.focus();
    else this.host.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus();
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
