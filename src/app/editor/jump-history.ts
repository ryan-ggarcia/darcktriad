import { Path } from '../ipc';

export interface JumpLocation {
  path: Path;
  line: number;
  column: number;
}

/** Alt+← / Alt+→: os locais de onde se saltou (definição, Ctrl+P, Ctrl+G, problema). */
export class JumpHistory {
  private entries: JumpLocation[] = [];
  /** Onde o usuário está na lista; `entries.length` é "depois do último salto". */
  private index = 0;

  constructor(private readonly limit = 50) {}

  /** Antes de um salto: guarda de onde se saiu e esquece o que dava para avançar. */
  record(from: JumpLocation): void {
    this.entries = [...this.entries.slice(0, this.index), from].slice(-this.limit);
    this.index = this.entries.length;
  }

  /** Para onde voltar; `current` fica guardado para o Avançar trazer de volta. */
  back(current: JumpLocation | null): JumpLocation | null {
    if (this.index === 0) return null;
    if (this.index === this.entries.length && current) {
      this.entries.push(current);
      if (this.entries.length > this.limit) {
        this.entries.shift();
        this.index--;
      }
    }
    return this.entries[--this.index];
  }

  forward(): JumpLocation | null {
    if (this.index >= this.entries.length - 1) return null;
    return this.entries[++this.index];
  }
}
