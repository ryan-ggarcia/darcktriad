import { Injectable } from '@angular/core';
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { ProjectEvent, ProjectState, TerminalEvent, TerminalInfo, ToolCheck } from './ipc';

/** Projeto CMake, compilar e executar, e verificação de ferramentas no núcleo Rust (docs/ipc.md, Projeto e Ferramentas). */
@Injectable({ providedIn: 'root' })
export class ProjectService {
  state(): Promise<ProjectState> {
    return invoke('project_state');
  }

  selectConfig(config: string): Promise<void> {
    return invoke('project_select_config', { config });
  }

  selectTarget(target: string): Promise<void> {
    return invoke('project_select_target', { target });
  }

  reconfigure(): Promise<void> {
    return invoke('project_reconfigure');
  }

  /** Responde quando a compilação termina. */
  build(): Promise<void> {
    return invoke('project_build');
  }

  cancelBuild(): Promise<void> {
    return invoke('project_build_cancel');
  }

  /** Compila o alvo ativo e o roda num terminal; null se a compilação falhou ou foi cancelada. */
  run(
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalInfo | null> {
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = onEvent;
    return invoke('project_run', { cols, rows, onEvent: channel });
  }

  checkTools(): Promise<ToolCheck[]> {
    return invoke('tools_check');
  }

  onEvent(handler: (event: ProjectEvent) => void): Promise<UnlistenFn> {
    return listen<ProjectEvent>('project-event', (event) => handler(event.payload));
  }
}
