import { memo } from 'react'
import type { AtelierConfig } from '../../../../shared/config'
import type { SessionRecord } from '../../../../shared/session-types'
import type { SessionWorkspacePayload } from '../../../../shared/session-workspace-types'
import { resolveSessionProfileFileTree } from '../../../../shared/session-profile-resolve'
import DiffPanel from '../panels/DiffPanel'
import FilesPanel from '../panels/FilesPanel'
import type { SessionTab } from '../panels/TabBar'

export const SessionWorkspacePanels = memo(function SessionWorkspacePanels({
  sessionIds,
  allSessions,
  workspaceBySession,
  sessionProfiles,
  activeSessionId,
  activeTab,
  activeSessionDisconnected,
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
  onRefreshWorkspace
}: {
  sessionIds: string[]
  allSessions: SessionRecord[]
  workspaceBySession: Record<string, SessionWorkspacePayload>
  sessionProfiles: AtelierConfig['sessionProfiles']
  activeSessionId: string | null
  activeTab: SessionTab
  activeSessionDisconnected: boolean
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
}): JSX.Element {
  return (
    <>
      {sessionIds.map((sessionId) => {
        const session = allSessions.find((s) => s.id === sessionId)
        const ws = workspaceBySession[sessionId]
        if (!session || session.mode !== 'claude-code') return null
        const panelsVisible = activeSessionId === sessionId && !activeSessionDisconnected
        const workspacePath = session.worktreePath ?? session.projectPath
        const profileFileTree = resolveSessionProfileFileTree(session, sessionProfiles ?? [])
        const inject = injectDiffBySession[sessionId]
        return (
          <div
            key={`workspace-panels-${sessionId}-${session.projectPath}`}
            style={{ display: panelsVisible ? 'contents' : 'none' }}
          >
            <div className={`tab-content${activeTab === 'diff' ? '' : ' hidden'}`} data-tab="diff">
              <DiffPanel
                workspacePath={workspacePath}
                repoRoot={session.projectPath}
                hostname={session.hostname}
                effectiveTheme={effectiveTheme}
                panelScopeKey={`${session.id}:${session.projectPath}`}
                active={panelsVisible && activeTab === 'diff'}
                workspaceDiff={ws?.diff}
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
              />
            </div>

            <div className={`tab-content${activeTab === 'files' ? '' : ' hidden'}`} data-tab="files">
              <FilesPanel
                projectPath={workspacePath}
                pathResolutionRoot={session.projectPath}
                sessionId={sessionId}
                hostname={session.hostname}
                effectiveTheme={effectiveTheme}
                active={panelsVisible && activeTab === 'files'}
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
