import { computed, inject, Injectable, signal } from '@angular/core';
import { EditorTabs } from '../editor/editor-tabs';
import {
  BuildProblem,
  BuildStatus,
  errorMessage,
  ProjectEvent,
  ProjectKind,
  ProjectState,
  TerminalEvent,
  TerminalInfo,
} from '../ipc';
import { ProjectService } from '../project.service';
import { Commands } from '../shared/commands';
import { Dialogs } from '../shared/dialogs';
import { Panel } from '../shared/panel';
import { MarkerSeverity } from '../language/lsp';
import { ProblemItem, Problems } from './problems';

/** Cada canal da Saída guarda só as últimas linhas, para não crescer sem fim. */
export const OUTPUT_LIMIT = 10_000;

export function withLine(lines: string[], line: string): string[] {
  return lines.length < OUTPUT_LIMIT ? [...lines, line] : [...lines.slice(1), line];
}

export const BUILD_CHANNEL = 'Build';
const BUSY = 'Já há uma compilação em andamento';
const RESULT_MS = 5000;

const SEVERITIES = {
  error: MarkerSeverity.Error,
  warning: MarkerSeverity.Warning,
  info: MarkerSeverity.Info,
};

/** O texto da barra de status ao fim da compilação: "Compilação falhou: 2 erros, 1 aviso". */
export function buildSummary(status: BuildStatus, problems: BuildProblem[]): string | null {
  if (status === 'succeeded') return 'Compilação concluída';
  if (status === 'cancelled') return null;
  const count = (severity: string, one: string, many: string) => {
    const n = problems.filter((item) => item.severity === severity).length;
    return n ? `${n} ${n === 1 ? one : many}` : '';
  };
  const parts = [count('error', 'erro', 'erros'), count('warning', 'aviso', 'avisos')];
  const detail = parts.filter(Boolean).join(', ');
  return detail ? `Compilação falhou: ${detail}` : 'Compilação falhou';
}

/** O item do painel Problemas; o de reserva (sem arquivo) abre a Saída. */
export function buildProblemItem(problem: BuildProblem): ProblemItem {
  const line = problem.line ?? 1;
  const column = problem.column ?? 1;
  return {
    file: problem.file,
    severity: SEVERITIES[problem.severity],
    message: problem.message,
    source: 'build',
    ...(problem.code && { code: problem.code }),
    startLineNumber: line,
    startColumn: column,
    endLineNumber: line,
    endColumn: column,
  };
}

/** O canal da Saída de cada tipo de projeto que configura (docs/ipc.md). */
const CHANNELS: Partial<Record<ProjectKind, 'CMake' | 'dotnet'>> = {
  cmake: 'CMake',
  cmakePresets: 'CMake',
  dotnetSolution: 'dotnet',
  dotnetProjects: 'dotnet',
};

/** O núcleo avisa o cancelamento como `failed` com esta mensagem (docs/ipc.md). */
// shortcut: reconhece pelo texto, igual ao de configure.rs; criar um status próprio se o texto precisar mudar.
const CONFIGURE_CANCELLED = 'Configuração cancelada.';

