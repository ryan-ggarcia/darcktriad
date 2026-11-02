import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { DebugService } from '../debug.service';
import { EditorTabs } from '../editor/editor-tabs';
import { DebugEvent, DebugLaunch, errorMessage, Path } from '../ipc';
import { Project, withLine } from '../project/project';
import { Dialogs } from '../shared/dialogs';
import { exitMessage, Terminals, TerminalSession } from '../terminal/terminals';
import { CurrentFolder } from '../workspace/current-folder';
import { Breakpoints, DapBreakpoint } from './breakpoints';
import { DapClient, DapReply } from './dap-client';

export const DEBUG_CHANNEL = 'Depuração';
/** Espera de cada passo do Parar: `terminate` → `disconnect` → `debug_stop`. */
export const STOP_MS = 3000;
/** Coleções grandes aparecem em blocos deste tamanho. */
const BLOCK = 100;
/** shortcut: só os 200 frames do topo; numa recursão infinita o resto não aparece. Paginar se alguém precisar. */
const LEVELS = 200;
const NO_INPUT = 'Este depurador não permite digitar a entrada do programa.';

export type DebugState = 'starting' | 'running' | 'paused';

export interface StackFrame {
  id: number;
  name: string;
  line: number;
  column: number;
  source?: { path?: string; name?: string; sourceReference?: number; presentationHint?: string };
}

/**
 * O arquivo do frame; null sem código-fonte. O lldb-dap manda a desmontagem com `sourceReference`
 * e um `path` que não é arquivo ("libc.so.6`__libc_start_main").
 */
export function sourcePath({ source }: StackFrame): string | null {
  if (!source?.path || source.sourceReference || source.presentationHint === 'deemphasize') {
    return null;
  }
  return source.path;
}

/** Uma thread na Pilha de chamadas; os frames chegam ao abrir. */
export class ThreadNode {
  readonly expanded = signal(false);
  readonly frames = signal<StackFrame[] | null>(null);

  constructor(
    readonly id: number,
    readonly name: string,
  ) {}
}

/** Um escopo, uma variável ou um bloco de 100 itens; os filhos chegam ao abrir. */
export class VariableNode {
  readonly expanded = signal(false);
  readonly children = signal<VariableNode[] | null>(null);

  constructor(
    readonly name: string,
    readonly value: string,
    readonly type: string | undefined,
    /** O `variablesReference`; 0 não tem filhos. */
    readonly reference: number,
    readonly indexed = 0,
    /** Bloco de uma coleção grande: o pedaço a pedir, ou os itens que já vieram. */
    readonly block?: { start: number; count: number; items?: VariableNode[] },
  ) {}

  get expandable(): boolean {
    return this.reference > 0 || this.block !== undefined;
  }
}

interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  indexedVariables?: number;
}

/** Os blocos de uma coleção com `total` itens: 0–99, 100–199… */
export function blocks(total: number, size = BLOCK): { start: number; count: number }[] {
  const list = [];
  for (let start = 0; start < total; start += size) {
    list.push({ start, count: Math.min(size, total - start) });
  }
  return list;
}

const REASONS: Record<string, string> = {
  breakpoint: 'Pausado: ponto de parada',
  step: 'Pausado: passo',
  pause: 'Pausado por você',
  entry: 'Pausado: início do programa',
};

/** O texto da faixa do editor a partir do evento `stopped`. */
export function pauseText(body: { reason?: string; description?: string; text?: string }): string {
  const reason = body.reason ?? '';
  if (reason === 'exception') {
    const detail = body.text ?? body.description;
    return detail ? `Pausado: exceção. ${detail}` : 'Pausado: exceção';
  }
  return REASONS[reason] ?? `Pausado: ${body.description ?? reason}`;
}

/**
 * A sessão de depuração (docs/specs/depuracao.md): fala DAP com o adaptador que o núcleo inicia
 * (docs/ipc.md, Depuração), mostra onde o programa parou e encerra tudo no fim.
 */
@Injectable({ providedIn: 'root' })
export class Debugger {
  private readonly service = inject(DebugService);
  private readonly project = inject(Project);
  private readonly terminals = inject(Terminals);
  private readonly breakpoints = inject(Breakpoints);
  private readonly tabs = inject(EditorTabs);
  private readonly dialogs = inject(Dialogs);
  private readonly folder = inject(CurrentFolder);

