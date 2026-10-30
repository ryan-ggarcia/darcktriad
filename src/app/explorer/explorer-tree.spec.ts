import { TestBed } from '@angular/core/testing';
import { createFakes, FakeBuffer, Fakes } from '../../testing/fakes';
import { EditorTabs } from '../editor/editor-tabs';
import { CurrentFolder } from '../workspace/current-folder';
import { ExplorerTree } from './explorer-tree';

const ROOT = 'C:\\proj';
const APP = 'C:\\proj\\app';

describe('ExplorerTree', () => {
  let fakes: Fakes;
  let tree: ExplorerTree;
  let tabs: EditorTabs;

  const names = () => tree.rows().map((row) => (row.kind === 'entry' ? row.entry.name : row.kind));

  beforeEach(async () => {
    fakes = createFakes();
    TestBed.configureTestingModule({ providers: fakes.providers });
    tree = TestBed.inject(ExplorerTree);
    tabs = TestBed.inject(EditorTabs);
    fakes.explorer.add(
      `${APP}\\`,
      'C:\\proj\\core\\',
      'C:\\proj\\tool\\',
      'C:\\proj\\CMakeLists.txt',
      `${APP}\\main.cpp`,
      `${APP}\\util.h`,
    );
    TestBed.inject(CurrentFolder).path.set(ROOT);
    await tree.refresh();
  });

  it('lê só a raiz ao abrir, e cada pasta quando ela é expandida', async () => {
    expect(names()).toEqual(['app', 'core', 'tool', 'CMakeLists.txt']);
    expect(fakes.explorer.listed).toEqual([ROOT]);

    await tree.expand(APP);

    expect(names()).toEqual(['app', 'main.cpp', 'util.h', 'core', 'tool', 'CMakeLists.txt']);
    expect(tree.rows()[1]).toMatchObject({ level: 2, position: 1, siblings: 2 });
  });

  it('teclado: → expande e desce para o filho; ← sobe para a pasta pai e depois recolhe', async () => {
    tree.moveSelection(1);
    expect(tree.selected()).toBe(APP);

    await tree.right();
    expect(tree.expanded().has(APP)).toBe(true);
    await tree.right();
    expect(tree.selected()).toBe(`${APP}\\main.cpp`);

    tree.left();
    expect(tree.selected()).toBe(APP);
    tree.left();
    expect(tree.expanded().has(APP)).toBe(false);

    tree.moveSelection(Infinity);
    expect(tree.selected()).toBe('C:\\proj\\CMakeLists.txt');
  });

  it('Enter num arquivo abre a aba sem tirar a seleção da árvore', async () => {
    fakes.files.write(`${APP}\\main.cpp`, '');
    await tree.expand(APP);
    tree.select(`${APP}\\main.cpp`);

    await tree.openSelected();

    expect(tabs.active()?.path()).toBe(`${APP}\\main.cpp`);
    expect(tree.selected()).toBe(`${APP}\\main.cpp`);
    expect(tabs.focusPending()).toBe(false);
  });

  it('digitar letras pula para o próximo item que começa com elas', () => {
    tree.select(APP);

    tree.typeAhead('t');
    expect(tree.selected()).toBe('C:\\proj\\tool');
    tree.typeAhead('c');
    expect(tree.selected()).toBe('C:\\proj\\CMakeLists.txt');
    tree.typeAhead('co');
    expect(tree.selected()).toBe('C:\\proj\\core');
  });

  it('fs-changed relê só a pasta expandida e mantém expansão e seleção', async () => {
    await tree.expand(APP);
    tree.select(`${APP}\\util.h`);
    fakes.explorer.add(`${APP}\\novo.cpp`, 'C:\\proj\\core\\x.c');
    fakes.explorer.remove(`${APP}\\main.cpp`);
    fakes.explorer.listed.length = 0;

    await tree.applyChanges({
      paths: [`${APP}\\novo.cpp`, `${APP}\\main.cpp`, 'C:\\proj\\core\\x.c'],
      rescan: false,
    });

    expect(fakes.explorer.listed).toEqual([APP]);
    expect(names()).toEqual(['app', 'util.h', 'novo.cpp', 'core', 'tool', 'CMakeLists.txt']);
    expect(tree.expanded().has(APP)).toBe(true);
    expect(tree.selected()).toBe(`${APP}\\util.h`);
  });

  it('sem permissão, o nó mostra a mensagem no lugar dos filhos', async () => {
    fakes.explorer.listErrors.set('C:\\proj\\core', {
      kind: 'permissionDenied',
      message: 'negado',
    });

    await tree.expand('C:\\proj\\core');

    expect(tree.rows()[2]).toMatchObject({
      kind: 'message',
      text: 'Sem permissão para ler',
      level: 2,
    });
  });

  it('novo arquivo: nome repetido mostra a mensagem e não cria; nome novo cria e abre', async () => {
    tree.select(APP);
    await tree.startCreate('file');
    expect(tree.edit()).toMatchObject({ kind: 'file', parent: APP });
    expect(tree.rows()[1]).toMatchObject({ kind: 'input', level: 2 });

    await tree.commitEdit('main.cpp');
    expect(tree.edit()?.error).toBe('Já existe main.cpp nesta pasta');
    expect(tabs.tabs()).toEqual([]);

    fakes.files.write(`${APP}\\util.cpp`, '');
    await tree.commitEdit('util.cpp');
    expect(tree.edit()).toBeNull();
    expect(tree.selected()).toBe(`${APP}\\util.cpp`);
    expect(tabs.active()?.path()).toBe(`${APP}\\util.cpp`);
  });

  it('renomear src/a.cpp para src/b.cpp: a aba muda de caminho e mantém as alterações', async () => {
    fakes.explorer.add('C:\\proj\\src\\', 'C:\\proj\\src\\a.cpp');
    fakes.files.write('C:\\proj\\src\\a.cpp', 'original');
    await tree.refresh();
    await tree.expand('C:\\proj\\src');
    const tab = (await tabs.open('C:\\proj\\src\\a.cpp'))!;
    (tab.buffer as FakeBuffer).type('não salvo');

    tree.startRename('C:\\proj\\src\\a.cpp');
    await tree.commitEdit('b.cpp');

    expect(tab.path()).toBe('C:\\proj\\src\\b.cpp');
    expect(tab.dirty()).toBe(true);
    expect(tab.buffer!.getText()).toBe('não salvo');
    expect(names()).toContain('b.cpp');
    expect(tree.selected()).toBe('C:\\proj\\src\\b.cpp');
  });

  it('renomear uma pasta expandida mantém ela e as subpastas expandidas', async () => {
    fakes.explorer.add(`${APP}\\lib\\`, `${APP}\\lib\\x.cpp`);
    await tree.expand(APP);
    await tree.expand(`${APP}\\lib`);

    tree.startRename(APP);
    await tree.commitEdit('src');

    expect([...tree.expanded()]).toEqual(['C:\\proj\\src', 'C:\\proj\\src\\lib']);
    const rows = names();
    expect(rows.slice(rows.indexOf('src'))).toEqual(['src', 'main.cpp', 'util.h', 'lib', 'x.cpp']);
  });

  it('a raiz não pode ser renomeada nem excluída', async () => {
    tree.startRename(ROOT);
    await tree.remove(ROOT);

    expect(tree.edit()).toBeNull();
    expect(fakes.dialogs.asked).toEqual([]);
  });

  it('excluir pergunta e usa a lixeira; se ela recusar, oferece excluir de vez', async () => {
    fakes.dialogs.answers.push('Mover para a lixeira');
    await tree.remove('C:\\proj\\CMakeLists.txt');
    expect(fakes.dialogs.asked[0].message).toBe('Mover CMakeLists.txt para a lixeira?');
    expect(fakes.explorer.trashed).toEqual(['C:\\proj\\CMakeLists.txt']);
    expect(names()).not.toContain('CMakeLists.txt');

    fakes.explorer.trashFails = true;
    fakes.dialogs.answers.push('Mover para a lixeira', 'Excluir permanentemente');
    await tree.remove('C:\\proj\\tool');
    expect(fakes.dialogs.asked[2].message).toBe(
      'Excluir tool permanentemente? Não dá para desfazer.',
    );
    expect(fakes.explorer.deleted).toEqual(['C:\\proj\\tool']);
  });
});
