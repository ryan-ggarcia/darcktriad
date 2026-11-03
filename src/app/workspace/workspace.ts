import { effect, inject, Injectable, signal } from '@angular/core';
import { Breakpoints } from '../debug/breakpoints';
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
  private readonly breakpoints = inject(Breakpoints);

  readonly recents = signal<RecentFolder[]>([]);
  /** Enquanto a pasta abre, a lista de abas está pela metade e não pode virar sessão. */
  private readonly restoring = signal(false);
  private sessionWrites: Promise<unknown> = Promise.resolve();
  /** Número da abertura de pasta mais nova: o que chega de uma abertura antiga é descartado. */
  private opening = 0;
  private folderOpens: Promise<unknown> = Promise.resolve();

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
    const opening = this.opening;
    const recents = await this.loadRecents();
    // Se o usuário já abriu outra pasta pela tela inicial, a escolha dele vence.
    if (opening === this.opening && recents[0]?.exists) await this.openFolder(recents[0].path);
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
    await this.removeRecent(recent);
  }

  /** "Remover da lista" na tela inicial: a pasta continua no disco. */
  async removeRecent(recent: RecentFolder): Promise<void> {
    await this.service
      .removeRecentFolder(recent.path)
      .catch((error) => console.warn('Falha ao tirar a pasta das recentes', error));
    await this.loadRecents();
  }

  /** Troca a pasta da janela, depois de perguntar sobre os arquivos não salvos. */
  async openFolder(path: Path): Promise<void> {
    const opening = ++this.opening;
    const current = () => opening === this.opening;
    if (!(await this.tabs.confirmDiscard()) || !current()) return;
    this.restoring.set(true);
    this.tabs.clear();
    this.tree.reset();
    this.breakpoints.load([]);
    this.folder.path.set(path);
    this.folder.watchError.set(null);
    // A árvore aparece sem esperar o observador, que pode demorar em pastas enormes.
    const tree = this.tree.refresh();
    try {
      // Em fila: o núcleo precisa terminar na última pasta pedida, não na que demorou mais.
      const request = this.folderOpens.then(() => this.service.openFolder(path));
      this.folderOpens = request.catch(() => undefined);
      const opened = await request;
      if (!current()) return;
      this.folder.watchError.set(opened.watchError);
      this.breakpoints.load(opened.breakpoints);
      await this.tabs.restore(opened.session);
    } catch (error) {
      if (!current()) return;
      this.folder.path.set(null);
      this.tree.reset();
      void this.dialogs.tell(`Não foi possível abrir a pasta ${path}.`, errorMessage(error));
    } finally {
      if (current()) this.restoring.set(false);
    }
    await Promise.all([tree, this.loadRecents()]);
  }

  /** Ctrl+K F: volta para a tela inicial. */
  async closeFolder(): Promise<void> {
    if (!this.folder.path() || !(await this.tabs.confirmDiscard())) return;
    await this.persist(this.tabs.session());
    this.tabs.clear();
    this.tree.reset();
    this.breakpoints.load([]);
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
  async confirmClose(): Promise<boolean> {
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
