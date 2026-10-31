import { Diagnostic } from './lsp';
import { LspClient, LspDocument } from './lsp-client';

interface Sent {
  id?: number;
  method?: string;
  params?: any;
  result?: unknown;
  error?: { code: number };
}

/** Um servidor falso: guarda o que o cliente mandou e responde como o clangd ou o Roslyn. */
class FakeServer {
  readonly sent: Sent[] = [];
  readonly diagnostics: { kind: string; uri: string; messages: string[] }[] = [];
  readonly logs: string[] = [];
  readonly client = new LspClient(
    (message) => this.sent.push(JSON.parse(message)),
    {
      diagnostics: (kind, uri, items) =>
        this.diagnostics.push({ kind, uri, messages: items.map((item) => item.message) }),
      log: (line) => this.logs.push(line),
    },
    0,
  );

  methods(): string[] {
    return this.sent.map((message) => message.method ?? 'resposta');
  }

  last(method: string): Sent {
    return this.sent.filter((message) => message.method === method).at(-1)!;
  }

  reply(id: number | undefined, result: unknown): void {
    this.client.receive(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  /** Um pedido do servidor ao cliente; devolve a resposta do cliente. */
  ask(method: string, params: unknown): Sent {
    const id = 900 + this.sent.length;
    this.client.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return this.sent.find((message) => message.id === id && !message.method)!;
  }

  notify(method: string, params: unknown): void {
    this.client.receive(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  async initialize(capabilities: object): Promise<void> {
    const done = this.client.initialize('file:///proj', 'proj');
    this.reply(this.last('initialize').id, { capabilities });
    await done;
  }
}

function document(uri: string, text: string): LspDocument {
  return { uri, languageId: 'cpp', version: 1, getText: () => text };
}

const URI = 'file:///proj/app/main.cpp';
const diagnostic = (message: string): Diagnostic => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('cliente LSP', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
  });

  it('handshake: initialize com as capacidades, initialized e reabre os arquivos já abertos', async () => {
    server.client.open(document(URI, 'int main() {}'));
    expect(server.methods()).toEqual([]);

    const done = server.client.initialize('file:///proj', 'proj');
    const initialize = server.last('initialize');
    expect(initialize.params.rootUri).toBe('file:///proj');
    expect(initialize.params.workspaceFolders).toEqual([{ uri: 'file:///proj', name: 'proj' }]);
    expect(initialize.params.capabilities.textDocument.diagnostic).toEqual({
      dynamicRegistration: true,
    });
    expect(server.client.ready()).toBe(false);

    server.reply(initialize.id, { capabilities: { textDocumentSync: 2 } });
    await done;

    expect(server.client.ready()).toBe(true);
    expect(server.methods()).toEqual(['initialize', 'initialized', 'textDocument/didOpen']);
    expect(server.last('textDocument/didOpen').params.textDocument).toEqual({
      uri: URI,
      languageId: 'cpp',
      version: 1,
      text: 'int main() {}',
    });
  });

  it('sincroniza: alteração incremental com versão nova, salvar e fechar', async () => {
    await server.initialize({ textDocumentSync: { openClose: true, change: 2, save: true } });
    server.client.open(document(URI, 'int x;'));
    const change = {
      range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } },
      text: 'y',
    };

    server.client.change(URI, [change]);
    server.client.save(URI);
    server.client.close(URI);

    expect(server.methods().slice(2)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
      'textDocument/didSave',
      'textDocument/didClose',
    ]);
    expect(server.last('textDocument/didChange').params).toEqual({
      textDocument: { uri: URI, version: 2 },
      contentChanges: [change],
    });
  });

  it('servidor sem sincronização incremental recebe o texto inteiro', async () => {
    await server.initialize({ textDocumentSync: 1 });
    server.client.open(document(URI, 'int y;'));

    server.client.change(URI, [{ text: 'y' }]);

    expect(server.last('textDocument/didChange').params.contentChanges).toEqual([
      { text: 'int y;' },
    ]);
  });

  it('cancela com $/cancelRequest o pedido superado e descarta a resposta que chega depois', async () => {
    await server.initialize({});
    const abort = new AbortController();
    const old = server.client.request('textDocument/completion', {}, abort.signal);
    const id = server.last('textDocument/completion').id;

    abort.abort();
    expect(await old).toBeNull();
    expect(server.last('$/cancelRequest').params).toEqual({ id });

    server.reply(id, { items: [{ label: 'velho' }] });
    const fresh = server.client.request('textDocument/completion', {});
    server.reply(server.last('textDocument/completion').id, { items: [{ label: 'novo' }] });
    expect(await fresh).toEqual({ items: [{ label: 'novo' }] });
  });

  it('um processo que acabou resolve os pedidos pendentes com null e não envia mais nada', async () => {
    await server.initialize({});
    const pending = server.client.request('textDocument/hover', {});
    const count = server.sent.length;

    server.client.dispose();

    expect(await pending).toBeNull();
    server.client.notify('textDocument/didClose', {});
    expect(server.sent.length).toBe(count);
  });

  it('responde aos pedidos do servidor que esperam resposta', async () => {
    await server.initialize({});

    expect(server.ask('workspace/configuration', { items: [{}, {}] }).result).toEqual([null, null]);
    expect(server.ask('window/workDoneProgress/create', { token: 't' })).toMatchObject({
      result: null,
    });
    expect(server.ask('client/registerCapability', { registrations: [] })).toMatchObject({
      result: null,
    });
    expect(server.ask('foo/bar', {}).error?.code).toBe(-32601);
  });

  it('publishDiagnostics (clangd) chega como erros publicados', async () => {
    await server.initialize({});

    server.notify('textDocument/publishDiagnostics', { uri: URI, diagnostics: [diagnostic('e1')] });

    expect(server.diagnostics).toEqual([{ kind: '', uri: URI, messages: ['e1'] }]);
  });

  it('Roslyn: pede os erros de cada categoria registrada ao abrir, ao alterar e quando o projeto carrega', async () => {
    await server.initialize({ textDocumentSync: 2 });
    server.client.open(document(URI, 'int x = "a";'));
    expect(server.methods()).not.toContain('textDocument/diagnostic');

    server.ask('client/registerCapability', {
      registrations: [
        { id: 'r1', method: 'textDocument/diagnostic', registerOptions: { identifier: 'syntax' } },
        {
          id: 'r2',
          method: 'textDocument/diagnostic',
          registerOptions: { identifier: 'DocumentCompilerSemantic' },
        },
        // Sem categoria: repete os erros das outras e fica de fora.
        { id: 'r3', method: 'textDocument/diagnostic' },
      ],
    });
    await tick();
    const pulls = () =>
      server.sent.filter((message) => message.method === 'textDocument/diagnostic');
    expect(pulls().map((message) => message.params)).toEqual([
      { textDocument: { uri: URI }, identifier: 'syntax' },
      { textDocument: { uri: URI }, identifier: 'DocumentCompilerSemantic' },
    ]);

    server.reply(pulls()[1].id, { kind: 'full', items: [diagnostic('CS0029')] });
    server.reply(pulls()[0].id, { kind: 'unchanged', resultId: '1' });
    await tick();
    expect(server.diagnostics).toEqual([
      { kind: 'DocumentCompilerSemantic', uri: URI, messages: ['CS0029'] },
    ]);

    // Alterar de novo antes da resposta cancela o pedido velho.
    server.client.change(URI, [{ text: 'int x = 1;' }]);
    await tick();
    server.client.change(URI, [{ text: 'int x = 2;' }]);
    expect(server.methods()).toContain('$/cancelRequest');
    await tick();
    expect(pulls().length).toBe(6);

    server.notify('workspace/projectInitializationComplete', {});
    await tick();
    expect(pulls().length).toBe(8);

    // Fechar apaga os erros pedidos, que ninguém mais vai atualizar.
    server.client.close(URI);
    expect(server.diagnostics.slice(-2)).toEqual([
      { kind: 'syntax', uri: URI, messages: [] },
      { kind: 'DocumentCompilerSemantic', uri: URI, messages: [] },
    ]);
  });

  it('$/progress dá o percentual da indexação e some no fim', async () => {
    await server.initialize({});

    server.notify('$/progress', {
      token: 'idx',
      value: { kind: 'begin', title: 'indexing', percentage: 0 },
    });
    server.notify('$/progress', { token: 'idx', value: { kind: 'report', percentage: 45 } });
    expect(server.client.progress()).toEqual({ percentage: 45 });

    server.notify('$/progress', { token: 'idx', value: { kind: 'end' } });
    expect(server.client.progress()).toBeNull();
  });
});
