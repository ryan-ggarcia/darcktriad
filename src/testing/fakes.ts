/** Falsos dos serviços que falam com o núcleo, para testar sem o Tauri. */
import { Provider, signal } from '@angular/core';
import { TextBuffer, TextBuffers } from '../app/editor/text-buffer';
import { ExplorerService } from '../app/explorer.service';
import { FileService } from '../app/file.service';
import {
  AppError,
  ChangeBatch,
  Entry,
  Eol,
  FileContent,
  OpenedFolder,
  Path,
  RecentFolder,
  Session,
} from '../app/ipc';
import { basename, dirname } from '../app/paths';
import { Dialogs } from '../app/shared/dialogs';
import { WorkspaceService } from '../app/workspace.service';

function fail(kind: AppError['kind'], message: string): Promise<never> {
  return Promise.reject({ kind, message } satisfies AppError);
}

/** Texto em memória com desfazer, imitando o `getAlternativeVersionId` do Monaco. */
export class FakeBuffer implements TextBuffer {
  private version = 1;
  private nextVersion = 2;
  private readonly undoStack: [string, number][] = [];
  disposed = false;

  constructor(
    public text: string,
    public eol: Eol,
    public language: string,
    private readonly onChange: () => void,
  ) {}

  /** O usuário digitando. */
  type(text: string): void {
    this.undoStack.push([this.text, this.version]);
    this.text = text;
    this.version = this.nextVersion++;
    this.onChange();
  }

  undo(): void {
    [this.text, this.version] = this.undoStack.pop()!;
    this.onChange();
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.type(text);
  }

  setEol(eol: Eol): void {
    this.eol = eol;
  }

  setLanguage(language: string): void {
    this.language = language;
  }

