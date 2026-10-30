import { fold, fuzzyScore, highlight, prepareQuery } from './fuzzy';

function matches(query: string, title: string): boolean {
  return fuzzyScore(prepareQuery(query), fold(title)) >= 0;
}

describe('filtro aproximado', () => {
  it('acha pelas letras em ordem, sem diferenciar maiúsculas nem acentos', () => {
    expect(matches('slvtd', 'Arquivo: Salvar tudo')).toBe(true);
    expect(matches('SALVAR TUDO', 'Arquivo: Salvar tudo')).toBe(true);
    expect(matches('depuracao', 'Depuração: Passar por cima')).toBe(true);
    expect(matches('DEPURAÇÃO', 'Depuração: Passar por cima')).toBe(true);
    expect(matches('xyz', 'Arquivo: Salvar tudo')).toBe(false);
    expect(matches('xyz', 'Depuração: Passar por cima')).toBe(false);
    expect(matches('tudosalvar', 'Arquivo: Salvar tudo')).toBe(false);
  });

  it('dobra o texto sem mudar o comprimento, inclusive com acento decomposto (macOS)', () => {
    expect(fold('Depuração')).toBe('depuracao');
    const decomposed = 'Ação';
    expect(fold(decomposed)).toHaveLength(decomposed.length);
    expect(matches('acao', decomposed)).toBe(true);
    expect(fold('app\\Main.cpp')).toBe('app/main.cpp');
  });

  it('letras seguidas e começo de palavra valem mais', () => {
    const score = (query: string, title: string) => fuzzyScore(query, fold(title));

    expect(score('salvar', 'Arquivo: Salvar')).toBeGreaterThan(
      score('salvar', 'Ver: Sair e fechar a lavanderia'),
    );
    expect(score('main', 'main.cpp')).toBeGreaterThan(score('main', 'domain.cpp'));
  });

  it('destaca as letras encontradas', () => {
    const positions: number[] = [];
    fuzzyScore(prepareQuery('slvtd'), fold('Arquivo: Salvar tudo'), 0, positions);

    expect(highlight('Arquivo: Salvar tudo', positions)).toEqual([
      { text: 'Arquivo: ', match: false },
      { text: 'S', match: true },
      { text: 'a', match: false },
      { text: 'lv', match: true },
      { text: 'ar ', match: false },
      { text: 't', match: true },
      { text: 'u', match: false },
      { text: 'd', match: true },
      { text: 'o', match: false },
    ]);
  });
});
