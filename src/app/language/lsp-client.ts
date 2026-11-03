import { signal } from '@angular/core';
import { Diagnostic, TextChange } from './lsp';

/** Um arquivo aberto no servidor. `version` sobe a cada alteração enviada. */
export interface LspDocument {
  uri: string;
  languageId: string;
  version: number;
  getText(): string;
}

export interface LspHooks {
  /** Erros de um arquivo. `kind` é `''` para os publicados e a categoria (`identifier`) para os pedidos. */
  diagnostics(kind: string, uri: string, diagnostics: Diagnostic[]): void;
  log(line: string): void;
}

/** O que o servidor anuncia no `initialize` e o cliente usa. */
export interface ServerCapabilities {
  textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean | object };
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
  hoverProvider?: boolean | object;
  definitionProvider?: boolean | object;
  documentFormattingProvider?: boolean | object;
  documentRangeFormattingProvider?: boolean | object;
  diagnosticProvider?: { identifier?: string };
}

interface Message {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const SYNC_FULL = 1;
const SYNC_INCREMENTAL = 2;
const REQUEST_CANCELLED = -32800;
const METHOD_NOT_FOUND = -32601;
/** Espera depois da digitação antes de pedir os erros (Roslyn). */
const PULL_DELAY_MS = 300;

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  window: { workDoneProgress: true },
  workspace: { configuration: true, workspaceFolders: true },
  textDocument: {
    synchronization: { didSave: true },
    publishDiagnostics: {},
    // O Roslyn só manda erros por pull, com um provedor por categoria registrado depois.
    diagnostic: { dynamicRegistration: true },
    completion: {
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        resolveSupport: { properties: ['documentation', 'detail'] },
        labelDetailsSupport: true,
      },
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    signatureHelp: {
      contextSupport: true,
      signatureInformation: {
        documentationFormat: ['markdown', 'plaintext'],
        parameterInformation: { labelOffsetSupport: true },
        activeParameterSupport: true,
      },
    },
    definition: { linkSupport: true },
    formatting: {},
    rangeFormatting: {},
  },
};

/**
 * Um cliente LSP para um processo do servidor: handshake, pedidos com cancelamento, respostas aos
 * pedidos do servidor, sincronização dos arquivos e erros (publicados ou pedidos). Fala JSON por
 * `send`; as mensagens do servidor entram por `receive`. Um processo novo pede um cliente novo.
 */
export class LspClient {
  /** O `initialize` foi respondido: pedidos e sincronização valem. */
  readonly ready = signal(false);
  /** Andamento do `$/progress`: o percentual da tarefa mais recente; nulo sem tarefa. */
  readonly progress = signal<{ percentage?: number } | null>(null);
  capabilities: ServerCapabilities = {};

  private nextId = 1;
  private readonly pending = new Map<number, (result: unknown) => void>();
  private readonly documents = new Map<string, LspDocument>();
  private readonly tasks = new Map<string | number, number | undefined>();
  /** Provedores de erros por pull: id do registro → categoria. */
  private readonly pullers = new Map<string, string | undefined>();
  private readonly pulls = new Map<
    string,
    { timer?: ReturnType<typeof setTimeout>; abort?: AbortController }
  >();
  private disposed = false;

  constructor(
    private readonly send: (message: string) => void,
    private readonly hooks: LspHooks,
    private readonly pullDelay = PULL_DELAY_MS,
  ) {}

  /** `initialize` → `initialized`, e abre no servidor os arquivos já registrados. */
  async initialize(rootUri: string | null, rootName: string): Promise<void> {
    const result = await this.request<{ capabilities?: ServerCapabilities }>('initialize', {
      processId: null,
      clientInfo: { name: 'Dark Triad' },
      rootUri,
      workspaceFolders: rootUri ? [{ uri: rootUri, name: rootName }] : null,
      capabilities: CLIENT_CAPABILITIES,
    });
    if (!result || this.disposed) return;
    this.capabilities = result.capabilities ?? {};
    const identifier = this.capabilities.diagnosticProvider?.identifier;
    if (this.capabilities.diagnosticProvider) this.pullers.set('initialize', identifier);
    this.notify('initialized', {});
    this.ready.set(true);
    for (const document of this.documents.values()) this.sendOpen(document);
  }