const NO_PROJECT: ProjectState = {
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

/** O projeto da pasta aberta (docs/specs/projeto.md): estado do núcleo, canal da Saída e escolhas. */
@Injectable({ providedIn: 'root' })
export class Project {
  private readonly service = inject(ProjectService);
  private readonly panel = inject(Panel);
  private readonly dialogs = inject(Dialogs);
  private readonly problems = inject(Problems);
  private readonly tabs = inject(EditorTabs);
  private readonly commands = inject(Commands);

  readonly state = signal<ProjectState>(NO_PROJECT);
  /** As linhas do canal da Saída, uma por item. */
  readonly output = signal<string[]>([]);
  /** As linhas do canal Build. */
  readonly buildOutput = signal<string[]>([]);
  /** Os problemas da última compilação, para os links do canal Build. */
  readonly buildProblems = signal<BuildProblem[]>([]);
  /** Entre o pedido e a resposta de `project_build`/`project_run`: "Compilando…" com o ✕. */
  readonly building = signal(false);
  /** "Compilação concluída" ou "Compilação falhou: …", por 5 s. */
  readonly buildResult = signal<string | null>(null);
  private lastBuild: BuildStatus | null = null;
  private onBuildEnded?: () => void;
  private resultTimer?: ReturnType<typeof setTimeout>;
  /** O canal da Saída (CMake ou dotnet); null se a pasta não tem projeto que configure. */
  readonly channel = computed(() => CHANNELS[this.state().kind] ?? null);
  /** A configuração falhou de verdade: cancelar é escolha do usuário, não erro. */
  readonly configureFailed = computed(() => {
    const { status } = this.state();
    return status.kind === 'failed' && status.message !== CONFIGURE_CANCELLED;
  });
  private warnedRoot: string | null = null;
  private eventSeen = false;

  /** Ao iniciar: ouve o núcleo e pega o estado atual (o aviso de uma pasta já aberta pode ter passado). */
  async start(): Promise<void> {
    await this.service.onEvent((event) => this.onEvent(event));
    const state = await this.service.state().catch(warn);
    // Um evento que chegou antes da resposta é mais novo do que ela.
    if (state && !this.eventSeen) this.apply(state);
  }

  /** Depois de fechar a pasta: o núcleo esquece o projeto sem mandar evento. */
  async refresh(): Promise<void> {
    const state = await this.service.state().catch(warn);
    if (state) this.apply(state);
  }

  selectConfig(config: string): void {
    if (config === this.state().config) return;
    this.service.selectConfig(config).catch(this.tellError('trocar a configuração'));
  }

  selectTarget(target: string): void {
    if (target === this.state().target) return;
    this.service.selectTarget(target).catch(this.tellError('trocar o alvo'));
  }

  reconfigure(): void {
    this.service.reconfigure().catch(this.tellError('reconfigurar o projeto'));
  }

  /** Ctrl+Shift+B: salva tudo e compila todos os alvos. */
  build(): void {
    void this.compile(() => this.service.build());
  }

  cancelBuild(): void {
    this.service.cancelBuild().catch(warn);
  }

  /** Cancela e resolve quando a compilação acabou de fato. */
  cancelBuildAndWait(): Promise<void> {
    if (!this.building()) return Promise.resolve();
    this.cancelBuild();
    return new Promise((resolve) => (this.onBuildEnded = resolve));
  }

  /**
   * Ctrl+F5: salva tudo, compila o alvo ativo e o roda num terminal novo (o canal já recebe a
   * saída). Null se não rodou; com a compilação falha, abre o painel Problemas.
   */
  async run(
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalInfo | null> {
    return this.startAfterBuild(() => this.service.run(cols, rows, onEvent));
  }

  /** O começo do Ctrl+F5 e do F5: salva, compila e chama `start`, que inicia o programa. */
  async startAfterBuild<T>(start: () => Promise<T | null>): Promise<T | null> {
    const started = await this.compile(start);
    if (!started && this.lastBuild === 'failed') this.panel.show('problems');
    return started;
  }

  private async compile<T>(start: () => Promise<T>): Promise<T | null> {
    if (this.building()) {
      this.commands.flash(BUSY);
      return null;
    }
    this.building.set(true);
    this.lastBuild = null;
    try {
      // Só os arquivos: uma aba sem título abriria o "Salvar como" a cada compilação.
      for (const tab of this.tabs.dirtyTabs()) if (tab.path()) await this.tabs.save(tab);
      this.buildOutput.set([]);
      this.buildProblems.set([]);
      this.buildResult.set(null);
      // O painel Saída não pega o foco: o editor continua com ele.
      this.panel.showOutput(BUILD_CHANNEL);
      return await start();
    } catch (error) {
      void this.dialogs.tell(errorMessage(error));
      return null;
    } finally {
      this.building.set(false);
      this.onBuildEnded?.();
    }
  }

  private onEvent(event: ProjectEvent): void {
    if (event.kind === 'output') {
      this.output.update((lines) => withLine(lines, event.line));
    } else if (event.kind === 'buildOutput') {
      this.buildOutput.update((lines) => withLine(lines, event.line));
    } else if (event.kind === 'buildFinished') {
      this.finishBuild(event.status, event.problems);
    } else {
      this.eventSeen = true;
      this.apply(event.state);
    }
  }

  private finishBuild(status: BuildStatus, problems: BuildProblem[]): void {
    this.lastBuild = status;
    this.buildProblems.set(problems);
    this.problems.set('build', problems.map(buildProblemItem));
    this.buildResult.set(buildSummary(status, problems));
    clearTimeout(this.resultTimer);
    this.resultTimer = setTimeout(() => this.buildResult.set(null), RESULT_MS);
  }

  private apply(state: ProjectState): void {
    const before = this.state().status.kind;
    this.state.set(state);
    const source = this.channel() ?? 'CMake';
    this.problems.set(
      'project',
      state.problems.map(({ file, line, message }) => ({
        file,
        severity: MarkerSeverity.Error,
        message,
        source,
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: 1,
      })),
    );
    // Cada configuração começa com o canal limpo; a primeira linha é o comando.
    if (state.status.kind === 'configuring' && before !== 'configuring') this.output.set([]);
    if (this.configureFailed() && before !== 'failed') this.panel.showOutput(this.channel());
    if (state.warning && state.root !== this.warnedRoot) {
      this.warnedRoot = state.root;
      void this.dialogs.tell(state.warning);
    }
  }

  private tellError(action: string): (error: unknown) => void {
    return (error) => void this.dialogs.tell(`Não foi possível ${action}.`, errorMessage(error));
  }
}

function warn(error: unknown): undefined {
  console.warn('Projeto:', errorMessage(error));
  return undefined;
}
