// @ts-expect-error: lidos como texto pelo Angular (`loader`), sem tipos.
import ours from '../../styles.css' with { loader: 'text' };
// @ts-expect-error: idem.
import monaco from '../../../node_modules/monaco-editor/min/vs/editor/editor.main.css' with {
  loader: 'text',
};

describe('styles.css e o Monaco', () => {
  // `.main` com fundo opaco cobriu o texto e a seleção de cada linha das sugestões.
  it('nenhuma regra global começa por uma classe que o Monaco também usa', () => {
    const classes = new Set(
      [...(monaco as string).matchAll(/\.([\w-]+)/g)].map((match) => match[1]),
    );
    const css = (ours as string).replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/([^{}]+)\{/g)]
      .flatMap((match) => match[1].split(','))
      .map((selector) => selector.trim());
    const global = selectors.filter((selector) => {
      const name = /^\.([\w-]+)(?![\w.-])/.exec(selector)?.[1];
      return name !== undefined && classes.has(name);
    });
    expect(global).toEqual([]);
  });
});