  /** Nulo sem sessão; `starting` inclui a compilação. */
  readonly state = signal<DebugState | null>(null);
  /** O alvo depurado: "🐞 Depurando app". */
  readonly target = signal('');
  /** A faixa "Pausado: …". */
  readonly pauseReason = signal<string | null>(null);
  readonly threads = signal<ThreadNode[]>([]);
  /** O frame escolhido na Pilha de chamadas: linha atual e Variáveis. */
  readonly frame = signal<StackFrame | null>(null);
  readonly scopes = signal<VariableNode[]>([]);
  /** O canal Depuração da Saída. */
  readonly log = signal<string[]>([]);
  readonly currentLine = computed(() => {
    const frame = this.frame();
    const file = frame && sourcePath(frame);
    return file && frame.line > 0 ? { file, line: frame.line } : null;
  });

  private client: DapClient | null = null;
  private adapter: DebugLaunch['adapter'] = 'lldb-dap';
  /** Sobe a cada sessão: eventos e temporizadores de uma sessão antiga são ignorados. */
  private session = 0;
  /** Sobe a cada pausa e retomada: respostas de uma pausa antiga são descartadas. */
  private pauses = 0;
  private threadId: number | undefined;
  private configured = false;
  private stopping = false;
  private disconnecting = false;
  private stopTimer?: ReturnType<typeof setTimeout>;
  /** O adaptador pediu `runInTerminal`: o programa tem terminal com teclado. */
  private inTerminal = false;
  private outputTerminal: Promise<TerminalSession | null> | null = null;
  private onInitialized = () => undefined as void;
  private ended: Promise<void> = Promise.resolve();
  private onEnded = () => undefined as void;

  constructor() {
    this.breakpoints.onEdit = (file) => void this.sendBreakpoints(file);
    // Ao trocar ou fechar a pasta, o núcleo encerra a sessão à força, sem o evento `ended`.
    effect(() => {
      this.folder.path();
      untracked(() => this.finish(null));
    });
  }

  /** F5: sem sessão, salva, compila e inicia; com o programa pausado, continua. */
  async start(): Promise<void> {
    if (this.state() === 'paused') return this.resume('continue');
    if (this.state()) return;
    const session = ++this.session;
    this.state.set('starting');
    this.target.set(this.project.state().target ?? 'programa');
    this.log.set([]);
    this.ended = new Promise((resolve) => (this.onEnded = resolve));
    const launch = await this.project.startAfterBuild(() =>
      this.service.start((event) => this.onEvent(session, event)),
    );
    if (!launch || this.stopping) {
      if (launch) await this.service.stop().catch(warn);
      return this.finish(null);
    }
    this.adapter = launch.adapter;
    const client = new DapClient((message) => void this.service.send(message).catch(warn), {
      event: (event, body) => this.onDapEvent(event, body),
      request: (command, args) => this.onRequest(command, args),
      log: (line) => this.append(line),
    });
    this.client = client;
    this.state.set('running');
    const initialized = new Promise<void>((resolve) => (this.onInitialized = resolve));
    const capabilities = await client.request('initialize', {
      clientID: 'darktriad',
      clientName: 'Dark Triad',
      adapterID: this.adapter,
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsRunInTerminalRequest: true,
    });
    if (!capabilities) return void this.stop();
    // O lldb-dap só responde ao `launch` depois do `configurationDone`: não dá para esperar aqui.
    void client.request('launch', launch.launch).then((ok) => {
      if (client !== this.client) return;
      if (!ok) {
        void this.dialogs.tell(
          'O depurador não conseguiu iniciar o programa. Veja o canal Depuração na Saída.',
        );
        void this.stop();
      } else if (!this.inTerminal) {
        // Sem o pedido até a resposta, ele não vem mais: a saída chega por eventos `output`.
        void this.programTerminal();
      }
    });
    await initialized;
    if (client !== this.client) return;
    this.configured = true;
    for (const file of this.breakpoints.files()) void this.sendBreakpoints(file);
    const filters = this.adapter === 'netcoredbg' ? ['user-unhandled'] : [];
    void client.request('setExceptionBreakpoints', { filters });
    void client.request('configurationDone');
  }

  /** F6. */
  async pause(): Promise<void> {
    const client = this.client;
    if (this.state() !== 'running' || !client) return;
    const result = await client.request<{ threads?: { id: number }[] }>('threads');
    const threadId = result?.threads?.[0]?.id;
    if (threadId !== undefined) void client.request('pause', { threadId });
  }

  stepOver(): void {
    this.resume('next');
  }

  stepInto(): void {
    this.resume('stepIn');
  }

  stepOut(): void {
    this.resume('stepOut');
  }

  /**
   * Shift+F5: pede `terminate`; sem o fim em 3 s, `disconnect`; sem resposta em mais 3 s,
   * `debug_stop`. Resolve quando a sessão acaba.
   */
  stop(): Promise<void> {
    if (!this.state()) return Promise.resolve();
    const client = this.client;
    if (!this.stopping) {
      this.stopping = true;
      if (client) {
        this.stopTimer = setTimeout(() => this.disconnect(), STOP_MS);
        void client.request('terminate').then((ok) => ok || this.disconnect());
      } else {
        // Ainda compilando: o `debug_start` responde null e a sessão acaba.
        this.project.cancelBuild();
      }
    }
    return this.ended;
  }

