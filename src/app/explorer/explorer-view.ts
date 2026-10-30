import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Entry, Path } from '../ipc';
import { basename, relativeTo } from '../paths';
import { Commands } from '../shared/commands';
import { Dialogs } from '../shared/dialogs';
import { Icon } from '../shared/icon';
import { PLATFORM } from '../shared/keybindings';
import { CurrentFolder } from '../workspace/current-folder';
import { Workspace } from '../workspace/workspace';
import { EntryRow, ExplorerTree } from './explorer-tree';

const ROW_HEIGHT = 22;
/** Linhas desenhadas além das visíveis, para a rolagem não mostrar buracos. */
const OVERSCAN = 10;
const TYPE_AHEAD_MS = 800;

interface MenuItem {
  label: string;
  shortcut?: string;
  run(): unknown;
}

/** Ícone simples por tipo (docs/specs/explorador.md): C, C++/cabeçalho, C#, CMake e projeto .NET. */
function fileBadge(name: string): { label: string; kind: string } | null {
  const lower = name.toLowerCase();
  if (lower === 'cmakelists.txt') return { label: '▲', kind: 'cmake' };
  const extension = lower.slice(lower.lastIndexOf('.') + 1);
  if (extension === 'c') return { label: 'C', kind: 'c' };
  if (['cpp', 'cc', 'cxx', 'h', 'hpp', 'hh', 'hxx', 'inl'].includes(extension)) {
    return { label: 'C++', kind: 'cpp' };
  }
  if (extension === 'cs') return { label: 'C#', kind: 'cs' };
  if (extension === 'csproj' || extension === 'sln') return { label: '◆', kind: 'project' };
  return null;
}

@Component({
  selector: 'app-explorer-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, NgTemplateOutlet],
  host: { class: 'explorer', '(document:mousedown)': 'closeMenuOutside($event)' },
  templateUrl: './explorer-view.html',
})
export class ExplorerView {
  protected readonly tree = inject(ExplorerTree);
  protected readonly folder = inject(CurrentFolder);
  protected readonly workspace = inject(Workspace);
  protected readonly commands = inject(Commands);
  private readonly dialogs = inject(Dialogs);
  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly fileBadge = fileBadge;

  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly menuElement = viewChild<ElementRef<HTMLElement>>('menu');
  protected readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(0);

  /** Lista virtualizada: só as linhas na tela (mais uma margem) viram elementos. */
  protected readonly first = computed(() =>
    Math.max(0, Math.floor(this.scrollTop() / ROW_HEIGHT) - OVERSCAN),
  );
  protected readonly visibleRows = computed(() => {
    const count = Math.ceil(this.viewportHeight() / ROW_HEIGHT) + 2 * OVERSCAN;
    return this.tree.rows().slice(this.first(), this.first() + count);
  });
  protected readonly rootName = computed(() => {
    const root = this.folder.path();
    return root ? basename(root) || root : '';
  });
  private readonly selectedIndex = computed(() =>
    this.tree.rows().findIndex((row) => row.kind === 'entry' && row.key === this.tree.selected()),
  );
  protected readonly activeId = computed(() =>
    this.selectedIndex() < 0 ? null : `tree-row-${this.selectedIndex()}`,
  );

  protected readonly menu = signal<{ x: number; y: number; entry: Entry | null } | null>(null);
  protected readonly menuItems = computed(() => this.itemsFor(this.menu()?.entry ?? null));

  private typed = '';
  private typedAt = 0;

  constructor() {
    effect((onCleanup) => {
      const element = this.viewport()?.nativeElement;
      if (!element) return;
      // A lista é recriada ao reabrir a pasta: a rolagem antiga não vale para ela.
      this.scrollTop.set(element.scrollTop);
      const observer = new ResizeObserver(() => this.viewportHeight.set(element.clientHeight));
      observer.observe(element);
      onCleanup(() => observer.disconnect());
    });
    // Só a troca de seleção rola a lista; recarregar a pasta não tira o usuário do lugar.
    // Depois de desenhar: a altura da lista já inclui a pasta recém-expandida.
    afterRenderEffect(() => {
      this.tree.selected();
      untracked(() => this.revealSelection());
    });
    afterRenderEffect(() => {
      const input = this.tree.edit() && this.host()?.querySelector<HTMLInputElement>('.tree-input');
      if (!input || document.activeElement === input) return;
      input.focus();
      // Como no VS Code, o nome vem selecionado sem a extensão.
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    });
    afterRenderEffect(() => {
      if (this.menu())
        this.menuElement()?.nativeElement.querySelector<HTMLElement>('button')?.focus();
    });
  }

  /** Ctrl+Shift+E. */
  focus(): void {
    this.viewport()?.nativeElement.focus();
  }

  protected indent(level: number): number {
    return 4 + (level - 1) * 12;
  }

  protected onTreeKeydown(event: KeyboardEvent): void {
    if (this.handleTreeKey(event)) event.preventDefault();
  }

