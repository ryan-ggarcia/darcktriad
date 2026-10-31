import { Injectable, signal } from '@angular/core';
import { EditRole } from '../ipc';
import {
  Binding,
  formatChord,
  formatStroke,
  parseChord,
  Platform,
  PLATFORM,
  ShortcutDispatcher,
} from './keybindings';

/** Condição de disponibilidade: o comando só aparece e só roda quando ela vale. */
export type Condition = 'editorOpen' | 'textEditor' | 'folderOpen' | 'project';

export interface CommandSpec {
  /** Nome em pt-BR no formato `Categoria: Ação`. */
  title: string;
  /** Atalhos padrão do VS Code (ver `parseChord`); `windows`, `linux` e `mac` trocam o padrão. */
  keys?: string[];
  windows?: string[];
  linux?: string[];
  mac?: string[];
  when?: Condition;
  /** A tecla é do campo com foco (editor ou caixa de texto): o atalho só aparece, não é despachado. */
  native?: true;
  /** Rótulo no menu quando o nome sem a categoria fica vago. */
  menu?: string;
  /** Item nativo de edição no menu do macOS (docs/ipc.md, `set_menu`). */
  role?: EditRole;
}

export type CommandId =
  | 'newFile'
  | 'openFile'
  | 'openFolder'
  | 'closeFolder'
  | 'save'
  | 'saveAs'
  | 'saveAll'
  | 'closeEditor'
  | 'closeAllEditors'
  | 'nextEditor'
  | 'previousEditor'
  | 'recentEditors'
  | 'recentEditorsBack'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'find'
  | 'replace'
  | 'commentLine'
  | 'showCommands'
  | 'quickOpen'
  | 'goToLine'
  | 'showExplorer'
  | 'toggleSidebar'
  | 'explorerNewFile'
  | 'explorerNewFolder'
  | 'explorerRefresh'
  | 'explorerCollapseAll'
  | 'toggleTerminal'
  | 'newTerminal'
  | 'selectConfig'
  | 'selectTarget'
  | 'reconfigure'
  | 'checkTools'
  | 'keyboardShortcuts';

/**
 * O registro: todo comando da IDE, com os atalhos das tabelas das specs (docs/specs/editor.md,
 * explorador.md, paleta-de-comandos.md, terminal.md e projeto.md). Menu, botões, paleta e teclado partem daqui.
 */
