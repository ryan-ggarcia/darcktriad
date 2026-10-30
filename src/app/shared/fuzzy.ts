/**
 * Filtro aproximado da paleta e do Abrir rápido: as letras da busca aparecem em ordem no texto,
 * sem diferenciar maiúsculas nem acentos ("slvtd" acha "Arquivo: Salvar tudo").
 */

const ASCII = /^[\x00-\x7f]*$/;
const WORD_START = new Set([' ', '/', '.', '_', '-', ':', '(']);
const CONSECUTIVE_BONUS = 4;
const WORD_START_BONUS = 3;

/**
 * Minúsculas, sem acento e com `/` no lugar de `\`, mantendo o comprimento: a posição de cada
 * letra no resultado é a mesma no texto original, para o destaque.
 */
export function fold(text: string): string {
  if (ASCII.test(text)) return text.toLowerCase().replaceAll('\\', '/');
  let folded = '';
  for (let i = 0; i < text.length; i++) {
    folded += text[i].normalize('NFD')[0].toLowerCase()[0].replace('\\', '/');
  }
  return folded;
}

/** A busca como o filtro a compara: dobrada e sem espaços. */
export function prepareQuery(query: string): string {
  return fold(query.replace(/\s+/g, ''));
}

/**
 * Pontua `target` (já dobrado) para `query` (já preparada), olhando só a partir de `from`; -1 se
 * não casar. Letras seguidas e começos de palavra valem mais. Com `positions`, guarda onde casou.
 */
export function fuzzyScore(query: string, target: string, from = 0, positions?: number[]): number {
  let score = 0;
  let index = from - 1;
  for (let i = 0; i < query.length; i++) {
    const previous = index;
    index = target.indexOf(query[i], index + 1);
    if (index < 0) return -1;
    score += 1;
    if (index === previous + 1 && i > 0) score += CONSECUTIVE_BONUS;
    if (index === from || WORD_START.has(target[index - 1])) score += WORD_START_BONUS;
    positions?.push(index);
  }
  return score;
}

export interface Segment {
  text: string;
  match: boolean;
}

/** Corta `text` em trechos com e sem destaque, nas `positions` casadas (em ordem). */
export function highlight(text: string, positions: number[]): Segment[] {
  const segments: Segment[] = [];
  let next = 0;
  for (let i = 0; i < text.length; i++) {
    const match = positions[next] === i;
    if (match) next++;
    const last = segments.at(-1);
    if (last?.match === match) last.text += text[i];
    else segments.push({ text: text[i], match });
  }
  return segments;
}
