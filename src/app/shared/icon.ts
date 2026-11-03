import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

const FOLDER =
  'M1.5 4.3a1.3 1.3 0 0 1 1.3-1.3h3.1l1.5 1.5h5.8a1.3 1.3 0 0 1 1.3 1.3v6.4a1.3 1.3 0 0 1-1.3 1.3H2.8a1.3 1.3 0 0 1-1.3-1.3z';
/** Folha com o canto dobrado, comum a todos os tipos de arquivo. */
const PAGE =
  'M3.8 1.5h5.7l3 3v8.7a1.3 1.3 0 0 1-1.3 1.3H3.8a1.3 1.3 0 0 1-1.3-1.3V2.8a1.3 1.3 0 0 1 1.3-1.3z';
const PAGE_FOLD = 'M9.5 1.5v2.2a.8.8 0 0 0 .8.8h2.2';

/** Traços 16×16 (desenho próprio) para os ícones da interface. */
const PATHS: Record<string, string> = {
  'chevron-right': 'M6 3.5 10.5 8 6 12.5',
  'chevron-down': 'M3.5 6 8 10.5 12.5 6',
  'chevron-up': 'M3.5 10 8 5.5 12.5 10',
  folder: 'M1.5 6.2h13',
  'folder-open': 'M3 7.2h11.2l-1.6 5.6',
  // A silhueta da folha vem de `TILES`; aqui, a dobra e o desenho de cada tipo.
  file: `${PAGE_FOLD}M5 8h5M5 10.5h3.5`,
  'file-c': `${PAGE_FOLD}M9.4 8.1a2.2 2.2 0 1 0 0 3.3`,
  'file-cpp': `${PAGE_FOLD}M7.4 8.1a1.9 1.9 0 1 0 0 3.2M8.6 9.7h2.4M9.8 8.5v2.4`,
  'file-header': `${PAGE_FOLD}M5.6 7.2v5M9.4 7.2v5M5.6 9.7h3.8`,
  'file-cs': `${PAGE_FOLD}M7 8.1a1.9 1.9 0 1 0 0 3.2M8.7 7.6l-.4 4.2M10.3 7.6l-.4 4.2M8.1 9h2.6M7.9 10.5h2.6`,
  'file-cmake': `${PAGE_FOLD}M7.5 6.8l2.8 5H4.7z`,
  'file-project': `${PAGE_FOLD}M7.5 6.6l2.8 1.6v3.2L7.5 13l-2.8-1.6V8.2zM4.7 8.2l2.8 1.6 2.8-1.6M7.5 9.8V13`,
  'file-json': `${PAGE_FOLD}M6.3 7c-.9 0-1.2.4-1.2 1.1v.6c0 .5-.2.8-.7 1 .5.2.7.5.7 1v.6c0 .7.3 1.1 1.2 1.1M8.7 7c.9 0 1.2.4 1.2 1.1v.6c0 .5.2.8.7 1-.5.2-.7.5-.7 1v.6c0 .7-.3 1.1-1.2 1.1`,
  'file-markdown': `${PAGE_FOLD}M4.8 12V7.6l2.1 2.2L9 7.6V12M10.6 8.6v3.2M9.6 10.8l1 1 1-1`,
  /** O triângulo do ícone do app (src-tauri/icons), cheio. */
  logo: 'M8 2.2 14.3 13.3H1.7z',
  'new-file': 'M8.5 14.5h-5v-13h6l3 3v4M9.5 1.5v3h3M12.5 10v5M10 12.5h5',
  'new-folder': 'M8 12.5h-6.5v-9h4.5l1.5 1.5h6.5v3M12.5 10v5M10 12.5h5',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.6M13 2v3h-3',
  'collapse-all': 'M4.5 2.5h9v9M1.5 5.5h9v9h-9zM3.5 10h5',
  close: 'M4 4l8 8M12 4l-8 8',
  add: 'M8 2.5v11M2.5 8h11',
  dot: 'M8 8h0',
  more: 'M3.5 8h0M8 8h0M12.5 8h0',
  files: 'M5.5 1.5h5l3 3v8h-8zM10.5 1.5v3h3M3.5 4.5v10h7',
  tools:
    'M13.4 4.6 11.3 6.7 9.5 6.5 9.3 4.7l2.1-2.1a3.3 3.3 0 0 0-4.3 4.2L2.4 11.5a1.4 1.4 0 0 0 2 2l4.7-4.7a3.3 3.3 0 0 0 4.3-4.2z',
  settings:
    'M12.79 6.97L14.47 6.69L14.47 9.31L12.79 9.03L12.12 10.66L13.5 11.65L11.65 13.5L10.66 12.12L9.03 12.79L9.31 14.47L6.69 14.47L6.97 12.79L5.34 12.12L4.35 13.5L2.5 11.65L3.88 10.66L3.21 9.03L1.53 9.31L1.53 6.69L3.21 6.97L3.88 5.34L2.5 4.35L4.35 2.5L5.34 3.88L6.97 3.21L6.69 1.53L9.31 1.53L9.03 3.21L10.66 3.88L11.65 2.5L13.5 4.35L12.12 5.34zM8 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4',
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9M10.3 10.3l3.2 3.2',
  sun: 'M8 5.3a2.7 2.7 0 1 0 0 5.4a2.7 2.7 0 1 0 0-5.4M8 1.3v1.4M8 13.3v1.4M1.3 8h1.4M13.3 8h1.4M3.3 3.3l1 1M11.7 11.7l1 1M3.3 12.7l1-1M11.7 4.3l1-1',
  moon: 'M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z',
  play: 'M4.5 2.8v10.4L13 8z',
  'window-minimize': 'M3 8h10',
  'window-maximize': 'M3.5 3.5h9v9h-9z',
  'window-restore': 'M3.5 5.5h7v7h-7zM5.5 5.5v-2h7v7h-2',
  'window-close': 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  'run-debug': 'M3.5 2.5l8 5.5-8 5.5zM12.5 10.5a2 2 0 1 0 0 4a2 2 0 1 0 0-4',
  continue: 'M3.5 3v10M6.5 3l7 5-7 5z',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  'step-over': 'M2.5 8.5a5.5 5.5 0 0 1 10.5-2.3M13.5 3v3.5h-3.5M8 11.5a1 1 0 1 0 0 2a1 1 0 1 0 0-2',
  'step-into': 'M8 1.5v7M5 5.5l3 3 3-3M8 11.5a1 1 0 1 0 0 2a1 1 0 1 0 0-2',
  'step-out': 'M8 8.5v-7M5 4.5l3-3 3 3M8 11.5a1 1 0 1 0 0 2a1 1 0 1 0 0-2',
  stop: 'M4 4h8v8h-8z',
};

