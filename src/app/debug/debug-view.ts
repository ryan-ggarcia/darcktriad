import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { EditorTabs } from '../editor/editor-tabs';
import { basename } from '../paths';
import { Commands } from '../shared/commands';
import { Icon } from '../shared/icon';
import { Breakpoint, Breakpoints } from './breakpoints';
import { UNBOUND_HINT } from './debug-decorations';
import { Debugger, sourcePath, StackFrame, VariableNode } from './debugger';

/** As variáveis abertas, em linhas com a profundidade, para a lista da tela. */
export function flatten(
  nodes: VariableNode[],
  depth = 0,
  rows: { node: VariableNode; depth: number }[] = [],
): { node: VariableNode; depth: number }[] {
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.expanded()) flatten(node.children() ?? [], depth + 1, rows);
  }
  return rows;
}

type Section = 'variables' | 'stack' | 'breakpoints';

/** A visão Executar e Depurar (Ctrl+Shift+D): Variáveis, Pilha de chamadas e Pontos de parada. */
@Component({
  selector: 'app-debug-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'debug-view' },
  template: `
    <header class="explorer-header">
      <h2 class="explorer-root">Executar e Depurar</h2>
    </header>
    @if (!debug.state()) {
      <div class="debug-start">
        <button
          type="button"
          class="primary"
          [title]="commands.hint('Compilar o alvo ativo e iniciar a depuração', 'debugStart')"
          [disabled]="!commands.isAvailable('debugStart')"
          (click)="commands.run('debugStart')"
        >
          Iniciar depuração
        </button>
        <p class="debug-note">
          Marque uma linha com {{ commands.shortcut('toggleBreakpoint') }} ou um clique na margem à
          esquerda dos números para o programa parar nela.
        </p>
      </div>
    }

    <section class="debug-section">
      <button
        type="button"
        class="debug-section-title"
        [attr.aria-expanded]="open().variables"
        (click)="flip('variables')"
      >
        <app-icon [name]="open().variables ? 'chevron-down' : 'chevron-right'" />
        Variáveis
      </button>
      @if (open().variables) {
        @if (rows().length) {
          <ul class="debug-list" aria-label="Variáveis">
            @for (row of rows(); track row.node) {
              @let node = row.node;
              <li>
                <button
                  type="button"
                  class="debug-row"
                  [style.padding-left.px]="8 + row.depth * 12"
                  [attr.aria-expanded]="node.expandable ? node.expanded() : null"
                  [attr.aria-label]="describe(node)"
                  [title]="describe(node)"
                  (click)="node.expandable && debug.toggle(node)"
                >
                  @if (node.expandable) {
                    <app-icon [name]="node.expanded() ? 'chevron-down' : 'chevron-right'" />
                  } @else {
                    <span class="debug-spacer"></span>
                  }
                  <span class="debug-name">{{ node.name }}</span>
                  @if (node.value) {
                    <span class="debug-value">= {{ node.value }}</span>
                  }
                </button>
              </li>
            }
          </ul>
        } @else {
          <p class="debug-empty">
            {{
              debug.state() === 'paused'
                ? 'Nenhuma variável neste ponto.'
                : 'As variáveis aparecem com o programa pausado.'
            }}
          </p>
        }
      }
    </section>

    <section class="debug-section">
      <button
        type="button"
        class="debug-section-title"
        [attr.aria-expanded]="open().stack"
        (click)="flip('stack')"
      >
        <app-icon [name]="open().stack ? 'chevron-down' : 'chevron-right'" />
        Pilha de chamadas
      </button>
      @if (open().stack) {
        @if (debug.threads().length) {
          <ul class="debug-list" aria-label="Pilha de chamadas">
            @for (thread of debug.threads(); track thread) {
              <li>
                <button
                  type="button"
                  class="debug-row"
                  [attr.aria-expanded]="thread.expanded()"
                  [title]="'Thread ' + thread.name"
                  (click)="debug.toggleThread(thread)"
                >
                  <app-icon [name]="thread.expanded() ? 'chevron-down' : 'chevron-right'" />
                  <span class="debug-name">{{ thread.name }}</span>
                </button>
                @if (thread.expanded()) {
                  <ul class="debug-list">
                    @for (frame of thread.frames() ?? []; track frame.id) {
                      <li>
                        <button
                          type="button"
                          class="debug-row debug-frame"
                          [class.selected]="frame === debug.frame()"
                          [class.debug-subtle]="!hasSource(frame)"
                          [title]="frameHint(frame)"
                          (click)="debug.selectFrame(frame)"
                        >
                          <span class="debug-name">{{ frame.name }}</span>
                          <span class="debug-location">{{ frameLocation(frame) }}</span>
                        </button>
                      </li>
                    }
                  </ul>
                }
              </li>
            }
          </ul>
        } @else {
          <p class="debug-empty">A pilha aparece com o programa pausado.</p>
        }
      }
    </section>

    <section class="debug-section">
      <div class="debug-section-header">
        <button
          type="button"
          class="debug-section-title"
          [attr.aria-expanded]="open().breakpoints"
          (click)="flip('breakpoints')"
        >
          <app-icon [name]="open().breakpoints ? 'chevron-down' : 'chevron-right'" />
          Pontos de parada
        </button>
        @if (breakpoints.list().length) {
          <button
            type="button"
            class="panel-text-button"
            title="Remover todos os pontos de parada"
            (click)="commands.run('removeAllBreakpoints')"
          >
            Remover todos
          </button>
        }
      </div>
      @if (open().breakpoints) {
        @if (breakpoints.list().length) {
          <ul class="debug-list" aria-label="Pontos de parada">
            @for (point of breakpoints.list(); track point.file + ':' + point.line) {
              <li class="debug-breakpoint-item">
                <button
                  type="button"
                  class="debug-row"
                  [title]="pointHint(point)"
                  (click)="openPoint(point)"
                >
                  <span
                    class="debug-dot"
                    [class.unbound]="point.verified === false"
                    aria-hidden="true"
                  ></span>
                  <span class="debug-name">{{ pointLabel(point) }}</span>
                </button>
                <button
                  type="button"
                  class="icon-button"
                  [attr.aria-label]="'Remover o ponto de parada ' + pointLabel(point)"
                  title="Remover ponto de parada"
                  (click)="breakpoints.remove(point)"
                >
                  <app-icon name="close" />
                </button>
              </li>
            }
          </ul>
        } @else {
          <p class="debug-empty">Nenhum ponto de parada.</p>
        }
      }
    </section>
  `,
})
export class DebugView {
  protected readonly debug = inject(Debugger);
  protected readonly breakpoints = inject(Breakpoints);
  protected readonly commands = inject(Commands);
  private readonly tabs = inject(EditorTabs);
  protected readonly open = signal<Record<Section, boolean>>({
    variables: true,
    stack: true,
    breakpoints: true,
  });
  protected readonly rows = computed(() => flatten(this.debug.scopes()));

