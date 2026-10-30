import { ComponentFixture, TestBed } from '@angular/core/testing';
import { createFakes, Fakes, settle } from '../../testing/fakes';
import { EditorTabs } from '../editor/editor-tabs';
import { CommandId, COMMANDS, Commands } from '../shared/commands';
import { CurrentFolder } from '../workspace/current-folder';
import { parseLineTarget, QuickOpen } from './quick-open';

const ROOT = 'C:\\proj';
const MAIN = 'C:\\proj\\app\\main.cpp';
const FILES = [
  'CMakeLists.txt',
  'app\\main.cpp',
  'core\\soma.cpp',
  'core\\soma.h',
  'tool\\main.cpp',
];

/** Meta do README (critério 14): primeira lista < 500 ms e cada tecla < 100 ms, com 50.000 arquivos. */
const FIRST_LIST_BUDGET_MS = 500;
const KEYSTROKE_BUDGET_MS = 100;

describe('QuickOpen', () => {
  let fakes: Fakes;
  let fixture: ComponentFixture<QuickOpen>;
  let quick: QuickOpen;
  let tabs: EditorTabs;
  let ran: CommandId[];
  let textEditor: boolean;

  const page = () => fixture.nativeElement as HTMLElement;
  const input = () => page().querySelector<HTMLInputElement>('.quick-input')!;
  const items = () => [...page().querySelectorAll<HTMLElement>('[role=option]')];
  const labels = () => items().map((item) => item.querySelector('.quick-label')!.textContent);
  const message = () => page().querySelector('.quick-message')?.textContent ?? '';

  async function render(): Promise<void> {
    await settle();
    await fixture.whenStable();
  }

  async function type(text: string): Promise<void> {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    await render();
  }

  async function press(key: string): Promise<void> {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await render();
  }

  async function open(prefix: string): Promise<void> {
    quick.show(prefix);
    await render();
  }

  beforeEach(() => {
    fakes = createFakes();
    fakes.workspace.index = { root: ROOT, files: FILES, indexing: false };
    fakes.files.write(MAIN, 'int main() {}\n');
    TestBed.configureTestingModule({ providers: fakes.providers });
    TestBed.inject(CurrentFolder).path.set(ROOT);
    tabs = TestBed.inject(EditorTabs);
    ran = [];
    textEditor = false;
    const commands = TestBed.inject(Commands);
    const ids = Object.keys(COMMANDS) as CommandId[];
    commands.register(Object.fromEntries(ids.map((id) => [id, () => ran.push(id)])));
    commands.setConditions({
      editorOpen: () => textEditor,
      textEditor: () => textEditor,
      folderOpen: () => true,
    });
    fixture = TestBed.createComponent(QuickOpen);
    quick = fixture.componentInstance;
  });

  describe('paleta de comandos', () => {
    it('lista os comandos disponíveis com o atalho à direita e filtra sem acento', async () => {
      await open('>');

      expect(labels()).toContain('Ver: Mostrar Explorador');
      // Sem editor de texto, ir para linha não está disponível e não aparece.
      expect(labels()).not.toContain('Ir: Ir para linha');

      await type('>salvar');

      expect(labels()).toEqual(['Arquivo: Salvar tudo']);
      textEditor = true;
      await type('>salvar ');
      expect(labels()).toEqual(['Arquivo: Salvar', 'Arquivo: Salvar como', 'Arquivo: Salvar tudo']);
      expect(items()[0].querySelector('.quick-keys')?.textContent).toBe('Ctrl+S');
      expect(items()[0].querySelector('.quick-match')?.textContent).toBe('Salvar');
    });

    it('Enter executa; os usados recentemente vêm primeiro com o campo vazio', async () => {
      await open('>');
      await type('>fechar pasta');
      await press('Enter');

      expect(ran).toEqual(['closeFolder']);
      expect(page().querySelector('[role=dialog]')).toBeNull();

      await open('>');
      expect(page().querySelector('.quick-section')?.textContent).toBe('Usados recentemente');
      expect(labels()[0]).toBe('Arquivo: Fechar pasta');
      expect(labels()[1]).toBe('Ajuda: Atalhos de teclado');
    });

    it('↑/↓ escolhem e Esc fecha devolvendo o foco para onde estava', async () => {
      const before = document.body.appendChild(document.createElement('button'));
      before.focus();
      await open('>');
      expect(document.activeElement).toBe(input());

      await press('ArrowDown');
      expect(items()[1].getAttribute('aria-selected')).toBe('true');
      await press('ArrowUp');
      await press('ArrowUp');
      expect(items().at(-1)!.getAttribute('aria-selected')).toBe('true');

      await press('Escape');
      expect(page().querySelector('[role=dialog]')).toBeNull();
      expect(document.activeElement).toBe(before);
      expect(ran).toEqual([]);
      before.remove();
    });
  });

  describe('abrir rápido', () => {
    it('acha main.cpp com a pasta em cinza; Enter abre e ele vira recente', async () => {
      await open('');
      await type('mcpp');

      const first = items()[0];
      expect(first.querySelector('.quick-label')?.textContent).toBe('main.cpp');
      expect(first.querySelector('.quick-detail')?.textContent).toBe('app');

      await press('Enter');
      await render();
      expect(tabs.active()?.path()).toBe(MAIN);

      await open('');
      expect(page().querySelector('.quick-section')?.textContent).toBe('Abertos recentemente');
      expect(labels()).toEqual(['main.cpp']);
    });

    it('mostra "Indexando…" com o que já foi achado e pede a lista de novo a cada mudança', async () => {
      fakes.workspace.index = { root: ROOT, files: ['app\\main.cpp'], indexing: true };
      await open('');
      await type('cpp');

      expect(message()).toBe('Indexando…');
      expect(labels()).toEqual(['main.cpp']);

      fakes.workspace.index = { root: ROOT, files: FILES, indexing: false };
      fakes.workspace.projectFilesChanged!();
      await render();

      expect(message()).toBe('');
      expect(labels()).toEqual(['main.cpp', 'soma.cpp', 'main.cpp']);
    });

    it('guarda a lista e só pede de novo depois de project-files-changed', async () => {
      await open('');
      quick.close();
      await open('');
      expect(fakes.workspace.projectFilesCalls).toBe(1);

      quick.close();
      fakes.workspace.projectFilesChanged!();
      await open('');
      expect(fakes.workspace.projectFilesCalls).toBe(2);
    });

    it('descarta a lista de outra pasta', async () => {
      fakes.workspace.index = { root: 'C:\\outra', files: FILES, indexing: false };
      await open('');
      await type('main');

      expect(items()).toEqual([]);
      expect(message()).toBe('Indexando…');
    });

    it('os prefixos > e : trocam o modo no mesmo campo', async () => {
      await open('');
      await type('>explorador');
      expect(labels()).toContain('Ver: Mostrar Explorador');

      await type('explorador');
      expect(labels()).toEqual([]);
      expect(message()).toBe('Nenhum arquivo encontrado');

      await type(':');
      expect(message()).toBe('Abra um arquivo de texto para ir para uma linha.');
    });
  });

  describe('ir para linha', () => {
    it('aceita linha e linha:coluna', () => {
      expect(parseLineTarget('50')).toEqual({ line: 50, column: undefined });
      expect(parseLineTarget(' 20:5 ')).toEqual({ line: 20, column: 5 });
      expect(parseLineTarget('20,5')).toEqual({ line: 20, column: 5 });
      expect(parseLineTarget('')).toBeNull();
      expect(parseLineTarget('abc')).toBeNull();
      expect(parseLineTarget('20:')).toBeNull();
    });

    it('Enter pede ao editor a linha e a coluna', async () => {
      await tabs.open(MAIN);
      await open(':');
      await type(':20:5');

      expect(labels()).toEqual(['Ir para a linha 20, coluna 5']);
      await press('Enter');
      expect(tabs.goTo()).toEqual({ line: 20, column: 5 });

      await open(':');
      await type(':9999');
      await press('Enter');
      expect(tabs.goTo()).toEqual({ line: 9999, column: 1 });
    });
  });

  it('com 50.000 arquivos, a primeira lista e cada tecla ficam dentro da meta', async () => {
    const extensions = ['c', 'cpp', 'h', 'hpp', 'cs'];
    const files = Array.from(
      { length: 50_000 },
      (_, i) => `src\\modulo${i % 250}\\parte${i % 17}\\arquivo${i}.${extensions[i % 5]}`,
    );
    fakes.workspace.index = { root: ROOT, files, indexing: false };

    let start = performance.now();
    await open('');
    await type('a');
    const firstList = performance.now() - start;
    // No máximo 200 resultados, e só as linhas visíveis viram elementos.
    expect(items()[0].getAttribute('aria-setsize')).toBe('200');
    expect(items().length).toBeLessThan(50);

    const keystrokes: number[] = [];
    for (const query of ['ar', 'arq', 'arq1', 'arq12', 'arq123', 'arq1234']) {
      start = performance.now();
      await type(query);
      keystrokes.push(performance.now() - start);
    }
    expect(labels()).toContain('arquivo1234.cs');

    console.log(
      `Abrir rápido, 50.000 arquivos: primeira lista ${firstList.toFixed(0)} ms; ` +
        `teclas ${keystrokes.map((ms) => ms.toFixed(0)).join(', ')} ms`,
    );
    expect(firstList).toBeLessThan(FIRST_LIST_BUDGET_MS);
    expect(Math.max(...keystrokes)).toBeLessThan(KEYSTROKE_BUDGET_MS);
  });
});
