import { memo } from 'react'
import type { AtelierConfig } from '../../../../shared/config'
import type { SessionRecord } from '../../../../shared/session-types'
import type { SessionWorkspacePayload } from '../../../../shared/session-workspace-types'
import { resolveSessionProfileFileTree } from '../../../../shared/session-profile-resolve'
import DiffPanel from '../panels/DiffPanel'
import FilesPanel from '../panels/FilesPanel'
import type { SessionTab } from '../panels/TabBar'
import {
  isSplitLayoutVisible,
  resolveTabVisibility,
  tabContentClass
} from '../../workspace-split/workspace-split-logic'
import { WorkspaceSplitPaneClose } from '../../workspace-split/WorkspaceSplitPaneClose'
import type { WorkspaceSplitState } from '../../workspace-split/workspace-split-types'

export const SessionWorkspacePanels = memo(function SessionWorkspacePanels({
  sessionIds,
  allSessions,
  workspaceBySession,
  sessionProfiles,
  activeSessionId,
  activeTab,
  workspaceSplit,
  onCloseSplitPane,
  onToggleMaximizePane,
  activeSessionDisconnected,
  sessionMainInForeground,
  effectiveTheme,
  revealChangePath,
  revealChangeSeq,
  revealCommitHash,
  revealCommitSeq,
  revealFilePath,
  revealFileSeq,
  revealFileDiffPath,
  revealFileDiffSeq,
  injectDiffBySession,
  onRevealChangeHandled,
  onRevealCommitHandled,
  onRevealFileHandled,
  onRevealFileDiffHandled,
  onAddComment,
  onOpenFileQuickOpen,
  onRefreshWorkspace,
  refreshingBySession
}: {
  sessionIds: string[]
  allSessions: SessionRecord[]
  workspaceBySession: Record<string, SessionWorkspacePayload>
  sessionProfiles: AtelierConfig['sessionProfiles']
  activeSessionId: string | null
  activeTab: SessionTab
  workspaceSplit: WorkspaceSplitState | null
  onCloseSplitPane: (tab: SessionTab) => void
  onToggleMaximizePane: (tab: SessionTab) => void
  activeSessionDisconnected: boolean
  /** False while a note/weekly-plan surface owns the main area — keeps the layer inert. */
  sessionMainInForeground: boolean
  effectiveTheme: 'light' | 'dark'
  revealChangePath?: string
  revealChangeSeq: number
  revealCommitHash?: string
  revealCommitSeq: number
  revealFilePath?: string
  revealFileSeq: number
  revealFileDiffPath?: string
  revealFileDiffSeq: number
  injectDiffBySession: Record<string, { file: import('../../../../shared/panel-types').DiffFileChange; seq: number }>
  onRevealChangeHandled: () => void
  onRevealCommitHandled: () => void
  onRevealFileHandled: () => void
  onRevealFileDiffHandled: () => void
  onAddComment: (text: string) => void
  onOpenFileQuickOpen: () => void
  onRefreshWorkspace: (sessionId: string) => void
  refreshingBySession: Record<string, boolean>
}): JSX.Element {
  return (
    <>
      {sessionIds.map((sessionId) => {
        const session = allSessions.find((s) => s.id === sessionId)
        const ws = workspaceBySession[sessionId]
        if (!session || session.mode !== 'claude-code') return null
        const panelsVisible =
          activeSessionId === sessionId && sessionMainInForeground && !activeSessionDisconnected
        const split = panelsVisible ? workspaceSplit : null
        const diffVisible = resolveTabVisibility('diff', activeTab, split)
        const filesVisible = resolveTabVisibility('files', activeTab, split)
        // The layer sits on top of the whole content area, so it may only take
        // pointer events while one of its own tabs is actually showing — either
        // as the selected tab or as a pane of the split.
        const entryActive = panelsVisible && (diffVisible !== 'hidden' || filesVisible !== 'hidden')
        // Diff/Files live in this layer rather than inside .session-workspace-tabs,
        // so the split geometry has to be mirrored here to stay aligned with the
        // chat pane that is still laid out over there.
        const entrySplit = isSplitLayoutVisible(split)
        const workspacePath = session.worktreePath ?? session.projectPath
        const profileFileTree = resolveSessionProfileFileTree(session, sessionProfiles ?? [])
        const inject = injectDiffBySession[sessionId]
        return (
          <div
            key={`workspace-panels-${sessionId}-${session.projectPath}`}
            className={`panel-cache-entry${entryActive ? ' active' : ''}${
              entrySplit && split ? ` panel-cache-entry--split panel-cache-entry--split-${split.direction}` : ''
            }`}
            style={
              entrySplit && split
                ? ({ '--workspace-split-ratio': split.splitRatio } as React.CSSProperties)
                : undefined
            }
            data-session-id={sessionId}
          >
            <div className={`${tabContentClass(diffVisible)} workspace-pane--tool`} data-tab="diff">
              <WorkspaceSplitPaneClose
                tab="diff"
                visibility={diffVisible}
                onClose={onCloseSplitPane}
                onToggleMaximize={onToggleMaximizePane}
                maximized={split?.fullscreenTab === 'diff'}
              />
              <DiffPanel
                workspacePath={workspacePath}
                repoRoot={session.projectPath}
                hostname={session.hostname}
                effectiveTheme={effectiveTheme}
                panelScopeKey={`${session.id}:${session.projectPath}`}
                active={panelsVisible && diffVisible !== 'hidden'}
                workspaceDiff={ws?.diff}
                workspaceRefreshing={Boolean(refreshingBySession[sessionId])}
                onRefreshWorkspace={() => onRefreshWorkspace(sessionId)}
                revealChangePath={panelsVisible ? revealChangePath : undefined}
                revealChangeSeq={panelsVisible ? revealChangeSeq : 0}
                injectDiffFile={panelsVisible ? inject?.file : undefined}
                injectDiffFileSeq={panelsVisible ? inject?.seq ?? 0 : 0}
                onRevealChangeHandled={onRevealChangeHandled}
                revealCommitHash={panelsVisible ? revealCommitHash : undefined}
                revealCommitSeq={panelsVisible ? revealCommitSeq : 0}
                onRevealCommitHandled={onRevealCommitHandled}
                onAddComment={onAddComment}
                rightPanel={
                  split?.direction === 'row' &&
                  !split.fullscreenTab &&
                  (diffVisible === 'split-primary' || diffVisible === 'split-secondary')
                }
              />
            </div>

            <div className={`${tabContentClass(filesVisible)} workspace-pane--tool`} data-tab="files">
              <WorkspaceSplitPaneClose
                tab="files"
                visibility={filesVisible}
                onClose={onCloseSplitPane}
                onToggleMaximize={onToggleMaximizePane}
                maximized={split?.fullscreenTab === 'files'}
              />
              <FilesPanel
                projectPath={workspacePath}
                sessionId={sessionId}
                hostname={session.hostname}
                effectiveTheme={effectiveTheme}
                active={panelsVisible && filesVisible !== 'hidden'}
                initialFilesTree={profileFileTree ? null : ws?.filesTree}
                profileBar={
                  profileFileTree
                    ? {
                        name: profileFileTree.profileName,
                        workspacePath: profileFileTree.workspacePath,
                        dirCount: profileFileTree.roots.length
                      }
                    : null
                }
                fileTreeRoots={profileFileTree?.roots ?? null}
                revealFilePath={panelsVisible ? revealFilePath : undefined}
                revealFileSeq={panelsVisible ? revealFileSeq : 0}
                onRevealFileHandled={onRevealFileHandled}
                revealFileDiffPath={panelsVisible ? revealFileDiffPath : undefined}
                revealFileDiffSeq={panelsVisible ? revealFileDiffSeq : 0}
                onRevealFileDiffHandled={onRevealFileDiffHandled}
                onAddComment={onAddComment}
                onOpenFileQuickOpen={onOpenFileQuickOpen}
              />
            </div>
          </div>
        )
      })}
    </>
  )
})
