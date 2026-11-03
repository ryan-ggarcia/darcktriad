import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RecentFolder } from '../ipc';
import { basename } from '../paths';
import { Commands } from '../shared/commands';
import { Icon } from '../shared/icon';
import { MenuButton } from '../shared/menu-button';
import { MenuItem } from '../shared/menu-list';
import { Workspace } from './workspace';

const DAY_MS = 86_400_000;

/** Quando a pasta foi aberta, na hora local: "hoje, 14:32", "ontem, 09:15" ou "28/10/2026 09:15". */
export function formatLastOpened(lastOpened: number | null, now = new Date()): string {
  if (lastOpened == null) return '';
  const date = new Date(lastOpened);
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const midnight = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate());
  // Arredonda: dias de 23 ou 25 h na troca do horário de verão.
  const days = Math.round((midnight(now).getTime() - midnight(date).getTime()) / DAY_MS);
  if (days === 0) return `hoje, ${time}`;
  if (days === 1) return `ontem, ${time}`;
  return `${date.toLocaleDateString('pt-BR')} ${time}`;
}

/** Tela inicial: abrir pasta, novo arquivo, executar e as pastas recentes (docs/specs/explorador.md). */
@Component({
  selector: 'app-welcome-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, MenuButton],
  host: { class: 'welcome' },
  template: `
    <header class="welcome-hero">
      <app-icon class="welcome-logo" name="logo" />
      <h1 class="welcome-title">Dark Triad</h1>
      <p class="welcome-tagline">IDE para C, C++ e C#</p>
      <p class="welcome-motto">Escreva • Compile • Execute</p>
    </header>

    <div class="welcome-cards">
      <button
        type="button"
        class="welcome-card"
        [title]="commands.hint('Abrir pasta', 'openFolder')"
        (click)="workspace.openFolderDialog()"
      >
        <app-icon class="card-icon" name="folder-open" />
        <span class="card-title">Abrir pasta</span>
        <span class="card-text">Um projeto CMake, .NET ou uma pasta de arquivos</span>
        <kbd>{{ commands.shortcut('openFolder') }}</kbd>
      </button>
      <button
        type="button"
        class="welcome-card"
        [title]="commands.hint('Novo arquivo sem título', 'newFile')"
        (click)="commands.run('newFile')"
      >
        <app-icon class="card-icon" name="new-file" />
        <span class="card-title">Novo arquivo</span>
        <span class="card-text">Um arquivo sem título, para salvar onde quiser</span>
        <kbd>{{ commands.shortcut('newFile') }}</kbd>
      </button>
      @let canRun = commands.isAvailable('run');
      <button
        type="button"
        class="welcome-card"
        [attr.aria-disabled]="!canRun || null"
        [title]="
          canRun
            ? commands.hint('Executar projeto: compila e roda o alvo ativo', 'run')
            : 'Executar projeto: abra uma pasta com CMakeLists.txt (C/C++) ou .csproj (C#)'
        "
        (click)="canRun && commands.run('run')"
      >
        <app-icon class="card-icon" name="play" />
        <span class="card-title">Executar projeto</span>
        <span class="card-text">{{
          canRun ? 'Compila e roda o alvo ativo no terminal' : 'Precisa de um projeto aberto'
        }}</span>
        <kbd>{{ commands.shortcut('run') }}</kbd>
      </button>
    </div>

    @if (workspace.recents().length) {
      <section class="welcome-recents" aria-labelledby="recents-title">
        <h2 class="welcome-subtitle" id="recents-title">Recentes</h2>
        <ul class="recents">
          @for (recent of workspace.recents(); track recent.path) {
            @let name = basename(recent.path) || recent.path;
            <li class="recent" [class.missing]="!recent.exists" animate.leave="recent-leave">
              <button
                type="button"
                class="recent-open"
                [title]="
                  recent.exists
                    ? 'Abrir ' + recent.path
                    : 'A pasta não existe mais: clique para tirar da lista'
                "
                (click)="workspace.openRecent(recent)"
              >
                <app-icon class="folder-icon" name="folder" />
                <span class="recent-text">
                  <span class="recent-name">{{ name }}</span>
                  <span class="recent-path">{{ recent.path }}</span>
                </span>
                @if (formatLastOpened(recent.lastOpened); as when) {
                  <span class="recent-date">{{ when }}</span>
                }
              </button>
              <app-menu-button
                icon="more"
                buttonClass="recent-more"
                placement="below-end"
                [label]="'Opções de ' + name"
                [items]="options(recent)"
              />
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class WelcomeView {
  protected readonly workspace = inject(Workspace);
  protected readonly commands = inject(Commands);
  protected readonly basename = basename;
  protected readonly formatLastOpened = formatLastOpened;

  protected options(recent: RecentFolder): MenuItem[] {
    return [
      {
        label: 'Abrir',
        hint: recent.exists ? `Abrir ${recent.path}` : 'A pasta não existe mais',
        disabled: !recent.exists,
        run: () => this.workspace.openRecent(recent),
      },
      {
        label: 'Remover da lista',
        hint: 'Tira a pasta das recentes; nada é apagado do disco',
        run: () => this.workspace.removeRecent(recent),
      },
    ];
  }
}
