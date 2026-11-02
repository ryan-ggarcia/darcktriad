import { TestBed } from '@angular/core/testing';
import { createFakes, FakeBuffer, Fakes, settle } from '../../testing/fakes';
import { EditorTabs } from '../editor/editor-tabs';
import { CurrentFolder } from './current-folder';
import { Workspace } from './workspace';

const ROOT = 'C:\\proj';
const MAIN = 'C:\\proj\\main.cpp';
const UTIL = 'C:\\proj\\util.h';

describe('Workspace', () => {
  let fakes: Fakes;
  let workspace: Workspace;
  let tabs: EditorTabs;
  let folder: CurrentFolder;

  beforeEach(() => {
    fakes = createFakes();
    TestBed.configureTestingModule({ providers: fakes.providers });
    workspace = TestBed.inject(Workspace);
    tabs = TestBed.inject(EditorTabs);
    folder = TestBed.inject(CurrentFolder);
    fakes.explorer.add(MAIN, UTIL);
    fakes.files.write(MAIN, 'int main() {}');
    fakes.files.write(UTIL, '#pragma once');
  });

  async function flush(): Promise<void> {
    TestBed.tick();
    await settle();
  }

  it('ao iniciar, reabre a última pasta e as abas, com a mesma ativa', async () => {
    fakes.workspace.recents = [{ path: ROOT, exists: true }];
    fakes.workspace.sessions.set(ROOT, {
      openFiles: [MAIN, 'C:\\proj\\sumiu.cpp', UTIL],
      activeFile: UTIL,
    });

    await workspace.start();
    await flush();

    expect(folder.path()).toBe(ROOT);
    expect(tabs.tabs().map((tab) => tab.path())).toEqual([MAIN, UTIL]);
    expect(tabs.active()?.path()).toBe(UTIL);
    // Nenhuma sessão pela metade foi gravada durante a restauração.
    expect(fakes.workspace.savedSessions).toEqual([{ openFiles: [MAIN, UTIL], activeFile: UTIL }]);
  });

  describe('outra pasta aberta enquanto a última ainda reabre', () => {
    const OTHER = 'C:\\outra';
    const OTHER_MAIN = 'C:\\outra\\main.cpp';
    let release: () => void;

    beforeEach(() => {
      fakes.files.write(OTHER_MAIN, 'int main() { return 2; }');
      fakes.workspace.recents = [
        { path: ROOT, exists: true },
        { path: OTHER, exists: true },
      ];
      fakes.workspace.sessions.set(ROOT, { openFiles: [MAIN], activeFile: MAIN });
      fakes.workspace.sessions.set(OTHER, { openFiles: [OTHER_MAIN], activeFile: OTHER_MAIN });
      fakes.workspace.holds.set(ROOT, new Promise((resolve) => (release = resolve)));
    });

    it('fica só com as abas da pasta clicada, e só elas vão para a sessão', async () => {
      const starting = workspace.start();
      await settle();
      const clicked = workspace.openRecent({ path: OTHER, exists: true });
      release();
      await Promise.all([starting, clicked]);
      await flush();

      expect(folder.path()).toBe(OTHER);
      expect(tabs.tabs().map((tab) => tab.path())).toEqual([OTHER_MAIN]);
      expect(fakes.workspace.savedSessions).toEqual([
        { openFiles: [OTHER_MAIN], activeFile: OTHER_MAIN },
      ]);
    });

    it('clicar na própria pasta que reabre não duplica a aba', async () => {
      const starting = workspace.start();
      await settle();
      const clicked = workspace.openRecent({ path: ROOT, exists: true });
      release();
      await Promise.all([starting, clicked]);
      await flush();

      expect(tabs.tabs().map((tab) => tab.path())).toEqual([MAIN]);
    });
  });

  it('se a última pasta não existe mais, fica na tela inicial', async () => {
    fakes.workspace.recents = [{ path: ROOT, exists: false }];

    await workspace.start();

    expect(folder.path()).toBeNull();
    expect(workspace.recents()).toEqual([{ path: ROOT, exists: false }]);
  });

  it('uma recente riscada sai da lista ao ser clicada', async () => {
    fakes.workspace.recents = [{ path: 'C:\\velha', exists: false }];

    await workspace.openRecent({ path: 'C:\\velha', exists: false });

    expect(fakes.workspace.removedRecents).toEqual(['C:\\velha']);
    expect(workspace.recents()).toEqual([]);
    expect(folder.path()).toBeNull();
  });

  it('com watchError, a pasta abre mesmo assim e guarda o aviso', async () => {
    fakes.workspace.watchError = 'limite do inotify';

    await workspace.openFolder(ROOT);

    expect(folder.path()).toBe(ROOT);
    expect(folder.watchError()).toBe('limite do inotify');
  });

  it('a sessão acompanha as abas e é gravada antes de fechar a pasta', async () => {
    await workspace.openFolder(ROOT);
    await tabs.open(MAIN);
    await flush();
    expect(fakes.workspace.savedSessions.at(-1)).toEqual({ openFiles: [MAIN], activeFile: MAIN });

    await workspace.closeFolder();
    await flush();

    expect(folder.path()).toBeNull();
    expect(tabs.tabs()).toEqual([]);
    expect(fakes.workspace.savedSessions.at(-1)).toEqual({ openFiles: [MAIN], activeFile: MAIN });
    expect(workspace.recents()[0]).toEqual({ path: ROOT, exists: true });
  });

  it('fechar a janela com abas modificadas: uma pergunta; Cancelar mantém a janela', async () => {
    await workspace.start();
    await workspace.openFolder(ROOT);
    ((await tabs.open(MAIN))!.buffer as FakeBuffer).type('x');

    fakes.dialogs.answers.push('Cancelar');
    expect(await fakes.workspace.closeRequested!()).toBe(false);

    fakes.dialogs.answers.push('Não salvar');
    expect(await fakes.workspace.closeRequested!()).toBe(true);
    expect(fakes.dialogs.asked.length).toBe(2);
  });

  it('Arquivo: Sair faz a mesma pergunta e só fecha a janela se o usuário seguir', async () => {
    await workspace.openFolder(ROOT);
    ((await tabs.open(MAIN))!.buffer as FakeBuffer).type('x');

    fakes.dialogs.answers.push('Cancelar');
    await workspace.quit();
    expect(fakes.workspace.destroyed).toBe(false);

    fakes.dialogs.answers.push('Não salvar');
    await workspace.quit();
    expect(fakes.workspace.destroyed).toBe(true);
  });

  it('fs-changed chega na árvore e nas abas', async () => {
    await workspace.start();
    await workspace.openFolder(ROOT);
    const tab = (await tabs.open(MAIN))!;
    fakes.files.write(MAIN, 'int main() { return 0; }');

    fakes.workspace.fsChanged!({ paths: [MAIN], rescan: false });
    await settle();

    expect(tab.buffer!.getText()).toBe('int main() { return 0; }');
  });
});
