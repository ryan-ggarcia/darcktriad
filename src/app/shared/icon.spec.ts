import { TestBed } from '@angular/core/testing';
import { fileIcon, Icon } from './icon';

describe('Icon', () => {
  const drawn = (name: string) => {
    const fixture = TestBed.createComponent(Icon);
    fixture.componentRef.setInput('name', name);
    fixture.detectChanges();
    return fixture.nativeElement.querySelector('svg') as SVGElement;
  };

  // O sanitizador do Angular tiraria o SVG, e o ícone ficaria em branco sem erro nenhum.
  it('desenha dentro do SVG o que o sanitizador tiraria', () => {
    expect(drawn('folder').querySelector('path.fd-front')).not.toBeNull();
    expect(drawn('file-cs').querySelector('text')?.textContent).toBe('C#');
    expect(drawn('close').querySelector('path')).not.toBeNull();
  });

  it('sem desenho para o nome, fica vazio', () => {
    expect(drawn('').childElementCount).toBe(0);
  });
});

describe('fileIcon', () => {
  it.each([
    ['main.c', 'file-c'],
    ['main.cpp', 'file-cpp'],
    ['a.cc', 'file-cpp'],
    ['a.cxx', 'file-cpp'],
    ['a.h', 'file-header'],
    ['a.hpp', 'file-header'],
    ['Program.cs', 'file-cs'],
    ['CMakeLists.txt', 'file-cmake'],
    ['toolchain.cmake', 'file-cmake'],
    ['app.csproj', 'file-project'],
    ['app.sln', 'file-project'],
    ['tsconfig.json', 'file-json'],
    ['README.md', 'file-markdown'],
  ])('%s mostra %s', (name, icon) => {
    expect(fileIcon(name)).toBe(icon);
  });

  it('não diferencia maiúsculas de minúsculas', () => {
    expect(fileIcon('MAIN.CPP')).toBe('file-cpp');
    expect(fileIcon('cmakelists.TXT')).toBe('file-cmake');
  });

  it('usa só a última extensão', () => {
    expect(fileIcon('main.c.bak')).toBe('file');
    expect(fileIcon('app.test.cs')).toBe('file-cs');
  });

  it('usa o ícone genérico sem extensão conhecida', () => {
    // Sem ponto, o nome inteiro não é extensão: um arquivo chamado "c" não é código C.
    expect(fileIcon('c')).toBe('file');
    expect(fileIcon('notas.txt')).toBe('file');
    expect(fileIcon('Sem título-1')).toBe('file');
    // Arquivo oculto: o que vem depois do ponto é o nome.
    expect(fileIcon('.json')).toBe('file');
    // Propriedades que todo objeto tem não são extensões.
    expect(fileIcon('a.constructor')).toBe('file');
    expect(fileIcon('terminado.')).toBe('file');
  });
});
