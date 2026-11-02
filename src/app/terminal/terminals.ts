import { inject, Injectable, signal } from '@angular/core';
import { errorMessage, TerminalEvent, TerminalInfo } from '../ipc';
import { Project } from '../project/project';
import { Commands } from '../shared/commands';
import { Dialogs } from '../shared/dialogs';
import { PLATFORM } from '../shared/keybindings';
import { Panel } from '../shared/panel';
import { TerminalService } from '../terminal.service';
import { terminalKey } from './terminal-keys';
import { TerminalScreen, TerminalScreens } from './terminal-screen';

export function exitMessage(code: number | null, program = false): string {
  if (program)
    return code === null ? 'O programa foi encerrado' : `O programa terminou com código ${code}`;
  return code === null ? 'Processo encerrado' : `Processo encerrado com código ${code}`;
}

export type Start = (
  cols: number,
  rows: number,
  onEvent: (event: TerminalEvent) => void,
) => Promise<TerminalInfo | null>;

/** Um terminal da lista: a tela e o shell do núcleo. */
export class TerminalSession {
  /** O nome do shell, depois que o núcleo o inicia. */
  readonly name = signal('Terminal');
  /** O shell não iniciou: a mensagem aparece no lugar da tela. */
  readonly error = signal<string | null>(null);
  /** Nulo até o núcleo responder ao `terminal_create`. */
  id: number | null = null;
  exited = false;
  closed = false;

  /** `program`: o terminal `▶ <alvo>` do Executar sem depurar, em vez de um shell. */
  constructor(
    readonly screen: TerminalScreen,
    readonly program = false,
  ) {}

  /** O shell ainda recebe teclas e tamanhos. */
  get running(): boolean {
    return this.id !== null && !this.exited && !this.closed;
  }
}

/** Os terminais do painel inferior (docs/specs/terminal.md). */
@Injectable({ providedIn: 'root' })
export class Terminals {
  private readonly service = inject(TerminalService);
  private readonly screens = inject(TerminalScreens);
  private readonly commands = inject(Commands);
  private readonly panel = inject(Panel);
  private readonly project = inject(Project);
  private readonly dialogs = inject(Dialogs);
  readonly sessions = signal<TerminalSession[]>([]);
  readonly active = signal<TerminalSession | null>(null);
  /** O programa rodando (um por vez): "▶ app rodando" na barra de status. */
  readonly program = signal<TerminalSession | null>(null);
  /** O painel inferior está à mostra (em qualquer aba). */
  readonly visible = this.panel.visible;
  /** O primeiro terminal está sendo criado: o Ctrl+` não cria outro enquanto isso. */
  private creating = false;

  /** Ctrl+`: mostra ou esconde o painel na aba Terminal; sem nenhum terminal, cria um. */
  toggle(): void {
    if (this.visible() && this.panel.tab() === 'terminal') {
      this.visible.set(false);
    } else {
      this.show();
    }
  }

  /** Mostra a aba Terminal; sem nenhum terminal, cria um. */
  show(): void {
    if (this.sessions().length || this.creating) {
      this.panel.show('terminal');
    } else {
      void this.create();
    }
  }

  /** Cria um terminal com o shell padrão e o ativa. */
  async create(): Promise<void> {
    this.panel.show('terminal');
    this.creating = true;
    const screen = await this.screens
      .create()
      .catch(warn)
      .finally(() => (this.creating = false));
    // O xterm.js não carregou: sem tela não há terminal para mostrar.
    if (!screen) return this.visible.set(this.sessions().length > 0);
    const session = new TerminalSession(screen);
    this.sessions.update((list) => [...list, session]);
    this.active.set(session);
    await this.connect(session, (cols, rows, onEvent) =>
      this.service.create(cols, rows, onEvent),
    ).catch((error) => session.error.set(errorMessage(error)));
  }

  /**
   * Ctrl+F5: compila e roda o alvo ativo no terminal `▶ <alvo>`, que toma o lugar da aba anterior
   * do mesmo alvo. Com um programa rodando, pergunta antes de reiniciar.
   */
  async run(): Promise<void> {
    const running = this.program();
    if (running) {
      const name = running.name().replace(/^▶ /, '');
      const choice = await this.dialogs.ask(`${name} já está rodando. Reiniciar?`, [
        'Reiniciar',
        'Cancelar',
      ]);
      if (choice !== 'Reiniciar') return;
      // A resposta só chega quando o processo e os filhos já morreram.
      await this.service.close(running.id!).catch(warn);
    }
    const screen = await this.screens.create().catch(warn);
    if (!screen) return;
    const session = new TerminalSession(screen, true);
    const info = await this.connect(session, (cols, rows, onEvent) =>
      this.project.run(cols, rows, onEvent),
    );
    if (!info) return screen.dispose();
    this.place(session);
    if (!session.exited) this.program.set(session);
  }

