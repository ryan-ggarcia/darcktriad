/** Falsos dos serviços que falam com o núcleo, para testar sem o Tauri. */
import { Provider, signal } from '@angular/core';
import { TextBuffer, TextBuffers } from '../app/editor/text-buffer';
import { DebugService } from '../app/debug.service';
import { ExplorerService } from '../app/explorer.service';
import { FileService } from '../app/file.service';
import {
  AppError,
  Breakpoint,
  ChangeBatch,
  DebugEvent,
  DebugLaunch,
  Entry,
  Eol,
  FileContent,
  Language,
  LanguageEvent,
  MenuEntry,
  OpenedFolder,
  Path,
  ProjectEvent,
  ProjectFiles,
  ProjectState,
  RecentFolder,
  Session,
  TerminalEvent,
  TerminalInfo,
  ToolCheck,
} from '../app/ipc';
import { TextChange } from '../app/language/lsp';
import { basename, dirname, replacePrefix } from '../app/paths';
import { LanguageService } from '../app/language.service';
import { ProjectService } from '../app/project.service';
import { Dialogs } from '../app/shared/dialogs';
import { TerminalScreen, TerminalScreens } from '../app/terminal/terminal-screen';
import { TerminalService } from '../app/terminal.service';
import { WorkspaceService } from '../app/workspace.service';

function fail(kind: AppError['kind'], message: string): Promise<never> {
  return Promise.reject({ kind, message } satisfies AppError);
}

/** Texto em memória com desfazer, imitando o `getAlternativeVersionId` do Monaco. */
export class FakeBuffer implements TextBuffer {
  private version = 1;
  private nextVersion = 2;
  private readonly undoStack: [string, number][] = [];
  private readonly editListeners = new Set<(changes: TextChange[]) => void>();
  disposed = false;

  constructor(
    public text: string,
    public eol: Eol,
    public language: string,
    private readonly onChange: () => void,
  ) {}

  /** O usuário digitando. */
  type(text: string): void {
    const lines = this.text.split('\n');
    const end = { line: lines.length - 1, character: lines[lines.length - 1].length };
    this.undoStack.push([this.text, this.version]);
    this.text = text;
    this.version = this.nextVersion++;
    this.onChange();
    for (const listener of this.editListeners) {
      listener([{ range: { start: { line: 0, character: 0 }, end }, text }]);
    }
  }

