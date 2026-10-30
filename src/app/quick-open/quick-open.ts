import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { EditorTabs } from '../editor/editor-tabs';
import { Path } from '../ipc';
import { basename, dirname, isWithin, joinPath, relativeTo } from '../paths';
import { CommandId, Commands } from '../shared/commands';
import { fold, fuzzyScore, highlight, prepareQuery, Segment } from '../shared/fuzzy';
import { CurrentFolder } from '../workspace/current-folder';
import { ProjectIndex } from './project-index';

const RECENT_COMMANDS = 5;
/** Igual ao `--row` e ao `max-height` de `.quick-list` em styles.css. */
const ROW_HEIGHT = 22;
const VISIBLE_ROWS = 20;
const OVERSCAN = 5;

type Mode = 'files' | 'commands' | 'line';

const TITLES: Record<Mode, string> = {
  files: 'Abrir rápido',
  commands: 'Paleta de comandos',
  line: 'Ir para linha',
};

const PLACEHOLDERS: Record<Mode, string> = {
  files: 'Nome do arquivo (> para comandos, : para ir a uma linha)',
  commands: 'Nome do comando',
  line: 'Linha, ou linha:coluna',
};

export interface QuickItem {
  label: Segment[];
  /** Texto em cinza ao lado: a pasta do arquivo. */
  detail: Segment[];
  /** Atalho, alinhado à direita. */
  keys: string;
  /** Título do grupo que começa neste item. */
  section?: string;
  accept(): void;
}

/** O texto do Ctrl+G: `linha` ou `linha:coluna`; nulo se não for isso. */
export function parseLineTarget(text: string): { line: number; column?: number } | null {
  const match = /^\s*(\d+)\s*(?:[:,]\s*(\d+)\s*)?$/.exec(text);
  if (!match) return null;
  return { line: Number(match[1]), column: match[2] ? Number(match[2]) : undefined };
}

/**
 * A caixa no topo da janela (docs/specs/paleta-de-comandos.md): Abrir rápido, paleta de comandos
 * (prefixo `>`) e ir para linha (prefixo `:`), no mesmo campo, como no VS Code.
 */
@Component({
  selector: 'app-quick-open',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './quick-open.html',
})
export class QuickOpen {
  private readonly commands = inject(Commands);
  private readonly tabs = inject(EditorTabs);
  private readonly folder = inject(CurrentFolder);
  private readonly index = inject(ProjectIndex);
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');

  protected readonly visible = signal(false);
  protected readonly value = signal('');
  protected readonly selected = signal(0);
  /** Ajuda: Atalhos de teclado lista só os comandos que têm atalho. */
  private readonly shortcutsOnly = signal(false);
  private readonly recentCommands = signal<CommandId[]>([]);
  private previousFocus: HTMLElement | null = null;

  protected readonly mode = computed<Mode>(() => {
    const value = this.value();
    return value.startsWith('>') ? 'commands' : value.startsWith(':') ? 'line' : 'files';
  });
  protected readonly title = computed(() => TITLES[this.mode()]);
  protected readonly placeholder = computed(() => PLACEHOLDERS[this.mode()]);
  protected readonly items = computed<QuickItem[]>(() => {
    if (!this.visible()) return [];
    const text = this.value();
    switch (this.mode()) {
      case 'commands':
        return this.commandItems(text.slice(1));
      case 'line':
        return this.lineItems(text.slice(1));
      default:
        return this.fileItems(text);
    }
  });
  protected readonly message = computed(() => {
    if (!this.visible()) return '';
    switch (this.mode()) {
      case 'commands':
        return this.items().length ? '' : 'Nenhum comando correspondente';
      case 'line':
        return this.lineMessage();
      default:
        return this.filesMessage();
    }
  });

  /** Lista virtualizada: só as linhas na tela (mais uma margem) viram elementos. */
  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly scrollTop = signal(0);
  protected readonly first = computed(() =>
    Math.max(0, Math.floor(this.scrollTop() / ROW_HEIGHT) - OVERSCAN),
  );
  protected readonly shown = computed(() =>
    this.items().slice(this.first(), this.first() + VISIBLE_ROWS + 2 * OVERSCAN),
  );