  /** Ctrl+Shift+F5: para, recompila e inicia de novo, com os mesmos pontos de parada. */
  async restart(): Promise<void> {
    if (!this.state()) return;
    await this.stop();
    await this.start();
  }

  /** Clique num frame: a linha dele no editor e as variáveis dele. */
  async selectFrame(frame: StackFrame): Promise<void> {
    this.frame.set(frame);
    const file = sourcePath(frame);
    if (file && frame.line > 0) {
      void this.tabs.openAt(file, { line: frame.line, column: Math.max(frame.column, 1) }, false);
    }
    const pause = this.pauses;
    const result = await this.client?.request<{ scopes?: Variable[] }>('scopes', {
      frameId: frame.id,
    });
    if (pause !== this.pauses || this.frame() !== frame) return;
    const scopes = (result?.scopes ?? []).map(toNode);
    this.scopes.set(scopes);
    if (scopes[0]) await this.toggle(scopes[0]);
  }

  async toggleThread(thread: ThreadNode): Promise<void> {
    thread.expanded.update((open) => !open);
    if (!thread.expanded() || thread.frames()) return;
    const result = await this.client?.request<{ stackFrames?: StackFrame[] }>('stackTrace', {
      threadId: thread.id,
      startFrame: 0,
      levels: LEVELS,
    });
    thread.frames.set(result?.stackFrames ?? []);
  }

  /** Abre ou fecha uma variável; os filhos são pedidos só na primeira vez que ela abre. */
  async toggle(node: VariableNode): Promise<void> {
    node.expanded.update((open) => !open);
    if (!node.expanded() || node.children()) return;
    node.children.set(await this.childrenOf(node));
  }

  private async childrenOf(node: VariableNode): Promise<VariableNode[]> {
    const { block } = node;
    if (block?.items) return block.items;
    if (!block && node.indexed > BLOCK) {
      return blocks(node.indexed).map((range) => blockNode(node, range));
    }
    const result = await this.client?.request<{ variables?: Variable[] }>('variables', {
      variablesReference: node.reference,
      ...(block && { filter: 'indexed', start: block.start, count: block.count }),
    });
    const items = (result?.variables ?? []).map(toNode);
    // O depurador mandou tudo de uma vez: os blocos ficam só na tela.
    if (block || items.length <= BLOCK) return items;
    return blocks(items.length).map((range) =>
      blockNode(node, { ...range, items: items.slice(range.start, range.start + range.count) }),
    );
  }

  private resume(command: 'continue' | 'next' | 'stepIn' | 'stepOut'): void {
    const client = this.client;
    if (this.state() !== 'paused' || !client) return;
    const threadId = this.threadId;
    this.onContinued();
    void client.request(command, { threadId });
  }

  private onEvent(session: number, event: DebugEvent): void {
    if (session !== this.session) return;
    if (event.kind === 'log') this.append(event.line);
    else if (event.kind === 'message') this.client?.receive(event.message);
    else this.finish(event.reason);
  }

  private onDapEvent(event: string, body: Record<string, unknown>): void {
    switch (event) {
      case 'initialized':
        return this.onInitialized();
      case 'stopped':
        return void this.onStopped(body);
      case 'continued':
        return this.onContinued();
      case 'breakpoint':
        if (body['reason'] === 'changed') {
          this.breakpoints.applyEvent(body['breakpoint'] as DapBreakpoint);
        }
        return;
      case 'output':
        return this.onOutput(body['category'] as string | undefined, String(body['output'] ?? ''));
      case 'exited':
        // Com `runInTerminal`, o próprio terminal avisa o fim.
        if (!this.inTerminal) {
          const code = typeof body['exitCode'] === 'number' ? body['exitCode'] : null;
          this.writeProgram(`\n\n${exitMessage(code, true)}\n`);
        }
        return;
      case 'terminated':
        return this.disconnect();
    }
  }

  /** O pedido reverso `runInTerminal`: o programa roda no terminal `🐞 <alvo>`, com teclado. */
  private async onRequest(command: string, args: Record<string, unknown>): Promise<DapReply> {
    if (command !== 'runInTerminal') return { success: false, message: `Sem suporte a ${command}` };
    this.inTerminal = true;
    try {
      const session = await this.terminals.openDebug(`🐞 ${this.target()}`, (cols, rows, onEvent) =>
        this.service.runInTerminal(
          args['args'] as string[],
          args['cwd'] as string,
          cols,
          rows,
          onEvent,
        ),
      );
      return session
        ? { success: true, body: {} }
        : { success: false, message: 'O terminal não abriu.' };
    } catch (error) {
      return { success: false, message: errorMessage(error) };
    }
  }

