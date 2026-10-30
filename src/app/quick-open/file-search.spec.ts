import { FileSearch, MAX_RESULTS } from './file-search';

describe('FileSearch', () => {
  it('acerto no nome vale mais que acerto só no caminho', () => {
    const search = new FileSearch(['main\\util.cpp', 'app\\main.cpp', 'core\\domain.h']);

    expect(search.search('main').map((match) => match.file)).toEqual([
      'app\\main.cpp',
      'core\\domain.h',
      'main\\util.cpp',
    ]);
  });

  it('casa letras espalhadas pelo caminho e guarda as posições para o destaque', () => {
    const search = new FileSearch(['app/main.cpp', 'tool/main.cpp']);

    const [match] = search.search('appmain');

    expect(match.file).toBe('app/main.cpp');
    expect(match.nameStart).toBe(4);
    expect(match.positions).toEqual([0, 1, 2, 4, 5, 6, 7]);
  });

  it('mostra no máximo 200 resultados', () => {
    const search = new FileSearch(Array.from({ length: 500 }, (_, i) => `src/arquivo${i}.cpp`));

    expect(search.search('arquivo')).toHaveLength(MAX_RESULTS);
    expect(search.search('xyz')).toEqual([]);
  });
});
