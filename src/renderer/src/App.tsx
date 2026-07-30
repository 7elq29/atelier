import { useEffect, useMemo, useState } from 'react'
import CommandPalette, { type PaletteItem } from './components/CommandPalette'
import OnboardingWizard from './components/OnboardingWizard'
import Sidebar, { type PlaceholderSession } from './components/Sidebar'
import SettingsPanel from './components/SettingsPanel'
import { useConfig } from './hooks/useConfig'

// TODO: replace with the real session list once 02-session-lifecycle exists.
// This single placeholder entry exists so the command palette / sidebar
// selection / focus-jump mechanism has something real to operate against.
const PLACEHOLDER_SESSIONS: PlaceholderSession[] = [{ id: 'welcome', name: 'Welcome session' }]

function resolveEffectiveTheme(theme: 'system' | 'light' | 'dark'): 'light' | 'dark' {
  if (theme !== 'system') return theme
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * App shell + global nav/settings chrome for 08-global-nav-and-settings.
 * There's no real session/chat UI yet (that starts in 03-chat-surface-core),
 * so the sidebar's session list is a single placeholder entry — everything
 * else (command palette, collapsed rail, settings, onboarding, notifications)
 * is fully real.
 */
export default function App(): JSX.Element {
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const { config, loaded, updateConfig } = useConfig()

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  useEffect(() => {
    window.gardenia
      .getAppVersion()
      .then((version) => {
        setAppVersion(version)
        window.gardenia.log('info', 'renderer received app version via IPC', { version })
      })
      .catch((err) => {
        window.gardenia.log('error', 'failed to fetch app version via IPC', {
          error: err instanceof Error ? err.message : String(err)
        })
      })
  }, [])

  // Theme: really flips `data-theme` on <html> — this is the one source of
  // truth every CSS custom property in tokens.css keys off of.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolveEffectiveTheme(config.theme))
  }, [config.theme])

  // Three independent font-size CSS custom properties, each in its own
  // effect keyed on its own config field only — changing one can never touch
  // the others, by construction (not just by convention).
  useEffect(() => {
    document.documentElement.style.setProperty('--font-terminal-size', `${config.fontSizes.terminal}px`)
  }, [config.fontSizes.terminal])
  useEffect(() => {
    document.documentElement.style.setProperty('--font-interface-size', `${config.fontSizes.interface}px`)
  }, [config.fontSizes.interface])
  useEffect(() => {
    document.documentElement.style.setProperty('--font-agent-message-size', `${config.fontSizes.agentMessage}px`)
  }, [config.fontSizes.agentMessage])

  // Keyboard-only trigger for the command palette + a global Escape to close
  // whichever overlay is open.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  function selectSession(id: string): void {
    setActiveSessionId(id)
  }

  // "Focus jumped to that session": move real DOM focus to the row, not just
  // a CSS highlight — provable from Playwright via document.activeElement.
  useEffect(() => {
    if (!activeSessionId) return
    const row = document.querySelector<HTMLElement>(
      `[data-testid="session-row"][data-session-id="${activeSessionId}"]`
    )
    row?.focus()
  }, [activeSessionId])

  const paletteItems: PaletteItem[] = useMemo(
    () => [
      {
        id: 'toggle-theme',
        label: 'Toggle theme',
        category: 'Action',
        run: () => {
          const effective = resolveEffectiveTheme(config.theme)
          updateConfig({ theme: effective === 'dark' ? 'light' : 'dark' })
        }
      },
      {
        id: 'open-settings',
        label: 'Open Settings',
        category: 'Action',
        run: () => setSettingsOpen(true)
      },
      {
        id: 'toggle-sidebar-collapse',
        label: 'Toggle sidebar collapse',
        category: 'Action',
        run: () => updateConfig({ sidebarCollapsed: !config.sidebarCollapsed })
      },
      ...PLACEHOLDER_SESSIONS.map((session) => ({
        id: `session-${session.id}`,
        label: session.name,
        category: 'Session',
        // TODO: replace this stub jump with real session-panel navigation once
        // 02-session-lifecycle / 03-chat-surface-core exist — for now it just
        // proves the palette -> selection -> focus mechanism end-to-end.
        run: () => selectSession(session.id)
      }))
    ],
    [config.theme, config.sidebarCollapsed]
  )

  function handleOnboardingFinish(identity: { name: string; email: string }): void {
    updateConfig({ onboardingCompleted: true, gitIdentity: identity })
  }

  function handleOnboardingSkip(): void {
    updateConfig({ onboardingCompleted: true })
  }

  const activeSession = PLACEHOLDER_SESSIONS.find((s) => s.id === activeSessionId) ?? null
  const showOnboarding = loaded && !config.onboardingCompleted

  return (
    <div className="app-root">
      <div id="app" className="app-body">
        <Sidebar
          collapsed={config.sidebarCollapsed}
          onToggleCollapse={() => updateConfig({ sidebarCollapsed: !config.sidebarCollapsed })}
          sessions={PLACEHOLDER_SESSIONS}
          activeSessionId={activeSessionId}
          onSelectSession={selectSession}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <div className="main-area">
          <div className="topbar">
            <span className="title">{activeSession ? activeSession.name : 'Gardenia'}</span>
          </div>
          <div className="empty-main" data-testid="main-empty-state">
            <div>{activeSession ? `Viewing: ${activeSession.name}` : 'No session selected'}</div>
            <div className="preview-stack">
              <div className="preview-block" data-testid="interface-preview">
                Interface text preview
              </div>
              <div className="preview-block agent-message-preview" data-testid="agent-message-preview">
                Agent message preview — this is what assistant replies will look like.
              </div>
              <div className="preview-block terminal-preview" data-testid="terminal-preview">
                $ echo &quot;terminal preview&quot;
              </div>
            </div>
          </div>
          <div className="app-shell__debug" data-testid="debug-corner">
            <span className="label-caps">version</span>{' '}
            <span data-testid="app-version">{appVersion ?? 'loading…'}</span>
          </div>
        </div>
      </div>

      <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems} />

      <SettingsPanel
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={config}
        onUpdate={updateConfig}
        onReplayOnboarding={() => {
          setSettingsOpen(false)
          updateConfig({ onboardingCompleted: false })
        }}
      />

      <OnboardingWizard
        isOpen={showOnboarding}
        initialGitIdentity={config.gitIdentity}
        onFinish={handleOnboardingFinish}
        onSkip={handleOnboardingSkip}
      />
    </div>
  )
}
