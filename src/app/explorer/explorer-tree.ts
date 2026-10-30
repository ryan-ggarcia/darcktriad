import { computed, inject, Injectable, signal } from '@angular/core';
import { EditorTabs } from '../editor/editor-tabs';
import { ExplorerService } from '../explorer.service';
import { ChangeBatch, Entry, errorKind, errorMessage, Path } from '../ipc';
import { basename, dirname, isWithin, replacePrefix } from '../paths';
import { Dialogs } from '../shared/dialogs';
import { CurrentFolder } from '../workspace/current-folder';

type Listing = { entries: Entry[] } | { error: string };

export interface EntryRow {
  kind: 'entry';
  key: string;
  entry: Entry;
  level: number;
  expanded: boolean;
  /** Posição entre os irmãos, para `aria-posinset` / `aria-setsize`. */
  position: number;
  siblings: number;
  renaming: boolean;
}

export type TreeRow =
  | EntryRow
  | { kind: 'message'; key: string; text: string; level: number }
  | { kind: 'input'; key: string; level: number };

/** Edição em linha: novo arquivo, nova pasta ou renomear. `error` vem do núcleo. */
export interface TreeEdit {
  kind: 'file' | 'dir' | 'rename';
  parent: Path;
  target: Path | null;
  name: string;
  error: string;
}

/** Estado da árvore do explorador e as operações em arquivos (docs/specs/explorador.md). */
@Injectable({ providedIn: 'root' })
export class ExplorerTree {
  private readonly explorer = inject(ExplorerService);
  private readonly tabs = inject(EditorTabs);
  private readonly dialogs = inject(Dialogs);
  private readonly folder = inject(CurrentFolder);

  /** Conteúdo das pastas já lidas; só as expandidas são relidas. */
  private readonly listings = signal(new Map<Path, Listing>());
  readonly expanded = signal(new Set<Path>());
  readonly selected = signal<Path | null>(null);
  readonly edit = signal<TreeEdit | null>(null);
  /** As linhas visíveis, na ordem da tela. A raiz não é linha: é o título do painel. */
  readonly rows = computed(() => {
    const root = this.folder.path();
    return root ? this.flatten(root, 1, []) : [];
  });

  /** Geração da última leitura de cada pasta: uma resposta antiga não apaga uma nova. */
  private readonly loads = new Map<Path, number>();
  private committing = false;

  reset(): void {
    this.listings.set(new Map());
    this.expanded.set(new Set());
    this.selected.set(null);
    this.edit.set(null);
    this.loads.clear();
  }

  /** Relê a raiz e todas as pastas expandidas (botão Atualizar e `rescan`). */
  async refresh(): Promise<void> {
    const root = this.folder.path();
    if (root) await Promise.all([root, ...this.expanded()].map((dir) => this.load(dir)));
  }

  /** `fs-changed`: relê a pasta pai de cada caminho e o próprio caminho, se expandidos. */
  async applyChanges(batch: ChangeBatch): Promise<void> {
    const root = this.folder.path();
    if (!root) return;
    if (batch.rescan) return this.refresh();
    const expanded = this.expanded();
    const dirs = new Set<Path>();
    for (const path of batch.paths) {
      const parent = dirname(path);
      if (parent === root || expanded.has(parent)) dirs.add(parent);
      if (expanded.has(path)) dirs.add(path);
    }
    await Promise.all([...dirs].map((dir) => this.load(dir)));
  }

  toggle(path: Path): Promise<void> {
    return this.expanded().has(path) ? Promise.resolve(this.collapse(path)) : this.expand(path);
  }

  /** Expande e relê a pasta: o que estava em cache aparece enquanto o disco responde. */
  async expand(path: Path): Promise<void> {
    this.expanded.update((set) => new Set(set).add(path));
    await this.load(path);
  }

