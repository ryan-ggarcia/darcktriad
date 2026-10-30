import { Path } from './ipc';

/** Separador de um caminho absoluto vindo do núcleo: `/` no Linux e no macOS, `\` no Windows. */
export function separatorOf(path: Path): string {
  return path.startsWith('/') ? '/' : '\\';
}

export function basename(path: Path): string {
  return path.slice(path.lastIndexOf(separatorOf(path)) + 1);
}

export function dirname(path: Path): Path {
  const separator = separatorOf(path);
  const parent = path.slice(0, path.lastIndexOf(separator));
  // A raiz do disco mantém o separador: `/` e `C:\`.
  return parent === '' || parent.endsWith(':') ? parent + separator : parent;
}

/** `path` é `base` ou fica dentro de `base`. */
export function isWithin(path: Path, base: Path): boolean {
  const separator = separatorOf(base);
  return path === base || path.startsWith(base.endsWith(separator) ? base : base + separator);
}

/** Troca o prefixo `from` por `to`; `null` se `path` não está em `from`. */
export function replacePrefix(path: Path, from: Path, to: Path): Path | null {
  return isWithin(path, from) ? to + path.slice(from.length) : null;
}

export function relativeTo(path: Path, root: Path): string {
  return path.slice(root.endsWith(separatorOf(root)) ? root.length : root.length + 1);
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  inl: 'cpp',
  cs: 'csharp',
};

export const LANGUAGE_NAMES: Record<string, string> = {
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  plaintext: 'Texto sem formatação',
};

/** Linguagem do Monaco pela extensão (docs/specs/editor.md); `.h` usa C++. */
export function languageOf(path: Path | null): string {
  const name = path ? basename(path) : '';
  const dot = name.lastIndexOf('.');
  return (dot > 0 && LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()]) || 'plaintext';
}
