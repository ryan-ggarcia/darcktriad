import { computed, inject, Injectable, signal } from '@angular/core';
import { errorMessage, ProjectEvent, ProjectKind, ProjectState } from '../ipc';
import { ProjectService } from '../project.service';
import { Dialogs } from '../shared/dialogs';
import { Panel } from '../shared/panel';
import { MarkerSeverity } from '../language/lsp';
import { Problems } from './problems';

/** O canal da Saída guarda só as últimas linhas, para não crescer sem fim. */
export const OUTPUT_LIMIT = 5000;

/** O canal da Saída de cada tipo de projeto que configura (docs/ipc.md). */
const CHANNELS: Partial<Record<ProjectKind, 'CMake' | 'dotnet'>> = {
  cmake: 'CMake',
  cmakePresets: 'CMake',
  dotnetSolution: 'dotnet',
  dotnetProjects: 'dotnet',
};

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

  readonly state = signal<ProjectState>(NO_PROJECT);
  /** As linhas do canal da Saída, uma por item. */
  readonly output = signal<string[]>([]);
  /** O canal da Saída (CMake ou dotnet); null se a pasta não tem projeto que configure. */
  readonly channel = computed(() => CHANNELS[this.state().kind] ?? null);
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

  private onEvent(event: ProjectEvent): void {
    if (event.kind === 'output') {
      this.output.update((lines) =>
        lines.length < OUTPUT_LIMIT ? [...lines, event.line] : [...lines.slice(1), event.line],
      );
    } else {
      this.eventSeen = true;
      this.apply(event.state);
    }
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
    if (state.status.kind === 'failed' && before !== 'failed')
      this.panel.showOutput(this.channel());
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
