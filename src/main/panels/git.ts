/** Re-export session-scoped git API (implementation in git-repository.ts + git-core.ts). */
export {
  addWorktree,
  getDiffSummary,
  getFileDiff,
  getGitBranch,
  invalidateGitRepository,
  listCommits,
  listWorktrees,
  mergeWorktreeBranch,
  removeWorktree,
  warmRemoteGitHost
} from './git-repository'
