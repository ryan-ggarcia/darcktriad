import { TestBed } from '@angular/core/testing';
import { bindingsFor, COMMANDS, Commands } from './commands';
import { Platform } from './keybindings';

const PLATFORMS: Platform[] = ['windows', 'linux', 'mac'];
/** Categorias em pt-BR das specs; uma nova entra aqui junto com a spec que a cria. */
const CATEGORIES = [
  'Arquivo',
  'Editar',
  'Ver',
  'Ir',
  'Explorador',
  'Terminal',
  'Projeto',
  'Linguagem',
  'Ferramentas',
  'Ajuda',
];

function key(code: string, modifiers: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { code, key: code.replace(/^Key/, ''), ...modifiers });
}

describe('registro de comandos', () => {
  for (const platform of PLATFORMS) {
    it(`não tem dois comandos com o mesmo atalho e a mesma condição (${platform})`, () => {
      expect(() => bindingsFor(platform)).not.toThrow();
    });
  }

  it('rejeita um atalho repetido com a mesma condição, nomeando os dois comandos', () => {
    const repeated = { ...COMMANDS, saveAs: { ...COMMANDS.saveAs, keys: ['Mod+S'] } };

    expect(() => bindingsFor('windows', repeated)).toThrowError(
      '"Arquivo: Salvar" e "Arquivo: Salvar como" usam o mesmo atalho (Ctrl+S) com a mesma condição.',
    );
  });

  it('aceita o mesmo atalho quando as condições são diferentes', () => {
    const elsewhere = {
      ...COMMANDS,
      saveAs: { ...COMMANDS.saveAs, keys: ['Mod+S'], when: 'folderOpen' as const },
    };

    expect(() => bindingsFor('windows', elsewhere)).not.toThrow();
  });

  it('todo comando tem nome "Categoria: Ação" em pt-BR, sem texto vazio', () => {
    for (const [id, { title }] of Object.entries(COMMANDS)) {
      const [category, action, ...rest] = title.split(': ');
      expect(CATEGORIES, `${id}: ${title}`).toContain(category);
      expect(action?.trim(), `${id}: ${title}`).toMatch(/^\p{Lu}\p{Ll}/u);
      expect(rest, `${id}: ${title}`).toEqual([]);
    }
  });
});

describe('Commands', () => {
  let commands: Commands;
  let ran: string[];

  beforeEach(() => {
    commands = TestBed.inject(Commands);
    ran = [];
    commands.register({
      save: () => ran.push('save'),
      openFolder: () => ran.push('openFolder'),
      closeFolder: () => ran.push('closeFolder'),
    });
    commands.setConditions({
      editorOpen: () => false,
      textEditor: () => false,
      folderOpen: () => true,
      project: () => false,
    });
  });

  it('só executa o que está disponível agora', () => {
    expect(commands.run('save')).toBe(false);
    expect(commands.run('closeFolder')).toBe(true);
    // Sem tratador ligado, o comando ainda não existe na interface.
    expect(commands.run('goToLine')).toBe(false);
    expect(ran).toEqual(['closeFolder']);
    expect(commands.available()).toEqual(['openFolder', 'closeFolder']);
  });

  it('mostra na barra de status o acorde esperando a segunda tecla, e quando ele não existe', () => {
    expect(commands.handleKey(key('KeyK', { ctrlKey: true }))).toBe(true);
    expect(commands.keyStatus()).toBe('(Ctrl+K) pressionado. Aguardando a segunda tecla…');

    expect(commands.handleKey(key('Escape'))).toBe(true);
    expect(commands.keyStatus()).toBe('A combinação não é um comando');

    commands.handleKey(key('KeyK', { ctrlKey: true }));
    commands.handleKey(key('KeyO', { ctrlKey: true }));
    expect(commands.keyStatus()).toBe('');
    expect(ran).toEqual(['openFolder']);
  });

  it('a dica junta o nome e o atalho', () => {
    expect(commands.hint('Abrir pasta', 'openFolder')).toBe('Abrir pasta (Ctrl+K Ctrl+O)');
    expect(commands.hint('Novo arquivo', 'explorerNewFile')).toBe('Novo arquivo');
  });
});