  /**
   * O terminal `🐞 <alvo>` da depuração. Com `start`, roda o programa (pedido `runInTerminal`) e
   * rejeita se ele não iniciar; sem, é só leitura, para a saída que chega por eventos `output`.
   */
  async openDebug(name: string, start?: Start): Promise<TerminalSession | null> {
    const screen = await this.screens.create().catch(warn);
    if (!screen) return null;
    const session = new TerminalSession(screen, true);
    session.name.set(name);
    if (start) {
      await this.connect(session, start).catch((error) => {
        screen.dispose();
        throw error;
      });
    } else {
      // Sem `connect`, os atalhos da IDE (F5, F10…) ainda precisam sair da tela.
      screen.attachCustomKeyEventHandler((event) => this.onKey(screen, event));
    }
    this.place(session);
    return session;
  }

  /** Um terminal de programa toma o lugar da aba anterior com o mesmo nome e fica à mostra. */
  private place(session: TerminalSession): void {
    const old = this.sessions().find((item) => item.program && item.name() === session.name());
    this.sessions.update((list) =>
      old ? list.map((item) => (item === old ? session : item)) : [...list, session],
    );
    if (old) this.dispose(old);
    this.active.set(session);
    this.panel.show('terminal');
  }

  /** Shift+F5: encerra o programa; a aba fica aberta com o fim dele. */
  stop(): void {
    const running = this.program();
    if (running?.running) this.service.close(running.id!).catch(warn);
  }

  /**
   * Liga a tela ao processo que `start` inicia. O que a tela manda antes da resposta do núcleo
   * espera aqui. No Windows, o ConPTY pede a posição do cursor (ESC[6n) ao iniciar e só mostra
   * algo depois que a resposta do xterm.js chega.
   */
  private async connect(session: TerminalSession, start: Start): Promise<TerminalInfo | null> {
    const { screen } = session;
    screen.attachCustomKeyEventHandler((event) => this.onKey(screen, event));
    let queued: string | null = '';
    screen.onData((data) => {
      if (queued !== null) queued += data;
      else if (session.running) this.service.write(session.id!, data).catch(warn);
    });
    screen.onResize(({ cols, rows }) => {
      if (session.running) this.service.resize(session.id!, cols, rows).catch(warn);
    });
    // A tela pode ser ajustada ao painel antes da resposta; o tamanho novo vai logo depois dela.
    const { cols, rows } = screen;
    let pending = '';
    let info: TerminalInfo | null;
    try {
      info = await start(cols, rows, (event) => this.onEvent(session, event));
    } finally {
      pending = queued;
      queued = null;
    }
    if (!info) return null;
    session.id = info.id;
    if (session.closed) {
      this.service.close(info.id).catch(warn);
      return null;
    }
    session.name.set(info.name);
    if (pending && !session.exited) this.service.write(info.id, pending).catch(warn);
    if (screen.cols !== cols || screen.rows !== rows) {
      this.service.resize(info.id, screen.cols, screen.rows).catch(warn);
    }
    return info;
  }

  /** Encerra o shell e tudo o que roda nele; sem terminais, o painel se esconde. */
  close(session: TerminalSession): void {
    if (session.closed) return;
    this.dispose(session);
    const list = this.sessions();
    const rest = list.filter((item) => item !== session);
    this.sessions.set(rest);
    if (this.active() === session) {
      this.active.set(rest[Math.min(list.indexOf(session), rest.length - 1)] ?? null);
    }
    if (!rest.length) this.visible.set(false);
  }

  private dispose(session: TerminalSession): void {
    session.closed = true;
    if (this.program() === session) this.program.set(null);
    if (session.id !== null) this.service.close(session.id).catch(warn);
    session.screen.dispose();
  }

  private onEvent(session: TerminalSession, event: TerminalEvent): void {
    // Depois do `terminal_close` ainda chega o `exited`, e a tela já foi descartada.
    if (session.closed) return;
    if (event.kind === 'output') {
      session.screen.write(event.data);
    } else {
      session.exited = true;
      if (this.program() === session) this.program.set(null);
      session.screen.write(`\r\n\r\n${exitMessage(event.code, session.program)}\r\n`);
    }
  }

  /** O filtro do xterm.js: `false` faz ele ignorar a tecla. */
  private onKey(screen: TerminalScreen, event: KeyboardEvent): boolean {
    const action = terminalKey(event, PLATFORM, {
      hasSelection: screen.hasSelection(),
      altBuffer: screen.buffer.active.type === 'alternate',
      chordWaiting: this.commands.chordWaiting(),
    });
    // O xterm.js deixa subir as teclas que não usa (ex.: Ctrl+Shift+S); elas são do processo.
    if (action === 'shell') {
      if (event.type === 'keydown') event.stopPropagation();
      return true;
    }
    if (action === 'page') return false;
    event.preventDefault();
    if (event.type !== 'keydown') return false;
    if (action === 'copy') {
      navigator.clipboard.writeText(screen.getSelection()).catch(warn);
    } else if (action === 'paste') {
      // Colar passa pelo xterm.js, que avisa o programa (bracketed paste) e chama `onData`.
      navigator.clipboard.readText().then((text) => screen.paste(text), warn);
    } else {
      screen.scrollPages(action === 'pageUp' ? -1 : 1);
    }
    return false;
  }
}

function warn(error: unknown): void {
  console.warn('Terminal:', errorMessage(error));
}