  collapse(path: Path): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      next.delete(path);
      return next;
    });
  }

  collapseAll(): void {
    this.expanded.set(new Set());
  }

  select(path: Path): void {
    this.selected.set(path);
  }

  /** Clique ou Enter: pasta expande ou recolhe; arquivo abre numa aba. */
  async activate(entry: Entry): Promise<void> {
    this.selected.set(entry.path);
    if (entry.isDir) await this.toggle(entry.path);
    else await this.tabs.open(entry.path);
  }

  async openSelected(): Promise<void> {
    const row = this.selectedRow();
    if (row) await this.activate(row.entry);
  }

  /** ↑/↓ (e Home/End com ±Infinity). */
  moveSelection(offset: number): void {
    const entries = this.entryRows();
    if (!entries.length) return;
    const index = entries.findIndex((row) => row.entry.path === this.selected());
    const next = index < 0 ? 0 : Math.min(Math.max(index + offset, 0), entries.length - 1);
    this.selected.set(entries[next].entry.path);
  }

  /** →: expande a pasta, ou desce para o primeiro filho se ela já está expandida. */
  async right(): Promise<void> {
    const row = this.selectedRow();
    if (!row?.entry.isDir) return;
    if (!row.expanded) return this.expand(row.entry.path);
    const entries = this.entryRows();
    const child = entries[entries.indexOf(row) + 1];
    if (child && child.level > row.level) this.selected.set(child.entry.path);
  }

  /** ←: recolhe a pasta, ou sobe para a pasta pai. */
  left(): void {
    const row = this.selectedRow();
    if (!row) return;
    if (row.expanded) return this.collapse(row.entry.path);
    const parent = dirname(row.entry.path);
    if (parent !== this.folder.path()) this.selected.set(parent);
  }

  /** Letras digitadas: uma letra pula para o próximo item que começa com ela; várias refinam. */
  typeAhead(prefix: string): void {
    const entries = this.entryRows();
    const current = entries.findIndex((row) => row.entry.path === this.selected());
    const start = prefix.length === 1 ? current + 1 : Math.max(current, 0);
    const lower = prefix.toLowerCase();
    for (let offset = 0; offset < entries.length; offset++) {
      const row = entries[(start + offset) % entries.length];
      if (row.entry.name.toLowerCase().startsWith(lower)) {
        this.selected.set(row.entry.path);
        return;
      }
    }
  }

  /** Novo arquivo/pasta dentro da pasta de `target` (ou da raiz), com o nome editado em linha. */
  async startCreate(kind: 'file' | 'dir', target = this.selected()): Promise<void> {
    const root = this.folder.path();
    if (!root) return;
    const row = this.entryRows().find((item) => item.entry.path === target);
    const parent = !row ? root : row.entry.isDir ? row.entry.path : dirname(row.entry.path);
    if (parent !== root && !this.expanded().has(parent)) await this.expand(parent);
    this.edit.set({ kind, parent, target: null, name: '', error: '' });
  }

  startRename(path = this.selected()): void {
    if (!path || path === this.folder.path()) return;
    this.edit.set({
      kind: 'rename',
      parent: dirname(path),
      target: path,
      name: basename(path),
      error: '',
    });
  }

  cancelEdit(): void {
    this.edit.set(null);
  }

  /** Enter (ou sair do campo): cria ou renomeia. Com erro, o campo fica aberto com a mensagem. */
  async commitEdit(name: string): Promise<void> {
    const edit = this.edit();
    if (!edit || this.committing) return;
    if (!name || (edit.target && name === basename(edit.target))) return this.cancelEdit();
    this.committing = true;
    let path: Path;
    try {
      path = await this.apply(edit, name);
    } catch (error) {
      this.edit.set({ ...edit, name, error: errorMessage(error) });
      return;
    } finally {
      this.committing = false;
    }
    this.edit.set(null);
    if (edit.target) {
      this.tabs.renamePath(edit.target, path);
      await this.keepExpanded(edit.target, path);
    }
    await this.load(edit.parent);
    this.selected.set(path);
    if (edit.kind === 'file' && (await this.tabs.open(path))) this.tabs.requestFocus();
  }

  /** Delete: lixeira; se ela recusar, oferece excluir de vez. */
  async remove(path = this.selected()): Promise<void> {
    if (!path || path === this.folder.path()) return;
    const name = basename(path);
    const trash = 'Mover para a lixeira';
    if ((await this.dialogs.ask(`Mover ${name} para a lixeira?`, [trash, 'Cancelar'])) !== trash)
      return;
    if (!(await this.trashOrDelete(path))) return;
    await Promise.all([this.load(dirname(path)), this.tabs.checkDisk([path])]);
  }

  /** `true` se o item saiu do disco. */
  private async trashOrDelete(path: Path): Promise<boolean> {
    const name = basename(path);
    try {
      await this.explorer.moveToTrash(path);
      return true;
    } catch (error) {
      if (errorKind(error) !== 'trashFailed') return this.deleteFailed(name, error);
      const label = 'Excluir permanentemente';
      const question = `Excluir ${name} permanentemente? Não dá para desfazer.`;
      if ((await this.dialogs.ask(question, [label, 'Cancelar'], errorMessage(error))) !== label) {
        return false;
      }
    }
    try {
      await this.explorer.deletePermanently(path);
      return true;
    } catch (error) {
      return this.deleteFailed(name, error);
    }
  }

  private deleteFailed(name: string, error: unknown): false {
    void this.dialogs.tell(`Não foi possível excluir ${name}.`, errorMessage(error));
    return false;
  }

  /** Pasta renomeada: ela e as subpastas que estavam expandidas continuam expandidas no caminho novo. */
  private async keepExpanded(from: Path, to: Path): Promise<void> {
    const moved = new Map<Path, Path>();
    for (const dir of this.expanded()) {
      const renamed = replacePrefix(dir, from, to);
      if (renamed !== null) moved.set(dir, renamed);
    }
    if (!moved.size) return;
    this.expanded.update((set) => new Set([...set].map((dir) => moved.get(dir) ?? dir)));
    await Promise.all([...moved.values()].map((dir) => this.load(dir)));
  }

  private apply(edit: TreeEdit, name: string): Promise<Path> {
    if (edit.kind === 'file') return this.explorer.createFile(edit.parent, name);
    if (edit.kind === 'dir') return this.explorer.createDir(edit.parent, name);
    return this.explorer.rename(edit.target!, name);
  }

  private async load(dir: Path): Promise<void> {
    const generation = (this.loads.get(dir) ?? 0) + 1;
    this.loads.set(dir, generation);
    let listing: Listing;
    try {
      listing = { entries: await this.explorer.list(dir) };
    } catch (error) {
      const denied = errorKind(error) === 'permissionDenied';
      listing = { error: denied ? 'Sem permissão para ler' : errorMessage(error) };
    }
    const root = this.folder.path();
    if (this.loads.get(dir) !== generation || !root || !isWithin(dir, root)) return;
    this.listings.update((map) => new Map(map).set(dir, listing));
  }

  private flatten(dir: Path, level: number, rows: TreeRow[]): TreeRow[] {
    const edit = this.edit();
    if (edit && edit.kind !== 'rename' && edit.parent === dir) {
      rows.push({ kind: 'input', key: `new:${dir}`, level });
    }
    const listing = this.listings().get(dir);
    if (!listing) return rows;
    if ('error' in listing) {
      rows.push({ kind: 'message', key: `error:${dir}`, text: listing.error, level });
      return rows;
    }
    const expanded = this.expanded();
    listing.entries.forEach((entry, index) => {
      const open = entry.isDir && expanded.has(entry.path);
      rows.push({
        kind: 'entry',
        key: entry.path,
        entry,
        level,
        expanded: open,
        position: index + 1,
        siblings: listing.entries.length,
        renaming: edit?.kind === 'rename' && edit.target === entry.path,
      });
      if (open) this.flatten(entry.path, level + 1, rows);
    });
    return rows;
  }

  private entryRows(): EntryRow[] {
    return this.rows().filter((row) => row.kind === 'entry');
  }

  private selectedRow(): EntryRow | undefined {
    return this.entryRows().find((row) => row.entry.path === this.selected());
  }
}
