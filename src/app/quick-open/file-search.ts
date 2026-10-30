import { fold, fuzzyScore, prepareQuery } from '../shared/fuzzy';

/** Acerto no nome sempre fica acima de acerto só no caminho. */
const NAME_BONUS = 1000;
/** A pontuação vira uma chave só, com o caminho mais curto desempatando. */
const LENGTH_RANGE = 4096;
export const MAX_RESULTS = 200;

export interface FileMatch {
  /** Relativo à raiz, como veio de `project_files`. */
  file: string;
  /** Onde começa o nome dentro de `file`. */
  nameStart: number;
  /** Posições casadas em `file`, para o destaque. */
  positions: number[];
}

/** O filtro do Abrir rápido sobre a lista do índice; dobra os caminhos uma vez só. */
export class FileSearch {
  private readonly folded: string[];
  private readonly nameStarts: number[];
  /** Reaproveitados a cada tecla: alocar 50.000 posições por tecla pesa no coletor de lixo. */
  private readonly keys: Float64Array;
  private readonly inName: Uint8Array;

  constructor(readonly files: string[]) {
    this.folded = files.map(fold);
    this.nameStarts = this.folded.map((path) => path.lastIndexOf('/') + 1);
    this.keys = new Float64Array(files.length);
    this.inName = new Uint8Array(files.length);
  }

  search(query: string, limit = MAX_RESULTS): FileMatch[] {
    const prepared = prepareQuery(query);
    const { keys, inName } = this;
    const matched: number[] = [];
    for (let index = 0; index < this.folded.length; index++) {
      const path = this.folded[index];
      const name = fuzzyScore(prepared, path, this.nameStarts[index]);
      const score = name >= 0 ? name + NAME_BONUS : fuzzyScore(prepared, path);
      if (score < 0) continue;
      keys[index] = score * LENGTH_RANGE - Math.min(path.length, LENGTH_RANGE - 1);
      inName[index] = name >= 0 ? 1 : 0;
      matched.push(index);
    }
    return this.best(matched, keys, limit).map((index) => {
      const nameStart = this.nameStarts[index];
      const positions: number[] = [];
      fuzzyScore(prepared, this.folded[index], inName[index] ? nameStart : 0, positions);
      return { file: this.files[index], nameStart, positions };
    });
  }

  /**
   * Os `limit` de chave maior, empatando pela ordem do índice (que já vem por caminho). Acha o
   * corte com a ordenação nativa de números, sem ordenar com comparador os 50.000 acertos.
   */
  private best(matched: number[], keys: Float64Array, limit: number): number[] {
    let top = matched;
    if (matched.length > limit) {
      const sorted = Float64Array.from(matched, (index) => keys[index]).sort();
      const cut = sorted[sorted.length - limit];
      top = matched.filter((index) => keys[index] > cut);
      for (const index of matched) {
        if (top.length === limit) break;
        if (keys[index] === cut) top.push(index);
      }
    }
    return top.sort((a, b) => keys[b] - keys[a] || a - b);
  }
}
