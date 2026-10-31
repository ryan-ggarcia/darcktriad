import { TestBed } from '@angular/core/testing';
import { createFakes, settle } from '../testing/fakes';
import { MenuEntry } from './ipc';
import { buildMenu, MainMenu } from './main-menu';
import { Commands, isCommandId } from './shared/commands';
import { Workspace } from './workspace/workspace';

type Submenu = Extract<MenuEntry, { kind: 'submenu' }>;
type Command = Extract<MenuEntry, { kind: 'command' }>;

function submenu(menu: MenuEntry[], label: string): MenuEntry[] {
  return (menu.find((entry) => entry.kind === 'submenu' && entry.label === label) as Submenu).items;
}

function item(items: MenuEntry[], label: string): Command | undefined {
  return items.find((entry) => entry.kind === 'command' && entry.label === label) as
    Command | undefined;
}

describe('menu principal', () => {
  const recents = [
    { path: 'C:\\proj', exists: true },
    { path: 'C:\\velha', exists: false },
  ];

  it('tem só os menus e comandos que já existem, com o atalho de cada um', () => {
    const menu = buildMenu(recents, 'windows');

    expect(menu.map((entry) => (entry as Submenu).label)).toEqual([
      'Arquivo',
      'Editar',
      'Ver',
      'Ir',
      'Ajuda',
    ]);
    expect(item(submenu(menu, 'Ir'), 'Voltar')?.accelerator).toBe('Alt+←');
    expect(item(submenu(buildMenu(recents, 'linux'), 'Ir'), 'Voltar')?.accelerator).toBe(
      'Ctrl+Alt+-',
    );
    const file = submenu(menu, 'Arquivo');
    expect(item(file, 'Abrir pasta')?.accelerator).toBe('Ctrl+K Ctrl+O');
    expect(item(file, 'Sair')).toEqual({
      kind: 'command',
      id: 'quit',
      label: 'Sair',
      accelerator: null,
    });
    expect(item(submenu(menu, 'Ver'), 'Paleta de comandos')?.accelerator).toBe('Ctrl+Shift+P');
    expect(item(submenu(menu, 'Ver'), 'Terminal')?.accelerator).toBe('Ctrl+`');
    expect(item(submenu(buildMenu(recents, 'mac'), 'Ver'), 'Terminal')?.accelerator).toBe(
      'Ctrl+Backquote',
    );
    expect(item(submenu(menu, 'Editar'), 'Copiar')).toEqual({
      kind: 'command',
      id: 'copy',
      label: 'Copiar',
      accelerator: 'Ctrl+C',
      role: 'copy',
    });
    expect(item(submenu(menu, 'Ajuda'), 'Verificar e instalar ferramentas')).toEqual({
      kind: 'command',
      id: 'checkTools',
      label: 'Verificar e instalar ferramentas',
      accelerator: null,
    });
    const ids = menu.flatMap((entry) => (entry as Submenu).items);
    for (const entry of ids) {
      if (entry.kind === 'command') expect(isCommandId(entry.id), entry.id).toBe(true);
    }
  });

  it('põe as pastas recentes num submenu, marcando a que não existe mais', () => {
    const recent = submenu(submenu(buildMenu(recents, 'linux'), 'Arquivo'), 'Pastas recentes');

    expect(recent).toEqual([
      { kind: 'command', id: 'recentFolder:C:\\proj', label: 'C:\\proj' },
      { kind: 'command', id: 'recentFolder:C:\\velha', label: 'C:\\velha (não existe mais)' },
    ]);
    expect(item(submenu(buildMenu([], 'linux'), 'Arquivo'), 'Pastas recentes')).toBeUndefined();
  });

  it('no macOS, deixa o Sair para o menu do app e não manda acordes como atalho', () => {
    const file = submenu(buildMenu([], 'mac'), 'Arquivo');

    expect(item(file, 'Sair')).toBeUndefined();
    expect(file.at(-1)?.kind).toBe('command');
    expect(item(file, 'Salvar')?.accelerator).toBe('Cmd+KeyS');
    expect(item(file, 'Fechar pasta')?.accelerator).toBeNull();
  });

  it('chama set_menu ao iniciar e executa o comando escolhido no menu pelo registro', async () => {
    const fakes = createFakes();
    TestBed.configureTestingModule({ providers: fakes.providers });
    const ran: string[] = [];
    TestBed.inject(Commands).register({ showCommands: () => ran.push('showCommands') });
    TestBed.inject(MainMenu).start();
    fakes.workspace.recents = [{ path: 'C:\\proj', exists: true }];
    await TestBed.inject(Workspace).start();
    TestBed.tick();
    await settle();

    expect(fakes.workspace.menus.length).toBeGreaterThan(0);
    expect(submenu(fakes.workspace.menus.at(-1)!, 'Arquivo')).toContainEqual(
      expect.objectContaining({ label: 'Pastas recentes' }),
    );

    fakes.workspace.menuCommand!('showCommands');
    fakes.workspace.menuCommand!('naoExiste');
    expect(ran).toEqual(['showCommands']);
  });
});
