import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommandId, Commands } from '../shared/commands';
import { Icon } from '../shared/icon';
import { Debugger } from './debugger';

/** A barra flutuante da sessão, no topo dos editores; cada ícone tem dica com nome e atalho. */
@Component({
  selector: 'app-debug-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'debug-toolbar', role: 'toolbar', 'aria-label': 'Depuração' },
  template: `
    @for (item of items(); track item.id) {
      <button
        type="button"
        class="icon-button"
        [class.debug-stop]="item.id === 'stop'"
        [attr.aria-label]="commands.hint(item.label, item.id)"
        [title]="commands.hint(item.label, item.id)"
        [disabled]="!commands.isAvailable(item.id)"
        (click)="commands.run(item.id)"
      >
        <app-icon [name]="item.icon" />
      </button>
    }
  `,
})
export class DebugToolbar {
  protected readonly debug = inject(Debugger);
  protected readonly commands = inject(Commands);

  protected items(): { id: CommandId; label: string; icon: string }[] {
    const paused = this.debug.state() === 'paused';
    return [
      paused
        ? { id: 'debugStart', label: 'Continuar', icon: 'continue' }
        : { id: 'debugPause', label: 'Pausar', icon: 'pause' },
      { id: 'debugStepOver', label: 'Passar por cima', icon: 'step-over' },
      { id: 'debugStepInto', label: 'Entrar', icon: 'step-into' },
      { id: 'debugStepOut', label: 'Sair', icon: 'step-out' },
      { id: 'debugRestart', label: 'Reiniciar', icon: 'refresh' },
      { id: 'stop', label: 'Parar', icon: 'stop' },
    ];
  }
}
