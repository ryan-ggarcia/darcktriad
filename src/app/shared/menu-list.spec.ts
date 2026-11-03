import { buildMenu } from '../main-menu';
import { fold } from './fuzzy';
import { mnemonicPositions } from './menu-list';

function letters(labels: (string | null)[]): string[] {
  return mnemonicPositions(labels).map((at, index) => (at < 0 ? '' : labels[index]![at]));
}

describe('letra dos itens de menu', () => {
  it('prefere a inicial de uma palavra e, depois, a primeira letra livre', () => {
    expect(letters(['Salvar', 'Salvar como', 'Salvar tudo', null, 'Sair'])).toEqual([
      'S',
      'c',
      't',
      '',
      'a',
    ]);
  });

  it('não diferencia maiúsculas nem acentos; sem letra livre, o item fica sem letra', () => {
    expect(letters(['Área', 'Ação', 'A'])).toEqual(['Á', 'ç', '']);
  });

  it('nos menus reais, cada item tem uma letra só dele', () => {
    for (const platform of ['windows', 'linux', 'mac'] as const) {
      for (const menu of buildMenu(
        [{ path: '/projetos/um', exists: true, lastOpened: null }],
        platform,
      )) {
        if (menu.kind !== 'submenu') continue;
        const labels = menu.items.map((item) => (item.kind === 'separator' ? null : item.label));
        const found = letters(labels).filter((_, index) => labels[index]);
        expect(found.every(Boolean), `${platform}: ${menu.label}`).toBe(true);
        expect(new Set(found.map(fold)).size, `${platform}: ${menu.label}`).toBe(found.length);
      }
    }
  });
});
