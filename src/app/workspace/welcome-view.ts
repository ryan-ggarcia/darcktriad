import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { basename } from '../paths';
import { Commands } from '../shared/commands';
import { Workspace } from './workspace';

/** Tela inicial: abrir pasta ou arquivo e as pastas recentes (docs/specs/explorador.md). */
@Component({
  selector: 'app-welcome-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'welcome' },
  template: `
    <h1 class="welcome-title">Dark Triad</h1>
    <div class="welcome-actions">
      <button type="button" class="primary" (click)="workspace.openFolderDialog()">
        Abrir pasta <kbd>{{ commands.shortcut('openFolder') }}</kbd>
      </button>
      <button type="button" (click)="workspace.openFileDialog()">
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
