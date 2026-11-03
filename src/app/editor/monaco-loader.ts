/**
 * Traduções nossas, pela tabela de mensagens do Monaco (a mesma que o pt-br.js preenche), por
 * índice. shortcut: os índices são do monaco-editor 0.57.0 (o hover de um problema); ao
 * atualizar o Monaco, o teste do monaco-loader avisa se eles mudaram.
 */
export const MESSAGES: Record<number, string> = {
  1195: 'Ver problema',
  1196: 'Nenhuma correção rápida disponível',
  1198: 'Nenhuma correção rápida disponível',
};

/** Carrega o Monaco sob demanda, fora do pacote inicial. */
export async function loadMonaco(): Promise<typeof import('monaco-editor')> {
  // As mensagens precisam existir antes de os módulos do Monaco serem avaliados.
  // shortcut: o pt-br.js do monaco-editor 0.57 vem sem traduções (tudo null), então a busca e o
  // menu do Monaco ficam em inglês; traduzir nós mesmos quando isso incomodar ou o pacote trouxer.
  await import('monaco-editor/nls/lang/pt-br');
  Object.assign(
    (globalThis as unknown as { _VSCODE_NLS_MESSAGES: (string | null)[] })._VSCODE_NLS_MESSAGES,
    MESSAGES,
  );
  return (await import('./monaco')).monaco;
}