  protected onInputKeydown(event: KeyboardEvent, value: string): void {
    // As teclas do campo de nome não são da árvore.
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.tree.commitEdit(value).then(() => this.tree.edit() || this.focus());
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.tree.cancelEdit();
      this.focus();
    }
  }

  protected openMenu(event: MouseEvent, entry: Entry | null): void {
    event.preventDefault();
    event.stopPropagation();
    if (entry) this.tree.select(entry.path);
    this.showMenu(event.clientX, event.clientY, entry);
  }

  protected runMenuItem(item: MenuItem): void {
    this.menu.set(null);
    // O foco volta para a árvore antes da ação: os diálogos o devolvem para ela ao fechar.
    this.focus();
    item.run();
  }

  protected onMenuKeydown(event: KeyboardEvent): void {
    const items = [...this.menuElement()!.nativeElement.querySelectorAll<HTMLElement>('button')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + offset + items.length) % items.length].focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      this.menu.set(null);
      this.focus();
    }
  }

  protected closeMenuOutside(event: MouseEvent): void {
    if (this.menu() && !this.menuElement()?.nativeElement.contains(event.target as Node)) {
      this.menu.set(null);
    }
  }

  private host(): HTMLElement | undefined {
    return this.viewport()?.nativeElement;
  }

  private handleTreeKey(event: KeyboardEvent): boolean {
    const mac = PLATFORM === 'mac';
    switch (event.key) {
      case 'ArrowDown':
        if (mac && event.metaKey) void this.tree.openSelected();
        else this.tree.moveSelection(1);
        return true;
      case 'ArrowUp':
        this.tree.moveSelection(-1);
        return true;
      case 'Home':
        this.tree.moveSelection(-Infinity);
        return true;
      case 'End':
        this.tree.moveSelection(Infinity);
        return true;
      case 'ArrowRight':
        void this.tree.right();
        return true;
      case 'ArrowLeft':
        this.tree.left();
        return true;
      case 'Enter':
        if (mac) this.tree.startRename();
        else void this.tree.openSelected();
        return true;
      case 'F2':
        if (!mac) this.tree.startRename();
        return !mac;
      case 'Delete':
        if (!mac) void this.tree.remove();
        return !mac;
      case 'Backspace':
        if (mac && event.metaKey) void this.tree.remove();
        return mac && event.metaKey;
      case 'ContextMenu':
        this.openMenuAtSelection();
        return true;
      case 'F10':
        if (event.shiftKey) this.openMenuAtSelection();
        return event.shiftKey;
    }
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (!plain || event.key.length !== 1 || event.key === ' ') return false;
    this.typeAhead(event.key);
    return true;
  }

  private typeAhead(key: string): void {
    const now = Date.now();
    this.typed = now - this.typedAt < TYPE_AHEAD_MS ? this.typed + key : key;
    this.typedAt = now;
    // A mesma letra repetida passa para o próximo item que começa com ela.
    this.tree.typeAhead(/^(.)\1+$/.test(this.typed) ? key : this.typed);
  }

  private revealSelection(): void {
    const element = this.viewport()?.nativeElement;
    const index = this.selectedIndex();
    if (!element || index < 0) return;
    const top = index * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }
  }

  private openMenuAtSelection(): void {
    const row = this.tree.rows()[this.selectedIndex()] as EntryRow | undefined;
    const id = this.activeId();
    const rect = id ? document.getElementById(id)?.getBoundingClientRect() : undefined;
    this.showMenu((rect?.left ?? 0) + 24, rect?.bottom ?? 0, row?.entry ?? null);
  }

  private showMenu(x: number, y: number, entry: Entry | null): void {
    // Mantém o menu dentro da janela.
    this.menu.set({
      x: Math.min(x, window.innerWidth - 260),
      y: Math.min(y, window.innerHeight - 200),
      entry,
    });
  }

  private itemsFor(entry: Entry | null): MenuItem[] {
    const target = entry?.path ?? null;
    const items: MenuItem[] = [
      { label: 'Novo arquivo', run: () => this.tree.startCreate('file', target) },
      { label: 'Nova pasta', run: () => this.tree.startCreate('dir', target) },
    ];
    const root = this.folder.path();
    if (!entry || !root) return items;
    const mac = PLATFORM === 'mac';
    return [
      ...items,
      {
        label: 'Renomear',
        shortcut: mac ? 'Enter' : 'F2',
        run: () => this.tree.startRename(entry.path),
      },
      {
        label: 'Excluir',
        shortcut: mac ? '⌘⌫' : 'Delete',
        run: () => this.tree.remove(entry.path),
      },
      { label: 'Copiar caminho', run: () => this.copy(entry.path) },
      { label: 'Copiar caminho relativo', run: () => this.copy(relativeTo(entry.path, root)) },
    ];
  }

  private copy(text: Path): void {
    navigator.clipboard
      .writeText(text)
      .catch(() => this.dialogs.tell('Não foi possível copiar para a área de transferência.'));
  }
}
