import { TestBed } from '@angular/core/testing';
import { createFakes, Fakes, settle } from '../../testing/fakes';
import { Workspace } from '../workspace/workspace';
import { Breakpoints, relocated, toggled, withEvent, withResults } from './breakpoints';

const MAIN = '/proj/app/main.cpp';
const CORE = '/proj/core/soma.cpp';

describe('pontos de parada (critério 3)', () => {
  it('alternar duas vezes a mesma linha remove o ponto', () => {
    const once = toggled([], MAIN, 5);
    expect(once).toEqual([{ file: MAIN, line: 5 }]);
    expect(toggled(once, MAIN, 5)).toEqual([]);
    expect(toggled(once, CORE, 5)).toHaveLength(2);
  });

  it('verified: false marca o ponto como não vinculado; os outros arquivos ficam iguais', () => {
    const list = [
      { file: MAIN, line: 3 },
      { file: MAIN, line: 5 },
      { file: CORE, line: 3 },
    ];
    const result = withResults(
      list,
      MAIN,
      [3, 5],
      [
        { id: 1, verified: false },
        { id: 2, verified: true, line: 5 },
      ],
    );
    expect(result).toEqual([
      { file: MAIN, line: 3, verified: false, id: 1 },
      { file: MAIN, line: 5, verified: true, id: 2 },
      { file: CORE, line: 3 },
    ]);
  });

  it('uma resposta com outra linha move o ponto; dois na mesma linha viram um', () => {
    const list = [
      { file: MAIN, line: 2 },
      { file: MAIN, line: 4 },
    ];
    const result = withResults(
      list,
      MAIN,
      [2, 4],
      [
        { id: 1, verified: true, line: 4 },
        { id: 2, verified: true, line: 4 },
      ],
    );
    expect(result).toEqual([{ file: MAIN, line: 4, verified: true, id: 1 }]);
  });

  it('o evento breakpoint (changed) vincula e move pelo id, como o netcoredbg faz depois', () => {
    const list = [{ file: MAIN, line: 7, verified: false, id: 9 }];
    expect(withEvent(list, { id: 9, verified: true, line: 8 })).toEqual([
      { file: MAIN, line: 8, verified: true, id: 9 },
    ]);
    expect(withEvent(list, { id: 1, verified: true })).toEqual(list);
  });

  it('linhas inseridas acima empurram o ponto', () => {
    const list = [
      { file: MAIN, line: 5 },
      { file: CORE, line: 5 },
    ];
    expect(relocated(list, MAIN, [[5, 7]])).toEqual([
      { file: MAIN, line: 7 },
      { file: CORE, line: 5 },
    ]);
  });
});

describe('pontos de parada salvos por projeto', () => {
  let fakes: Fakes;

  beforeEach(() => {
    fakes = createFakes();
    TestBed.configureTestingModule({ providers: fakes.providers });
  });

  it('salvar e reabrir a pasta devolve os mesmos pontos, sem o estado da sessão', async () => {
    const workspace = TestBed.inject(Workspace);
    const breakpoints = TestBed.inject(Breakpoints);
    await workspace.openFolder('/proj');

    breakpoints.toggle(MAIN, 5);
    breakpoints.toggle(CORE, 3);
    breakpoints.applyResults(MAIN, [5], [{ id: 1, verified: false }]);
    await settle();
    expect(fakes.workspace.breakpoints.get('/proj')).toEqual([
      { file: MAIN, line: 5 },
      { file: CORE, line: 3 },
    ]);

    await workspace.closeFolder();
    expect(breakpoints.list()).toEqual([]);
    await workspace.openFolder('/proj');
    expect(breakpoints.list()).toEqual([
      { file: MAIN, line: 5 },
      { file: CORE, line: 3 },
    ]);
  });

  it('Remover todos limpa a lista salva e avisa cada arquivo', async () => {
    const workspace = TestBed.inject(Workspace);
    const breakpoints = TestBed.inject(Breakpoints);
    await workspace.openFolder('/proj');
    breakpoints.toggle(MAIN, 5);
    breakpoints.toggle(CORE, 3);
    const edited: string[] = [];
    breakpoints.onEdit = (file) => edited.push(file);

    breakpoints.removeAll();
    await settle();

    expect(fakes.workspace.breakpoints.get('/proj')).toEqual([]);
    expect(edited).toEqual([MAIN, CORE]);
  });
});
