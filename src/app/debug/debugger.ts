import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { DebugService } from '../debug.service';
import { EditorTabs } from '../editor/editor-tabs';
import { DebugEvent, DebugLaunch, errorMessage, Path } from '../ipc';
import { Project, withLine } from '../project/project';
import { Commands } from '../shared/commands';
import { Dialogs } from '../shared/dialogs';
import { exitMessage, Terminals, TerminalSession } from '../terminal/terminals';
import { CurrentFolder } from '../workspace/current-folder';
import { Breakpoints, DapBreakpoint } from './breakpoints';
import { DapClient, DapReply } from './dap-client';

export const DEBUG_CHANNEL = 'Depuração';
/** Espera do Parar: sem o fim depois do `terminate`, `disconnect` e `debug_stop` juntos. */
export const STOP_MS = 3000;
/** O F6 recusado antes de o programa rodar de fato é repetido neste intervalo, por até ~10 s. */
export const PAUSE_RETRY_MS = 200;
const PAUSE_TRIES = 50;
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
  private readonly commands = inject(Commands);
  private readonly folder = inject(CurrentFolder);

  /** Nulo sem sessão; `starting` inclui a compilação. */
  readonly state = signal<DebugState | null>(null);
  /** O alvo depurado: "🐞 Depurando app"; vazio enquanto ainda não se sabe. */
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
  /** F6 enviado: o próximo `stopped` é "Pausado por você" (o lldb-dap avisa como `exception`). */
  private pauseRequested = false;
  private supportsExceptionInfo = false;
  /** O lldb-dap não declara: recusaria o `terminate` (o netcoredbg declara). */
  private supportsTerminate = false;
  private configured = false;
  private stopping = false;
  private disconnecting = false;
  private stopTimer?: ReturnType<typeof setTimeout>;
  /** O adaptador pediu `runInTerminal`: o programa tem terminal com teclado. */
  private inTerminal = false;
  private outputTerminal: Promise<TerminalSession | null> | null = null;
  /** O terminal do `runInTerminal`, marcado no Parar. */
  private runTerminal: TerminalSession | null = null;
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
    this.target.set(this.project.state().target ?? '');
    this.log.set([]);
    this.ended = new Promise((resolve) => (this.onEnded = resolve));
    const launch = await this.project.startAfterBuild(() =>
      this.service.start((event) => this.onEvent(session, event)),
    );
    if (!launch || this.stopping) {
      if (launch) await this.service.stop().catch(warn);
      return this.finish(null);
    }
    // O alvo só é conhecido depois da configuração (o .NET pode ainda estar configurando no F5).
    this.target.set(this.project.state().target ?? 'programa');
    this.adapter = launch.adapter;
    const client = new DapClient((message) => void this.service.send(message).catch(warn), {
      event: (event, body) => this.onDapEvent(event, body),
      request: (command, args) => this.onRequest(command, args),
      log: (line) => this.append(line),
    });
    this.client = client;
    this.state.set('running');
    const initialized = new Promise<void>((resolve) => (this.onInitialized = resolve));
    const capabilities = await client.request<{
      supportsExceptionInfoRequest?: boolean;
      supportsTerminateRequest?: boolean;
    }>('initialize', {
      clientID: 'darktriad',
      clientName: 'Dark Triad',
      adapterID: this.adapter,
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsRunInTerminalRequest: true,
    });
    if (!capabilities) return void this.stop();
    this.supportsExceptionInfo = capabilities.supportsExceptionInfoRequest === true;
    this.supportsTerminate = capabilities.supportsTerminateRequest === true;
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
    if (this.pauseRequested) void this.sendPause(client);
  }

  /** F6; antes da configuração (inclusive compilando), o pedido fica guardado até ela. */
  async pause(): Promise<void> {
    const state = this.state();
    if ((state !== 'running' && state !== 'starting') || this.pauseRequested) return;
    this.pauseRequested = true;
    if (this.configured && this.client) await this.sendPause(this.client);
  }

  /**
   * O depurador recusa o `pause` enquanto o programa não roda de fato (lldb-dap: logo depois do
   * evento `process`; netcoredbg: até a primeira thread): repete até aceitar, pausar ou acabar.
   */
  private async sendPause(client: DapClient): Promise<void> {
    const pending = () =>
      client === this.client && this.state() === 'running' && this.pauseRequested;
    for (let tries = 1; ; tries++) {
      // O lldb-dap recusa `threads` com o programa rodando, mas ignora o `threadId` do `pause`; o
      // netcoredbg responde `threads` e exige uma thread que exista.
      const threadId =
        this.threadId ??
        (await client.request<{ threads?: { id: number }[] }>('threads'))?.threads?.[0]?.id ??
        0;
      if (!pending()) return;
      if (await client.request('pause', { threadId })) return;
      if (tries === PAUSE_TRIES) break;
      await new Promise((resolve) => setTimeout(resolve, PAUSE_RETRY_MS));
      if (!pending()) return;
    }
    if (client === this.client) this.pauseRequested = false;
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
   * Shift+F5: pede `terminate` (ou, se o adaptador não o declara, `disconnect`, como o VS Code);
   * sem o fim em 3 s, `disconnect` e logo depois `debug_stop`.
   * Resolve quando a sessão acaba.
   */
  stop(): Promise<void> {
    if (!this.state()) return Promise.resolve();
    const client = this.client;
    if (!this.stopping) {
      this.stopping = true;
      // O código de saída do lançador do `runInTerminal` não é o do programa.
      if (this.runTerminal) this.runTerminal.stoppedByUser = true;
      if (client) {
        const session = this.session;
        this.stopTimer = setTimeout(() => {
          this.disconnect();
          void this.kill(session);
        }, STOP_MS);
        if (this.supportsTerminate)
          void client.request('terminate').then((ok) => ok || this.disconnect());
        else this.disconnect();
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
      case 'thread':
        // A thread usada pelo F6 com o programa rodando.
        if (body['reason'] === 'started') this.threadId ??= body['threadId'] as number;
        else if (body['threadId'] === this.threadId) this.threadId = undefined;
        return;
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
          const code =
            typeof body['exitCode'] === 'number' && !this.stopping ? body['exitCode'] : null;
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
      this.runTerminal = session;
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
    const requested = this.pauseRequested;
    this.pauseRequested = false;
    const pausedByUser = requested && body['reason'] !== 'breakpoint';
    this.pauseReason.set(pauseText(pausedByUser ? { reason: 'pause' } : body));
    this.threadId = (body['threadId'] as number | undefined) ?? this.threadId;
    if (body['reason'] === 'exception' && !pausedByUser && this.supportsExceptionInfo) {
      // O `stopped` do netcoredbg não traz a mensagem da exceção; o `exceptionInfo` traz.
      void client
        .request<{ description?: string }>('exceptionInfo', { threadId: this.threadId })
        .then((info) => {
          if (pause === this.pauses && info?.description) {
            this.pauseReason.set(pauseText({ reason: 'exception', description: info.description }));
          }
        });
    }
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
    const session = this.session;
    const timeout = new Promise((resolve) => setTimeout(resolve, STOP_MS));
    void Promise.race([client.request('disconnect', { terminateDebuggee: true }), timeout]).then(
      () => this.kill(session),
    );
  }

  /** `debug_stop`: o núcleo encerra o adaptador e o programa, e a sessão acaba. */
  private async kill(session: number): Promise<void> {
    if (session !== this.session || !this.state()) return;
    await this.service.stop().catch(warn);
    if (session === this.session) this.finish(null);
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
    this.pauseRequested = this.supportsExceptionInfo = this.supportsTerminate = false;
    this.outputTerminal = this.runTerminal = null;
    this.breakpoints.forgetSession();
    this.onInitialized();
    this.onEnded();
    // Na barra de status, sem segurar o teclado: o F5 já inicia outra sessão.
    if (reason) this.commands.flash(reason);
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
