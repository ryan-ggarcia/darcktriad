/**
 * Preferências da interface (tema, material, tamanhos), no localStorage da pasta de dados do app.
 * Sem acesso a ele (cota, armazenamento bloqueado), vale o padrão e nada quebra.
 */
export function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Sem onde gravar: vale só até fechar o app.
  }
}

/** Um número salvo dentro de [min, max]; `fallback` se não houver ou não for número. */
export function readSize(key: string, fallback: number, min: number, max: number): number {
  const value = Number(readSetting(key) ?? NaN);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
