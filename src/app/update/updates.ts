import { inject, Injectable, signal } from '@angular/core';
import { Debugger } from '../debug/debugger';
import { EditorTabs } from '../editor/editor-tabs';
import { AvailableUpdate, errorMessage } from '../ipc';
import { Project } from '../project/project';
import { Dialogs } from '../shared/dialogs';
import { Terminals } from '../terminal/terminals';
import { UpdateService } from '../update.service';
import { Workspace } from '../workspace/workspace';

/** Depois de a janela abrir, para não disputar a abertura com a pasta e os servidores. */
const AUTO_CHECK_DELAY_MS = 5000;
const STOP_AND_RESTART = 'Encerrar e reiniciar';

/** O que o aviso mostra; `null` é aviso nenhum. */
export type UpdateState =
  | { kind: 'checking' }
  | { kind: 'upToDate' }
  | { kind: 'available'; version: string; notes: string | null }
  | { kind: 'installing'; version: string; downloaded: number; total: number | null }
  | { kind: 'ready' }
  | { kind: 'restarting' }
  /** `retry`: o que "Tentar de novo" refaz. */
  | { kind: 'failed'; message: string; retry: 'check' | 'install' };

/** A atualização do app: verificar, baixar e reiniciar sem perder o trabalho (docs/ipc.md). */
@Injectable({ providedIn: 'root' })
export class Updates {
  private readonly service = inject(UpdateService);
  private readonly workspace = inject(Workspace);
  private readonly tabs = inject(EditorTabs);
  private readonly project = inject(Project);
  private readonly terminals = inject(Terminals);
  private readonly debug = inject(Debugger);
  private readonly dialogs = inject(Dialogs);

  readonly state = signal<UpdateState | null>(null);
  /** Baixada e esperando o reinício: "Depois" esconde o aviso, e o comando o traz de volta. */
  private installed = false;
  private restarting = false;

  /** Ao abrir: verifica em segundo plano. */
  start(): void {
    setTimeout(() => void this.checkSilently(), AUTO_CHECK_DELAY_MS);
  }

  /** O comando: aqui a resposta aparece sempre. */
  async check(): Promise<void> {
    const kind = this.state()?.kind;
    if (kind === 'checking' || kind === 'installing' || kind === 'restarting') return;
    if (this.installed) return this.state.set({ kind: 'ready' });
    this.state.set({ kind: 'checking' });
    try {
      this.showResult(await this.service.check());
    } catch (error) {
      this.state.set({ kind: 'failed', message: errorMessage(error), retry: 'check' });
    }
  }

  /** "Atualizar": o botão some ao mudar de estado, e um segundo pedido não passa daqui. */
  async install(): Promise<void> {
    const state = this.state();
    if (state?.kind === 'available') await this.download(state.version);
  }

  /** "Tentar de novo". Depois de uma rejeição, o núcleo só instala após outro `update_check`. */
  async retry(): Promise<void> {
    const state = this.state();
    if (state?.kind !== 'failed') return;
    if (state.retry === 'check') return this.check();
    this.state.set({ kind: 'checking' });
    try {
      const update = await this.service.check();
      if (update) await this.download(update.version);
      else this.showResult(null);
    } catch (error) {
      this.state.set({ kind: 'failed', message: errorMessage(error), retry: 'install' });
    }
  }

  /** "Depois" e "Fechar": sem gravar nada, então o aviso volta na próxima abertura. */
  hide(): void {
    this.state.set(null);
  }

  /** "Reiniciar agora": só depois das perguntas; cancelar qualquer uma mantém tudo como está. */
  async restart(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    try {
      if (!(await this.confirmStopWork()) || !(await this.workspace.confirmClose())) return;
      const answered = new Map(this.tabs.dirtyTabs().map((tab) => [tab, tab.buffer?.versionId()]));
      this.state.set({ kind: 'restarting' });
      await Promise.all([this.project.cancelBuildAndWait(), this.debug.stop()]);
      // Encerrar leva segundos com o editor aberto: o que foi digitado nesse tempo não teve pergunta.
      const typed = this.tabs
        .dirtyTabs()
        .filter((tab) => answered.get(tab) !== tab.buffer?.versionId());
      if (!(await this.tabs.confirmDiscard(typed))) return this.state.set({ kind: 'ready' });
      await this.service.restart().catch((error) => {
        // O núcleo já gastou o pacote baixado: é preciso baixar de novo.
        this.installed = false;
        this.state.set({ kind: 'failed', message: errorMessage(error), retry: 'install' });
      });
    } finally {
      this.restarting = false;
    }
  }

  private async checkSilently(): Promise<void> {
    if (this.state()) return;
    try {
      const update = await this.service.check();
      // O usuário pode ter pedido a verificação enquanto esta rodava: a dele vale.
      if (update && !this.state()) this.showResult(update);
    } catch (error) {
      console.warn('Atualização:', errorMessage(error));
    }
  }

  private showResult(update: AvailableUpdate | null): void {
    this.state.set(update ? { kind: 'available', ...update } : { kind: 'upToDate' });
  }

  private async download(version: string): Promise<void> {
    this.state.set({ kind: 'installing', version, downloaded: 0, total: null });
    try {
      await this.service.install(({ downloaded, total }) =>
        // O canal não tem ordem garantida com a resposta: um progresso atrasado não desfaz o fim.
        this.state.update((state) =>
          state?.kind === 'installing' ? { ...state, downloaded, total } : state,
        ),
      );
      this.installed = true;
      this.state.set({ kind: 'ready' });
    } catch (error) {
      this.state.set({ kind: 'failed', message: errorMessage(error), retry: 'install' });
    }
  }

  /** Os terminais e os servidores de linguagem o núcleo encerra; o programa rodando merece a pergunta. */
  private async confirmStopWork(): Promise<boolean> {
    const program = this.terminals.program();
    const work = [
      this.project.building() && 'a compilação em andamento',
      program && `o programa ${program.name().replace(/^▶ /, '')}`,
      this.debug.state() && 'a sessão de depuração',
    ].filter(Boolean);
    if (!work.length) return true;
    const choice = await this.dialogs.ask(
      'Reiniciar agora encerra o que está rodando. Continuar?',
      [STOP_AND_RESTART, 'Cancelar'],
      `Será encerrado: ${work.join(', ')}.`,
    );
    return choice === STOP_AND_RESTART;
  }
}