  protected flip(section: Section): void {
    this.open.update((open) => ({ ...open, [section]: !open[section] }));
  }

  /** Nome, tipo e o valor inteiro: o da linha pode estar cortado. */
  protected describe(node: VariableNode): string {
    const type = node.type ? `: ${node.type}` : '';
    return node.value ? `${node.name}${type} = ${node.value}` : node.name;
  }

  protected frameLocation(frame: StackFrame): string {
    const path = sourcePath(frame);
    return path ? `${basename(path)}:${frame.line}` : (frame.source?.name ?? 'sem código-fonte');
  }

  protected frameHint(frame: StackFrame): string {
    const path = sourcePath(frame);
    return path ? `${frame.name}: ${path}:${frame.line}` : `${frame.name}: sem código-fonte`;
  }

  protected hasSource(frame: StackFrame): boolean {
    return sourcePath(frame) !== null;
  }

  protected pointLabel(point: Breakpoint): string {
    return `${basename(point.file)}:${point.line}`;
  }

  protected pointHint(point: Breakpoint): string {
    const where = `${point.file}:${point.line}`;
    return point.verified === false ? `${where}. ${UNBOUND_HINT}` : `Ir para ${where}`;
  }

  protected openPoint(point: Breakpoint): void {
    void this.tabs.openAt(point.file, { line: point.line, column: 1 });
  }
}