  versionId(): number {
    return this.version;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export class FakeBuffers extends TextBuffers {
  async create(text: string, eol: Eol, language: string, onChange: () => void) {
    return new FakeBuffer(text, eol, language, onChange);
  }
}

/** Disco em memória com versões, conflito e falhas sob encomenda. */
export class FakeFiles implements Partial<FileService> {
  readonly disk = new Map<Path, FileContent>();
  readonly saves: {
    path: Path;
    content: string;
    eol: Eol;
    bom: boolean;
    expected: string | null;
  }[] = [];
  readonly saveDialogs: { directory: Path | null; fileName: string }[] = [];
  /** Erros devolvidos pelas próximas gravações, em ordem. */
  readonly saveErrors: AppError[] = [];
  savePath: Path | null = null;
  pickedFile: Path | null = null;
  private versions = 0;

  /** Grava "por fora da IDE": nova versão no disco. */
  write(path: Path, content: string, eol: Eol = 'lf'): string {
    const version = `v${++this.versions}`;
    this.disk.set(path, { kind: 'text', content, eol, bom: false, readOnly: false, version });
    return version;
  }

  read(path: Path): Promise<FileContent> {
    const content = this.disk.get(path);
    return content ? Promise.resolve({ ...content }) : fail('notFound', `${path} não existe`);
  }

  save(path: Path, content: string, eol: Eol, bom: boolean, expected: string | null) {
    this.saves.push({ path, content, eol, bom, expected });
    const error = this.saveErrors.shift();
    if (error) return Promise.reject(error);
    const current = this.disk.get(path);
    if (expected !== null && current?.kind === 'text' && current.version !== expected) {
      return fail('conflict', 'O arquivo mudou no disco');
    }
    return Promise.resolve(this.write(path, content, eol));
  }

  defaultEol(): Promise<Eol> {
    return Promise.resolve('crlf');
  }

  pickFile(): Promise<Path | null> {
    return Promise.resolve(this.pickedFile);
  }

  pickSavePath(directory: Path | null, fileName: string): Promise<Path | null> {
    this.saveDialogs.push({ directory, fileName });
    return Promise.resolve(this.savePath);
  }
}

/** Responde às perguntas com as respostas da fila (vazia = Esc). */
export class FakeDialogs implements Partial<Dialogs> {
  readonly asked: { message: string; buttons: string[]; detail: string }[] = [];
  readonly answers: (string | null)[] = [];

  ask(message: string, buttons: string[], detail = ''): Promise<string | null> {
    this.asked.push({ message, buttons, detail });
    return Promise.resolve(this.answers.shift() ?? null);
  }

  async tell(message: string, detail = ''): Promise<void> {
    await this.ask(message, ['OK'], detail);
  }

  readonly current = signal(null).asReadonly();
}

/** Árvore em memória: `dirs` guarda os itens de cada pasta já em ordem. */
export class FakeExplorer implements Partial<ExplorerService> {
  readonly dirs = new Map<Path, Entry[]>();
  readonly listErrors = new Map<Path, AppError>();
  readonly listed: Path[] = [];
  trashFails = false;
  readonly trashed: Path[] = [];
  readonly deleted: Path[] = [];

  /** Cria os itens de `paths` (pastas terminam com o separador). */
  add(...paths: Path[]): void {
    for (const raw of paths) {
      const isDir = /[\\/]$/.test(raw);
      const path = isDir ? raw.slice(0, -1) : raw;
      const parent = dirname(path);
      const entries = this.dirs.get(parent) ?? [];
      entries.push({ name: basename(path), path, isDir, isSymlink: false });
      this.dirs.set(parent, entries);
      if (isDir && !this.dirs.has(path)) this.dirs.set(path, []);
    }
  }

  remove(path: Path): void {
    const parent = dirname(path);
    this.dirs.set(
      parent,
      (this.dirs.get(parent) ?? []).filter((entry) => entry.path !== path),
    );
  }

  list(path: Path): Promise<Entry[]> {
    this.listed.push(path);
    const error = this.listErrors.get(path);
    if (error) return Promise.reject(error);
    const entries = this.dirs.get(path);
    return entries ? Promise.resolve([...entries]) : fail('notFound', `${path} não existe`);
  }

  createFile(parent: Path, name: string): Promise<Path> {
    return this.create(parent, name, false);
  }

  createDir(parent: Path, name: string): Promise<Path> {
    return this.create(parent, name, true);
  }

  rename(path: Path, newName: string): Promise<Path> {
    const target = `${dirname(path)}${path.includes('\\') ? '\\' : '/'}${newName}`;
    const entry = this.dirs.get(dirname(path))!.find((item) => item.path === path)!;
    this.remove(path);
    this.add(entry.isDir ? `${target}\\` : target);
    return Promise.resolve(target);
  }

  moveToTrash(path: Path): Promise<void> {
    if (this.trashFails) return fail('trashFailed', 'A lixeira não está disponível');
    this.trashed.push(path);
    this.remove(path);
    return Promise.resolve();
  }

  deletePermanently(path: Path): Promise<void> {
    this.deleted.push(path);
    this.remove(path);
    return Promise.resolve();
  }

  private create(parent: Path, name: string, isDir: boolean): Promise<Path> {
    if (!name || /[\\/]/.test(name)) return fail('invalidInput', 'Nome inválido');
    if (this.dirs.get(parent)?.some((entry) => entry.name === name)) {
      return fail('alreadyExists', `Já existe ${name} nesta pasta`);
    }
    const path = `${parent}\\${name}`;
    this.add(isDir ? `${path}\\` : path);
    return Promise.resolve(path);
  }
}

export class FakeWorkspaceService implements Partial<WorkspaceService> {
  recents: RecentFolder[] = [];
  readonly sessions = new Map<Path, Session>();
  readonly savedSessions: Session[] = [];
  readonly removedRecents: Path[] = [];
  pickedFolder: Path | null = null;
  openError: AppError | null = null;
  watchError: string | null = null;
  fsChanged?: (batch: ChangeBatch) => void;
  closeRequested?: () => Promise<boolean>;

  openFolder(path: Path): Promise<OpenedFolder> {
    if (this.openError) return Promise.reject(this.openError);
    this.recents = [{ path, exists: true }, ...this.recents.filter((item) => item.path !== path)];
    const session = this.sessions.get(path) ?? { openFiles: [], activeFile: null };
    return Promise.resolve({ path, session, watchError: this.watchError });
  }

  closeFolder(): Promise<void> {
    return Promise.resolve();
  }

  recentFolders(): Promise<RecentFolder[]> {
    return Promise.resolve([...this.recents]);
  }

  removeRecentFolder(path: Path): Promise<void> {
    this.removedRecents.push(path);
    this.recents = this.recents.filter((item) => item.path !== path);
    return Promise.resolve();
  }

  saveSession(session: Session): Promise<void> {
    this.savedSessions.push(session);
    return Promise.resolve();
  }

  pickFolder(): Promise<Path | null> {
    return Promise.resolve(this.pickedFolder);
  }

  async onFsChanged(handler: (batch: ChangeBatch) => void) {
    this.fsChanged = handler;
    return () => undefined;
  }

  async onCloseRequested(handler: () => Promise<boolean>) {
    this.closeRequested = handler;
    return () => undefined;
  }
}

export interface Fakes {
  files: FakeFiles;
  dialogs: FakeDialogs;
  explorer: FakeExplorer;
  workspace: FakeWorkspaceService;
  providers: Provider[];
}

export function createFakes(): Fakes {
  const files = new FakeFiles();
  const dialogs = new FakeDialogs();
  const explorer = new FakeExplorer();
  const workspace = new FakeWorkspaceService();
  return {
    files,
    dialogs,
    explorer,
    workspace,
    providers: [
      { provide: FileService, useValue: files },
      { provide: Dialogs, useValue: dialogs },
      { provide: ExplorerService, useValue: explorer },
      { provide: WorkspaceService, useValue: workspace },
      { provide: TextBuffers, useClass: FakeBuffers },
    ],
  };
}

/** Espera as promessas pendentes (leituras falsas, gravações em fila). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
