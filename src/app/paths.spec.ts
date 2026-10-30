import { basename, dirname, isWithin, languageOf, relativeTo, replacePrefix } from './paths';

describe('caminhos', () => {
  it('separa nome e pasta no Windows e no Linux/macOS', () => {
    expect(basename('C:\\proj\\app\\main.cpp')).toBe('main.cpp');
    expect(dirname('C:\\proj\\app\\main.cpp')).toBe('C:\\proj\\app');
    expect(dirname('C:\\main.cpp')).toBe('C:\\');
    expect(basename('/home/x/main.cpp')).toBe('main.cpp');
    expect(dirname('/home/x/main.cpp')).toBe('/home/x');
    expect(dirname('/main.cpp')).toBe('/');
  });

  it('troca o prefixo só em caminhos de dentro da pasta', () => {
    expect(isWithin('C:\\proj\\src\\a.cpp', 'C:\\proj\\src')).toBe(true);
    expect(isWithin('C:\\proj\\src2\\a.cpp', 'C:\\proj\\src')).toBe(false);
    expect(replacePrefix('/p/src/sub/a.h', '/p/src', '/p/lib')).toBe('/p/lib/sub/a.h');
    expect(replacePrefix('/p/src2/a.h', '/p/src', '/p/lib')).toBeNull();
    expect(relativeTo('C:\\proj\\app\\main.cpp', 'C:\\proj')).toBe('app\\main.cpp');
    expect(relativeTo('C:\\app\\main.cpp', 'C:\\')).toBe('app\\main.cpp');
  });

  it('escolhe a linguagem pela extensão, com .h em C++', () => {
    expect(languageOf('/p/main.c')).toBe('c');
    expect(languageOf('/p/util.h')).toBe('cpp');
    expect(languageOf('/p/util.INL')).toBe('cpp');
    expect(languageOf('/p/Program.cs')).toBe('csharp');
    expect(languageOf('/p/CMakeLists.txt')).toBe('plaintext');
    expect(languageOf('/p/.cs')).toBe('plaintext');
    expect(languageOf(null)).toBe('plaintext');
  });
});