export const COMMANDS: Record<CommandId, CommandSpec> = {
  newFile: { title: 'Arquivo: Novo arquivo', keys: ['Mod+N'] },
  // No macOS, ⌘O abre arquivo ou pasta.
  openFile: { title: 'Arquivo: Abrir arquivo', keys: ['Mod+O'] },
  openFolder: { title: 'Arquivo: Abrir pasta', keys: ['Mod+K Mod+O'], mac: [] },
  closeFolder: { title: 'Arquivo: Fechar pasta', keys: ['Mod+K F'], when: 'folderOpen' },
  save: { title: 'Arquivo: Salvar', keys: ['Mod+S'], when: 'editorOpen' },
  saveAs: { title: 'Arquivo: Salvar como', keys: ['Mod+Shift+S'], when: 'editorOpen' },
  saveAll: { title: 'Arquivo: Salvar tudo', windows: ['Mod+K S'], mac: ['Mod+Alt+S'] },
  // Sem atalho no Windows: lá o Alt+F4 do sistema fecha a janela.
  quit: { title: 'Arquivo: Sair', linux: ['Ctrl+Q'], mac: ['Mod+Q'] },
  closeEditor: {
    title: 'Ver: Fechar editor',
    keys: ['Mod+W'],
    windows: ['Mod+F4', 'Mod+W'],
    when: 'editorOpen',
  },
  closeAllEditors: {
    title: 'Ver: Fechar todos os editores',
    keys: ['Mod+K Mod+W'],
    when: 'editorOpen',
  },
  nextEditor: {
    title: 'Ver: Próximo editor',
    keys: ['Mod+PageDown'],
    mac: ['Mod+Alt+Right', 'Mod+Shift+]'],
    when: 'editorOpen',
  },
  previousEditor: {
    title: 'Ver: Editor anterior',
    keys: ['Mod+PageUp'],
    mac: ['Mod+Alt+Left', 'Mod+Shift+['],
    when: 'editorOpen',
  },
  recentEditors: {
    title: 'Ver: Alternar entre editores recentes',
    keys: ['Ctrl+Tab'],
    when: 'editorOpen',
  },
  recentEditorsBack: {
    title: 'Ver: Alternar entre editores recentes (voltar)',
    keys: ['Ctrl+Shift+Tab'],
    when: 'editorOpen',
  },
  undo: {
    title: 'Editar: Desfazer',
    keys: ['Mod+Z'],
    when: 'textEditor',
    native: true,
    role: 'undo',
  },
  redo: {
    title: 'Editar: Refazer',
    keys: ['Mod+Y'],
    mac: ['Mod+Shift+Z'],
    when: 'textEditor',
    native: true,
    role: 'redo',
  },
  cut: {
    title: 'Editar: Recortar',
    keys: ['Mod+X'],
    when: 'textEditor',
    native: true,
    role: 'cut',
  },
  copy: {
    title: 'Editar: Copiar',
    keys: ['Mod+C'],
    when: 'textEditor',
    native: true,
    role: 'copy',
  },
  paste: {
    title: 'Editar: Colar',
    keys: ['Mod+V'],
    when: 'textEditor',
    native: true,
    role: 'paste',
  },
  selectAll: {
    title: 'Editar: Selecionar tudo',
    keys: ['Mod+A'],
    when: 'textEditor',
    native: true,
    role: 'selectAll',
  },
  find: { title: 'Editar: Localizar', keys: ['Mod+F'], when: 'textEditor' },
  replace: { title: 'Editar: Substituir', keys: ['Mod+H'], mac: ['Mod+Alt+F'], when: 'textEditor' },
  commentLine: { title: 'Editar: Comentar linha', keys: ['Mod+/'], when: 'textEditor' },
  showCommands: { title: 'Ver: Paleta de comandos', keys: ['Mod+Shift+P', 'F1'] },
  quickOpen: { title: 'Ver: Abrir rápido (ir para arquivo)', keys: ['Mod+P'] },
  goToLine: { title: 'Ir: Ir para linha', keys: ['Ctrl+G'], when: 'textEditor' },
  showExplorer: { title: 'Ver: Mostrar Explorador', keys: ['Mod+Shift+E'] },
  toggleSidebar: { title: 'Ver: Mostrar/ocultar barra lateral', keys: ['Mod+B'] },
  explorerNewFile: { title: 'Explorador: Novo arquivo', when: 'folderOpen' },
  explorerNewFolder: { title: 'Explorador: Nova pasta', when: 'folderOpen' },
  explorerRefresh: { title: 'Explorador: Atualizar', when: 'folderOpen' },
  explorerCollapseAll: { title: 'Explorador: Recolher tudo', when: 'folderOpen' },
  // ⌃` também no macOS, como no VS Code.
  toggleTerminal: { title: 'Ver: Terminal', keys: ['Ctrl+`'] },
  newTerminal: { title: 'Terminal: Novo terminal', keys: ['Ctrl+Shift+`'] },
  // Sem atalho, como no VS Code: ficam na paleta e na barra de status.
  selectConfig: { title: 'Projeto: Selecionar configuração', when: 'project' },
  selectTarget: { title: 'Projeto: Selecionar alvo', when: 'project' },
  reconfigure: { title: 'Projeto: Reconfigurar', when: 'project' },
  checkTools: {
    title: 'Ferramentas: Verificar e instalar',
    menu: 'Verificar e instalar ferramentas',
  },
  keyboardShortcuts: { title: 'Ajuda: Atalhos de teclado' },
};

/**
 * Os atalhos do registro em `platform`. Recusa dois comandos com o mesmo atalho e a mesma
 * condição: o teclado não teria como escolher entre eles.
 */
export function bindingsFor(
  platform: Platform,
  commands: Record<string, CommandSpec> = COMMANDS,
): Binding<CommandId>[] {
  const owners = new Map<string, string>();
  const bindings: Binding<CommandId>[] = [];
  for (const [id, spec] of Object.entries(commands)) {
    for (const text of spec[platform] ?? spec.keys ?? []) {
      const chord = parseChord(text, platform);
      const key = `${formatChord(chord, platform)} | ${spec.when ?? ''}`;
      const owner = owners.get(key);
      if (owner && owner !== id) {
        throw new Error(
          `"${commands[owner].title}" e "${spec.title}" usam o mesmo atalho (${formatChord(chord, platform)}) com a mesma condição.`,
        );
      }
      owners.set(key, id);
      bindings.push({ id: id as CommandId, chord });
    }
  }
  return bindings;
}

