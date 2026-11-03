// @ts-expect-error: lido como texto pelo Vite (`?raw`), sem tipos.
import source from 'monaco-editor/editor/contrib/hover/browser/markerHoverParticipant.js?raw';
import { MESSAGES } from './monaco-loader';

describe('traduções do Monaco', () => {
  it('os índices ainda são os textos em inglês do hover de um problema', () => {
    const english: Record<number, string> = {
      1195: 'View Problem',
      1196: 'No quick fixes available',
      1198: 'No quick fixes available',
    };

    expect(Object.keys(MESSAGES)).toEqual(Object.keys(english));
    for (const [index, text] of Object.entries(english)) {
      expect(source).toContain(`localize(${index}, "${text}")`);
    }
  });
});
