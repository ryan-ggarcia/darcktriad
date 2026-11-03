import { TestBed } from '@angular/core/testing';
import { MarkerSeverity } from '../language/lsp';
import { ProblemItem, Problems } from './problems';

function item(file: string, line: number, severity: number, source: string): ProblemItem {
  return {
    file,
    severity,
    message: `${source} ${line}`,
    source,
    startLineNumber: line,
    startColumn: 1,
    endLineNumber: line,
    endColumn: 2,
  };
}

describe('repositório de problemas', () => {
  const main = '/proj/app/main.cpp';
  const core = '/proj/core/soma.cpp';
  let problems: Problems;

  beforeEach(() => {
    problems = TestBed.inject(Problems);
  });

  const messages = () => problems.items().map((problem) => problem.message);

  it('substituir os itens do build mantém os do clangd no mesmo arquivo', () => {
    problems.set('clangd', [item(main, 3, MarkerSeverity.Warning, 'clangd')], main);
    problems.set('build', [item(main, 9, MarkerSeverity.Error, 'build')]);

    problems.set('build', [item(main, 1, MarkerSeverity.Error, 'build')]);

    expect(messages()).toEqual(['build 1', 'clangd 3']);
    problems.set('build', []);
    expect(messages()).toEqual(['clangd 3']);
  });

  it('agrupa por arquivo e ordena por gravidade e depois linha', () => {
    problems.set('build', [
      item(main, 20, MarkerSeverity.Warning, 'build'),
      item(main, 30, MarkerSeverity.Error, 'build'),
    ]);
    problems.set(
      'clangd',
      [
        item(main, 2, MarkerSeverity.Info, 'clangd'),
        item(main, 10, MarkerSeverity.Error, 'clangd'),
      ],
      main,
    );
    problems.set('clangd', [item(core, 1, MarkerSeverity.Error, 'clangd')], core);

    expect(problems.groups().map((group) => group.file)).toEqual([main, core].sort());
    expect(
      problems
        .groups()
        .find((group) => group.file === main)!
        .items.map((p) => p.message),
    ).toEqual(['clangd 10', 'build 30', 'build 20', 'clangd 2']);
    expect([problems.errors(), problems.warnings()]).toEqual([3, 1]);
  });

  it('o clangd por arquivo troca só os itens daquele arquivo', () => {
    problems.set('clangd', [item(main, 1, MarkerSeverity.Error, 'clangd')], main);
    problems.set('clangd', [item(core, 1, MarkerSeverity.Error, 'clangd')], core);

    problems.set('clangd', [], main);

    expect(problems.items().map((problem) => problem.file)).toEqual([core]);
  });

  it('F8 / Shift+F8 passam de arquivo em arquivo, dando a volta', () => {
    problems.set('build', [
      item(main, 5, MarkerSeverity.Error, 'build'),
      item(core, 2, MarkerSeverity.Error, 'build'),
      item(core, 8, MarkerSeverity.Error, 'build'),
    ]);
    const at = (problem: ProblemItem | null) =>
      problem && `${problem.file}:${problem.startLineNumber}`;

    // Fora de um problema: o primeiro do arquivo atual.
    expect(at(problems.next({ file: main, line: 1, column: 1 }, 1))).toBe(`${main}:5`);
    // Fora de um problema: o próximo depois do cursor (ou o anterior), dando a volta no arquivo.
    expect(at(problems.next({ file: core, line: 5, column: 1 }, 1))).toBe(`${core}:8`);
    expect(at(problems.next({ file: core, line: 5, column: 1 }, -1))).toBe(`${core}:2`);
    expect(at(problems.next({ file: core, line: 9, column: 1 }, 1))).toBe(`${core}:2`);
    expect(at(problems.next({ file: core, line: 1, column: 1 }, -1))).toBe(`${core}:8`);
    expect(at(problems.next({ file: main, line: 5, column: 1 }, 1))).toBe(`${core}:2`);
    expect(at(problems.next({ file: core, line: 8, column: 1 }, 1))).toBe(`${main}:5`);
    expect(at(problems.next({ file: core, line: 2, column: 1 }, -1))).toBe(`${main}:5`);
    expect(at(problems.next(null, -1))).toBe(`${core}:8`);
  });
});
