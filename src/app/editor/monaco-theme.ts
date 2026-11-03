import type * as Monaco from 'monaco-editor';
import type { Theme } from '../shared/appearance';

const TRANSPARENT = '#00000000';

/** As cores do editor em cada tema; os fundos sólidos são iguais aos de styles.css (sem emenda). */
const PALETTES = {
  dark: {
    base: 'vs-dark',
    background: '#0D0919',
    foreground: '#F5F3FF',
    muted: '#B9ADD8',
    lineNumber: '#8F83B0',
    accent: '#A855FF',
    keyword: 'C49BFF',
    widget: '#140E25',
    border: '#2A1D45',
    hover: '#1E1535',
    selected: '#7825F566',
    selection: '#7825F566',
    rules: [{ token: 'annotation', foreground: 'D98080' }],
  },
  light: {
    base: 'vs',
    background: '#FFFFFF',
    foreground: '#1B1433',
    muted: '#5A4E78',
    lineNumber: '#6F6491',
    accent: '#7825F5',
    keyword: '6A1FE0',
    widget: '#FFFFFF',
    border: '#E2D9F5',
    hover: '#F3EEFD',
    selected: '#7825F526',
    selection: '#7825F533',
    rules: [
      { token: 'comment', foreground: '006B00' },
      { token: 'number', foreground: '076A46' },
      { token: 'type', foreground: '006B6B' },
      { token: 'annotation', foreground: '666666' },
    ],
  },
} as const;

/** O nome registrado no Monaco para o tema e o material. */
export function monacoThemeName(theme: Theme, glass: boolean): string {
  return `dark-triad-${theme}${glass ? '-glass' : ''}`;
}

/**
 * Herda as cores de código do tema base, menos as que ficam abaixo de 4,5:1 no vidro com o pior
 * fundo atrás (`rules`). Os erros, os avisos e as marcas da depuração não são
 * definidos aqui, de propósito: continuam com a cor própria. No vidro o fundo do editor é
 * transparente e quem pinta é o cartão (styles.css); o que fica por cima do texto (cabeçalho fixo
 * da rolagem, sugestões) continua opaco.
 */
export function monacoThemeData(theme: Theme, glass: boolean): Monaco.editor.IStandaloneThemeData {
  const p = PALETTES[theme];
  const background = glass ? TRANSPARENT : p.background;
  return {
    base: p.base,
    inherit: true,
    rules: [{ token: 'keyword', foreground: p.keyword }, ...p.rules],
    colors: {
      'editor.background': background,
      'editor.foreground': p.foreground,
      'editorGutter.background': background,
      'minimap.background': background,
      'editorStickyScroll.background': p.background,
      'editorStickyScrollHover.background': p.hover,
      'editorLineNumber.foreground': p.lineNumber,
      'editorLineNumber.activeForeground': p.muted,
      'editorCursor.foreground': p.accent,
      'editor.lineHighlightBackground': `${p.accent}12`,
      'editor.lineHighlightBorder': TRANSPARENT,
      'editor.selectionBackground': p.selection,
      'editor.inactiveSelectionBackground': `${p.accent}26`,
      'editor.selectionHighlightBackground': `${p.accent}26`,
      'editor.wordHighlightBackground': `${p.accent}26`,
      'editor.findMatchBackground': `${p.accent}66`,
      'editor.findMatchHighlightBackground': `${p.accent}33`,
      'editorBracketMatch.background': `${p.accent}26`,
      'editorBracketMatch.border': p.border,
      'editorIndentGuide.background1': p.border,
      'editorIndentGuide.activeBackground1': `${p.accent}80`,
      'editorLink.activeForeground': p.accent,
      // Sem ela, a régua vira uma faixa preta: o Monaco descarta o alfa do fundo do editor.
      'editorOverviewRuler.background': background,
      'editorOverviewRuler.border': TRANSPARENT,
      focusBorder: p.accent,
      'scrollbar.shadow': TRANSPARENT,
      'scrollbarSlider.background': `${p.accent}33`,
      'scrollbarSlider.hoverBackground': `${p.accent}59`,
      'scrollbarSlider.activeBackground': `${p.accent}80`,
      'widget.shadow': theme === 'dark' ? '#00000080' : '#2A1D4526',
      'editorWidget.background': p.widget,
      'editorWidget.border': p.border,
      'editorHoverWidget.background': p.widget,
      'editorHoverWidget.border': p.border,
      'editorSuggestWidget.background': p.widget,
      'editorSuggestWidget.border': p.border,
      'editorSuggestWidget.selectedBackground': p.selected,
      'editorSuggestWidget.highlightForeground': p.accent,
      'list.hoverBackground': p.hover,
      'list.activeSelectionBackground': p.selected,
      'list.activeSelectionForeground': p.foreground,
      'list.focusBackground': p.selected,
      'list.highlightForeground': p.accent,
      'input.background': p.widget,
      'input.border': p.border,
    },
  };
}

/** Registra as quatro combinações de tema e material. */
export function defineMonacoThemes(monaco: typeof Monaco): void {
  for (const theme of ['dark', 'light'] as const) {
    for (const glass of [false, true]) {
      monaco.editor.defineTheme(monacoThemeName(theme, glass), monacoThemeData(theme, glass));
    }
  }
}
