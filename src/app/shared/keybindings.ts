/** Atalhos de teclado: definição, leitura de eventos e acordes (Ctrl+K …). */

export type Platform = 'windows' | 'mac' | 'linux';

export const PLATFORM: Platform = navigator.userAgent.includes('Mac')
  ? 'mac'
  : navigator.userAgent.includes('Windows')
    ? 'windows'
    : 'linux';

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
  | 'showExplorer'
  | 'toggleSidebar';

/**
 * Atalhos padrão do VS Code, conferidos nas tabelas de docs/specs/editor.md e explorador.md.
 * `Mod` é Ctrl, ou ⌘ no macOS; as partes de um acorde são separadas por espaço.
 */
export function defaultKeys(platform: Platform): Record<CommandId, string[]> {
  const mac = platform === 'mac';
  return {
    newFile: ['Mod+N'],
    openFile: ['Mod+O'],
    // No macOS, ⌘O abre arquivo ou pasta.
    openFolder: mac ? ['Mod+O'] : ['Mod+K Mod+O'],
    closeFolder: ['Mod+K F'],
    save: ['Mod+S'],
    saveAs: ['Mod+Shift+S'],
    saveAll: mac ? ['Mod+Alt+S'] : platform === 'windows' ? ['Mod+K S'] : [],
    closeEditor: platform === 'windows' ? ['Mod+F4', 'Mod+W'] : ['Mod+W'],
    closeAllEditors: ['Mod+K Mod+W'],
    nextEditor: mac ? ['Mod+Alt+Right', 'Mod+Shift+]'] : ['Mod+PageDown'],
    previousEditor: mac ? ['Mod+Alt+Left', 'Mod+Shift+['] : ['Mod+PageUp'],
    recentEditors: ['Ctrl+Tab'],
    recentEditorsBack: ['Ctrl+Shift+Tab'],
    showExplorer: ['Mod+Shift+E'],
    toggleSidebar: ['Mod+B'],
  };
}

/** Uma tecla com modificadores; `code` é o `KeyboardEvent.code` (posição física). */
export interface KeyStroke {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  code: string;
}

export interface Binding {
  id: CommandId;
  chord: KeyStroke[];
}

const CODES: Record<string, string> = {
  Right: 'ArrowRight',
  Left: 'ArrowLeft',
  '[': 'BracketLeft',
  ']': 'BracketRight',
};

const LABELS: Record<string, string> = {
  ArrowRight: '→',
  ArrowLeft: '←',
  BracketLeft: '[',
  BracketRight: ']',
};

export function parseStroke(text: string, platform: Platform): KeyStroke {
  const parts = text.split('+');
  const key = parts.pop()!;
  const mod = parts.includes('Mod');
  return {
    ctrl: parts.includes('Ctrl') || (mod && platform !== 'mac'),
    meta: mod && platform === 'mac',
    shift: parts.includes('Shift'),
    alt: parts.includes('Alt'),
    code: CODES[key] ?? (key.length === 1 ? `Key${key}` : key),
  };
}

export function bindingsFor(keys: Record<CommandId, string[]>, platform: Platform): Binding[] {
  return (Object.entries(keys) as [CommandId, string[]][]).flatMap(([id, list]) =>
    list.map((text) => ({ id, chord: text.split(' ').map((s) => parseStroke(s, platform)) })),
  );
}

/** Texto do atalho como o VS Code mostra: `Ctrl+Shift+S`, ou `⇧⌘S` no macOS. */
export function formatChord(chord: KeyStroke[], platform: Platform): string {
  return chord
    .map((stroke) => {
      const key = LABELS[stroke.code] ?? stroke.code.replace(/^Key/, '');
      if (platform === 'mac') {
        const mods = `${stroke.ctrl ? '⌃' : ''}${stroke.alt ? '⌥' : ''}${stroke.shift ? '⇧' : ''}`;
        return `${mods}${stroke.meta ? '⌘' : ''}${key}`;
      }
      return [stroke.ctrl && 'Ctrl', stroke.shift && 'Shift', stroke.alt && 'Alt', key]
        .filter(Boolean)
        .join('+');
    })
    .join(' ');
}

function matches(event: KeyboardEvent, stroke: KeyStroke): boolean {
  return (
    event.code === stroke.code &&
    event.ctrlKey === stroke.ctrl &&
    event.metaKey === stroke.meta &&
    event.shiftKey === stroke.shift &&
    event.altKey === stroke.alt
  );
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

/** O que fazer com a tecla: rodar um comando, só consumir (parte de um acorde) ou deixar passar. */
export type KeyResult = CommandId | 'consume' | null;

/** Casa teclas com atalhos, guardando a primeira parte de um acorde até a próxima tecla. */
export class ShortcutDispatcher {
  private pending: Binding[] | null = null;

  constructor(private readonly bindings: Binding[]) {}

  handle(event: KeyboardEvent): KeyResult {
    if (MODIFIER_KEYS.has(event.key)) return null;
    const step = this.pending ? 1 : 0;
    const candidates = (this.pending ?? this.bindings).filter(
      (binding) => binding.chord.length > step && matches(event, binding.chord[step]),
    );
    this.pending = null;
    const complete = candidates.find((binding) => binding.chord.length === step + 1);
    if (complete) return complete.id;
    if (candidates.length) {
      this.pending = candidates;
      return 'consume';
    }
    // Como no VS Code, a segunda tecla de um acorde que não existe é descartada.
    return step ? 'consume' : null;
  }
}
