/** Carrega o Monaco sob demanda, fora do pacote inicial. */
export async function loadMonaco(): Promise<typeof import('monaco-editor')> {
  // As mensagens precisam existir antes de os módulos do Monaco serem avaliados.
  // shortcut: o pt-br.js do monaco-editor 0.57 vem sem traduções (tudo null), então a busca e o
  // menu do Monaco ficam em inglês; traduzir nós mesmos quando isso incomodar ou o pacote trouxer.
  await import('monaco-editor/nls/lang/pt-br');
  return (await import('./monaco')).monaco;
}
