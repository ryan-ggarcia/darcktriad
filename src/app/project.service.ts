import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { ProjectEvent, ProjectState, ToolCheck } from './ipc';

/** Projeto CMake e verificação de ferramentas no núcleo Rust (docs/ipc.md, Projeto e Ferramentas). */
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

  checkTools(): Promise<ToolCheck[]> {
    return invoke('tools_check');
  }

  onEvent(handler: (event: ProjectEvent) => void): Promise<UnlistenFn> {
    return listen<ProjectEvent>('project-event', (event) => handler(event.payload));
  }
}
