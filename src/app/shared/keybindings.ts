/** Atalhos de teclado: leitura de eventos, texto do atalho e acordes (Ctrl+K …). */

export type Platform = 'windows' | 'mac' | 'linux';

export const PLATFORM: Platform = navigator.userAgent.includes('Mac')
  ? 'mac'
  : navigator.userAgent.includes('Windows')
    ? 'windows'
    : 'linux';

/** Uma tecla com modificadores; `code` é o `KeyboardEvent.code` (posição física). */
export interface KeyStroke {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  code: string;
}

export interface Binding<Id extends string = string> {
  id: Id;
  chord: KeyStroke[];
}

const CODES: Record<string, string> = {
  Right: 'ArrowRight',
  Left: 'ArrowLeft',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '/': 'Slash',
};

const LABELS: Record<string, string> = {
  ArrowRight: '→',
  ArrowLeft: '←',
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/',
  Escape: 'Esc',
};

/** `Mod` é Ctrl, ou ⌘ no macOS; as partes de um acorde são separadas por espaço. */
export function parseChord(text: string, platform: Platform): KeyStroke[] {
  return text.split(' ').map((stroke) => parseStroke(stroke, platform));
}

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

/** Texto do atalho como o VS Code mostra: `Ctrl+Shift+S`, ou `⇧⌘S` no macOS. */
export function formatChord(chord: KeyStroke[], platform: Platform): string {
  return chord.map((stroke) => formatStroke(stroke, platform)).join(' ');
}

export function formatStroke(stroke: KeyStroke, platform: Platform): string {
  const key = LABELS[stroke.code] ?? stroke.code.replace(/^(Key|Digit)/, '');
  if (platform === 'mac') {
    const mods = `${stroke.ctrl ? '⌃' : ''}${stroke.alt ? '⌥' : ''}${stroke.shift ? '⇧' : ''}`;
    return `${mods}${stroke.meta ? '⌘' : ''}${key}`;
  }
  return [stroke.ctrl && 'Ctrl', stroke.shift && 'Shift', stroke.alt && 'Alt', key]
    .filter(Boolean)
    .join('+');
}

/**
 * O atalho para o menu nativo (docs/ipc.md, `set_menu`). Fora do macOS ele é só texto; no macOS
 * vai no formato do Tauri, e acordes ficam sem atalho, porque o menu de lá não os entende.
 */
export function formatAccelerator(chord: KeyStroke[], platform: Platform): string | null {
  if (platform !== 'mac') return formatChord(chord, platform);
  if (chord.length > 1) return null;
  const [stroke] = chord;
  return [stroke.ctrl && 'Ctrl', stroke.alt && 'Alt', stroke.shift && 'Shift', stroke.meta && 'Cmd']
    .filter(Boolean)
    .concat(stroke.code)
    .join('+');
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

/** O que fazer com a tecla: rodar um comando, esperar a segunda tecla, avisar que o acorde não existe ou deixar passar. */
export type KeyResult<Id extends string> =
  { kind: 'command'; id: Id } | { kind: 'pending'; first: KeyStroke } | { kind: 'unknown' } | null;

/** Casa teclas com atalhos, guardando a primeira parte de um acorde até a próxima tecla. */
export class ShortcutDispatcher<Id extends string> {
  private pending: Binding<Id>[] | null = null;

  constructor(private readonly bindings: Binding<Id>[]) {}

  /** `available` filtra os atalhos cujo comando não vale agora (condição de disponibilidade). */
  handle(event: KeyboardEvent, available: (id: Id) => boolean = () => true): KeyResult<Id> {
    if (MODIFIER_KEYS.has(event.key)) return null;
    const step = this.pending ? 1 : 0;
    const candidates = (this.pending ?? this.bindings).filter(
      (binding) =>
        binding.chord.length > step && matches(event, binding.chord[step]) && available(binding.id),
    );
    this.pending = null;
    const complete = candidates.find((binding) => binding.chord.length === step + 1);
    if (complete) return { kind: 'command', id: complete.id };
    if (candidates.length) {
      this.pending = candidates;
      return { kind: 'pending', first: candidates[0].chord[0] };
    }
    // Como no VS Code, a segunda tecla de um acorde que não existe é descartada.
    return step ? { kind: 'unknown' } : null;
  }
}
