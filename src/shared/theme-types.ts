/**
 * Custom theme types — shared across main, preload, and renderer.
 * No Electron/Node imports; safe to pull into any process.
 */

/** All solid-hex color tokens that a custom theme can override. */
export interface CustomThemeColors {
  // Surfaces
  bgApp?: string
  bgSidebar?: string
  bgPanel?: string
  bgPanelRaised?: string
  bgHover?: string
  bgActive?: string
  bgInput?: string
  bgCode?: string
  bgAppActivePanel?: string
  bgCodeActivePanel?: string
  // Text
  textPrimary?: string
  textSecondary?: string
  textTertiary?: string
  textDisabled?: string
  // Accent
  accent?: string
  accentStrong?: string
  accentDim?: string
  accentTextOn?: string
  // Semantic
  danger?: string
  dangerDim?: string
  warning?: string
  success?: string
  info?: string
}

export interface CustomTheme {
  id: string
  name: string
  /** Which built-in theme to inherit border/shadow/elevation tokens from. */
  base: 'light' | 'dark'
  colors: CustomThemeColors
}

/** Maps each CustomThemeColors key to the CSS custom property name it controls. */
export const TOKEN_CSS_VARS: Record<keyof CustomThemeColors, string> = {
  bgApp: '--bg-app',
  bgSidebar: '--bg-sidebar',
  bgPanel: '--bg-panel',
  bgPanelRaised: '--bg-panel-raised',
  bgHover: '--bg-hover',
  bgActive: '--bg-active',
  bgInput: '--bg-input',
  bgCode: '--bg-code',
  bgAppActivePanel: '--bg-app-active-panel',
  bgCodeActivePanel: '--bg-code-active-panel',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textTertiary: '--text-tertiary',
  textDisabled: '--text-disabled',
  accent: '--accent',
  accentStrong: '--accent-strong',
  accentDim: '--accent-dim',
  accentTextOn: '--accent-text-on',
  danger: '--danger',
  dangerDim: '--danger-dim',
  warning: '--warning',
  success: '--success',
  info: '--info'
}

export interface TokenMeta {
  key: keyof CustomThemeColors
  label: string
  /** One-line description shown as a tooltip in the theme editor. */
  hint: string
}

export interface TokenGroup {
  label: string
  tokens: TokenMeta[]
}

/** Grouped token metadata for the theme editor UI — label + hover hint per token. */
export const TOKEN_GROUPS: TokenGroup[] = [
  {
    label: 'Surfaces',
    tokens: [
      { key: 'bgApp', label: 'App bg', hint: 'Outermost window background, behind the sidebar and all panels' },
      { key: 'bgSidebar', label: 'Sidebar', hint: 'Left sidebar background — session list, nav icons' },
      { key: 'bgPanel', label: 'Panel', hint: 'Main content area — chat panel, settings dialogs, modals' },
      { key: 'bgPanelRaised', label: 'Panel+', hint: 'Elevated surface inside panels — file rows, tool-call cards, dropdowns' },
      { key: 'bgHover', label: 'Hover', hint: 'Background of any interactive row or button on mouse-over' },
      { key: 'bgActive', label: 'Active', hint: 'Background of the currently selected item — active session, active nav button' },
      { key: 'bgInput', label: 'Input', hint: 'Text inputs, the composer box, and search fields' },
      { key: 'bgCode', label: 'Code bg', hint: 'Code blocks inside agent messages and the terminal background' },
      { key: 'bgAppActivePanel', label: 'Active pane', hint: 'Background of the focused split-pane — slightly darker than App bg to distinguish it from the inactive pane at a glance' },
      { key: 'bgCodeActivePanel', label: 'Active code', hint: 'Code-block background inside the focused split-pane' }
    ]
  },
  {
    label: 'Text',
    tokens: [
      { key: 'textPrimary', label: 'Primary', hint: 'Main readable text — messages, file names, headings' },
      { key: 'textSecondary', label: 'Secondary', hint: 'Supporting labels — session subtitles, timestamps, field descriptions' },
      { key: 'textTertiary', label: 'Tertiary', hint: 'Muted metadata — tool-call details, line numbers, placeholder text' },
      { key: 'textDisabled', label: 'Disabled', hint: 'Grayed-out text — inactive items, empty state labels' }
    ]
  },
  {
    label: 'Accent',
    tokens: [
      { key: 'accent', label: 'Accent', hint: 'Selection highlights, links, focus rings, and the "working" status dot' },
      { key: 'accentStrong', label: 'Strong', hint: 'Hover / pressed state of accent elements, e.g. primary button on hover' },
      { key: 'accentDim', label: 'Dim', hint: 'Low-opacity tint behind accent elements — selected row fills, badge backgrounds' },
      { key: 'accentTextOn', label: 'On-accent', hint: 'Text drawn on top of an accent-colored surface, e.g. inside a primary button' }
    ]
  },
  {
    label: 'Semantic',
    tokens: [
      { key: 'danger', label: 'Danger', hint: 'Error and destructive states — delete button text, error banners, failed indicators' },
      { key: 'dangerDim', label: 'Danger dim', hint: 'Background tint behind danger elements — error banner fill' },
      { key: 'warning', label: 'Warning', hint: 'Attention states — "waiting for input" dot, Bash tool badge, rate-limit notices' },
      { key: 'success', label: 'Success', hint: 'Positive indicators — task completed, build passed' },
      { key: 'info', label: 'Info', hint: 'Informational highlights — Read tool badge, info banners' }
    ]
  }
]
