import { changedPart } from './monaco-buffers';

describe('changedPart (recarregar do disco)', () => {
  const apply = (old: string, next: string) => {
    const edit = changedPart(old, next);
    return edit ? old.slice(0, edit.start) + edit.text + old.slice(edit.end) : old;
  };

  it('troca só o trecho que mudou, para as linhas de fora seguirem o texto', () => {
    const old = 'a\nb\nc\nd\n';
    expect(changedPart(old, 'a\nB\nc\nd\n')).toEqual({ start: 2, end: 3, text: 'B' });
    // Duas linhas novas no começo: o resto não é tocado.
    expect(changedPart(old, 'x\ny\na\nb\nc\nd\n')).toEqual({ start: 0, end: 0, text: 'x\ny\n' });
    // Arquivo encurtado: o fim some, sem sobrar linha além da última.
    expect(changedPart(old, 'a\n')).toEqual({ start: 2, end: 8, text: '' });
    expect(changedPart(old, old)).toBeNull();
  });

  it('não corta um \\r\\n nem um emoji, e o resultado é sempre o texto novo', () => {
    const cases: [string, string][] = [
      ['a\r\nb', 'a\r\r\nb'],
      ['x\r\n', 'x\r\ny\r\n'],
      ['😀', '😁'],
      ['a😀b', 'a😁b'],
      ['aa', 'aaa'],
      ['abc', ''],
      ['', 'abc'],
    ];
    for (const [old, next] of cases) {
      const edit = changedPart(old, next)!;
      expect(apply(old, next)).toBe(next);
      for (const at of [edit.start, edit.end]) {
        expect(old.slice(at - 1, at + 1)).not.toBe('\r\n');
        expect(old.charCodeAt(at) >= 0xdc00 && old.charCodeAt(at) <= 0xdfff).toBe(false);
      }
    }
  });
});
