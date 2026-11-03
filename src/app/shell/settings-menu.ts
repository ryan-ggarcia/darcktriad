import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Languages } from '../language/languages';
import { Appearance } from '../shared/appearance';
import { Commands } from '../shared/commands';
import { MenuButton } from '../shared/menu-button';
import { MenuItem } from '../shared/menu-list';

/** A engrenagem (barra da janela e barra de atividades): tema, material e a lista de atalhos. */
@Component({
  selector: 'app-settings-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MenuButton],
  template: `
    <app-menu-button
      icon="settings"
      label="Configurações"
      title="Configurações: tema, material, formatar ao salvar e atalhos de teclado"
      [buttonClass]="buttonClass()"
      [placement]="placement()"
      [items]="items()"
    />
  `,
})
export class SettingsMenu {
  readonly placement = input<'below-end' | 'right-end'>('below-end');
  readonly buttonClass = input('');
  private readonly appearance = inject(Appearance);
  private readonly commands = inject(Commands);
  private readonly languages = inject(Languages);

  protected readonly items = computed<(MenuItem | null)[]>(() => {
    const { theme, material } = this.appearance;
    const glass = this.appearance.glassSupported();
    return [
      { label: 'Tema: Escuro', checked: theme() === 'dark', run: () => theme.set('dark') },
      { label: 'Tema: Claro', checked: theme() === 'light', run: () => theme.set('light') },
      null,
      {
        label: 'Material: Vidro',
        checked: glass && material() === 'glass',
        disabled: !glass,
        hint: glass
          ? 'Material: Vidro (fundo translúcido, com desfoque onde o sistema permite)'
          : 'O vidro precisa do Windows 11',
        run: () => material.set('glass'),
      },
      {
        label: 'Material: Sólido',
        checked: !glass || material() === 'solid',
        run: () => material.set('solid'),
      },
      null,
      {
        label: 'Formatar ao salvar',
        toggle: true,
        checked: this.languages.formatOnSave(),
        run: () => this.commands.run('toggleFormatOnSave'),
      },
      null,
      { label: 'Atalhos de teclado', run: () => this.commands.run('keyboardShortcuts') },
    ];
  });
}
