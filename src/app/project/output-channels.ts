import { computed, inject, Injectable } from '@angular/core';
import { DEBUG_CHANNEL, Debugger } from '../debug/debugger';
import { LANGUAGES, Languages, SERVER_NAMES } from '../language/languages';
import { Panel } from '../shared/panel';
import { BUILD_CHANNEL, Project } from './project';

/** Os canais da Saída: os do projeto (CMake ou dotnet, e Build), os dos servidores (clangd, C#) e o Depuração. */
@Injectable({ providedIn: 'root' })
export class OutputChannels {
  private readonly project = inject(Project);
  private readonly languages = inject(Languages);
  private readonly panel = inject(Panel);
  private readonly debug = inject(Debugger);

  readonly channels = computed(() => {
    const project = this.project.channel();
    return [
      ...(project ? [project, BUILD_CHANNEL] : []),
      ...this.languages.channels(),
      ...(this.debug.state() || this.debug.log().length ? [DEBUG_CHANNEL] : []),
    ];
  });
  /** O escolhido, ou o primeiro que houver. Na aba Depuração, sempre o canal dela. */
  readonly current = computed(() => {
    if (this.panel.tab() === 'debug') return DEBUG_CHANNEL;
    const chosen = this.panel.outputChannel();
    return chosen && this.channels().includes(chosen) ? chosen : (this.channels()[0] ?? null);
  });
  readonly lines = computed(() => this.source().log());

  /** O botão Limpar: esvazia o canal à mostra. */
  clear(): void {
    this.source().log.set([]);
  }

  private source() {
    const channel = this.current();
    const language = LANGUAGES.find((item) => SERVER_NAMES[item].channel === channel);
    if (language) return this.languages.servers[language];
    if (channel === DEBUG_CHANNEL) return this.debug;
    return { log: channel === BUILD_CHANNEL ? this.project.buildOutput : this.project.output };
  }
}
