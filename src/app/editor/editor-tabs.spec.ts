import { TestBed } from '@angular/core/testing';
import { createFakes, FakeBuffer, Fakes } from '../../testing/fakes';
import { CurrentFolder } from '../workspace/current-folder';
import { EditorTabs } from './editor-tabs';
import { Tab } from './tab';

const ROOT = 'C:\\proj';
const APP_MAIN = 'C:\\proj\\app\\main.cpp';
const TOOL_MAIN = 'C:\\proj\\tool\\main.cpp';

describe('EditorTabs', () => {
  let fakes: Fakes;
  let tabs: EditorTabs;
  const text = (tab: Tab) => tab.buffer as FakeBuffer;
  const open = async (path: string) => (await tabs.open(path))!;

  beforeEach(() => {
    fakes = createFakes();
    TestBed.configureTestingModule({ providers: fakes.providers });
    tabs = TestBed.inject(EditorTabs);
    TestBed.inject(CurrentFolder).path.set(ROOT);
    fakes.files.write(APP_MAIN, 'int main() {}\n');
    fakes.files.write(TOOL_MAIN, 'int main() { return 1; }\n');
  });

  describe('abrir', () => {
    it('abre o mesmo arquivo duas vezes numa aba só, e ela fica ativa', async () => {
      const [first, second] = await Promise.all([open(APP_MAIN), open(APP_MAIN)]);
      await open(TOOL_MAIN);
      const again = await open(APP_MAIN);

      expect(second).toBe(first);
      expect(again).toBe(first);
      expect(tabs.tabs().length).toBe(2);
      expect(tabs.active()).toBe(first);
    });

    it('mostra a pasta pai quando dois arquivos abertos têm o mesmo nome', async () => {
      const app = await open(APP_MAIN);
      const tool = await open(TOOL_MAIN);

      expect(tabs.labels().get(app)).toBe('main.cpp · app');
      expect(tabs.labels().get(tool)).toBe('main.cpp · tool');
    });

    it('arquivo binário ou grande demais vira aviso, sem texto', async () => {
      fakes.files.disk.set('C:\\proj\\a.bin', { kind: 'binary' });
      fakes.files.disk.set('C:\\proj\\enorme.log', { kind: 'tooLarge', size: 60 * 1048576 });
      const tab = await open('C:\\proj\\a.bin');
      const large = await open('C:\\proj\\enorme.log');

      expect(tab.view.kind).toBe('binary');
      expect(tab.buffer).toBeNull();
      expect(large.view).toEqual({ kind: 'tooLarge', size: 60 * 1048576 });
      expect(large.buffer).toBeNull();
    });
  });

  describe('salvar', () => {
    it('marca ● ao editar, desmarca ao desfazer e ao salvar', async () => {
      const tab = await open(APP_MAIN);

      text(tab).type('x');
      expect(tab.dirty()).toBe(true);
      text(tab).undo();
      expect(tab.dirty()).toBe(false);

      text(tab).type('int main() { return 2; }\n');
      expect(await tabs.save(tab)).toBe(true);
      expect(tab.dirty()).toBe(false);
      expect(fakes.files.disk.get(APP_MAIN)).toMatchObject({
        content: 'int main() { return 2; }\n',
      });
    });

    it('grava com o fim de linha, o BOM e a versão lidos do disco', async () => {
      fakes.files.disk.set(APP_MAIN, {
        kind: 'text',
        content: 'a\r\nb',
        eol: 'crlf',
        bom: true,
        readOnly: false,
        version: 'v-disco',
      });
      const tab = await open(APP_MAIN);
      text(tab).type('a\r\nc');

      await tabs.save(tab);

      expect(fakes.files.saves).toEqual([
        { path: APP_MAIN, content: 'a\r\nc', eol: 'crlf', bom: true, expected: 'v-disco' },
      ]);
      expect(tab.version).toBe((fakes.files.disk.get(APP_MAIN) as { version: string }).version);
    });

    it('com falha na gravação, mostra o motivo e a aba continua modificada', async () => {
      const tab = await open(APP_MAIN);
      text(tab).type('x');
      fakes.files.saveErrors.push({
        kind: 'permissionDenied',
        message: 'Sem permissão para gravar',
      });

      expect(await tabs.save(tab)).toBe(false);
      expect(tab.dirty()).toBe(true);
      expect(fakes.dialogs.asked[0].detail).toBe('Sem permissão para gravar');
    });

    it('o que foi digitado durante a gravação continua como alteração', async () => {
      const tab = await open(APP_MAIN);
      text(tab).type('a');
      const save = fakes.files.save.bind(fakes.files);
      fakes.files.save = (...args) => {
        text(tab).type('ab');
        return save(...args);
      };

      await tabs.save(tab);

      expect(fakes.files.saves[0].content).toBe('a');
      expect(tab.dirty()).toBe(true);
    });

    it('Ctrl+N e Ctrl+S: "Salvar como" na raiz, e a aba passa a ter o caminho escolhido', async () => {
      const tab = await tabs.newUntitled();
      expect(tab.name()).toBe('Sem título-1');
      text(tab).type('// novo');
      fakes.files.savePath = 'C:\\proj\\novo.cpp';

      expect(await tabs.save(tab)).toBe(true);

      expect(fakes.files.saveDialogs).toEqual([{ directory: ROOT, fileName: 'Sem título-1' }]);
      expect(fakes.files.saves[0]).toMatchObject({ eol: 'crlf', bom: false, expected: null });
      expect(tab.path()).toBe('C:\\proj\\novo.cpp');
      expect(text(tab).language).toBe('cpp');
      expect(tab.dirty()).toBe(false);
    });

    it('cancelar o "Salvar como" não grava nada', async () => {
      const tab = await tabs.newUntitled();
      text(tab).type('x');

      expect(await tabs.save(tab)).toBe(false);
      expect(fakes.files.saves).toEqual([]);
      expect(tab.path()).toBeNull();
    });
  });

  describe('conflito', () => {
    async function editedAndChangedOutside(): Promise<Tab> {
      const tab = await open(APP_MAIN);
      text(tab).type('minha versão');
      fakes.files.write(APP_MAIN, 'versão de fora');
      return tab;
    }

    it('Sobrescrever grava a versão da IDE por cima da do disco', async () => {
      const tab = await editedAndChangedOutside();
      fakes.dialogs.answers.push('Sobrescrever');

      expect(await tabs.save(tab)).toBe(true);

      expect(fakes.dialogs.asked[0].buttons).toEqual(['Sobrescrever', 'Cancelar']);
      // v1 é a versão lida ao abrir; a segunda tentativa grava por cima.
      expect(fakes.files.saves.map((save) => save.expected)).toEqual(['v1', null]);
      expect(fakes.files.disk.get(APP_MAIN)).toMatchObject({ content: 'minha versão' });
      expect(tab.dirty()).toBe(false);
    });

    it('Cancelar não grava e a aba continua modificada', async () => {
      const tab = await editedAndChangedOutside();
      fakes.dialogs.answers.push('Cancelar');

      expect(await tabs.save(tab)).toBe(false);

      expect(fakes.files.disk.get(APP_MAIN)).toMatchObject({ content: 'versão de fora' });
      expect(tab.dirty()).toBe(true);
    });
  });

  describe('fechar', () => {
    it('aba modificada: Cancelar mantém, Não salvar fecha sem gravar', async () => {
      const tab = await open(APP_MAIN);
      text(tab).type('x');

      fakes.dialogs.answers.push('Cancelar');
      expect(await tabs.close(tab)).toBe(false);
      expect(tabs.tabs()).toEqual([tab]);
      expect(fakes.dialogs.asked[0].buttons).toEqual(['Salvar', 'Não salvar', 'Cancelar']);

      fakes.dialogs.answers.push('Não salvar');
      expect(await tabs.close(tab)).toBe(true);
      expect(tabs.tabs()).toEqual([]);
      expect(fakes.files.saves).toEqual([]);
      expect(text(tab).disposed).toBe(true);
    });

    it('aba modificada: Salvar grava e fecha', async () => {
      const tab = await open(APP_MAIN);
      text(tab).type('salvo ao fechar');
      fakes.dialogs.answers.push('Salvar');

      expect(await tabs.close(tab)).toBe(true);

      expect(fakes.files.disk.get(APP_MAIN)).toMatchObject({ content: 'salvo ao fechar' });
      expect(tabs.tabs()).toEqual([]);
    });

    it('ativa a aba usada antes da fechada, não a vizinha', async () => {
      const [a, b, c] = await openMany(3);
      tabs.activate(a);
      tabs.activate(c);
      await tabs.close(c);

      expect(tabs.active()).toBe(a);
      expect(tabs.tabs()).toEqual([a, b]);
    });

    it('com várias abas modificadas, pergunta uma vez listando os arquivos', async () => {
      text(await open(APP_MAIN)).type('x');
      text(await open(TOOL_MAIN)).type('y');
      fakes.dialogs.answers.push('Não salvar');

      expect(await tabs.confirmDiscard()).toBe(true);

      expect(fakes.dialogs.asked.length).toBe(1);
      expect(fakes.dialogs.asked[0].buttons[0]).toBe('Salvar tudo');
      expect(fakes.dialogs.asked[0].detail).toContain('main.cpp · app\nmain.cpp · tool');
    });
  });

  describe('trocar de aba', () => {
    it('Ctrl+Tab ativa a anterior por uso; Ctrl+PageDown na última volta para a primeira', async () => {
      const opened = await openMany(5);
      for (const index of [0, 2, 4]) tabs.activate(opened[index]);

      tabs.cycleRecent(1);
      tabs.commitSwitcher();
      expect(tabs.active()).toBe(opened[2]);

      tabs.activate(opened[4]);
      tabs.activateNext(1);
      expect(tabs.active()).toBe(opened[0]);
    });

    it('Alt+1 a Alt+9: a aba pela posição, com o foco; sem aba lá, nada muda', async () => {
      const opened = await openMany(3);
      tabs.focusPending.set(false);

      tabs.activateAt(1);
      expect(tabs.active()).toBe(opened[1]);
      expect(tabs.focusPending()).toBe(true);

      tabs.focusPending.set(false);
      tabs.activateAt(8);
      expect(tabs.active()).toBe(opened[1]);
      expect(tabs.focusPending()).toBe(false);
    });

    it('Ctrl+PageDown leva o foco ao editor, mesmo vindo do terminal', async () => {
      await openMany(2);
      tabs.focusPending.set(false);

      tabs.activateNext(1);

      expect(tabs.focusPending()).toBe(true);
    });

    it('cada Ctrl+Tab com o Ctrl segurado avança na lista', async () => {
      const opened = await openMany(3);
      tabs.activate(opened[0]);

      tabs.cycleRecent(1);
      tabs.cycleRecent(1);
      tabs.commitSwitcher();

      expect(tabs.active()).toBe(opened[1]);
    });
  });

  describe('renomear no explorador', () => {
    it('o arquivo e os de dentro da pasta mudam de caminho e mantêm as alterações', async () => {
      fakes.files.write('C:\\proj\\src\\a.cpp', 'a');
      fakes.files.write('C:\\proj\\src\\sub\\b.h', 'b');
      fakes.files.write('C:\\proj\\src2\\c.cpp', 'c');
      const a = await open('C:\\proj\\src\\a.cpp');
      const b = await open('C:\\proj\\src\\sub\\b.h');
      const other = await open('C:\\proj\\src2\\c.cpp');
      text(a).type('não salvo');

      tabs.renamePath('C:\\proj\\src\\a.cpp', 'C:\\proj\\src\\a.c');
      expect(a.path()).toBe('C:\\proj\\src\\a.c');
      expect(text(a).language).toBe('c');

      tabs.renamePath('C:\\proj\\src', 'C:\\proj\\lib');
      expect(a.path()).toBe('C:\\proj\\lib\\a.c');
      expect(b.path()).toBe('C:\\proj\\lib\\sub\\b.h');
      expect(other.path()).toBe('C:\\proj\\src2\\c.cpp');
      expect(a.dirty()).toBe(true);
      expect(text(a).getText()).toBe('não salvo');
    });
  });

  describe('mudanças no disco', () => {
    it('aba sem alterações recarrega sem perguntar', async () => {
      const tab = await open(APP_MAIN);
      fakes.files.write(APP_MAIN, 'int main() {}\n// x\n');

      await tabs.checkDisk([APP_MAIN]);

      expect(text(tab).getText()).toBe('int main() {}\n// x\n');
      expect(tab.dirty()).toBe(false);
      expect(tab.changedOnDisk()).toBe(false);
    });

    it('ignora o eco da própria gravação', async () => {
      const tab = await open(APP_MAIN);
      text(tab).type('meu');
      const saving = tabs.save(tab);
      const checking = tabs.checkDisk([APP_MAIN]);
      await Promise.all([saving, checking]);

      expect(text(tab).versionId()).toBe(tab.savedVersionId);
      expect(tab.changedOnDisk()).toBe(false);
    });

    it('aba com alterações mostra a faixa; Manter faz o próximo salvamento perguntar', async () => {
      const tab = await open(APP_MAIN);
      text(tab).type('meu');
      fakes.files.write(APP_MAIN, 'de fora');

      await tabs.checkDisk([APP_MAIN]);
      expect(tab.changedOnDisk()).toBe(true);
      expect(text(tab).getText()).toBe('meu');

      tabs.keepMine(tab);
      expect(tab.changedOnDisk()).toBe(false);
      await tabs.save(tab);
      expect(fakes.dialogs.asked[0].buttons).toEqual(['Sobrescrever', 'Cancelar']);
    });

    it('Recarregar do disco descarta as alterações', async () => {
      const tab = await open(APP_MAIN);
      text(tab).type('meu');
      fakes.files.write(APP_MAIN, 'de fora');
      await tabs.checkDisk(null);

      await tabs.reload(tab);

      expect(text(tab).getText()).toBe('de fora');
      expect(tab.dirty()).toBe(false);
      expect(tab.changedOnDisk()).toBe(false);
    });

    it('arquivo excluído (ou a pasta dele) marca a aba e mantém o texto; salvar recria', async () => {
      const tab = await open(APP_MAIN);
      fakes.files.disk.delete(APP_MAIN);

      await tabs.checkDisk(['C:\\proj\\app']);
      expect(tab.deleted()).toBe(true);
      expect(text(tab).getText()).toBe('int main() {}\n');

      expect(await tabs.save(tab)).toBe(true);
      expect(fakes.files.disk.get(APP_MAIN)).toMatchObject({ content: 'int main() {}\n' });
      expect(tab.deleted()).toBe(false);
    });
  });

  it('restaura as abas na ordem, pula as que sumiram e ativa a que estava ativa', async () => {
    await tabs.restore({
      openFiles: [APP_MAIN, 'C:\\proj\\sumiu.cpp', TOOL_MAIN],
      activeFile: TOOL_MAIN,
    });

    expect(tabs.tabs().map((tab) => tab.path())).toEqual([APP_MAIN, TOOL_MAIN]);
    expect(tabs.active()?.path()).toBe(TOOL_MAIN);
    expect(tabs.session()).toEqual({ openFiles: [APP_MAIN, TOOL_MAIN], activeFile: TOOL_MAIN });
  });

  it('abrir um arquivo enquanto a sessão o restaura dá uma aba só', async () => {
    const session = { openFiles: [APP_MAIN], activeFile: APP_MAIN };
    const [, opened] = await Promise.all([tabs.restore(session), open(APP_MAIN)]);

    expect(tabs.tabs()).toEqual([opened]);
    expect(text(opened).disposed).toBe(false);
  });

  it('o que ainda era lido antes de fechar tudo não vira aba', async () => {
    const restoring = tabs.restore({ openFiles: [APP_MAIN], activeFile: APP_MAIN });
    const opening = tabs.open(TOOL_MAIN);
    tabs.clear();

    expect(await opening).toBeNull();
    await restoring;
    expect(tabs.tabs()).toEqual([]);
  });

  async function openMany(count: number): Promise<Tab[]> {
    const opened: Tab[] = [];
    for (let index = 1; index <= count; index++) {
      const path = `C:\\proj\\f${index}.c`;
      fakes.files.write(path, `// ${index}`);
      opened.push(await open(path));
    }
    return opened;
  }
});
