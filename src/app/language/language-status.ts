import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Language } from '../ipc';
import { Panel } from '../shared/panel';
import { LANGUAGES, Languages, SERVER_NAMES, ServerStatus } from './languages';

export interface ServerItem {
  language: Language;
  label: string;
  hint: string;
  stopped: boolean;
}

/** O texto de um servidor na barra de status (docs/specs/linguagem.md, Servidores). */
export function serverItem(
  language: Language,
  status: ServerStatus,
  ready: boolean,
  progress: { percentage?: number } | null,
): ServerItem {
  const { label, channel } = SERVER_NAMES[language];
  const show = `Clique para ver o canal ${channel} na Saída.`;
  const item = (state: string, hint: string, stopped = false) => ({
    language,
    label: `${label}: ${state}`,
    hint: `${hint} ${show}`,
    stopped,
  });
  switch (status.kind) {
    case 'stopped':
    case 'missing':
      return item('parado', status.reason, true);
    case 'noProject':
      return item(
        'sem projeto',
        'Erros e autocomplete de C# precisam de um projeto .NET: abra a pasta de um .csproj ou .sln.',
      );
    default:
      if (!ready) return item('iniciando…', `O servidor ${channel} está iniciando.`);
      if (!progress) return item('pronto', `O servidor ${channel} está pronto.`);
      return item(
        progress.percentage === undefined ? 'indexando…' : `indexando ${progress.percentage}%`,
        `O servidor ${channel} está indexando o projeto; os recursos já funcionam, mais lentos.`,
      );
  }
}

/** A parte direita da barra de status: um item por servidor de linguagem iniciado. */
@Component({
  selector: 'app-language-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'status-languages' },
  template: `
    @for (item of items(); track item.language) {
      <button
        type="button"
        class="status-item"
        [class.status-error]="item.stopped"
        [title]="item.hint"
        (click)="panel.showOutput(channelOf(item))"
      >
        {{ item.label }}
      </button>
      @if (item.stopped) {
        <button
          type="button"
          class="status-item status-action"
          [title]="'Reiniciar o servidor ' + channelOf(item)"
          (click)="languages.restart(item.language)"
        >
          Reiniciar
        </button>
      }
    }
  `,
})
export class LanguageStatus {
  protected readonly languages = inject(Languages);
  protected readonly panel = inject(Panel);

  protected readonly items = computed(() =>
    LANGUAGES.flatMap((language) => {
      const server = this.languages.servers[language];
      const status = server.status();
      if (!status) return [];
      const client = server.client();
      return [serverItem(language, status, !!client?.ready(), client?.progress() ?? null)];
    }),
  );

  protected channelOf(item: ServerItem): string {
    return SERVER_NAMES[item.language].channel;
  }
}
