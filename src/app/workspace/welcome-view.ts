import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { basename } from '../paths';
import { Commands } from '../shared/commands';
import { Icon } from '../shared/icon';
import { Workspace } from './workspace';

/** Tela inicial: abrir pasta ou arquivo e as pastas recentes (docs/specs/explorador.md). */
@Component({
  selector: 'app-welcome-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'welcome' },
  template: `
    <app-icon class="welcome-logo" name="triad" />
    <h1 class="welcome-title">Dark Triad</h1>
    <p class="welcome-tagline">IDE para C, C++ e C#</p>
    <div class="welcome-actions">
      <button
        type="button"
        class="primary"
        [title]="commands.hint('Abrir pasta', 'openFolder')"
        (click)="workspace.openFolderDialog()"
      >
        Abrir pasta <kbd>{{ commands.shortcut('openFolder') }}</kbd>
      </button>
      <button
        type="button"
        [title]="commands.hint('Abrir arquivo', 'openFile')"
        (click)="workspace.openFileDialog()"
      >
        Abrir arquivo <kbd>{{ commands.shortcut('openFile') }}</kbd>
      </button>
    </div>
    @if (workspace.recents().length) {
      <h2 class="welcome-subtitle" id="recents-title">Recentes</h2>
      <ul class="recents" aria-labelledby="recents-title">
        @for (recent of workspace.recents(); track recent.path) {
          <li>
            <button
              type="button"
              class="recent"
              [class.missing]="!recent.exists"
              [title]="
                recent.exists ? recent.path : 'A pasta não existe mais: clique para tirar da lista'
              "
              (click)="workspace.openRecent(recent)"
            >
              <app-icon class="folder-icon" name="folder" />
              <span class="recent-name">{{ basename(recent.path) || recent.path }}</span>
              <span class="recent-path">{{ recent.path }}</span>
            </button>
          </li>
        }
      </ul>
    }
  `,
})
export class WelcomeView {
  protected readonly workspace = inject(Workspace);
  protected readonly commands = inject(Commands);
  protected readonly basename = basename;
}
