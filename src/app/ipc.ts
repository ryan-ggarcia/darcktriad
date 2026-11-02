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
  breakpoints: Breakpoint[];
  watchError: string | null;
}

/** Um ponto de parada salvo: a linha do editor, a partir de 1. */
export interface Breakpoint {
  file: Path;
  line: number;
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

export type ProjectKind =
  'cmake' | 'cmakePresets' | 'dotnetSolution' | 'dotnetProjects' | 'editOnly';

export type ProjectStatus =
  | { kind: 'idle' }
  | { kind: 'configuring' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string };

export interface CMakeTarget {
  name: string;
  /** Absoluto; pode ainda não existir antes de compilar. */
  path: Path;
}

export interface Problem {
  /** Absoluto. */
  file: Path;
  /** A partir de 1. */
  line: number;
  message: string;
}

export interface ProjectState {
  root: Path | null;
  kind: ProjectKind;
  warning: string | null;
  configs: string[];
  config: string | null;
  status: ProjectStatus;
  buildDir: Path | null;
  targets: CMakeTarget[];
  target: string | null;
  problems: Problem[];
}

export type BuildStatus = 'succeeded' | 'failed' | 'cancelled';

/** Um item do painel Problemas com origem `build`. */
export interface BuildProblem {
  /** Absoluto; null só no item de reserva "A compilação falhou. Veja a Saída.". */
  file: Path | null;
  /** A partir de 1; null só no item de reserva. */
  line: number | null;
  column: number | null;
  severity: 'error' | 'warning' | 'info';
  code: string | null;
  message: string;
}

export type ProjectEvent =
  | { kind: 'output'; line: string }
  | { kind: 'state'; state: ProjectState }
  | { kind: 'buildOutput'; line: string }
  | { kind: 'buildFinished'; status: BuildStatus; problems: BuildProblem[] };

export type ToolStatus =
  | { kind: 'present'; path: Path; version: string | null }
  | { kind: 'outdated'; path: Path; version: string | null }
  | { kind: 'missing' };

export interface ToolCheck {
  program: string;
  purpose: string;
  minimum: string | null;
  install: string;
  status: ToolStatus;
}

/** C e C++ (clangd) ou C# (Roslyn). */
export type Language = 'cpp' | 'csharp';

export type ServerState =
  | { kind: 'starting' }
  | { kind: 'running' }
  | { kind: 'stopped'; reason: string }
  | { kind: 'noProject' };

export type LanguageEvent =
  | { kind: 'message'; message: string }
  | { kind: 'log'; line: string }
  | { kind: 'state'; state: ServerState };

/** A resposta do `debug_start`. */
export interface DebugLaunch {
  adapter: 'lldb-dap' | 'netcoredbg';
  /** Os `arguments` do pedido `launch`: vão como vieram. */
  launch: object;
}

export type DebugEvent =
  | { kind: 'message'; message: string }
  | { kind: 'log'; line: string }
  /** O adaptador saiu; `reason` não nulo: caiu, com a mensagem pronta para mostrar. */
  | { kind: 'ended'; reason: string | null };

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
