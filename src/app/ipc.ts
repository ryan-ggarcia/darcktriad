/** Tipos do contrato com o núcleo Rust (docs/ipc.md). */

export type Path = string;

export type Eol = 'lf' | 'crlf';

export type ErrorKind =
  | 'notFound'
  | 'alreadyExists'
  | 'permissionDenied'
  | 'invalidInput'
  | 'conflict'
  | 'readOnly'
  | 'trashFailed'
  | 'other';

export interface AppError {
  kind: ErrorKind;
  message: string;
}

export interface Entry {
  name: string;
  path: Path;
  isDir: boolean;
  isSymlink: boolean;
}

export type FileContent =
  | { kind: 'text'; content: string; eol: Eol; bom: boolean; readOnly: boolean; version: string }
  | { kind: 'binary' }
  | { kind: 'tooLarge'; size: number };

export interface Session {
  openFiles: Path[];
  activeFile: Path | null;
}

export interface OpenedFolder {
  path: Path;
  session: Session;
  watchError: string | null;
}

export interface RecentFolder {
  path: Path;
  exists: boolean;
}

export interface ChangeBatch {
  paths: Path[];
  rescan: boolean;
}

export interface ProjectFiles {
  root: Path | null;
  /** Relativos a `root`, com o separador do sistema. */
  files: string[];
  /** O índice ainda está sendo montado e `files` é parcial. */
  indexing: boolean;
}

export type EditRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';

export type MenuEntry =
  | { kind: 'command'; id: string; label: string; accelerator?: string | null; role?: EditRole }
  | { kind: 'submenu'; label: string; items: MenuEntry[] }
  | { kind: 'separator' };

export interface TerminalInfo {
  id: number;
  /** Nome do shell para a lista: 'pwsh', 'bash', 'zsh'… */
  name: string;
}

export type TerminalEvent =
  { kind: 'output'; data: string } | { kind: 'exited'; code: number | null };

function isAppError(error: unknown): error is AppError {
  return typeof error === 'object' && error !== null && 'kind' in error && 'message' in error;
}

/** Os comandos rejeitam com `AppError`; o próprio Tauri rejeita com uma string. */
export function errorKind(error: unknown): ErrorKind {
  return isAppError(error) ? error.kind : 'other';
}

export function errorMessage(error: unknown): string {
  return isAppError(error) ? error.message : String(error);
}
