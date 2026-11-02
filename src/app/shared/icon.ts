import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

const FOLDER =
  'M2.5 3.5h3.3l1.5 1.5h6.2a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z';
/** Folha com o canto cortado, comum a todos os tipos de arquivo. */
const PAGE =
  'M3 1.5h8l3.5 3.5v8a1.5 1.5 0 0 1-1.5 1.5h-10a1.5 1.5 0 0 1-1.5-1.5v-10a1.5 1.5 0 0 1 1.5-1.5z';

/** Traços 16×16 (desenho próprio) para os poucos ícones da interface. */
const PATHS: Record<string, string> = {
  'chevron-right': 'M6 3.5 10.5 8 6 12.5',
  'chevron-down': 'M3.5 6 8 10.5 12.5 6',
  folder: FOLDER,
  'folder-open':
    'M1.5 12.5v-8a1 1 0 0 1 1-1h3.3l1.5 1.5h5.2a1 1 0 0 1 1 1v1M1.5 12.5l2-5.5h11l-2 5.5z',
  // A silhueta da folha vem de `TILES`; aqui, só o desenho de cada tipo.
  file: 'M4.5 6.5h5M4.5 9h7M4.5 11.5h7',
  'file-c': 'M10.3 6.2A3.2 3.2 0 1 0 10.3 10.8',
  'file-cpp': 'M7.9 6.6A2.7 2.7 0 1 0 7.9 10.4M9.7 6.6h2.6M11 5.3v2.6M9.7 10.4h2.6M11 9.1v2.6',
  'file-header': 'M5 5v7M11 5v7M5 8.5h6',
  'file-cs': 'M7.5 6.7A2.5 2.5 0 1 0 7.5 10.3M10 5.8v5.4M12 5.8v5.4M9 7.6h4M9 9.4h4',
  'file-cmake': 'M8 4.5 12.5 7 8 9.5 3.5 7zM3.5 9.7 8 12.2 12.5 9.7',
  'file-project': 'M8 4l4 2.2v4.6L8 13l-4-2.2V6.2zM4 6.2l4 2.2 4-2.2M8 8.4V13',
  'file-json':
    'M6.5 4.5c-1.2 0-1.7.5-1.7 1.5v1c0 .7-.3 1.2-1 1.5.7.3 1 .8 1 1.5v1c0 1 .5 1.5 1.7 1.5M9.5 4.5c1.2 0 1.7.5 1.7 1.5v1c0 .7.3 1.2 1 1.5-.7.3-1 .8-1 1.5v1c0 1-.5 1.5-1.7 1.5',
  'file-markdown': 'M3.8 11.5v-6l4.2 4.2 4.2-4.2v6',
  triad:
    'M8 3.5 13 12H3zM8 3.5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M13 12m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M3 12m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  'new-file': 'M8.5 14.5h-5v-13h6l3 3v4M9.5 1.5v3h3M12.5 10v5M10 12.5h5',
  'new-folder': 'M8 12.5h-6.5v-9h4.5l1.5 1.5h6.5v3M12.5 10v5M10 12.5h5',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.6M13 2v3h-3',
  'collapse-all': 'M4.5 2.5h9v9M1.5 5.5h9v9h-9zM3.5 10h5',
  close: 'M4 4l8 8M12 4l-8 8',
  add: 'M8 2.5v11M2.5 8h11',
  dot: 'M8 8h0',
  files: 'M5.5 1.5h5l3 3v8h-8zM10.5 1.5v3h3M3.5 4.5v10h7',
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
  'folder-open': 'M1.5 12.5l2-5.5h11l-2 5.5z',
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
