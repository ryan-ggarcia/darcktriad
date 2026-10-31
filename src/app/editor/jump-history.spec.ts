import { JumpHistory, JumpLocation } from './jump-history';

const at = (path: string, line = 1): JumpLocation => ({ path, line, column: 1 });

describe('histórico de saltos (Alt+← / Alt+→)', () => {
  it('volta para de onde saiu e avança de volta para onde estava', () => {
    const history = new JumpHistory();
    history.record(at('a.cpp', 10)); // F12 de a.cpp para b.cpp
    history.record(at('b.cpp', 3)); // F12 de b.cpp para c.cpp

    expect(history.back(at('c.cpp', 7))).toEqual(at('b.cpp', 3));
    expect(history.back(at('b.cpp', 3))).toEqual(at('a.cpp', 10));
    expect(history.back(at('a.cpp', 10))).toBeNull();
    expect(history.forward()).toEqual(at('b.cpp', 3));
    expect(history.forward()).toEqual(at('c.cpp', 7));
    expect(history.forward()).toBeNull();
  });

  it('um salto novo depois de voltar esquece o que dava para avançar', () => {
    const history = new JumpHistory();
    history.record(at('a.cpp'));
    history.back(at('b.cpp'));

    history.record(at('a.cpp', 2));

    expect(history.forward()).toBeNull();
    expect(history.back(at('d.cpp'))).toEqual(at('a.cpp', 2));
  });

  it('guarda só as últimas 50 posições', () => {
    const history = new JumpHistory();
    for (let line = 1; line <= 60; line++) history.record(at('a.cpp', line));

    const lines: number[] = [];
    for (let jump = history.back(at('b.cpp')); jump; jump = history.back(null))
      lines.push(jump.line);

    // As 49 de antes mais a atual (b.cpp), que o Avançar traz de volta.
    expect(lines.length).toBe(49);
    expect(lines.at(-1)).toBe(12);
  });
});
