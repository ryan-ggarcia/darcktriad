import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Traços 16×16 (desenho próprio) para os poucos ícones da interface. */
const PATHS: Record<string, string> = {
  'chevron-right': 'M6 3.5 10.5 8 6 12.5',
  'chevron-down': 'M3.5 6 8 10.5 12.5 6',
  folder: 'M1.5 3.5h4.5l1.5 1.5h6.5v7.5h-12.5z',
  'folder-open': 'M1.5 12.5v-9h4.5l1.5 1.5h5.5v2M1.5 12.5l2-5.5h11l-2 5.5z',
  file: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3',
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

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': '"icon icon-" + name()' },
  template: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path [attr.d]="path()" />
  </svg>`,
})
export class Icon {
  readonly name = input.required<string>();
  protected readonly path = computed(() => PATHS[this.name()] ?? '');
}
