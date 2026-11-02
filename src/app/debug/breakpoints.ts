import { inject, Injectable, signal } from '@angular/core';
import { Breakpoint as SavedBreakpoint, errorMessage, Path } from '../ipc';
import { CurrentFolder } from '../workspace/current-folder';
import { WorkspaceService } from '../workspace.service';

/** Um ponto de parada no editor. `verified` só existe durante a sessão (false: não vinculado). */
export interface Breakpoint {
  file: Path;
  /** A partir de 1. */
  line: number;
  verified?: boolean;
  /** O `id` do depurador, para o evento `breakpoint`. */
  id?: number;
}

/** Um item da resposta do `setBreakpoints` ou do evento `breakpoint` (DAP). */
export interface DapBreakpoint {
  id?: number;
  verified: boolean;
  line?: number;
}

/** F9: põe o ponto na linha ou o tira. */
export function toggled(list: Breakpoint[], file: Path, line: number): Breakpoint[] {
  const rest = list.filter((item) => item.file !== file || item.line !== line);
  return rest.length < list.length ? rest : [...list, { file, line }];
}

/**
 * A resposta do `setBreakpoints` de `file`: um item por linha enviada, na mesma ordem. `line`
 * diferente move o ponto; `verified: false` o marca como não vinculado.
 */
export function withResults(
  list: Breakpoint[],
  file: Path,
  sent: number[],
  results: DapBreakpoint[],
): Breakpoint[] {
  return unique(
    list.map((item) => {
      const result = item.file === file ? results[sent.indexOf(item.line)] : undefined;
      return result
        ? { file, line: result.line ?? item.line, verified: result.verified, id: result.id }
        : item;
    }),
  );
}

/** O evento `breakpoint` (`changed`): o depurador vinculou ou moveu um ponto já enviado. */
export function withEvent(list: Breakpoint[], result: DapBreakpoint): Breakpoint[] {
  if (result.id === undefined) return list;
  return unique(
    list.map((item) =>
      item.id === result.id
        ? { ...item, line: result.line ?? item.line, verified: result.verified }
        : item,
    ),
  );
}

/** As linhas que o texto empurrou (inserir ou apagar linhas acima): `[antes, depois]`. */
export function relocated(list: Breakpoint[], file: Path, moves: [number, number][]): Breakpoint[] {
  const to = new Map(moves);
  return unique(
    list.map((item) =>
      item.file === file && to.has(item.line) ? { ...item, line: to.get(item.line)! } : item,
    ),
  );
}

/** Dois pontos que caíram na mesma linha viram um só. */
function unique(list: Breakpoint[]): Breakpoint[] {
  const seen = new Set<string>();
  return list.filter((item) => {
    const key = `${item.line}\n${item.file}`;
    return !seen.has(key) && seen.add(key);
  });
}

function saved(list: Breakpoint[]): SavedBreakpoint[] {
  return list.map(({ file, line }) => ({ file, line }));
}

/** Os pontos de parada da pasta (docs/specs/depuracao.md), salvos a cada mudança de linha. */
@Injectable({ providedIn: 'root' })
export class Breakpoints {
  private readonly service = inject(WorkspaceService);
  private readonly folder = inject(CurrentFolder);
  readonly list = signal<Breakpoint[]>([]);
  /** Quem avisa o depurador quando o usuário muda os pontos de um arquivo (F9, X, Remover todos). */
  onEdit: (file: Path) => void = () => undefined;
  private lastSaved = '[]';
  private writes: Promise<unknown> = Promise.resolve();

  /** Os da pasta que abriu (`OpenedFolder.breakpoints`); vazio ao fechar. */
  load(list: SavedBreakpoint[]): void {
    this.list.set(saved(list));
    this.lastSaved = JSON.stringify(this.list());
  }

  linesOf(file: Path): number[] {
    return this.list()
      .filter((item) => item.file === file)
      .map((item) => item.line);
  }

  files(): Path[] {
    return [...new Set(this.list().map((item) => item.file))];
  }

  toggle(file: Path, line: number): void {
    this.set(toggled(this.list(), file, line));
    this.onEdit(file);
  }

  remove(breakpoint: Breakpoint): void {
    this.set(this.list().filter((item) => item !== breakpoint));
    this.onEdit(breakpoint.file);
  }

  removeAll(): void {
    const files = this.files();
    this.set([]);
    files.forEach((file) => this.onEdit(file));
  }

  applyResults(file: Path, sent: number[], results: DapBreakpoint[]): void {
    this.set(withResults(this.list(), file, sent, results));
  }

  applyEvent(result: DapBreakpoint): void {
    this.set(withEvent(this.list(), result));
  }

  relocate(file: Path, moves: [number, number][]): void {
    this.set(relocated(this.list(), file, moves));
  }

  /** Fim da sessão: as bolinhas voltam a ser vermelhas. */
  forgetSession(): void {
    this.list.update((list) => saved(list));
  }

  /** Grava só quando arquivo ou linha mudou (não a cada resposta do depurador). */
  private set(list: Breakpoint[]): void {
    this.list.set(list);
    const plain = JSON.stringify(saved(list));
    if (plain === this.lastSaved || !this.folder.path()) return;
    this.lastSaved = plain;
    // Em fila: duas gravações em paralelo poderiam chegar fora de ordem.
    this.writes = this.writes
      .then(() => this.service.saveBreakpoints(saved(list)))
      .catch((error) => console.warn('Falha ao gravar os pontos de parada', errorMessage(error)));
  }
}
