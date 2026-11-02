import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { EditorTabs } from '../editor/editor-tabs';
import { BuildProblem } from '../ipc';
import { basename } from '../paths';
import { Panel } from '../shared/panel';
import { OutputChannels } from './output-channels';
import { BUILD_CHANNEL, Project } from './project';

/** Um pedaço do log: texto corrido, ou uma linha que é link para o problema. */
export interface OutputSegment {
  text: string;
  problem?: BuildProblem;
}

/**
 * Corta o log nas linhas que citam um problema da compilação (mesmo `arquivo:linha` e mensagem),
 * que viram links. O resto fica em texto corrido, com as quebras de linha.
 */
export function linkProblems(lines: string[], problems: BuildProblem[]): OutputSegment[] {
  const linked = problems.filter((problem) => problem.file && problem.line);
  const segments: OutputSegment[] = [];
  let text = '';
  // shortcut: compara cada linha com cada problema; indexar por arquivo se um log grande travar.
  lines.forEach((line, i) => {
    const separator = i ? '\n' : '';
    const problem = linked.find((item) => mentions(line, item));
    if (!problem) {
      text += separator + line;
      return;
    }
    segments.push({ text: text + separator }, { text: line, problem });
    text = '';
  });
  return [...segments, { text }].filter((segment) => segment.text);
}

function mentions(text: string, { file, line, message }: BuildProblem): boolean {
  const name = basename(file!);
  return (
    text.includes(message) &&
    [`${name}:${line}:`, `${name}(${line},`, `${name}(${line})`].some((place) =>
      text.includes(place),
    )
  );
}

/**
 * A aba Saída, no canal escolhido (CMake, dotnet, Build, clangd, C#): a saída ao vivo, que rola
 * sozinha enquanto o usuário está no fim. No Build, as linhas de erro abrem o arquivo.
 */
@Component({
  selector: 'app-output-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'output-view' },
  // Dentro do <pre> todo espaço aparece: o @for fica numa linha só.
  template: `
    @if (segments().length) {
      <pre
        #log
        class="output-log"
        tabindex="0"
        [attr.aria-label]="'Saída: canal ' + output.current()"
        (scroll)="onScroll(log)"
      >@for (segment of segments(); track $index) {@if (segment.problem; as problem) {<button type="button" class="output-link" [title]="hint(problem)" (click)="open(problem)">{{ segment.text }}</button>} @else {<span>{{ segment.text }}</span>}}</pre>
    } @else {
      <p class="panel-empty">
        Nada na Saída ainda. A saída aparece quando o projeto (CMake ou .NET) configura ou compila,
        ou quando um servidor de linguagem (clangd, C#) inicia.
      </p>
    }
  `,
})
export class OutputView {
  protected readonly output = inject(OutputChannels);
  private readonly project = inject(Project);
  private readonly panel = inject(Panel);
  private readonly tabs = inject(EditorTabs);
  private readonly log = viewChild<ElementRef<HTMLElement>>('log');
  protected readonly segments = computed(() => {
    const problems = this.output.current() === BUILD_CHANNEL ? this.project.buildProblems() : [];
    return linkProblems(this.output.lines(), problems);
  });
  private following = true;

  constructor() {
    afterRenderEffect(() => {
      this.segments();
      const log = this.log()?.nativeElement;
      if (log && this.panel.visible() && this.panel.tab() === 'output' && this.following) {
        log.scrollTop = log.scrollHeight;
      }
    });
  }

  protected onScroll(log: HTMLElement): void {
    this.following = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  }

  protected hint({ file, line }: BuildProblem): string {
    return `Abrir ${basename(file!)} na linha ${line}`;
  }

  protected open({ file, line, column }: BuildProblem): void {
    void this.tabs.openAt(file!, { line: line!, column: column ?? 1 });
  }
}