  onEdit(listener: (changes: TextChange[]) => void): () => void {
    this.editListeners.add(listener);
    return () => this.editListeners.delete(listener);
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
    // Como no disco, a pasta leva o conteúdo junto.
    for (const [dir, entries] of [...this.dirs]) {
      const moved = replacePrefix(dir, path, target);
      if (moved === null) continue;
      this.dirs.delete(dir);
      const items = entries.map((item) => ({
        ...item,
        path: replacePrefix(item.path, path, target)!,
      }));
      this.dirs.set(moved, items);
    }
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
  /** Os pontos de parada de cada pasta, como o núcleo os guarda. */
  readonly breakpoints = new Map<Path, Breakpoint[]>();
  private openPath: Path | null = null;
  readonly removedRecents: Path[] = [];
  pickedFolder: Path | null = null;
  openError: AppError | null = null;
  watchError: string | null = null;
  fsChanged?: (batch: ChangeBatch) => void;
  closeRequested?: () => Promise<boolean>;
  destroyed = false;
  /** O que `project_files` devolve; `projectFilesCalls` conta os pedidos. */
  index: ProjectFiles = { root: null, files: [], indexing: false };
  projectFilesCalls = 0;
  projectFilesChanged?: () => void;
  readonly menus: MenuEntry[][] = [];
  menuCommand?: (id: string) => void;

  openFolder(path: Path): Promise<OpenedFolder> {
    if (this.openError) return Promise.reject(this.openError);
    this.recents = [{ path, exists: true }, ...this.recents.filter((item) => item.path !== path)];
    const session = this.sessions.get(path) ?? { openFiles: [], activeFile: null };
    this.openPath = path;
    const breakpoints = this.breakpoints.get(path) ?? [];
    return Promise.resolve({ path, session, breakpoints, watchError: this.watchError });
  }

  closeFolder(): Promise<void> {
    this.openPath = null;
    return Promise.resolve();
  }

  saveBreakpoints(breakpoints: Breakpoint[]): Promise<void> {
    if (!this.openPath) return fail('invalidInput', 'Nenhuma pasta aberta');
    this.breakpoints.set(this.openPath, breakpoints);
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

  destroyWindow(): Promise<void> {
    this.destroyed = true;
    return Promise.resolve();
  }

  projectFiles(): Promise<ProjectFiles> {
    this.projectFilesCalls++;
    return Promise.resolve({ ...this.index });
  }

  async onProjectFilesChanged(handler: () => void) {
    this.projectFilesChanged = handler;
    return () => undefined;
  }

  setMenu(items: MenuEntry[]): Promise<void> {
    this.menus.push(items);
    return Promise.resolve();
  }

  async onMenuCommand(handler: (id: string) => void) {
    this.menuCommand = handler;
    return () => undefined;
  }
}

/** Shell em memória: guarda o que a interface pediu e deixa o teste mandar saída e fim. */
export class FakeTerminalService implements Partial<TerminalService> {
  readonly created: { id: number; cols: number; rows: number }[] = [];
  readonly writes: { id: number; data: string }[] = [];
  readonly resizes: { id: number; cols: number; rows: number }[] = [];
  readonly closed: number[] = [];
  /** Os eventos de cada terminal, como o `Channel` do núcleo. */
  readonly events = new Map<number, (event: TerminalEvent) => void>();
  /** Erro devolvido pelo próximo `terminal_create`. */
  createError: AppError | null = null;
  shell = 'bash';
  private nextId = 1;
  private held: Promise<void> | null = null;

  /** Segura as respostas do `terminal_create` até o teste chamar a função devolvida. */
  holdCreate(): () => void {
    let release!: () => void;
    this.held = new Promise((done) => (release = done));
    return release;
  }

  create(cols: number, rows: number, onEvent: (event: TerminalEvent) => void) {
    if (this.createError) return Promise.reject(this.createError);
    const id = this.nextId++;
    this.created.push({ id, cols, rows });
    // Como o `Channel`, os eventos já chegam antes da resposta.
    this.events.set(id, onEvent);
    const info: TerminalInfo = { id, name: this.shell };
    return this.held ? this.held.then(() => info) : Promise.resolve(info);
  }

  write(id: number, data: string): Promise<void> {
    this.writes.push({ id, data });
    return Promise.resolve();
  }

  resize(id: number, cols: number, rows: number): Promise<void> {
    this.resizes.push({ id, cols, rows });
    return Promise.resolve();
  }

  close(id: number): Promise<void> {
    this.closed.push(id);
    return Promise.resolve();
  }
}

/** Tela do xterm.js em memória: o teste digita, redimensiona e lê o que foi escrito. */
export class FakeScreen implements TerminalScreen {
  cols = 80;
  rows = 24;
  readonly buffer = { active: { type: 'normal' } } as TerminalScreen['buffer'];
  text = '';
  selection = '';
  pasted: string[] = [];
  scrolled = 0;
  opened: HTMLElement | null = null;
  disposed = false;
  /** O tamanho que `fit()` adota, como se o painel medisse isso. */
  fitSize = { cols: 80, rows: 24 };
  keyHandler: (event: KeyboardEvent) => boolean = () => true;
  private dataHandler: (data: string) => void = () => undefined;
  private resizeHandler: (size: { cols: number; rows: number }) => void = () => undefined;

  readonly onData = ((handler: (data: string) => void) => {
    this.dataHandler = handler;
    return { dispose: () => undefined };
  }) as TerminalScreen['onData'];

  readonly onResize = ((handler: (size: { cols: number; rows: number }) => void) => {
    this.resizeHandler = handler;
    return { dispose: () => undefined };
  }) as TerminalScreen['onResize'];

  /** O usuário digitando no terminal. */
  type(data: string): void {
    this.dataHandler(data);
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }

  open(parent: HTMLElement): void {
    this.opened = parent;
  }

  fit(): void {
    if (this.cols === this.fitSize.cols && this.rows === this.fitSize.rows) return;
    ({ cols: this.cols, rows: this.rows } = this.fitSize);
    this.resizeHandler(this.fitSize);
  }

  write(data: string | Uint8Array): void {
    this.text += data;
  }

  focus(): void {}

  hasSelection(): boolean {
    return this.selection !== '';
  }

  getSelection(): string {
    return this.selection;
  }

  paste(data: string): void {
    this.pasted.push(data);
  }

  scrollPages(pages: number): void {
    this.scrolled += pages;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export class FakeScreens extends TerminalScreens {
  readonly screens: FakeScreen[] = [];

  async create(): Promise<FakeScreen> {
    const screen = new FakeScreen();
    this.screens.push(screen);
    return screen;
  }
}

/** Projeto CMake em memória: o teste manda os eventos e lê o que a interface pediu. */
export class FakeProjectService implements Partial<ProjectService> {
  current: ProjectState = {
    root: null,
    kind: 'editOnly',
    warning: null,
    configs: [],
    config: null,
    status: { kind: 'idle' },
    buildDir: null,
    targets: [],
    target: null,
    problems: [],
  };
  readonly selectedConfigs: string[] = [];
  readonly selectedTargets: string[] = [];
  reconfigures = 0;
  tools: ToolCheck[] = [];
  toolsError: AppError | null = null;
  toolsChecks = 0;
  private handler: (event: ProjectEvent) => void = () => undefined;

  /** O núcleo mandando um `project-event`. */
  emit(event: ProjectEvent): void {
    this.handler(event);
  }

  /** Um estado novo, com `change` sobre o atual. */
  emitState(change: Partial<ProjectState>): void {
    this.current = { ...this.current, ...change };
    this.emit({ kind: 'state', state: this.current });
  }

  state(): Promise<ProjectState> {
    return Promise.resolve(this.current);
  }

  selectConfig(config: string): Promise<void> {
    this.selectedConfigs.push(config);
    return Promise.resolve();
  }

  selectTarget(target: string): Promise<void> {
    this.selectedTargets.push(target);
    return Promise.resolve();
  }

  reconfigure(): Promise<void> {
    this.reconfigures++;
    return Promise.resolve();
  }

  builds = 0;
  cancels = 0;
  /** A resposta do próximo `project_build` ou `project_run`; por padrão, na hora. */
  buildReply: Promise<void> = Promise.resolve();
  /** O que o próximo `project_run` devolve, depois da `buildReply`. */
  runInfo: TerminalInfo | null = { id: 100, name: '▶ app' };
  readonly runs: { cols: number; rows: number }[] = [];
  /** Os eventos do terminal do último `project_run`. */
  runEvents: (event: TerminalEvent) => void = () => undefined;

  build(): Promise<void> {
    this.builds++;
    return this.buildReply;
  }

  cancelBuild(): Promise<void> {
    this.cancels++;
    return Promise.resolve();
  }

  async run(cols: number, rows: number, onEvent: (event: TerminalEvent) => void) {
    this.runs.push({ cols, rows });
    this.runEvents = onEvent;
    await this.buildReply;
    return this.runInfo;
  }

  checkTools(): Promise<ToolCheck[]> {
    this.toolsChecks++;
    return this.toolsError ? Promise.reject(this.toolsError) : Promise.resolve(this.tools);
  }

  async onEvent(handler: (event: ProjectEvent) => void) {
    this.handler = handler;
    return () => undefined;
  }
}

/** Servidores de linguagem em memória: o teste manda eventos e lê as mensagens LSP enviadas. */
export class FakeLanguageService implements Partial<LanguageService> {
  readonly started: Language[] = [];
  readonly restarted: Language[] = [];
  /** As mensagens enviadas a cada servidor, já como objetos. */
  readonly sent: Record<Language, { id?: number; method?: string; params?: any }[]> = {
    cpp: [],
    csharp: [],
  };
  /** Erro devolvido pelo próximo `language_start`. */
  startError: AppError | null = null;
  private readonly handlers = new Map<Language, (event: LanguageEvent) => void>();

  /** O núcleo mandando um evento do servidor. */
  emit(language: Language, event: LanguageEvent): void {
    this.handlers.get(language)?.(event);
  }

  /** O servidor respondendo ao pedido `method` mais recente. */
  respond(language: Language, method: string, result: unknown): void {
    const request = this.sent[language].filter((message) => message.method === method).at(-1);
    const message = JSON.stringify({ jsonrpc: '2.0', id: request!.id, result });
    this.emit(language, { kind: 'message', message });
  }

  /** O processo de pé e o `initialize` respondido com `capabilities`. */
  run(language: Language, capabilities: object = {}): void {
    this.emit(language, { kind: 'state', state: { kind: 'running' } });
    this.respond(language, 'initialize', { capabilities });
  }

  methods(language: Language): string[] {
    return this.sent[language].map((message) => message.method ?? 'resposta');
  }

  start(language: Language, onEvent: (event: LanguageEvent) => void): Promise<void> {
    this.started.push(language);
    if (this.startError) return Promise.reject(this.startError);
    this.handlers.set(language, onEvent);
    onEvent({ kind: 'state', state: { kind: 'starting' } });
    return Promise.resolve();
  }

  send(language: Language, message: string): Promise<void> {
    this.sent[language].push(JSON.parse(message));
    return Promise.resolve();
  }

  restart(language: Language): Promise<void> {
    this.restarted.push(language);
    return Promise.resolve();
  }
}

/** Depurador em memória: o teste faz o papel do adaptador e lê as mensagens DAP enviadas. */
export class FakeDebugService implements Partial<DebugService> {
  /** O que o próximo `debug_start` devolve. */
  launch: DebugLaunch | null = { adapter: 'lldb-dap', launch: { program: '/proj/build/app' } };
  readonly sent: { seq: number; type: string; command?: string; arguments?: any }[] = [];
  readonly terminals: { args: string[]; cwd: Path }[] = [];
  stops = 0;
  private handler: (event: DebugEvent) => void = () => undefined;
  private seq = 1000;

  start(onEvent: (event: DebugEvent) => void): Promise<DebugLaunch | null> {
    this.handler = onEvent;
    return Promise.resolve(this.launch);
  }

  send(message: string): Promise<void> {
    this.sent.push(JSON.parse(message));
    return Promise.resolve();
  }

  /** Os eventos do terminal do último `runInTerminal`. */
  terminalEvent: (event: TerminalEvent) => void = () => undefined;

  runInTerminal(
    args: string[],
    cwd: Path,
    _cols: number,
    _rows: number,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalInfo> {
    this.terminals.push({ args, cwd });
    this.terminalEvent = onEvent;
    return Promise.resolve({ id: 200, name: '🐞 app' });
  }

  stop(): Promise<void> {
    this.stops++;
    return Promise.resolve();
  }

  emit(event: DebugEvent): void {
    this.handler(event);
  }

  /** O adaptador mandando uma mensagem DAP. */
  message(message: object): void {
    this.emit({ kind: 'message', message: JSON.stringify({ seq: this.seq++, ...message }) });
  }

  dapEvent(event: string, body: object = {}): void {
    this.message({ type: 'event', event, body });
  }

  /** A resposta ao pedido `command` mais recente. */
  respond(command: string, body: object = {}, success = true): void {
    const request = this.sent.filter((item) => item.command === command).at(-1)!;
    this.message({ type: 'response', request_seq: request.seq, command, success, body });
  }

  commands(): string[] {
    return this.sent.map((item) => (item.type === 'request' ? item.command! : 'resposta'));
  }
}

export interface Fakes {
  files: FakeFiles;
  dialogs: FakeDialogs;
  explorer: FakeExplorer;
  workspace: FakeWorkspaceService;
  terminals: FakeTerminalService;
  screens: FakeScreens;
  project: FakeProjectService;
  languages: FakeLanguageService;
  debug: FakeDebugService;
  providers: Provider[];
}

export function createFakes(): Fakes {
  const files = new FakeFiles();
  const dialogs = new FakeDialogs();
  const explorer = new FakeExplorer();
  const workspace = new FakeWorkspaceService();
  const terminals = new FakeTerminalService();
  const screens = new FakeScreens();
  const project = new FakeProjectService();
  const languages = new FakeLanguageService();
  const debug = new FakeDebugService();
  return {
    files,
    dialogs,
    explorer,
    workspace,
    terminals,
    screens,
    project,
    languages,
    debug,
    providers: [
      { provide: FileService, useValue: files },
      { provide: Dialogs, useValue: dialogs },
      { provide: ExplorerService, useValue: explorer },
      { provide: WorkspaceService, useValue: workspace },
      { provide: TextBuffers, useClass: FakeBuffers },
      { provide: TerminalService, useValue: terminals },
      { provide: TerminalScreens, useValue: screens },
      { provide: ProjectService, useValue: project },
      { provide: LanguageService, useValue: languages },
      { provide: DebugService, useValue: debug },
    ],
  };
}

/** Espera as promessas pendentes (leituras falsas, gravações em fila). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
