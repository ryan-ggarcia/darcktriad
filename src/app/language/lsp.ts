/** Os pedaços do LSP 3.17 que o MVP usa, e as conversões para o Monaco e para caminhos. */
import { Path } from '../ipc';

/** Base 0; `character` em unidades UTF-16, como as colunas do Monaco. */
export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  targetUri: string;
  targetSelectionRange: Range;
}

/** Uma alteração do texto: `range` no texto de antes; sem `range`, o texto inteiro. */
export interface TextChange {
  range?: Range;
  text: string;
}

/** Gravidade do marcador, com os valores do `MarkerSeverity` do Monaco. */
export const MarkerSeverity = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;

/** O `IMarkerData` do Monaco: base 1, e o hover mostra `message` e `source(code)`. */
export interface MarkerData {
  severity: number;
  message: string;
  source: string;
  code?: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

const SEVERITIES: Record<number, number> = {
  1: MarkerSeverity.Error,
  2: MarkerSeverity.Warning,
  3: MarkerSeverity.Info,
  4: MarkerSeverity.Info,
};

/** `Diagnostic` do LSP → marcador do Monaco. Sem gravidade, vale erro (como no VS Code). */
export function toMarker(diagnostic: Diagnostic, source: string): MarkerData {
  const { start, end } = diagnostic.range;
  return {
    severity: SEVERITIES[diagnostic.severity ?? 1],
    message: diagnostic.message,
    source,
    ...(diagnostic.code !== undefined && { code: String(diagnostic.code) }),
    startLineNumber: start.line + 1,
    startColumn: start.character + 1,
    endLineNumber: end.line + 1,
    endColumn: end.character + 1,
  };
}

/** Caminho do núcleo → URI `file://` (no Windows, `file:///C:/x/y.cpp`). */
export function pathToUri(path: Path): string {
  const slashed = path.replace(/\\/g, '/');
  const encoded = slashed
    .split('/')
    .map((part) => (/^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)))
    .join('/');
  return `file://${slashed.startsWith('/') ? '' : '/'}${encoded}`;
}

/** URI `file://` → caminho no formato do sistema; nulo para outros esquemas. */
export function uriToPath(uri: string): Path | null {
  if (!uri.startsWith('file://')) return null;
  const path = decodeURIComponent(uri.slice('file://'.length));
  const drive = /^\/([A-Za-z]):(\/.*)?$/.exec(path);
  // Os servidores podem devolver a letra do disco em minúscula; a aba usa a do núcleo.
  return drive ? `${drive[1].toUpperCase()}:${(drive[2] ?? '/').replace(/\//g, '\\')}` : path;
}

/** O resultado do `textDocument/definition` (um, vários ou links) como caminho e posição base 1. */
export function toLocations(
  result: Location | Location[] | LocationLink[] | null,
): { path: Path; line: number; column: number }[] {
  const list: (Location | LocationLink)[] = result
    ? Array.isArray(result)
      ? result
      : [result]
    : [];
  return list.flatMap((item) => {
    const [uri, range] =
      'targetUri' in item ? [item.targetUri, item.targetSelectionRange] : [item.uri, item.range];
    const path = uriToPath(uri);
    return path ? [{ path, line: range.start.line + 1, column: range.start.character + 1 }] : [];
  });
}
