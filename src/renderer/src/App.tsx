import { useEffect, useMemo, useState } from 'react'
import CommandPalette, { type PaletteItem } from './components/CommandPalette'
import OnboardingWizard from './components/OnboardingWizard'
import Sidebar from './components/Sidebar'
import NewSessionModal from './components/NewSessionModal'
import SettingsPanel from './components/SettingsPanel'
import DailyNotesSidebar from './components/daily-notes/DailyNotesSidebar'
import ChatTranscript from './components/chat/ChatTranscript'
import Composer from './components/chat/Composer'
import TrackerRail from './components/chat/TrackerRail'
import { useConfig } from './hooks/useConfig'
import { useSessions } from './hooks/useSessions'
import type { SessionRecord } from '../../shared/session-types'

function resolveEffectiveTheme(theme: 'system' | 'light' | 'dark'): 'light' | 'dark' {
  if (theme !== 'system') return theme
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * App shell + global nav/settings chrome (08) with the real session
 * lifecycle (02-session-lifecycle) wired in: sidebar backed by SQLite via
 * useSessions(), New Session flow (local + remote/devpod), a minimal
 * transcript + composer so create/resume/fork can be verified end-to-end,
 * plus the Daily Notes / Obsidian-integration sidebar (09) docked to the
 * right of the main area.
 */
export default function App(): JSX.Element {
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [date, setDate] = useState<string | null>(null)
  const { config, loaded, updateConfig } = useConfig()
  const sessions = useSessions()

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [composerText, setComposerText] = useState('')

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

    window.gardenia.getDefaultDate().then(setDate)
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

  const allSessions = useMemo(
    () => [...sessions.activeSessions, ...sessions.historySessions],
    [sessions.activeSessions, sessions.historySessions]
  )

  async function selectSession(session: SessionRecord): Promise<void> {
    setActiveSessionId(session.id)
    // Two independent reasons to call resumeSession (reopen + reconnect +
    // fetch transcript), not just one:
    //  - session.closedAt: an explicitly-closed session must always reopen
    //    and reconnect its live harness connection, even if its transcript
    //    happens to already be cached client-side from before it was closed.
    //  - !messagesBySession[id]: an "active" session's transcript only ever
    //    lived in this renderer's in-memory state, which resets on every app
    //    relaunch — without this, reopening a session that was never
    //    explicitly closed (the common case after just quitting and
    //    restarting the app) showed an empty transcript despite the real
    //    messages being intact in SQLite.
    if (session.closedAt || !sessions.messagesBySession[session.id]) {
      await sessions.resumeSession(session.id)
    }
  }

  // "Focus jumped to that session": move real DOM focus to the row, not just
  // a CSS highlight — provable from Playwright via document.activeElement.
  useEffect(() => {
    if (!activeSessionId) return
    const row = document.querySelector<HTMLElement>(
      `[data-testid="session-row"][data-session-id="${activeSessionId}"]`
    )
    row?.focus()
  }, [activeSessionId, allSessions.length])

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
      {
        id: 'new-session',
        label: 'New Session',
        category: 'Action',
        run: () => setNewSessionOpen(true)
      },
      ...allSessions.map((session) => ({
        id: `session-${session.id}`,
        label: session.name,
        category: 'Session',
        run: () => void selectSession(session)
      }))
    ],
    [config.theme, config.sidebarCollapsed, allSessions]
  )

  function handleOnboardingFinish(identity: { name: string; email: string }): void {
    updateConfig({ onboardingCompleted: true, gitIdentity: identity })
  }

  function handleOnboardingSkip(): void {
    updateConfig({ onboardingCompleted: true })
  }

  async function handleSend(text: string): Promise<void> {
    if (!activeSessionId || !text.trim()) return
    setComposerText('')
    await sessions.sendMessage(activeSessionId, text.trim())
  }

  async function handleInterrupt(): Promise<void> {
    if (!activeSessionId) return
    await sessions.interrupt(activeSessionId)
  }

  const activeSession = allSessions.find((s) => s.id === activeSessionId) ?? null
  const activeMessages = activeSessionId ? sessions.messagesBySession[activeSessionId] ?? [] : []
  const showOnboarding = loaded && !config.onboardingCompleted

  return (
    <div className="app-root">
      <div id="app" className="app-body">
        <Sidebar
          collapsed={config.sidebarCollapsed}
          onToggleCollapse={() => updateConfig({ sidebarCollapsed: !config.sidebarCollapsed })}
          activeSessions={sessions.activeSessions}
          historySessions={sessions.historySessions}
          activeSessionId={activeSessionId}
          onSelectSession={(s) => void selectSession(s)}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onNewSession={() => setNewSessionOpen(true)}
          onRename={(id, name) => void sessions.renameSession(id, name)}
          onTogglePin={(id, pinned) => void sessions.setPinned(id, pinned)}
          onClose={(id) => {
            if (activeSessionId === id) setActiveSessionId(null)
            void sessions.closeSession(id)
          }}
          onDelete={(id) => {
            if (activeSessionId === id) setActiveSessionId(null)
            void sessions.deleteSession(id)
          }}
          onFork={(id) => void sessions.forkSession(id).then((forked) => setActiveSessionId(forked.id))}
          onRestart={(id) => void sessions.restartSession(id).then((forked) => setActiveSessionId(forked.id))}
          groups={sessions.groups}
          statuses={sessions.statuses}
          messagesBySession={sessions.messagesBySession}
          onSetColor={(id, color) => void sessions.setColor(id, color)}
          onSetNotes={(id, notes) => void sessions.setNotes(id, notes)}
          onAddTag={(id, tag) => void sessions.addTag(id, tag)}
          onRemoveTag={(id, tag) => void sessions.removeTag(id, tag)}
          onReorderSessions={(groupId, orderedIds) => void sessions.reorderSessions(groupId, orderedIds)}
          onCreateGroup={(name) => void sessions.createGroup(name)}
          onRenameGroup={(id, name) => void sessions.renameGroup(id, name)}
          onSetGroupCollapsed={(id, collapsed) => void sessions.setGroupCollapsed(id, collapsed)}
          onDeleteGroup={(id) => void sessions.deleteGroup(id)}
          onReorderGroups={(orderedIds) => void sessions.reorderGroups(orderedIds)}
        />

        <div className="main-area">
          <div className="topbar">
            <span className="title" data-testid="main-title">
              {activeSession ? activeSession.name : 'Gardenia'}
            </span>
          </div>

          {activeSession ? (
            <div className="chat-tab-wrap" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div className="chat-body-row">
                <div className="chat-main-col">
                  <ChatTranscript messages={activeMessages} />
                  {activeSession.mode === 'claude-code' && (
                    <Composer
                      value={composerText}
                      onChange={setComposerText}
                      onSend={(text) => void handleSend(text)}
                      onInterrupt={() => void handleInterrupt()}
                      busy={sessions.busyBySession[activeSession.id] ?? false}
                    />
                  )}
                </div>
                <TrackerRail messages={activeMessages} />
              </div>
            </div>
          ) : (
            <div className="empty-main" data-testid="main-empty-state">
              <div>No session selected</div>
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
          )}

          <div className="app-shell__debug" data-testid="debug-corner">
            <span className="label-caps">version</span> <span data-testid="app-version">{appVersion ?? 'loading…'}</span>
          </div>
        </div>

        {date && <DailyNotesSidebar date={date} />}
      </div>

      <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems} />

      <NewSessionModal
        isOpen={newSessionOpen}
        hosts={sessions.hosts}
        onClose={() => setNewSessionOpen(false)}
        onCreate={async (opts) => {
          const created = await sessions.createSession(opts)
          setActiveSessionId(created.id)
        }}
      />

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
