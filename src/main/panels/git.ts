/** Re-export session-scoped git API (implementation in git-repository.ts + git-core.ts). */
export {
  addWorktree,
  getCommitDiff,
  getCommitFileDiff,
  getCommitFilePair,
  getDiffSummary,
  getFileDiff,
  getGitBranch,
  getWorkingTreeFilePair,
  getPathWorkingTreeNumstat,
  invalidateGitRepository,
  latestReflogSubject,
  listCommitChangedPaths,
  listCommitsInRange,
  listCommits,
  listWorktrees,
  mergeWorktreeBranch,
  removeWorktree,
  resolveHead,
  warmRemoteGitHost
} from './git-repository'