export function isCommandId(id: string): id is CommandId {
  return Object.hasOwn(COMMANDS, id);
}

const CHORD_FAILED = 'A combinação não é um comando';
const CHORD_FAILED_MS = 10_000;

/** O registro em uso: tratadores, disponibilidade, despacho de teclas e o texto dos atalhos. */
@Injectable({ providedIn: 'root' })
export class Commands {
  readonly bindings = bindingsFor(PLATFORM);
  private readonly dispatcher = new ShortcutDispatcher(
    this.bindings.filter((binding) => !COMMANDS[binding.id].native),
  );
  private readonly handlers: Partial<Record<CommandId, () => unknown>> = {};
  private conditions: Partial<Record<Condition, () => boolean>> = {};
  /** Texto da barra de status durante um acorde (Ctrl+K …). */
  readonly keyStatus = signal('');

  /** Liga comandos a quem os executa; a função devolvida desliga os mesmos. */
  register(handlers: Partial<Record<CommandId, () => unknown>>): () => void {
    Object.assign(this.handlers, handlers);
    return () => {
      for (const id of Object.keys(handlers) as CommandId[]) {
        if (this.handlers[id] === handlers[id]) delete this.handlers[id];
      }
    };
  }

  setConditions(conditions: Record<Condition, () => boolean>): void {
    this.conditions = conditions;
  }

  /** O comando existe agora: tem quem o execute e a condição dele vale. Lê signals. */
  isAvailable(id: CommandId): boolean {
    const when = COMMANDS[id].when;
    return id in this.handlers && (!when || (this.conditions[when]?.() ?? false));
  }

  available(): CommandId[] {
    return (Object.keys(COMMANDS) as CommandId[]).filter((id) => this.isAvailable(id));
  }

  /** Um acorde (Ctrl+K …) espera a segunda tecla no despachante. */
  chordWaiting(): boolean {
    return this.dispatcher.waiting;
  }

  /** Executa se o comando estiver disponível; `false` se não estava. */
  run(id: CommandId): boolean {
    if (!this.isAvailable(id)) return false;
    this.handlers[id]!();
    return true;
  }

  /** Trata uma tecla vinda de fora do editor; `true` se ela foi consumida. */
  handleKey(event: KeyboardEvent): boolean {
    const result = this.dispatcher.handle(event, (id) => this.isAvailable(id));
    if (result?.kind === 'pending') this.chordPending(formatStroke(result.first, PLATFORM));
    else if (result?.kind === 'unknown') this.chordFailed();
    else this.keyStatus.set('');
    if (result?.kind === 'command') this.run(result.id);
    return result !== null;
  }

  /** Mostra que um acorde espera a segunda tecla; devolve como apagar a mensagem. */
  chordPending(first: string): () => void {
    const text = `(${first}) pressionado. Aguardando a segunda tecla…`;
    this.keyStatus.set(text);
    return () => this.clearStatus(text);
  }

  chordFailed(): void {
    this.keyStatus.set(CHORD_FAILED);
    setTimeout(() => this.clearStatus(CHORD_FAILED), CHORD_FAILED_MS);
  }

  title(id: CommandId): string {
    return COMMANDS[id].title;
  }

  /** Atalho principal do comando, para dicas e listas; vazio se não houver. */
  shortcut(id: CommandId): string {
    const binding = this.bindings.find((item) => item.id === id);
    return binding ? formatChord(binding.chord, PLATFORM) : '';
  }

  /** Rótulo com o atalho entre parênteses: "Abrir pasta (Ctrl+K Ctrl+O)". */
  hint(label: string, id: CommandId): string {
    const shortcut = this.shortcut(id);
    return shortcut ? `${label} (${shortcut})` : label;
  }

  private clearStatus(text: string): void {
    if (this.keyStatus() === text) this.keyStatus.set('');
  }
}
