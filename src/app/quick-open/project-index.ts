import { computed, inject, Injectable, signal } from '@angular/core';
import { Path } from '../ipc';
import { CurrentFolder } from '../workspace/current-folder';
import { WorkspaceService } from '../workspace.service';
import { FileSearch } from './file-search';

/**
 * A lista do Abrir rápido (docs/ipc.md, `project_files`). Com 50.000 arquivos a resposta tem
 * ~1,5 MB: guarda a última e só pede de novo depois de `project-files-changed`.
 */
@Injectable({ providedIn: 'root' })
export class ProjectIndex {
  private readonly service = inject(WorkspaceService);
  private readonly folder = inject(CurrentFolder);
  private readonly loaded = signal<{ root: Path; search: FileSearch; indexing: boolean } | null>(
    null,
  );
  private stale = true;
  private watching = false;
  private requests = 0;

  /** A busca da pasta aberta; nula até chegar a primeira resposta dela. */
  readonly search = computed(() => {
    const loaded = this.loaded();
    return loaded?.root === this.folder.path() ? loaded.search : null;
  });
  /** Mostrar "Indexando…": o índice da pasta aberta ainda não terminou. */
  readonly indexing = computed(() =>
    this.search() ? this.loaded()!.indexing : this.folder.path() !== null,
  );

  constructor() {
    void this.service.onProjectFilesChanged(() => {
      this.stale = true;
      if (this.watching) void this.load();
    });
  }

  /** A caixa abriu: enquanto ela estiver aberta, cada mudança no índice pede a lista nova. */
  watch(): void {
    this.watching = true;
    if (this.stale || !this.search()) void this.load();
  }

  unwatch(): void {
    this.watching = false;
  }

  private async load(): Promise<void> {
    this.stale = false;
    const request = ++this.requests;
    try {
      const files = await this.service.projectFiles();
      // Uma resposta atrasada, ou de outra pasta, não vale mais.
      if (request !== this.requests || !files.root || files.root !== this.folder.path()) return;
      this.loaded.set({
        root: files.root,
        search: new FileSearch(files.files),
        indexing: files.indexing,
      });
    } catch (error) {
      this.stale = true;
      console.warn('Falha ao ler a lista de arquivos do projeto', error);
    }
  }
}
