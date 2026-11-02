/** A resposta da interface a um pedido do adaptador (ex.: `runInTerminal`). */
export interface DapReply {
  success: boolean;
  body?: unknown;
  message?: string;
}

export interface DapHooks {
  event(event: string, body: Record<string, unknown>): void;
  /** Pedido reverso do adaptador; sem resposta, ele pode esperar para sempre. */
  request(command: string, args: Record<string, unknown>): Promise<DapReply>;
  log(line: string): void;
}

interface Message {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  arguments?: Record<string, unknown>;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: Record<string, unknown>;
  event?: string;
}

/**
 * Um cliente DAP para um processo do adaptador: pedidos com `seq`, respostas, eventos e as
 * respostas aos pedidos reversos. Fala JSON por `send`; as mensagens entram por `receive`.
 */
export class DapClient {
  private seq = 1;
  private readonly pending = new Map<number, (body: unknown) => void>();
  private disposed = false;

  constructor(
    private readonly send: (message: string) => void,
    private readonly hooks: DapHooks,
  ) {}

  /** O `body` da resposta (`{}` sem corpo); null se o adaptador recusou ou a sessão acabou. */
  request<T = Record<string, unknown>>(command: string, args: unknown = {}): Promise<T | null> {
    if (this.disposed) return Promise.resolve(null);
    const seq = this.seq++;
    return new Promise((resolve) => {
      this.pending.set(seq, resolve as (body: unknown) => void);
      this.write({ seq, type: 'request', command, arguments: args as Record<string, unknown> });
    });
  }

  receive(text: string): void {
    let message: Message;
    try {
      message = JSON.parse(text);
    } catch {
      this.hooks.log(`Mensagem inválida do depurador: ${text.slice(0, 200)}`);
      return;
    }
    if (message.type === 'event') this.hooks.event(message.event ?? '', message.body ?? {});
    else if (message.type === 'request') void this.answer(message);
    else this.onResponse(message);
  }

  /** O processo acabou: pedidos pendentes resolvem com null e nada mais é enviado. */
  dispose(): void {
    this.disposed = true;
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
  }

  private onResponse({ request_seq, success, command, message, body }: Message): void {
    const resolve = this.pending.get(request_seq!);
    if (!resolve) return;
    this.pending.delete(request_seq!);
    if (!success) this.hooks.log(`${command}: ${message ?? 'recusado pelo depurador'}`);
    resolve(success ? (body ?? {}) : null);
  }

  private async answer({ seq, command = '', arguments: args = {} }: Message): Promise<void> {
    const reply = await this.hooks.request(command, args);
    if (this.disposed) return;
    this.write({ seq: this.seq++, type: 'response', request_seq: seq, command, ...reply });
  }

  private write(message: Message | (Omit<Message, 'body'> & { body?: unknown })): void {
    if (!this.disposed) this.send(JSON.stringify(message));
  }
}
