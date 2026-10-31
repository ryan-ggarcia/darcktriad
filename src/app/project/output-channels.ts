import { computed, inject, Injectable } from '@angular/core';
import { LANGUAGES, Languages, SERVER_NAMES } from '../language/languages';
import { Panel } from '../shared/panel';
import { Project } from './project';

/** Os canais da Saída: o do projeto (CMake ou dotnet) e os dos servidores (clangd, C#). */
@Injectable({ providedIn: 'root' })
export class OutputChannels {
  private readonly project = inject(Project);
  private readonly languages = inject(Languages);
  private readonly panel = inject(Panel);

  readonly channels = computed(() => {
    const project = this.project.channel();
    return [...(project ? [project] : []), ...this.languages.channels()];
  });
  /** O escolhido, ou o primeiro que houver. */
  readonly current = computed(() => {
    const chosen = this.panel.outputChannel();
    return chosen && this.channels().includes(chosen) ? chosen : (this.channels()[0] ?? null);
  });
  readonly lines = computed(() => {
    const channel = this.current();
    const language = LANGUAGES.find((item) => SERVER_NAMES[item].channel === channel);
    return language ? this.languages.servers[language].log() : this.project.output();
  });
}
