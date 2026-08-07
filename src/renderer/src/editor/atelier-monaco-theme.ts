import * as monaco from 'monaco-editor'

let themesRegistered = false

export function ensureAtelierMonacoThemes(): void {
  if (themesRegistered) return
  themesRegistered = true

  monaco.editor.defineTheme('atelier-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '9096c9' },
      { token: 'keyword.control', foreground: '9096c9' },
      { token: 'storage.type', foreground: '9096c9' },
      { token: 'storage.modifier', foreground: '9096c9' },
      { token: 'entity.name.type', foreground: '7fc0c4' },
      { token: 'entity.name.class', foreground: 'ece7d9' },
      { token: 'entity.name.function', foreground: '8fc17f' },
      { token: 'support.function', foreground: '8fc17f' },
      { token: 'string', foreground: 'd9b374' },
      { token: 'string.quoted', foreground: 'd9b374' },
      { token: 'constant.numeric', foreground: 'd9b374' },
      { token: 'constant.language', foreground: '9096c9' },
      { token: 'comment', foreground: '5c5647', fontStyle: 'italic' },
      { token: 'punctuation', foreground: '837c6b' },
      { token: 'variable.parameter', foreground: 'c9a87c' },
      { token: 'variable', foreground: 'd9c7a8' }
    ],
    colors: {
      'editor.background': '#17150f',
      'editor.foreground': '#b3ac9a',
      'editor.lineHighlightBackground': '#1f1d17',
      'editor.selectionBackground': '#3d382c',
      'editor.inactiveSelectionBackground': '#2a2721',
      'editorLineNumber.foreground': '#5c5647',
      'editorLineNumber.activeForeground': '#ece7d9',
      'editorCursor.foreground': '#ece7d9',
      'editorWhitespace.foreground': '#302c25',
      'editorIndentGuide.background1': '#2a2721',
      'editorIndentGuide.activeBackground1': '#3d382c',
      'editor.findMatchBackground': '#3d3010',
      'editor.findMatchHighlightBackground': '#2a2210',
      'editorWidget.background': '#2a2721',
      'editorWidget.border': '#3d382c',
      'input.background': '#302c25',
      'input.border': '#3d382c',
      'input.foreground': '#ece7d9',
      'scrollbarSlider.background': '#302c2580',
      'scrollbarSlider.hoverBackground': '#3d382c80',
      'scrollbarSlider.activeBackground': '#3d382ca0',
      'editorGutter.background': '#17150f',
      'minimap.background': '#120f0a'
    }
  })

  monaco.editor.defineTheme('atelier-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '5a6094' },
      { token: 'keyword.control', foreground: '5a6094' },
      { token: 'storage.type', foreground: '5a6094' },
      { token: 'storage.modifier', foreground: '5a6094' },
      { token: 'entity.name.type', foreground: '4a8890' },
      { token: 'entity.name.class', foreground: '2c2a25' },
      { token: 'entity.name.function', foreground: '587a53' },
      { token: 'support.function', foreground: '587a53' },
      { token: 'string', foreground: '8a6d3a' },
      { token: 'string.quoted', foreground: '8a6d3a' },
      { token: 'constant.numeric', foreground: '8a6d3a' },
      { token: 'constant.language', foreground: '5a6094' },
      { token: 'comment', foreground: '9a9686', fontStyle: 'italic' },
      { token: 'punctuation', foreground: '6d6a60' },
      { token: 'variable.parameter', foreground: '7a6340' },
      { token: 'variable', foreground: '4a463f' }
    ],
    colors: {
      'editor.background': '#ece7db',
      'editor.foreground': '#2c2a25',
      'editor.lineHighlightBackground': '#e4ddcc',
      'editor.selectionBackground': '#d8d0bc',
      'editor.inactiveSelectionBackground': '#e4ddcc',
      'editorLineNumber.foreground': '#9a9686',
      'editorLineNumber.activeForeground': '#2c2a25',
      'editorCursor.foreground': '#2c2a25',
      'editorWhitespace.foreground': '#d8d0bc',
      'editorIndentGuide.background1': '#d8d0bc',
      'editorIndentGuide.activeBackground1': '#c2beae',
      'editor.findMatchBackground': '#e8dcc0',
      'editor.findMatchHighlightBackground': '#f1ede3',
      'editorWidget.background': '#fbf9f4',
      'editorWidget.border': '#c2beae',
      'input.background': '#fbf9f4',
      'input.border': '#c2beae',
      'input.foreground': '#2c2a25',
      'scrollbarSlider.background': '#c2beae80',
      'scrollbarSlider.hoverBackground': '#9a968680',
      'scrollbarSlider.activeBackground': '#6d6a60a0',
      'editorGutter.background': '#ece7db',
      'minimap.background': '#f1ede3'
    }
  })
}

export function monacoThemeId(effectiveTheme: 'light' | 'dark'): 'atelier-light' | 'atelier-dark' {
  return effectiveTheme === 'light' ? 'atelier-light' : 'atelier-dark'
}
