import { effect, inject, Injectable, signal } from '@angular/core';
import { EditorTabs } from '../editor/editor-tabs';
import { ExplorerTree } from '../explorer/explorer-tree';
import { Project } from '../project/project';
import { FileService } from '../file.service';
import { ChangeBatch, errorMessage, Path, RecentFolder, Session } from '../ipc';
import { Dialogs } from '../shared/dialogs';
import { WorkspaceService } from '../workspace.service';
import { CurrentFolder } from './current-folder';

/** Liga pasta, árvore, abas e sessão: abrir e fechar pasta, iniciar e fechar a janela. */
@Injectable({ providedIn: 'root' })
export class Workspace {
  private readonly service = inject(WorkspaceService);
  private readonly files = inject(FileService);
  private readonly tabs = inject(EditorTabs);
  private readonly tree = inject(ExplorerTree);
  private readonly dialogs = inject(Dialogs);
  private readonly folder = inject(CurrentFolder);
  private readonly project = inject(Project);

  readonly recents = signal<RecentFolder[]>([]);
  /** Enquanto a pasta abre, a lista de abas está pela metade e não pode virar sessão. */
  private readonly restoring = signal(false);
  private sessionWrites: Promise<unknown> = Promise.resolve();

  constructor() {
    effect(() => {
      const session = this.tabs.session();
      if (this.folder.path() && !this.restoring()) void this.persist(session);
    });
  }

  /** Ao iniciar: reabre a última pasta, se ela ainda existe; senão fica a tela inicial. */
  async start(): Promise<void> {
    void this.service.onFsChanged((batch) => this.applyChanges(batch));
    void this.service.onCloseRequested(() => this.confirmClose());
    const recents = await this.loadRecents();
    if (recents[0]?.exists) await this.openFolder(recents[0].path);
  }

  async openFolderDialog(): Promise<void> {
    const path = await this.service.pickFolder();
    if (path) await this.openFolder(path);
  }

  async openFileDialog(): Promise<void> {
    const path = await this.files.pickFile();
    if (path && (await this.tabs.open(path))) this.tabs.requestFocus();
  }

  /** ⌘O no macOS: o diálogo nativo não escolhe arquivo ou pasta num só (docs/ipc.md). */
  async openFileOrFolder(): Promise<void> {
    const choice = await this.dialogs.ask('O que você quer abrir?', [
      'Arquivo',
      'Pasta',
      'Cancelar',
    ]);
    if (choice === 'Arquivo') await this.openFileDialog();
    if (choice === 'Pasta') await this.openFolderDialog();
  }

  /** Recente riscada (não existe mais) sai da lista; as outras abrem. */
  async openRecent(recent: RecentFolder): Promise<void> {
    if (recent.exists) return this.openFolder(recent.path);
    await this.service.removeRecentFolder(recent.path).catch(() => undefined);
    await this.loadRecents();
  }

  /** Troca a pasta da janela, depois de perguntar sobre os arquivos não salvos. */
  async openFolder(path: Path): Promise<void> {
    if (!(await this.tabs.confirmDiscard())) return;
    this.restoring.set(true);
    this.tabs.clear();
    this.tree.reset();
    this.folder.path.set(path);
    this.folder.watchError.set(null);
    // A árvore aparece sem esperar o observador, que pode demorar em pastas enormes.
    const tree = this.tree.refresh();
    try {
      const opened = await this.service.openFolder(path);
      this.folder.watchError.set(opened.watchError);
      await this.tabs.restore(opened.session);
    } catch (error) {
      this.folder.path.set(null);
      this.tree.reset();
      void this.dialogs.tell(`Não foi possível abrir a pasta ${path}.`, errorMessage(error));
    } finally {
      this.restoring.set(false);
    }
    await Promise.all([tree, this.loadRecents()]);
  }

  /** Ctrl+K F: volta para a tela inicial. */
  async closeFolder(): Promise<void> {
    if (!this.folder.path() || !(await this.tabs.confirmDiscard())) return;
    await this.persist(this.tabs.session());
    this.tabs.clear();
    this.tree.reset();
    this.folder.path.set(null);
    this.folder.watchError.set(null);
    await this.service.closeFolder();
    await Promise.all([this.project.refresh(), this.loadRecents()]);
  }

  /** Arquivo: Sair. A mesma pergunta do botão fechar; depois fecha a janela. */
  async quit(): Promise<void> {
    if (await this.confirmClose()) await this.service.destroyWindow();
  }

  private applyChanges(batch: ChangeBatch): void {
    void this.tree.applyChanges(batch);
    void this.tabs.checkDisk(batch.rescan ? null : batch.paths);
  }

  /** Fechar a janela: uma única pergunta sobre as abas modificadas; depois grava a sessão. */
  private async confirmClose(): Promise<boolean> {
    if (!(await this.tabs.confirmDiscard())) return false;
    if (this.folder.path()) await this.persist(this.tabs.session());
    return true;
  }

  private async loadRecents(): Promise<RecentFolder[]> {
    const recents = await this.service.recentFolders();
    this.recents.set(recents);
    return recents;
  }

  /** Em fila: duas gravações em paralelo poderiam chegar fora de ordem. */
  private persist(session: Session): Promise<unknown> {
    this.sessionWrites = this.sessionWrites
      .then(() => this.service.saveSession(session))
      .catch((error) => console.warn('Falha ao gravar a sessão', error));
    return this.sessionWrites;
  }
}
