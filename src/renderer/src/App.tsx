import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import CommandPalette, { type PaletteItem } from './components/CommandPalette'
import OnboardingWizard from './components/OnboardingWizard'
import Sidebar from './components/Sidebar'
import NewSessionModal from './components/NewSessionModal'
import SettingsPanel from './components/SettingsPanel'
import DailyNotesSidebar from './components/daily-notes/DailyNotesSidebar'
import ChatTranscript from './components/chat/ChatTranscript'
import TranscriptSearchBar from './components/chat/TranscriptSearchBar'
import Composer, { type ComposerHandle } from './components/chat/Composer'
import TrackerRail from './components/chat/TrackerRail'
import ExportMenu from './components/chat/ExportMenu'
import TabBar, { type SessionTab } from './components/panels/TabBar'
import DiffPanel from './components/panels/DiffPanel'
import FilesPanel from './components/panels/FilesPanel'
import PortsPanel from './components/panels/PortsPanel'
import TerminalPanel from './components/panels/TerminalPanel'
import CompanionTerminalDrawer from './components/panels/CompanionTerminalDrawer'
import { useConfig } from './hooks/useConfig'
import { useSessions } from './hooks/useSessions'
import type { ImageAttachment, MessageSearchHit, ModelSelection, SessionRecord } from '../../shared/session-types'
import { FTS_SNIPPET_START, FTS_SNIPPET_END } from '../../shared/chat-content'

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
  const [date, setDate] = useState<string | null>(null)
  const { config, loaded, updateConfig } = useConfig()
  const sessions = useSessions()

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const composerRef = useRef<ComposerHandle>(null)
  // Defaults to Sonnet 5 (explicit override, always sent) rather than `null`
  // (no override, harness/SDK picks its own default) — the app's default
  // model must be Sonnet 5 even when the user never touches the composer's
  // picker, including in e2e tests that never interact with it.
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>({
    model: 'claude-sonnet-5',
    effort: 'high'
  })
  const [activeTab, setActiveTab] = useState<SessionTab>('chat')
  const [visitedTabs, setVisitedTabs] = useState<Set<SessionTab>>(new Set(['chat']))
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerHeight, setDrawerHeight] = useState(240)
  /** Messages queued while the active session was busy (message-queue). Drained FIFO when busy → idle. */
  const [queuedMessages, setQueuedMessages] = useState<string[]>([])

  // Terminal keep-alive: maps ptyId → {cwd, hostname} for terminal-mode sessions
  // that have been visited. These TerminalPanels stay mounted permanently (only CSS
  // visibility changes on switch) so xterm + the tmux pty client are never torn down
  // and re-created between session switches.
  const [aliveTerminals, setAliveTerminals] = useState<Map<string, { cwd: string; hostname: string | null | undefined }>>(new Map())

  // Tab-terminal keep-alive: same idea for claude-code sessions' terminal tab.
  // Keyed by ptyId (`${sessionId}:tab-terminal`). Since the tab-bar lives inside
  // the 56px topbar (above the content wrapper), these entries use the same
  // terminal-cache-layer with top:0 and appear correctly below the tab-bar.
  const [aliveTabTerminals, setAliveTabTerminals] = useState<Map<string, { cwd: string; hostname: string | null | undefined }>>(new Map())

  // ── In-conversation "Find in conversation" (10b-enrichment-full-text-search) ──
  const [transcriptSearchOpen, setTranscriptSearchOpen] = useState(false)
  const [transcriptSearchQuery, setTranscriptSearchQuery] = useState('')
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  const [matchCount, setMatchCount] = useState(0)
  // Cross-session content-search palette jump target (10b-enrichment-full-
  // text-search): set when a content-match palette item runs, consumed by
  // the effect below once that message's row actually exists in the DOM
  // (which may be a render or two after `selectSession` resolves).
  const [pendingJumpMessageId, setPendingJumpMessageId] = useState<number | null>(null)

  useEffect(() => {
    window.atelier.getDefaultDate().then(setDate)
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
  // whichever overlay is open. CommandPalette also closes itself on Escape
  // via its own input's onKeyDown (its input auto-focuses on open), but
  // Settings and New Session don't auto-focus anything inside themselves —
  // focus stays on whatever sidebar button opened them — so an
  // Escape-closes-modal handler scoped to those dialogs never actually saw
  // the keydown. Closing all three here, globally, fixes that without
  // depending on where focus happens to be.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.altKey && e.code === 'KeyX') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (e.key === 'Escape') {
        // Modal-close always takes priority over interrupt — if any overlay
        // is open, close it and don't also fire the interrupt path.
        if (anyModalOpenRef.current) {
          setPaletteOpen(false)
          setSettingsOpen(false)
          setNewSessionOpen(false)
          return
        }
        // No overlay open: if the active session is busy, ESC interrupts it
        // (same action as clicking Stop) and restores the last-submitted text
        // back to the composer — matching Claude Code CLI's ESC behaviour.
        const sid = activeSessionIdRef.current
        if (sid && busyBySessionRef.current[sid]) {
          void sessions.interrupt(sid)
          if (lastSubmittedTextRef.current) {
            composerRef.current?.setValue(lastSubmittedTextRef.current)
          }
          return
        }
        // Idle session or no session: still close any modals that happen to
        // be open (redundant when anyModalOpen is false, but harmless).
        setPaletteOpen(false)
        setSettingsOpen(false)
        setNewSessionOpen(false)
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
    setActiveTab('chat')
    setVisitedTabs(new Set(['chat']))
    setDrawerOpen(false)
    // restore-mode-and-model-on-resume: restores the persisted model selection
    // so the composer's picker reflects what this session was last using,
    // not whatever the previously-active session had set. Falls back to the
    // app default (Sonnet 5 / high) for sessions that were never sent a
    // message with an explicit model override.
    setModelSelection(session.modelSelection ?? { model: 'claude-sonnet-5', effort: 'high' })
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

  function selectTab(tab: SessionTab): void {
    setActiveTab(tab)
    setVisitedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)))
  }

  // Switching sessions always closes/clears the in-conversation search bar —
  // matches (and their indices) are only meaningful for the transcript
  // they were found in (10b-enrichment-full-text-search).
  useEffect(() => {
    setTranscriptSearchOpen(false)
    setTranscriptSearchQuery('')
    setActiveMatchIndex(0)
    setMatchCount(0)
    // Also discard any queued messages — they were for the previous session.
    setQueuedMessages([])
  }, [activeSessionId])

  // Register terminal-mode sessions in the keep-alive map the first time they
  // become active. After registration the TerminalPanel never unmounts, so
  // switching away and back is a CSS visibility toggle with no pty re-spawn.
  const activeSession = activeSessionId
    ? allSessions.find((s) => s.id === activeSessionId) ?? null
    : null
  useEffect(() => {
    if (!activeSession || activeSession.mode !== 'terminal') return
    setAliveTerminals((prev) => {
      if (prev.has(activeSession.id)) return prev
      const next = new Map(prev)
      next.set(activeSession.id, { cwd: activeSession.projectPath, hostname: activeSession.hostname })
      return next
    })
  }, [activeSession?.id, activeSession?.mode])

  // Register claude-code tab-terminal sessions the first time the terminal tab
  // is visited. The TerminalPanel stays mounted in the cache layer so switching
  // between sessions never detaches the tmux client.
  useEffect(() => {
    if (!activeSession || activeSession.mode !== 'claude-code') return
    if (activeTab !== 'terminal') return
    const ptyId = `${activeSession.id}:tab-terminal`
    setAliveTabTerminals((prev) => {
      if (prev.has(ptyId)) return prev
      const next = new Map(prev)
      next.set(ptyId, { cwd: activeSession.worktreePath ?? activeSession.projectPath, hostname: activeSession.hostname })
      return next
    })
  }, [activeSession?.id, activeSession?.mode, activeTab])

  function toggleTranscriptSearch(): void {
    setTranscriptSearchOpen((open) => {
      const next = !open
      if (!next) {
        setTranscriptSearchQuery('')
        setActiveMatchIndex(0)
      }
      return next
    })
  }

  function handleTranscriptSearchQueryChange(query: string): void {
    setTranscriptSearchQuery(query)
    setActiveMatchIndex(0)
  }

  function navigateTranscriptMatches(direction: 1 | -1): void {
    setActiveMatchIndex((i) => {
      if (matchCount === 0) return 0
      return (i + direction + matchCount) % matchCount
    })
  }

  // Cross-session content-search jump (10b-enrichment-full-text-search):
  // opens (or switches to) `sessionId`'s transcript, then requests a
  // scroll+flash on `messageId` once its row is actually rendered.
  async function jumpToMessage(session: SessionRecord, messageId: number): Promise<void> {
    await selectSession(session)
    setPendingJumpMessageId(messageId)
  }

  // Consumes `pendingJumpMessageId` the moment the target row exists in the
  // real DOM: real `scrollIntoView` (not a mocked scroll) plus a brief
  // `.msg-jump-highlight` flash so the destination is visually obvious.
  const activeMessagesForJump = activeSessionId ? sessions.messagesBySession[activeSessionId] ?? [] : []
  useEffect(() => {
    if (pendingJumpMessageId == null) return
    const el = document.querySelector<HTMLElement>(`[data-testid="transcript-message"][data-message-id="${pendingJumpMessageId}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.classList.add('msg-jump-highlight')
    const timer = setTimeout(() => el.classList.remove('msg-jump-highlight'), 1600)
    setPendingJumpMessageId(null)
    return () => clearTimeout(timer)
  }, [pendingJumpMessageId, activeMessagesForJump.length])

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

  // Cross-session content search (10b-enrichment-full-text-search): the
  // command palette's "Session" results extended to also match message
  // *content*, not just session name (the mock only ever defined name
  // matching — see CommandPalette.tsx's doc comment for why this reuses the
  // exact same `cp-item` row rather than adding a new palette page/modal).
  // Backed by `window.atelier.searchMessages` -> SQLite FTS5. Stripped of
  // its `FTS_SNIPPET_START/END` markers here since `PaletteItem.label` is
  // plain text, not markup.
  async function searchSessionContent(query: string): Promise<PaletteItem[]> {
    const hits: MessageSearchHit[] = await window.atelier.searchMessages(query)
    return hits
      .map((hit): PaletteItem | null => {
        const session = allSessions.find((s) => s.id === hit.sessionId)
        if (!session) return null
        const snippet = hit.snippet.split(FTS_SNIPPET_START).join('').split(FTS_SNIPPET_END).join('')
        return {
          id: `session-content-${hit.sessionId}-${hit.messageId}`,
          label: `${snippet} — in ${hit.sessionName}`,
          category: 'Session',
          run: () => void jumpToMessage(session, hit.messageId)
        }
      })
      .filter((item): item is PaletteItem => item !== null)
  }

  function handleOnboardingFinish(identity: { name: string; email: string }): void {
    updateConfig({ onboardingCompleted: true, gitIdentity: identity })
  }

  function handleOnboardingSkip(): void {
    updateConfig({ onboardingCompleted: true })
  }

  async function handleSend(text: string, image?: ImageAttachment): Promise<void> {
    if (!activeSessionId || (!text.trim() && !image)) return
    const busy = sessions.busyBySession[activeSessionId] ?? false
    if (busy && !image) {
      // Session is in flight — queue the message for automatic dispatch when
      // the current turn completes. Image attachments can't be queued (the
      // queued-strip only shows text), so they fall through to the normal path.
      setQueuedMessages((prev) => [...prev, text.trim()])
      return
    }
    // Save the trimmed text BEFORE the composer clears — if the user presses
    // ESC while the turn is running, the global handler can restore it.
    lastSubmittedTextRef.current = text.trim()
    await sessions.sendMessage(activeSessionId, text.trim(), modelSelection ?? undefined, image)
  }

  async function handleInterrupt(): Promise<void> {
    if (!activeSessionId) return
    await sessions.interrupt(activeSessionId)
  }

  // Drain the message queue when the active session transitions busy → idle
  // (message-queue). Fires whenever busyBySession changes (i.e. any session
  // flips). Reads queuedMessages from the render closure — React re-renders
  // before running effects, so the value is always up-to-date at fire time.
  useEffect(() => {
    if (!activeSessionId) return
    const busy = sessions.busyBySession[activeSessionId] ?? false
    if (!busy && queuedMessages.length > 0) {
      const [next, ...rest] = queuedMessages
      setQueuedMessages(rest)
      void sessions.sendMessage(activeSessionId, next, modelSelection ?? undefined)
    }
  }, [sessions.busyBySession, activeSessionId])

  async function handleExport(format: 'markdown' | 'json'): Promise<void> {
    if (!activeSessionId) return
    await sessions.exportTranscript(activeSessionId, format)
  }

  const activeMessages = activeSessionId ? sessions.messagesBySession[activeSessionId] ?? [] : []
  const showOnboarding = loaded && !config.onboardingCompleted

  // Every overlay in this app (Onboarding, Command Palette, Settings, New
  // Session) is a `.modal-backdrop`/`.modal-dialog` rendered as a *sibling*
  // of `#app`, not an ancestor — so none of them naturally contain focus.
  // None of them install a focus trap either, which meant Tab could escape
  // any open modal into the sidebar/topbar underneath (still visually
  // dimmed, but fully live), and pressing Enter on a focused background
  // button would actually activate it — e.g. opening a second modal on top
  // of the first, or (worst case) escaping the mandatory first-run
  // onboarding gate entirely via keyboard. Confirmed via manual Playwright
  // probes for all four overlays before this fix.
  //
  // Rather than build a bespoke focus trap per dialog, `#app` (sidebar +
  // main area — the entire surface every overlay sits in front of) is made
  // genuinely unfocusable/unclickable via the `inert` DOM attribute whenever
  // any overlay is open. React 18's JSX typings don't know `inert`, so it's
  // set imperatively via a ref.
  const anyModalOpen = showOnboarding || paletteOpen || settingsOpen || newSessionOpen
  const appBodyRef = useRef<HTMLDivElement>(null)

  // Refs used inside the stable global ESC keydown handler (registered once
  // with [] deps) to read current render-cycle values without re-registering
  // the listener on every render.
  const activeSessionIdRef = useRef<string | null>(null)
  activeSessionIdRef.current = activeSessionId
  const busyBySessionRef = useRef<Record<string, boolean>>({})
  busyBySessionRef.current = sessions.busyBySession
  const anyModalOpenRef = useRef(false)
  anyModalOpenRef.current = anyModalOpen
  /**
   * Text of the most recently submitted message — saved in `handleSend`
   * before `composerText` is cleared, so an ESC press during a busy turn
   * can restore it to the composer (matching Claude Code CLI's behaviour:
   * ESC while the turn is running both interrupts AND returns the prompt).
   * Only meaningful while the session is busy; the value doesn't need to
   * be cleared on turn completion because the interrupt branch only runs
   * when `busyBySession[sid]` is true.
   */
  const lastSubmittedTextRef = useRef('')
  // A layout effect, not a plain effect: it must remove `inert` *before* the
  // "focus jumped to that session" effect below (declared earlier, but a
  // passive effect) tries to call `.focus()` on a session row — a `.focus()`
  // call on an element still inside an inert container is a no-op, which
  // broke the command palette's "Enter jumps focus to that session" behavior
  // when closing the palette and jumping sessions in the same tick.
  useLayoutEffect(() => {
    const el = appBodyRef.current
    if (!el) return
    if (anyModalOpen) {
      el.setAttribute('inert', '')
    } else {
      el.removeAttribute('inert')
    }
  }, [anyModalOpen])

  return (
    <div className="app-root">
      <div id="app" className="app-body" ref={appBodyRef}>
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
            // Remove from keep-alive caches so TerminalPanels unmount and ptyKill runs.
            setAliveTerminals((prev) => {
              if (!prev.has(id)) return prev
              const next = new Map(prev)
              next.delete(id)
              return next
            })
            setAliveTabTerminals((prev) => {
              const ptyId = `${id}:tab-terminal`
              if (!prev.has(ptyId)) return prev
              const next = new Map(prev)
              next.delete(ptyId)
              return next
            })
            // Kill the tmux server sessions for all pty variants of this
            // Atelier session (terminal-only, tab terminal, companion drawer).
            // No-op if tmux is not installed or the sessions never existed.
            void window.atelier.ptyKillTmuxSession(id)
            void window.atelier.ptyKillTmuxSession(`${id}:tab-terminal`)
            void window.atelier.ptyKillTmuxSession(`${id}:companion`)
          }}
          onFork={(id) => void sessions.forkSession(id).then((forked) => setActiveSessionId(forked.id))}
          onRestart={(id) => void sessions.restartSession(id).then((forked) => setActiveSessionId(forked.id))}
          groups={sessions.groups}
          statuses={sessions.statuses}
          staleSessionIds={sessions.staleSessionIds}
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
          worktreeProgressBySession={sessions.worktreeProgressBySession}
        />

        <div className="main-area">
          <div className="topbar">
            <span className="title" data-testid="main-title">
              {activeSession ? activeSession.name : 'Atelier'}
            </span>
            {activeSession && activeSession.mode === 'claude-code' && (
              <>
                <TabBar activeTab={activeTab} onSelect={selectTab} showPorts={Boolean(activeSession.hostname)} />
                <div className="topbar-spacer" />
                {sessions.statuses[activeSession.id] === 'connecting' && (
                  <span className="topbar-chip connecting-pill" data-testid="connecting-pill">
                    <span className="spinner" />
                    Connecting…
                  </span>
                )}
                <span className="topbar-chip" data-testid="cost-chip">
                  ${activeSession.totalCostUsd.toFixed(2)}
                </span>
                <ExportMenu onExport={(format) => void handleExport(format)} />
                <TranscriptSearchBar
                  open={transcriptSearchOpen}
                  query={transcriptSearchQuery}
                  matchCount={matchCount}
                  onQueryChange={handleTranscriptSearchQueryChange}
                  onNavigate={navigateTranscriptMatches}
                  onToggle={toggleTranscriptSearch}
                  onClose={toggleTranscriptSearch}
                />
                <button className="btn btn-sm" data-testid="toggle-companion-drawer" onClick={() => setDrawerOpen((o) => !o)}>
                  ▤ Terminal
                </button>
              </>
            )}
          </div>

          {/* Content area below topbar — position:relative anchors the terminal keep-alive layer */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
            {/* Terminal keep-alive layer: terminal-mode AND tab-terminal sessions stay
                mounted here permanently. Switching sessions only toggles CSS visibility —
                no xterm dispose/recreate, no tmux detach/reattach. Tab-bar lives inside
                the 56px topbar above this wrapper, so top:0 here is already below it. */}
            {(aliveTerminals.size > 0 || aliveTabTerminals.size > 0) && (
              <div className="terminal-cache-layer">
                {[...aliveTerminals.entries()].map(([ptyId, info]) => {
                  const isActive = activeSession?.mode === 'terminal' && activeSession.id === ptyId
                  return (
                    <div key={ptyId} className={`terminal-cache-entry${isActive ? ' active' : ''}`}>
                      <TerminalPanel ptyId={ptyId} cwd={info.cwd} hostname={info.hostname} active={isActive} />
                    </div>
                  )
                })}
                {[...aliveTabTerminals.entries()].map(([ptyId, info]) => {
                  const sessionId = ptyId.replace(/:tab-terminal$/, '')
                  const isActive = activeSession?.mode === 'claude-code' && activeSession.id === sessionId && activeTab === 'terminal'
                  return (
                    <div key={ptyId} className={`terminal-cache-entry${isActive ? ' active' : ''}`}>
                      <TerminalPanel ptyId={ptyId} cwd={info.cwd} hostname={info.hostname} active={isActive} />
                    </div>
                  )
                })}
              </div>
            )}

          {activeSession ? (
            activeSession.mode === 'terminal' ? (
              // TerminalPanel lives in the keep-alive layer above. This placeholder
              // keeps the layout slot and provides the testid for e2e tests.
              <div style={{ flex: 1 }} data-testid="terminal-only-session" />
            ) : (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                  <div className={`tab-content${activeTab === 'chat' ? '' : ' hidden'}`} data-tab="chat">
                    <div className="chat-tab-wrap" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                      <div className="chat-body-row">
                        <div className="chat-main-col">
                          <ChatTranscript
                            messages={activeMessages}
                            onRespond={(requestId, decision) => void sessions.respondToPrompt(activeSession.id, requestId, decision)}
                            searchQuery={transcriptSearchOpen ? transcriptSearchQuery : ''}
                            activeMatchIndex={activeMatchIndex}
                            onMatchCount={setMatchCount}
                          />
                        </div>
                        <TrackerRail messages={activeMessages} />
                      </div>
                      {activeSession.mode === 'claude-code' && (
                        <Composer
                          ref={composerRef}
                          onSend={(text, image) => void handleSend(text, image)}
                          onInterrupt={() => void handleInterrupt()}
                          busy={sessions.busyBySession[activeSession.id] ?? false}
                          projectPath={activeSession.projectPath}
                          worktreePath={activeSession.worktreePath}
                          hostname={activeSession.hostname}
                          onFork={() => void sessions.forkSession(activeSession.id).then((forked) => setActiveSessionId(forked.id))}
                          modelSelection={modelSelection}
                          onModelSelectionChange={(selection) => {
                            setModelSelection(selection)
                            if (activeSessionId && selection) {
                              void window.atelier.setSessionModelSelection(activeSessionId, selection)
                            }
                          }}
                          liveSlashCommands={sessions.commandsBySession[activeSession.id] ?? []}
                          mode={activeSession.permissionMode}
                          onCycleMode={() => void sessions.cycleMode(activeSession.id)}
                          queuedMessages={queuedMessages}
                          onCancelQueued={(index) => setQueuedMessages((prev) => prev.filter((_, i) => i !== index))}
                          tokenUsage={sessions.tokenUsageBySession[activeSession.id]}
                          onAddLocalMessage={(content) => sessions.addLocalMessage(activeSession.id, content)}
                          onValidateModel={(model) => sessions.validateModel(activeSession.id, model)}
                        />
                      )}
                    </div>
                  </div>

                  <div className={`tab-content${activeTab === 'diff' ? '' : ' hidden'}`} data-tab="diff">
                    {visitedTabs.has('diff') && (
                      <DiffPanel
                        projectPath={activeSession.projectPath}
                        hostname={activeSession.hostname}
                        onAddComment={(note) => {
                          const prev = composerRef.current?.getValue() ?? ''
                          composerRef.current?.setValue(prev ? `${prev}\n\n${note}` : note)
                        }}
                      />
                    )}
                  </div>

                  <div className={`tab-content${activeTab === 'files' ? '' : ' hidden'}`} data-tab="files">
                    {visitedTabs.has('files') && (
                      <FilesPanel
                        projectPath={activeSession.worktreePath ?? activeSession.projectPath}
                        hostname={activeSession.hostname}
                      />
                    )}
                  </div>

                  <div className={`tab-content${activeTab === 'terminal' ? '' : ' hidden'}`} data-tab="terminal">
                    {/* TerminalPanel lives in the terminal-cache-layer above this session subtree.
                        This empty div keeps the tab layout slot; the cache entry overlays it. */}
                  </div>

                  {Boolean(activeSession.hostname) && (
                    <div className={`tab-content${activeTab === 'ports' ? '' : ' hidden'}`} data-tab="ports">
                      {visitedTabs.has('ports') && (
                        <PortsPanel sessionId={activeSession.id} sshHost={activeSession.hostname as string} />
                      )}
                    </div>
                  )}
                </div>

                {drawerOpen && (
                  <CompanionTerminalDrawer
                    sessionId={activeSession.id}
                    cwd={activeSession.worktreePath ?? activeSession.projectPath}
                    hostname={activeSession.hostname}
                    height={drawerHeight}
                    onHeightChange={setDrawerHeight}
                    onClose={() => setDrawerOpen(false)}
                  />
                )}
              </div>
            )
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
          </div>
        </div>

        {date && <DailyNotesSidebar date={date} onClose={() => setDate(null)} vaultRoot={config.vault.root || undefined} />}
      </div>

      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
        searchContent={searchSessionContent}
      />

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
