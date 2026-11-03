import { computed, Injectable, signal } from '@angular/core';
import { Path } from '../ipc';
import { MarkerData } from '../language/lsp';

/** Um problema: o marcador do Monaco (base 1) e o arquivo; sem arquivo, o de reserva da compilação. */
export interface ProblemItem extends MarkerData {
  file: Path | null;
}

export interface ProblemGroup {
  file: Path | null;
  items: ProblemItem[];
}

/** Gravidade (maior primeiro), depois linha e coluna. */
function compare(a: ProblemItem, b: ProblemItem): number {
  return (
    b.severity - a.severity ||
    a.startLineNumber - b.startLineNumber ||
    a.startColumn - b.startColumn
  );
}

/**
 * Todos os problemas da janela (docs/specs/linguagem.md, painel Problemas). Cada fonte (clangd,
 * C#, projeto, build) substitui só os próprios itens.
 */
@Injectable({ providedIn: 'root' })
export class Problems {
  private readonly bySource = signal(new Map<string, ProblemItem[]>());

  /** Agrupados por arquivo; dentro do arquivo, por gravidade e linha. */
  readonly groups = computed<ProblemGroup[]>(() => {
    const byFile = new Map<Path | null, ProblemItem[]>();
    for (const items of this.bySource().values()) {
      for (const item of items) byFile.set(item.file, [...(byFile.get(item.file) ?? []), item]);
    }
    return [...byFile.keys()]
      .sort()
      .map((file) => ({ file, items: byFile.get(file)!.sort(compare) }));
  });
  /** Na ordem do painel. */
  readonly items = computed(() => this.groups().flatMap((group) => group.items));
  readonly errors = computed(() => this.count(8));
  readonly warnings = computed(() => this.count(4));

  /** Troca os itens de `source`; com `file`, só os desse arquivo. */
  set(source: string, items: ProblemItem[], file?: Path): void {
    this.bySource.update((sources) => {
      const kept =
        file === undefined ? [] : (sources.get(source) ?? []).filter((item) => item.file !== file);
      return new Map(sources).set(source, [...kept, ...items]);
    });
  }

  /** Apaga as fontes em que `match` vale (ex.: as do servidor que parou). */
  clear(match: (source: string) => boolean): void {
    this.bySource.update((sources) => new Map([...sources].filter(([source]) => !match(source))));
  }

  /**
   * F8 / Shift+F8: o vizinho na ordem do painel, passando de arquivo em arquivo. Fora de um
   * problema, vai para o próximo (ou o anterior) do cursor no arquivo atual, dando a volta nele;
   * sem problemas no arquivo, para o primeiro (ou o último) da lista.
   */
  next(
    from: { file: Path; line: number; column: number } | null,
    offset: 1 | -1,
  ): ProblemItem | null {
    const items = this.items();
    if (!items.length) return null;
    const at = items.findIndex(
      (item) =>
        item.file === from?.file &&
        item.startLineNumber === from.line &&
        item.startColumn === from.column,
    );
    if (at >= 0) return items[(at + offset + items.length) % items.length];
    const inFile = items.filter((item) => item.file === from?.file);
    if (!from || !inFile.length) return offset > 0 ? items[0] : items[items.length - 1];
    // Na ordem do texto (invertida no Shift+F8): o primeiro depois do cursor, senão dá a volta.
    const ordered = inFile.sort(
      (a, b) => offset * (a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn),
    );
    const ahead = (item: ProblemItem) =>
      offset * (item.startLineNumber - from.line || item.startColumn - from.column) > 0;
    return ordered.find(ahead) ?? ordered[0];
  }

  private count(severity: number): number {
    return this.items().filter((item) => item.severity === severity).length;
  }
}
