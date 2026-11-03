import { TestBed } from '@angular/core/testing';
import { createFakes, FakeBuffer, Fakes, settle } from '../../testing/fakes';
import { EditorTabs } from '../editor/editor-tabs';
import { Tab } from '../editor/tab';
import { Problems } from '../project/problems';
import type { Pick } from '../quick-open/quick-open';
import { Commands } from '../shared/commands';
import { CurrentFolder } from '../workspace/current-folder';
import { LanguageStatus, serverItem } from './language-status';
import { FORMAT_ON_SAVE_TIMEOUT_MS, Languages } from './languages';

const ROOT = '/home/ana/hello-cpp';
const MAIN = `${ROOT}/app/main.cpp`;
const SOMA = `${ROOT}/core/soma.cpp`;
const range = (line: number, character: number) => ({
  start: { line, character },
  end: { line, character: character + 1 },
});

describe('servidores de linguagem na interface', () => {
  let fakes: Fakes;
  let tabs: EditorTabs;
  let languages: Languages;
  let problems: Problems;

  beforeEach(async () => {
    fakes = createFakes();
    TestBed.configureTestingModule({ providers: fakes.providers });
    tabs = TestBed.inject(EditorTabs);
    languages = TestBed.inject(Languages);
    problems = TestBed.inject(Problems);
    TestBed.inject(CurrentFolder).path.set(ROOT);
    fakes.files.write(MAIN, 'int main() {\n  return soma(1, 2);\n}\n');
    fakes.files.write(SOMA, 'int soma(int a, int b) { return a + b; }\n');
    fakes.files.write(`${ROOT}/LEIAME.txt`, 'oi');
  });

  /** Abre o arquivo e deixa os efeitos rodarem. */
  async function open(path: string) {
    const tab = await tabs.open(path);
    TestBed.tick();
    await settle();
    return tab!;
  }

  it('inicia o clangd no primeiro C/C++ da pasta, faz o handshake e abre o arquivo', async () => {
    await open(`${ROOT}/LEIAME.txt`);
    expect(fakes.languages.started).toEqual([]);

    await open(MAIN);
    await open(SOMA);
    expect(fakes.languages.started).toEqual(['cpp']);
    expect(languages.servers.cpp.status()).toEqual({ kind: 'starting' });
    expect(fakes.languages.methods('cpp')).toEqual([]);

    fakes.languages.run('cpp', { textDocumentSync: 2 });
    await settle();

    expect(fakes.languages.methods('cpp')).toEqual([
      'initialize',
      'initialized',
      'textDocument/didOpen',
      'textDocument/didOpen',
    ]);
    expect(fakes.languages.sent.cpp[0].params.rootUri).toBe('file:///home/ana/hello-cpp');
  });

  it('digitar manda didChange; salvar, didSave; fechar, didClose', async () => {
    const tab = await open(MAIN);
    fakes.languages.run('cpp', { textDocumentSync: { change: 2, save: {} } });
    await settle();

    (tab.buffer as FakeBuffer).type('int x = "a";');
    await tabs.save(tab);
    await tabs.close(tab);
    TestBed.tick();

    expect(fakes.languages.methods('cpp').slice(3)).toEqual([
      'textDocument/didChange',
      'textDocument/didSave',
      'textDocument/didClose',
    ]);
  });

  it('erros do clangd vão para os Problemas com origem e posição de base 1; um processo novo os apaga', async () => {
    await open(MAIN);
    fakes.languages.run('cpp');
    await settle();

    fakes.languages.emit('cpp', {
      kind: 'message',
      message: JSON.stringify({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: 'file:///home/ana/hello-cpp/app/main.cpp',
          diagnostics: [
            { range: range(1, 9), severity: 1, message: 'use of undeclared identifier' },
          ],
        },
      }),
    });

    expect(problems.items()).toMatchObject([
      { file: MAIN, source: 'clangd', startLineNumber: 2, startColumn: 10, severity: 8 },
    ]);
    expect([problems.errors(), problems.warnings()]).toEqual([1, 0]);

    // Caiu e reinicia: os erros do processo velho somem até o novo publicar.
    fakes.languages.emit('cpp', { kind: 'state', state: { kind: 'starting' } });
    expect(problems.items()).toEqual([]);
  });

  it('a cada running refaz o initialize e reabre as abas da linguagem', async () => {
    await open(MAIN);
    fakes.languages.run('cpp');
    await settle();
    fakes.languages.emit('cpp', { kind: 'state', state: { kind: 'starting' } });
    fakes.languages.run('cpp');
    await settle();

    expect(fakes.languages.methods('cpp')).toEqual([
      'initialize',
      'initialized',
      'textDocument/didOpen',
      'initialize',
      'initialized',
      'textDocument/didOpen',
    ]);
  });

  describe('formatar ao salvar', () => {
    const FORMATTING = 'textDocument/formatting';
    const EDIT = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        newText: 'INT',
      },
    ];
    const formatted = 'INT main() {\n  return soma(1, 2);\n}\n';
    const saved = () => fakes.files.saves.at(-1)?.content;

    afterEach(() => {
      localStorage.removeItem('formatOnSave');
      vi.useRealTimers();
    });

    async function ready() {
      const tab = await open(MAIN);
      fakes.languages.run('cpp', { documentFormattingProvider: true });
      await settle();
      return { tab, buffer: tab.buffer as FakeBuffer };
    }

    async function saveAnswering(tab: Tab, answer: unknown) {
      const saving = tabs.save(tab);
      await settle();
      fakes.languages.respond('cpp', FORMATTING, answer);
      return saving;
    }

    it('desligado, que é o padrão, grava sem pedir nada ao servidor', async () => {
      const { tab, buffer } = await ready();
      buffer.type('int main() {}\n');

      expect(await tabs.save(tab)).toBe(true);
      expect(fakes.languages.methods('cpp')).not.toContain(FORMATTING);
      expect(saved()).toBe('int main() {}\n');
    });

    it('ligado, grava o texto formatado antes de avisar o servidor do salvamento', async () => {
      const { tab, buffer } = await ready();
      languages.toggleFormatOnSave();
      buffer.type('int main() {\n  return soma(1, 2);\n}\n');

      expect(await saveAnswering(tab, EDIT)).toBe(true);

      expect(saved()).toBe(formatted);
      expect(tab.dirty()).toBe(false);
      const request = fakes.languages.sent.cpp.find((item) => item.method === FORMATTING)!;
      expect(request.params).toEqual({
        textDocument: { uri: 'file:///home/ana/hello-cpp/app/main.cpp' },
        options: { tabSize: 4, insertSpaces: true },
      });
      buffer.undo();
      expect(buffer.getText()).toBe('int main() {\n  return soma(1, 2);\n}\n');
    });

    it('Ctrl+S sem alterações: formata e grava se mudou; sem nada a mudar, não grava', async () => {
      const { tab } = await ready();
      languages.toggleFormatOnSave();

      await saveAnswering(tab, []);
      expect(fakes.files.saves).toEqual([]);

      await saveAnswering(tab, EDIT);
      expect(saved()).toBe(formatted);
    });

    it('texto digitado durante a espera: descarta a formatação e grava o que está na tela', async () => {
      const { tab, buffer } = await ready();
      languages.toggleFormatOnSave();
      const saving = tabs.save(tab);
      await settle();
      buffer.type('digitado\n');
      fakes.languages.respond('cpp', FORMATTING, EDIT);

      expect(await saving).toBe(true);
      expect(saved()).toBe('digitado\n');
    });

    it('servidor com erro: grava como está', async () => {
      const { tab, buffer } = await ready();
      languages.toggleFormatOnSave();
      buffer.type('int x;\n');
      const saving = tabs.save(tab);
      await settle();
      const request = fakes.languages.sent.cpp.find((item) => item.method === FORMATTING)!;
      fakes.languages.emit('cpp', {
        kind: 'message',
        message: JSON.stringify({ id: request.id, error: { code: -32603, message: 'falhou' } }),
      });

      expect(await saving).toBe(true);
      expect(saved()).toBe('int x;\n');
    });

    it('servidor que não responde: desiste no prazo, grava como está e avisa', async () => {
      const { tab, buffer } = await ready();
      languages.toggleFormatOnSave();
      buffer.type('int x;\n');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const saving = tabs.save(tab);
      await vi.advanceTimersByTimeAsync(FORMAT_ON_SAVE_TIMEOUT_MS);

      expect(await saving).toBe(true);
      expect(saved()).toBe('int x;\n');
      expect(fakes.languages.methods('cpp')).toContain('$/cancelRequest');
      expect(TestBed.inject(Commands).keyStatus()).toContain('salvo sem formatar');
    });

    it('sem formatador no servidor: grava sem pedir; a preferência fica guardada', async () => {
      const tab = await open(MAIN);
      fakes.languages.run('cpp', {});
      await settle();
      languages.toggleFormatOnSave();
      (tab.buffer as FakeBuffer).type('int x;\n');

      expect(await tabs.save(tab)).toBe(true);
      expect(fakes.languages.methods('cpp')).not.toContain(FORMATTING);
      expect(localStorage.getItem('formatOnSave')).toBe('true');
    });
  });

  it('barra de status: iniciando, indexando, pronto, parado com Reiniciar e C# sem projeto', async () => {
    const fixture = TestBed.createComponent(LanguageStatus);
    const page = fixture.nativeElement as HTMLElement;
    const shown = async () => {
      await settle();
      await fixture.whenStable();
      return page.textContent!.replace(/\s+/g, ' ').trim();
    };
    await open(MAIN);
    expect(await shown()).toBe('C++: iniciando…');

    fakes.languages.run('cpp');
    const progress = (value: object) =>
      fakes.languages.emit('cpp', {
        kind: 'message',
        message: JSON.stringify({
          jsonrpc: '2.0',
          method: '$/progress',
          params: { token: 1, value },
        }),
      });
    progress({ kind: 'begin', title: 'indexing', percentage: 45 });
    expect(await shown()).toBe('C++: indexando 45%');
    progress({ kind: 'end' });
    expect(await shown()).toBe('C++: pronto');

    const reason = 'O clangd parou várias vezes. Veja o canal clangd na Saída.';
    fakes.languages.emit('cpp', { kind: 'state', state: { kind: 'stopped', reason } });
    expect(await shown()).toBe('C++: parado Reiniciar');
    expect(page.querySelector('.status-error')?.getAttribute('title')).toContain(reason);
    page.querySelectorAll<HTMLElement>('button')[1].click();
    expect(fakes.languages.restarted).toEqual(['cpp']);

    fakes.files.write(`${ROOT}/Program.cs`, 'class P {}');
    await open(`${ROOT}/Program.cs`);
    fakes.languages.emit('csharp', { kind: 'state', state: { kind: 'noProject' } });
    expect(await shown()).toBe('C++: parado Reiniciar C#: sem projeto');
    expect(serverItem('csharp', { kind: 'noProject' }, false, null).hint).toContain('.csproj');
  });

  it('sem o clangd instalado, mostra o motivo e Reiniciar procura de novo', async () => {
    fakes.languages.startError = { kind: 'notFound', message: 'clangd não encontrado.' };
    await open(MAIN);
    expect(languages.servers.cpp.status()).toEqual({
      kind: 'missing',
      reason: 'clangd não encontrado.',
    });
    expect(languages.servers.cpp.log()).toEqual(['clangd não encontrado.']);

    fakes.languages.startError = null;
    languages.restart('cpp');
    await settle();
    expect(fakes.languages.started).toEqual(['cpp', 'cpp']);
  });

  describe('F12', () => {
    let picks: Pick[];
    const definition = async (result: unknown) => {
      const going = languages.goToDefinition((pick) => picks.push(pick));
      fakes.languages.respond('cpp', 'textDocument/definition', result);
      await going;
      await settle();
    };

    beforeEach(async () => {
      picks = [];
      await open(MAIN);
      fakes.languages.run('cpp', { definitionProvider: true });
      await settle();
      tabs.cursor.set({ line: 2, column: 12 });
    });

    it('um resultado abre o arquivo na posição; Alt+← volta para a chamada', async () => {
      await definition({ uri: 'file:///home/ana/hello-cpp/core/soma.cpp', range: range(0, 4) });

      expect(fakes.languages.sent.cpp.at(-1)!.params.position).toEqual({ line: 1, character: 11 });
      expect(tabs.active()?.path()).toBe(SOMA);
      expect(tabs.goTo()).toEqual({ line: 1, column: 5 });
      expect(tabs.active()?.outsideProject()).toBe(false);

      await tabs.back();
      expect(tabs.active()?.path()).toBe(MAIN);
      expect(tabs.goTo()).toEqual({ line: 2, column: 12 });
    });

    it('vários resultados viram uma lista para escolher', async () => {
      await definition([
        { uri: 'file:///home/ana/hello-cpp/core/soma.cpp', range: range(0, 4) },
        { uri: 'file:///home/ana/hello-cpp/core/soma.h', range: range(2, 4) },
      ]);

      expect(picks[0].options).toEqual(['core/soma.cpp:1:5', 'core/soma.h:3:5']);
      picks[0].accept('core/soma.cpp:1:5');
      await settle();
      expect(tabs.active()?.path()).toBe(SOMA);
    });

    it('fora da pasta do projeto abre somente leitura', async () => {
      fakes.files.write('/usr/include/c++/14/string', '// <string>');
      await definition({ uri: 'file:///usr/include/c++/14/string', range: range(0, 0) });

      expect(tabs.active()?.path()).toBe('/usr/include/c++/14/string');
      expect(tabs.active()?.outsideProject()).toBe(true);
    });

    it('sem resultado avisa na barra; resposta que chega depois de o cursor mudar é descartada', async () => {
      await definition(null);
      expect(TestBed.inject(Commands).keyStatus()).toBe('Definição não disponível');

      const going = languages.goToDefinition((pick) => picks.push(pick));
      tabs.cursor.set({ line: 1, column: 1 });
      fakes.languages.respond('cpp', 'textDocument/definition', {
        uri: 'file:///home/ana/hello-cpp/core/soma.cpp',
        range: range(0, 4),
      });
      await going;
      expect(tabs.active()?.path()).toBe(MAIN);
    });
  });
});
