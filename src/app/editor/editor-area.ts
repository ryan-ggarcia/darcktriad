import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
} from '@angular/core';
import { Debugger } from '../debug/debugger';
import { Commands } from '../shared/commands';
import { fileIcon, Icon } from '../shared/icon';
import { CodeEditor } from './code-editor';
import { EditorTabs } from './editor-tabs';
import { Tab } from './tab';

/** Faixa de abas, avisos da aba ativa e o editor. */
@Component({
  selector: 'app-editor-area',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CodeEditor, Icon],
  host: { class: 'editor-area' },
  templateUrl: './editor-area.html',
})
export class EditorArea {
  protected readonly tabs = inject(EditorTabs);
  protected readonly commands = inject(Commands);
  protected readonly debug = inject(Debugger);
  protected readonly fileIcon = fileIcon;
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  protected readonly textTab = computed(() => {
    const tab = this.tabs.active();
    return tab?.view.kind === 'text' ? tab : null;
  });

  protected select(tab: Tab): void {
    this.tabs.activate(tab);
    this.tabs.requestFocus();
  }

  protected close(tab: Tab): void {
    void this.tabs.close(tab);
  }

  protected closeHint(tab: Tab): string {
    const hint = this.commands.hint('Fechar', 'closeEditor');
    return tab.dirty() ? `${hint}: alterações não salvas` : hint;
  }

  /** Setas na faixa de abas, como no padrão ARIA de abas. */
  protected onTabKeydown(event: KeyboardEvent): void {
    const offset = { ArrowRight: 1, ArrowLeft: -1 }[event.key] as 1 | -1 | undefined;
    if (!offset) return;
    event.preventDefault();
    this.tabs.activateNext(offset);
    afterNextRender(
      () => this.host.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus(),
      { injector: this.injector },
    );
  }

  protected readOnly(tab: Tab): boolean {
    return tab.view.kind === 'text' && tab.view.readOnly;
  }

  /** Aviso no lugar do editor para arquivos que não abrem nele. */
  protected notice(tab: Tab): string | null {
    if (tab.view.kind === 'binary') return 'Arquivo binário: não exibido no editor';
    if (tab.view.kind !== 'tooLarge') return null;
    const megabytes = tab.view.size / 1048576;
    return `Arquivo grande demais para o editor (${megabytes.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB)`;
  }
}
