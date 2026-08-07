/** Re-export session-scoped git API (implementation in git-repository.ts + git-core.ts). */
export {
  addWorktree,
  getCommitDiff,
  getCommitFileDiff,
  getCommitFilePair,
  getCommitPanelOpen,
  getDiffSummary,
  getFileDiff,
  getGitBranch,
  getWorkingTreeFilePair,
  invalidateGitRepository,
  listCommits,
  listWorktrees,
  mergeWorktreeBranch,
  removeWorktree,
  warmRemoteGitHost
} from './git-repository'