  /** Um pedido; com `abort` acionado, manda `$/cancelRequest` e resolve com `null`. */
  request<T>(method: string, params: unknown, abort?: AbortSignal): Promise<T | null> {
    if (this.disposed || abort?.aborted) return Promise.resolve(null);
    if (method !== 'initialize' && !this.ready()) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve as (result: unknown) => void);
      abort?.addEventListener(
        'abort',
        () => {
          if (!this.pending.delete(id)) return;
          this.notify('$/cancelRequest', { id });
          resolve(null);
        },
        { once: true },
      );
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.disposed) this.write({ method, params });
  }

  /** Uma mensagem inteira do servidor (o JSON do evento `message`). */
  receive(text: string): void {
    let message: Message;
    try {
      message = JSON.parse(text);
    } catch {
      this.hooks.log(`Mensagem inválida do servidor: ${text.slice(0, 200)}`);
      return;
    }
    if (message.method !== undefined && message.id !== undefined) this.answer(message);
    else if (message.method !== undefined) this.onNotification(message.method, message.params);
    else this.onResponse(message);
  }

  open(document: LspDocument): void {
    this.documents.set(document.uri, document);
    if (this.ready()) this.sendOpen(document);
  }

  /** Incremental se o servidor anunciou; senão o texto inteiro. */
  change(uri: string, changes: TextChange[]): void {
    const document = this.documents.get(uri);
    const kind = this.syncKind();
    if (!document || !this.ready() || (kind !== SYNC_FULL && kind !== SYNC_INCREMENTAL)) return;
    document.version++;
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: document.version },
      contentChanges: kind === SYNC_INCREMENTAL ? changes : [{ text: document.getText() }],
    });
    this.schedulePull(uri);
  }

  save(uri: string): void {
    const document = this.documents.get(uri);
    const sync = this.capabilities.textDocumentSync;
    const save = typeof sync === 'object' ? sync.save : undefined;
    if (!document || !this.ready() || !save) return;
    const includeText = typeof save === 'object' && (save as { includeText?: boolean }).includeText;
    this.notify('textDocument/didSave', {
      textDocument: { uri },
      ...(includeText && { text: document.getText() }),
    });
  }

  close(uri: string): void {
    if (!this.documents.delete(uri)) return;
    this.cancelPull(uri);
    if (this.ready()) this.notify('textDocument/didClose', { textDocument: { uri } });
    // Os erros pedidos não têm quem os apague depois do fechamento.
    for (const kind of this.pullKinds()) this.hooks.diagnostics(kind ?? '', uri, []);
  }

  /** O processo acabou: pedidos pendentes resolvem com `null` e nada mais é enviado. */
  dispose(): void {
    this.disposed = true;
    this.ready.set(false);
    for (const uri of this.pulls.keys()) this.cancelPull(uri);
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
  }

  private write(message: Omit<Message, 'jsonrpc'>): void {
    this.send(JSON.stringify({ jsonrpc: '2.0', ...message }));
  }

  private onResponse({ id, result, error }: Message): void {
    const resolve = this.pending.get(id as number);
    if (!resolve) return; // Cancelado ou de um pedido que não existe mais: descarta.
    this.pending.delete(id as number);
    if (error && error.code !== REQUEST_CANCELLED)
      this.hooks.log(`Erro do servidor: ${error.message}`);
    resolve(error ? null : (result ?? null));
  }

  /** Pedidos do servidor ao cliente: sem resposta, ele pode esperar para sempre. */
  private answer({ id, method, params }: Message): void {
    const reply = (result: unknown) => this.write({ id, result });
    switch (method) {
      case 'workspace/configuration':
        return reply(((params as { items?: unknown[] }).items ?? []).map(() => null));
      case 'client/registerCapability':
        for (const item of (params as { registrations: Registration[] }).registrations) {
          if (item.method === 'textDocument/diagnostic') {
            this.pullers.set(item.id, item.registerOptions?.identifier);
          }
        }
        reply(null);
        return this.pullAll();
      case 'client/unregisterCapability':
        // "unregisterations": o nome com o erro de digitação é o do protocolo.
        for (const item of (params as { unregisterations: Registration[] }).unregisterations) {
          this.pullers.delete(item.id);
        }
        return reply(null);
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
        return reply(null);
      case 'workspace/applyEdit':
        return reply({ applied: false });
      default:
        this.write({ id, error: { code: METHOD_NOT_FOUND, message: `Sem suporte a ${method}` } });
    }
  }

  private onNotification(method: string, params: unknown): void {
    switch (method) {
      case 'textDocument/publishDiagnostics': {
        const { uri, diagnostics } = params as { uri: string; diagnostics: Diagnostic[] };
        return this.hooks.diagnostics('', uri, diagnostics);
      }
      case '$/progress':
        return this.onProgress(params as ProgressParams);
      case 'window/logMessage':
      case 'window/showMessage':
        return this.hooks.log((params as { message: string }).message);
      case 'workspace/projectInitializationComplete':
        // Só agora os arquivos têm as referências do projeto (Roslyn).
        return this.pullAll();
    }
  }

  private onProgress({ token, value }: ProgressParams): void {
    if (value?.kind === 'begin') this.tasks.set(token, value.percentage);
    else if (value?.kind === 'report' && this.tasks.has(token)) {
      this.tasks.set(token, value.percentage ?? this.tasks.get(token));
    } else if (value?.kind === 'end') this.tasks.delete(token);
    else return;
    const last = [...this.tasks.values()].at(-1);
    this.progress.set(this.tasks.size ? { percentage: last } : null);
  }

  private syncKind(): number {
    const sync = this.capabilities.textDocumentSync;
    return typeof sync === 'number' ? sync : (sync?.change ?? 0);
  }

  private sendOpen(document: LspDocument): void {
    const { uri, languageId, version } = document;
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version, text: document.getText() },
    });
    this.schedulePull(uri, 0);
  }

  private pullAll(): void {
    for (const uri of this.documents.keys()) this.schedulePull(uri, 0);
  }

  /** Pede os erros de cada categoria registrada; um pedido novo cancela o anterior do arquivo. */
  private schedulePull(uri: string, delay = this.pullDelay): void {
    if (!this.pullers.size || !this.ready()) return;
    this.cancelPull(uri);
    const timer = setTimeout(() => this.pull(uri), delay);
    this.pulls.set(uri, { timer });
  }

  private pull(uri: string): void {
    const abort = new AbortController();
    this.pulls.set(uri, { abort });
    for (const kind of this.pullKinds()) {
      void this.request<DiagnosticReport>(
        'textDocument/diagnostic',
        { textDocument: { uri }, ...(kind !== undefined && { identifier: kind }) },
        abort.signal,
      ).then((report) => {
        // `unchanged` mantém os erros que já estão lá.
        if (report?.kind === 'full' && this.documents.has(uri)) {
          this.hooks.diagnostics(kind ?? '', uri, report.items);
        }
      });
    }
  }

  /**
   * As categorias a pedir. O Roslyn também registra um provedor sem categoria que repete os
   * erros de todas (o CS0029 viria duas vezes): com categorias, ele fica de fora.
   */
  private pullKinds(): (string | undefined)[] {
    const kinds = [...new Set(this.pullers.values())];
    return kinds.some((kind) => kind !== undefined)
      ? kinds.filter((kind) => kind !== undefined)
      : kinds;
  }

  private cancelPull(uri: string): void {
    const pull = this.pulls.get(uri);
    clearTimeout(pull?.timer);
    pull?.abort?.abort();
    this.pulls.delete(uri);
  }
}

interface Registration {
  id: string;
  method: string;
  registerOptions?: { identifier?: string };
}

interface ProgressParams {
  token: string | number;
  value?: { kind: 'begin' | 'report' | 'end'; percentage?: number };
}

type DiagnosticReport = { kind: 'full'; items: Diagnostic[] } | { kind: 'unchanged' };
