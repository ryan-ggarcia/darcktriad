import { MarkerSeverity, pathToUri, toLocations, toMarker, uriToPath } from './lsp';

describe('conversões do LSP', () => {
  const range = { start: { line: 4, character: 8 }, end: { line: 4, character: 11 } };

  it('Diagnostic → marcador: gravidade 1→erro, 2→aviso, 3/4→informação e posição de base 1', () => {
    const severities = ([1, 2, 3, 4] as const).map(
      (severity) => toMarker({ range, severity, message: 'x' }, 'clangd').severity,
    );
    expect(severities).toEqual([
      MarkerSeverity.Error,
      MarkerSeverity.Warning,
      MarkerSeverity.Info,
      MarkerSeverity.Info,
    ]);

    expect(
      toMarker({ range, message: "cannot initialize 'int' with 'const char[2]'", code: 2 }, 'C#'),
    ).toEqual({
      severity: MarkerSeverity.Error,
      message: "cannot initialize 'int' with 'const char[2]'",
      source: 'C#',
      code: '2',
      startLineNumber: 5,
      startColumn: 9,
      endLineNumber: 5,
      endColumn: 12,
    });
  });

  it('caminho ↔ URI file:// no Linux/macOS e no Windows', () => {
    expect(pathToUri('/home/ana/meu projeto/a.cpp')).toBe('file:///home/ana/meu%20projeto/a.cpp');
    expect(uriToPath('file:///home/ana/meu%20projeto/a.cpp')).toBe('/home/ana/meu projeto/a.cpp');
    expect(pathToUri('C:\\proj\\app\\main.cpp')).toBe('file:///C:/proj/app/main.cpp');
    expect(uriToPath('file:///C:/proj/app/main.cpp')).toBe('C:\\proj\\app\\main.cpp');
    // O clangd e o Roslyn podem mandar a letra em minúscula e os dois-pontos codificados.
    expect(uriToPath('file:///c%3A/proj/main.cpp')).toBe('C:\\proj\\main.cpp');
    expect(uriToPath('csharp:/metadata/Console.cs')).toBeNull();
  });

  it('definição: um, vários e links viram caminho e posição de base 1', () => {
    const uri = 'file:///proj/core/soma.cpp';
    expect(toLocations({ uri, range })).toEqual([
      { path: '/proj/core/soma.cpp', line: 5, column: 9 },
    ]);
    expect(
      toLocations([
        { targetUri: uri, targetSelectionRange: range },
        { targetUri: 'file:///usr/include/string', targetSelectionRange: range },
      ]),
    ).toEqual([
      { path: '/proj/core/soma.cpp', line: 5, column: 9 },
      { path: '/usr/include/string', line: 5, column: 9 },
    ]);
    expect(toLocations(null)).toEqual([]);
  });
});
