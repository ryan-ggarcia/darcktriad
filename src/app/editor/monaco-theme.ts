import type * as Monaco from 'monaco-editor';

export const DARK_TRIAD_THEME = 'dark-triad';

const CARD = '#150d26';
const HOVER = '#2a1c47';
const SELECTED = '#43227f';
const BORDER = '#4b3673';
const TRANSPARENT = '#00000000';

/**
 * Herda as cores de código do tema escuro. Os erros, os avisos e as marcas da depuração não são
 * definidos aqui, de propósito: continuam com a cor própria.
 */
export const THEME_DATA: Monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [{ token: 'keyword', foreground: 'c4a5ff' }],
  colors: {
    // Igual a --bg em styles.css: o cartão e o editor não mostram emenda.
    'editor.background': '#0c0915',
    'editor.foreground': '#e2dcef',
    'editorGutter.background': '#0c0915',
    'minimap.background': '#0c0915',
    'editorLineNumber.foreground': '#8a7ea3',
    'editorLineNumber.activeForeground': '#e2dcef',
    'editorCursor.foreground': '#c4b5fd',
    'editor.lineHighlightBackground': '#a78bfa12',
    'editor.lineHighlightBorder': TRANSPARENT,
    'editor.selectionBackground': '#6d3fd080',
    'editor.inactiveSelectionBackground': '#6d3fd040',
    'editor.selectionHighlightBackground': '#7c3aed30',
    'editor.wordHighlightBackground': '#7c3aed30',
    'editor.findMatchBackground': '#a855f770',
    'editor.findMatchHighlightBackground': '#a855f735',
    'editorBracketMatch.background': '#7c3aed30',
    'editorBracketMatch.border': BORDER,
    'editorIndentGuide.background1': '#2f2249',
    'editorIndentGuide.activeBackground1': BORDER,
    'editorLink.activeForeground': '#c4b5fd',
    'editorOverviewRuler.border': TRANSPARENT,
    focusBorder: '#a78bfa',
    'scrollbar.shadow': TRANSPARENT,
    'scrollbarSlider.background': '#7c5cc44d',
    'scrollbarSlider.hoverBackground': '#7c5cc480',
    'scrollbarSlider.activeBackground': '#a78bfa99',
    'widget.shadow': '#000000aa',
    'editorWidget.background': CARD,
    'editorWidget.border': BORDER,
    'editorHoverWidget.background': CARD,
    'editorHoverWidget.border': BORDER,
    'editorSuggestWidget.background': CARD,
    'editorSuggestWidget.border': BORDER,
    'editorSuggestWidget.selectedBackground': SELECTED,
    'editorSuggestWidget.highlightForeground': '#c4b5fd',
    'list.hoverBackground': HOVER,
    'list.activeSelectionBackground': SELECTED,
    'list.activeSelectionForeground': '#ffffff',
    'list.focusBackground': SELECTED,
    'list.highlightForeground': '#c4b5fd',
    'input.background': '#221739',
    'input.border': BORDER,
  },
};