  constructor() {
    afterRenderEffect(() => {
      if (this.visible()) this.input()?.nativeElement.focus();
    });
    // Mantém o item escolhido à vista; uma lista nova (outra busca) volta ao topo.
    afterRenderEffect(() => {
      this.items();
      const top = this.selected() * ROW_HEIGHT;
      const list = this.list()?.nativeElement;
      if (!list) return;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight) {
        list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
      }
      this.scrollTop.set(list.scrollTop);
    });
  }

  /** Abre a caixa com `prefix` já digitado: `''` arquivos, `'>'` comandos, `':'` linha. */
  show(prefix: string, shortcutsOnly = false): void {
    if (!this.visible()) this.previousFocus = document.activeElement as HTMLElement | null;
    this.index.watch();
    this.value.set(prefix);
    this.selected.set(0);
    this.shortcutsOnly.set(shortcutsOnly);
    this.visible.set(true);
  }

  /** Fecha; com `restoreFocus`, o foco volta para onde estava antes de abrir. */
  close(restoreFocus = true): void {
    if (!this.visible()) return;
    this.visible.set(false);
    this.index.unwatch();
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (restoreFocus && previous?.isConnected) previous.focus();
  }

  protected onInput(text: string): void {
    this.value.set(text);
    this.selected.set(0);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const count = this.items().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      if (count) this.selected.update((index) => (index + offset + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.accept(this.selected());
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    }
  }

  /** Clicar fora fecha, deixando o foco onde o usuário clicou. */
  protected onFocusOut(event: FocusEvent, dialog: HTMLElement): void {
    if (!dialog.contains(event.relatedTarget as Node | null)) this.close(false);
  }

  protected accept(index: number): void {
    this.items()[index]?.accept();
  }

  private commandItems(query: string): QuickItem[] {
    const ids = this.commands
      .available()
      .filter((id) => !this.shortcutsOnly() || this.commands.shortcut(id));
    const title = (id: CommandId) => this.commands.title(id);
    const prepared = prepareQuery(query);
    if (!prepared) {
      const recent = this.recentCommands().filter((id) => ids.includes(id));
      const others = ids
        .filter((id) => !recent.includes(id))
        .sort((a, b) => title(a).localeCompare(title(b), 'pt-BR'));
      return [
        ...recent.map((id, i) => this.commandItem(id, [], i ? undefined : 'Usados recentemente')),
        ...others.map((id, i) =>
          this.commandItem(id, [], i || !recent.length ? undefined : 'Outros comandos'),
        ),
      ];
    }
    return ids
      .map((id) => {
        const positions: number[] = [];
        return { id, positions, score: fuzzyScore(prepared, fold(title(id)), 0, positions) };
      })
      .filter((match) => match.score >= 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          title(a.id).length - title(b.id).length ||
          title(a.id).localeCompare(title(b.id), 'pt-BR'),
      )
      .map(({ id, positions }) => this.commandItem(id, positions));
  }

  private commandItem(id: CommandId, positions: number[], section?: string): QuickItem {
    return {
      label: highlight(this.commands.title(id), positions),
      detail: [],
      keys: this.commands.shortcut(id),
      section,
      accept: () => {
        this.close();
        this.recentCommands.update((ids) =>
          [id, ...ids.filter((item) => item !== id)].slice(0, RECENT_COMMANDS),
        );
        this.commands.run(id);
      },
    };
  }

  private fileItems(query: string): QuickItem[] {
    const root = this.folder.path();
    if (!prepareQuery(query)) {
      return this.tabs.recentPaths().map((path, i) => {
        const dir = dirname(path);
        const detail = root && isWithin(path, root) ? relativeTo(dir, root) : dir;
        return this.fileItem(
          path,
          plain(basename(path)),
          plain(detail),
          i ? undefined : 'Abertos recentemente',
        );
      });
    }
    const search = this.index.search();
    if (!root || !search) return [];
    return search.search(query).map(({ file, nameStart, positions }) => {
      const dirEnd = Math.max(nameStart - 1, 0);
      const inName = positions.filter((at) => at >= nameStart).map((at) => at - nameStart);
      return this.fileItem(
        joinPath(root, file),
        highlight(file.slice(nameStart), inName),
        highlight(
          file.slice(0, dirEnd),
          positions.filter((at) => at < dirEnd),
        ),
      );
    });
  }

  private fileItem(path: Path, label: Segment[], detail: Segment[], section?: string): QuickItem {
    return {
      label,
      detail,
      keys: '',
      section,
      accept: () => {
        this.close();
        void this.tabs.open(path).then((tab) => tab && this.tabs.requestFocus());
      },
    };
  }

  private lineItems(text: string): QuickItem[] {
    const target = parseLineTarget(text);
    if (!target || !this.hasTextEditor()) return [];
    const { line, column } = target;
    const label = column ? `Ir para a linha ${line}, coluna ${column}` : `Ir para a linha ${line}`;
    return [
      {
        label: plain(label),
        detail: [],
        keys: '',
        accept: () => {
          this.close();
          this.tabs.goTo.set({ line, column: column ?? 1 });
        },
      },
    ];
  }

  private lineMessage(): string {
    if (!this.hasTextEditor()) return 'Abra um arquivo de texto para ir para uma linha.';
    if (this.items().length) return '';
    const cursor = this.tabs.cursor();
    const current = cursor ? `Linha atual: ${cursor.line}, coluna ${cursor.column}. ` : '';
    return `${current}Digite um número de linha, ou linha:coluna.`;
  }

  private filesMessage(): string {
    if (this.index.indexing()) return 'Indexando…';
    if (this.items().length) return '';
    if (!prepareQuery(this.value())) return 'Digite o nome de um arquivo.';
    if (!this.folder.path()) return 'Abra uma pasta para buscar arquivos pelo nome.';
    return 'Nenhum arquivo encontrado';
  }

  private hasTextEditor(): boolean {
    return this.tabs.active()?.view.kind === 'text';
  }
}

function plain(text: string): Segment[] {
  return text ? [{ text, match: false }] : [];
}
