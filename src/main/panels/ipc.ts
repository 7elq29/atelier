/**
 * IPC handlers for the secondary panels (07-secondary-panels): real git
 * diff/log/worktree ops, real filesystem tree/reads, real pty terminals, and
 * real SSH port forwards — plus `shell:openExternal` for "web links open
 * externally" (§7), used by every panel that renders links (diff comments,
 * file previews, chat).
 */
import { ipcMain, shell, type BrowserWindow } from 'electron'
import type { DiffFileStatus } from '../../shared/panel-types'
import { logger } from '../logger'
import * as git from './git'
import { walkFileTree, walkDirChildren, listWorkspaceFiles, pathIsDirectory, readFileForPreview, writeFileContent } from './files'
import {
  deleteEditorBuffer,
  listEditorBufferPaths,
  readEditorBuffer,
  writeEditorBuffer
} from './editor-buffers'
import { PtyManager } from './pty'
import { PortForwardManager } from './ports'

export function registerPanelHandlers(getWindow: () => BrowserWindow | null): { ptyManager: PtyManager; portManager: PortForwardManager } {
  const ptyManager = new PtyManager(getWindow)
  const portManager = new PortForwardManager(getWindow)

  // ── Git / diff / worktrees ─────────────────────────────────────────
  ipcMain.handle('panel:git:diff', async (_e, projectPath: string, hostname?: string | null, force?: boolean) => {
    const startedAt = Date.now()
    logger.info('panel:git:diff:trace', { event: 'start', projectPath, hostname: hostname ?? null, force: force === true })
    try {
      const summary = force
        ? await git.getDiffSummaryWithHunks(projectPath, hostname, true)
        : await git.getDiffSummary(projectPath, hostname, force)
      logger.info('panel:git:diff:trace', {
        event: 'done',
        projectPath,
        hostname: hostname ?? null,
        force: force === true,
        isRepo: summary.isRepo,
        diffFiles: summary.files.length,
        ms: Date.now() - startedAt
      })
      return summary
    } catch (err) {
      logger.info('panel:git:diff:trace', {
        event: 'error',
        projectPath,
        hostname: hostname ?? null,
        force: force === true,
        ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
  })
  ipcMain.handle('panel:git:fileDiff', (_e, projectPath: string, filePath: string, hostname?: string | null) =>
    git.getFileDiff(projectPath, filePath, hostname)
  )
  ipcMain.handle('panel:git:commitDiff', (_e, projectPath: string, commit: string, hostname?: string | null) =>
    git.getCommitDiff(projectPath, commit, hostname)
  )
  ipcMain.handle('panel:git:commitOpen', (_e, projectPath: string, commit: string, hostname?: string | null) =>
    git.getCommitPanelOpen(projectPath, commit, hostname)
  )
  ipcMain.handle(
    'panel:git:commitFileDiff',
    (_e, projectPath: string, commit: string, filePath: string, hostname?: string | null) =>
      git.getCommitFileDiff(projectPath, commit, filePath, hostname)
  )
  ipcMain.handle(
    'panel:git:workingTreeFilePair',
    (_e, projectPath: string, filePath: string, status: DiffFileStatus, hostname?: string | null) =>
      git.getWorkingTreeFilePair(projectPath, filePath, status, hostname)
  )
  ipcMain.handle(
    'panel:git:commitFilePair',
    (_e, projectPath: string, commit: string, filePath: string, status: DiffFileStatus, hostname?: string | null) =>
      git.getCommitFilePair(projectPath, commit, filePath, status, hostname)
  )
  ipcMain.handle('panel:git:commits', (_e, projectPath: string, hostname?: string | null, force?: boolean) =>
    git.listCommits(projectPath, 50, hostname, force)
  )
  ipcMain.handle('panel:git:worktrees', (_e, projectPath: string, hostname?: string | null, force?: boolean) =>
    git.listWorktrees(projectPath, hostname, force)
  )
  ipcMain.handle('panel:git:warmRemote', (_e, hostname: string) => git.warmRemoteGitHost(hostname))
  ipcMain.handle('panel:git:branch', (_e, projectPath: string, hostname?: string | null) =>
    git.getGitBranch(projectPath, hostname)
  )
  ipcMain.handle('panel:git:worktreeAdd', (_e, projectPath: string, worktreePath: string, branch: string, hostname?: string | null) =>
    git.addWorktree(projectPath, worktreePath, branch, hostname)
  )
  ipcMain.handle('panel:git:worktreeRemove', (_e, projectPath: string, worktreePath: string, hostname?: string | null) =>
    git.removeWorktree(projectPath, worktreePath, hostname)
  )
  ipcMain.handle('panel:git:worktreeMerge', (_e, projectPath: string, branch: string, hostname?: string | null) =>
    git.mergeWorktreeBranch(projectPath, branch, hostname)
  )

  // ── Files ────────────────────────────────────────────────────────────
  ipcMain.handle('panel:files:tree', (_e, projectPath: string, hostname?: string | null) => walkFileTree(projectPath, hostname))
  ipcMain.handle('panel:files:dir', (_e, root: string, dir: string, hostname?: string | null) => walkDirChildren(root, dir, hostname))
  ipcMain.handle('panel:files:list', (_e, workspaceRoot: string, underDir?: string | null, hostname?: string | null) =>
    listWorkspaceFiles(workspaceRoot, hostname, underDir)
  )
  ipcMain.handle('panel:files:isDirectory', (_e, path: string, hostname?: string | null) => pathIsDirectory(path, hostname))
  ipcMain.handle('panel:files:read', (_e, path: string, hostname?: string | null) => readFileForPreview(path, hostname))
  ipcMain.handle('panel:files:write', (_e, path: string, content: string, hostname?: string | null) => {
    const result = writeFileContent(path, content, hostname)
    logger.info('panel:files:write', { path, hostname: hostname ?? null, bytes: content.length })
    return result
  })

  // ── Unsaved editor buffers (scratch text for un-⌘S'd Files edits) ────
  ipcMain.handle('panel:files:bufferRead', (_e, path: string, hostname?: string | null) =>
    readEditorBuffer(path, hostname)
  )
  ipcMain.handle('panel:files:bufferWrite', (_e, path: string, content: string, hostname?: string | null) =>
    writeEditorBuffer(path, content, hostname)
  )
  ipcMain.handle('panel:files:bufferDelete', (_e, path: string, hostname?: string | null) =>
    deleteEditorBuffer(path, hostname)
  )
  ipcMain.handle('panel:files:bufferList', (_e, hostname?: string | null) =>
    listEditorBufferPaths(hostname)
  )

  // ── Terminal (pty) ───────────────────────────────────────────────────
  ipcMain.handle('panel:pty:spawn', async (_e, opts: { id: string; cwd: string; hostname?: string | null; cols: number; rows: number }) => {
    await ptyManager.spawn(opts.id, opts)
    return true
  })
  ipcMain.handle('panel:pty:write', (_e, id: string, data: string) => ptyManager.write(id, data))
  ipcMain.handle('panel:pty:resize', (_e, id: string, cols: number, rows: number) => ptyManager.resize(id, cols, rows))
  ipcMain.handle('panel:pty:kill', (_e, id: string) => ptyManager.kill(id))
  // Kill the tmux server session for this pty id — call on Atelier session
  // close/delete so the tmux session is cleaned up permanently (local or remote).
  ipcMain.handle('panel:pty:killTmuxSession', (_e, id: string, hostname?: string | null) =>
    ptyManager.killTmuxSession(id, hostname)
  )

  // ── Ports (SSH forwards) ─────────────────────────────────────────────
  ipcMain.handle(
    'panel:ports:add',
    (_e, sessionId: string, sshHost: string, localPort: number, remoteHost: string, remotePort: number) =>
      portManager.add(sessionId, sshHost, localPort, remoteHost, remotePort)
  )
  ipcMain.handle('panel:ports:remove', (_e, id: string) => portManager.remove(id))
  ipcMain.handle('panel:ports:list', (_e, sessionId: string) => portManager.list(sessionId))

  // ── External links (§7) ──────────────────────────────────────────────
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    logger.info('opening external URL', { url })
    return shell.openExternal(url)
  })

  return { ptyManager, portManager }
}