const FILE_ICONS = [
  ['file-c', ['c']],
  ['file-cpp', ['cpp', 'cc', 'cxx', 'c++']],
  ['file-header', ['h', 'hh', 'hpp', 'hxx', 'inl']],
  ['file-cs', ['cs']],
  ['file-cmake', ['cmake']],
  ['file-project', ['csproj', 'sln']],
  ['file-json', ['json']],
  ['file-markdown', ['md', 'markdown']],
] as const;

const ICON_BY_EXTENSION = new Map<string, string>(
  FILE_ICONS.flatMap(([icon, extensions]) => extensions.map((extension) => [extension, icon])),
);

/** O preenchimento suave que fica atrás do traço, nos ícones de arquivo e de pasta. */
const TILES: Record<string, string> = {
  file: PAGE,
  ...Object.fromEntries(FILE_ICONS.map(([icon]) => [icon, PAGE])),
  folder: FOLDER,
  'folder-open':
    'M1.5 12.2V4.3A1.3 1.3 0 0 1 2.8 3h3.1l1.5 1.5h5.8a1.3 1.3 0 0 1 1.3 1.3v1.4M1.5 12.2 3 7.2h11.2l-1.6 5.6H2.1a.6.6 0 0 1-.6-.6z',
};

/** O nome do ícone de um arquivo, pela extensão (docs/specs/explorador.md). */
export function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'cmakelists.txt') return 'file-cmake';
  const dot = lower.lastIndexOf('.');
  return (dot > 0 && ICON_BY_EXTENSION.get(lower.slice(dot + 1))) || 'file';
}

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': '"icon icon-" + name()' },
  template: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    @if (tile(); as tile) {
      <path class="icon-tile" [attr.d]="tile" />
    }
    <path [attr.d]="path()" />
  </svg>`,
})
export class Icon {
  readonly name = input.required<string>();
  protected readonly path = computed(() => PATHS[this.name()] ?? '');
  protected readonly tile = computed(() => TILES[this.name()]);
}