  private async onStopped(body: Record<string, unknown>): Promise<void> {
    const client = this.client;
    if (!client) return;
    const pause = ++this.pauses;
    this.state.set('paused');
    this.pauseReason.set(pauseText(body));
    this.threadId = body['threadId'] as number | undefined;
    const result = await client.request<{ threads?: { id: number; name: string }[] }>('threads');
    if (pause !== this.pauses) return;
    const threads = (result?.threads ?? []).map((item) => new ThreadNode(item.id, item.name));
    this.threads.set(threads);
    const thread = threads.find((item) => item.id === this.threadId) ?? threads[0];
    if (!thread) return;
    this.threadId = thread.id;
    await this.toggleThread(thread);
    if (pause !== this.pauses) return;
    const frames = thread.frames() ?? [];
    // Como no VS Code: a linha atual é a do primeiro frame com código-fonte.
    const frame = frames.find((item) => sourcePath(item)) ?? frames[0];
    if (frame) await this.selectFrame(frame);
  }

  private onContinued(): void {
    this.pauses++;
    if (this.state() === 'paused') this.state.set('running');
    this.pauseReason.set(null);
    this.threads.set([]);
    this.frame.set(null);
    this.scopes.set([]);
  }

  private onOutput(category: string | undefined, output: string): void {
    if (category === 'telemetry') return;
    if ((category === 'stdout' || category === 'stderr') && !this.inTerminal) {
      return this.writeProgram(output);
    }
    for (const line of output.replace(/\r?\n$/, '').split(/\r?\n/)) this.append(line);
  }

  /** A saída do programa sem `runInTerminal`, no terminal `🐞 <alvo>` só de leitura. */
  private writeProgram(text: string): void {
    void this.programTerminal().then((session) => {
      if (session && !session.closed) session.screen.write(text.replace(/\r?\n/g, '\r\n'));
    });
  }

  private programTerminal(): Promise<TerminalSession | null> {
    this.outputTerminal ??= this.terminals.openDebug(`🐞 ${this.target()}`).then((session) => {
      session?.screen.write(`${NO_INPUT}\r\n\r\n`);
      return session;
    });
    return this.outputTerminal;
  }

  /** `disconnect` encerrando o programa; sem resposta em 3 s, `debug_stop`. */
  private disconnect(): void {
    const client = this.client;
    if (!client || this.disconnecting) return;
    this.disconnecting = true;
    clearTimeout(this.stopTimer);
    const session = this.session;
    const timeout = new Promise((resolve) => (this.stopTimer = setTimeout(resolve, STOP_MS)));
    void Promise.race([client.request('disconnect', { terminateDebuggee: true }), timeout]).then(
      async () => {
        if (session !== this.session || !this.state()) return;
        await this.service.stop().catch(warn);
        if (session === this.session) this.finish(null);
      },
    );
  }

  /** A sessão acabou: tudo volta ao normal; `reason` não nulo é a mensagem de que o adaptador caiu. */
  private finish(reason: string | null): void {
    if (!this.state()) return;
    this.client?.dispose();
    this.client = null;
    clearTimeout(this.stopTimer);
    this.onContinued();
    this.state.set(null);
    this.threadId = undefined;
    this.configured = this.stopping = this.disconnecting = this.inTerminal = false;
    this.outputTerminal = null;
    this.breakpoints.forgetSession();
    this.onInitialized();
    this.onEnded();
    if (reason) void this.dialogs.tell(reason);
  }

  private async sendBreakpoints(file: Path): Promise<void> {
    const client = this.client;
    if (!client || !this.configured) return;
    const lines = this.breakpoints.linesOf(file);
    const result = await client.request<{ breakpoints?: DapBreakpoint[] }>('setBreakpoints', {
      source: { path: file },
      breakpoints: lines.map((line) => ({ line })),
    });
    if (result && client === this.client) {
      this.breakpoints.applyResults(file, lines, result.breakpoints ?? []);
    }
  }

  private append(line: string): void {
    this.log.update((lines) => withLine(lines, line));
  }
}

function toNode(item: Variable): VariableNode {
  return new VariableNode(
    item.name,
    item.value ?? '',
    item.type,
    item.variablesReference,
    item.indexedVariables ?? 0,
  );
}

function blockNode(
  parent: VariableNode,
  block: { start: number; count: number; items?: VariableNode[] },
): VariableNode {
  const name = `[${block.start}..${block.start + block.count - 1}]`;
  return new VariableNode(name, '', undefined, parent.reference, 0, block);
}

function warn(error: unknown): void {
  console.warn('Depuração:', errorMessage(error));
}
