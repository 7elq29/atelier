/**
 * System-prompt block for worktree-backed sessions.
 *
 * "Use worktree" only sets the agent's working directory — it cannot stop the
 * agent from addressing files by absolute path somewhere else on the machine.
 * Observed in the wild (session 65c4ff11, remote devpod): the harness started
 * with `cwd` set to the worktree, yet the agent ran `find /home/user/go-code/…`,
 * edited `/home/user/go-code/config/…`, and committed with
 * `git -C /home/user/go-code commit`. The commit landed on `main` in the
 * original checkout while the session's worktree branch stayed clean, so the
 * work never appeared in the Diff panel (which reads the worktree).
 *
 * Appending this to Claude Code's own preset prompt makes the boundary
 * explicit instead of implicit in `cwd`.
 */
export function worktreeSystemPromptAppend(worktreePath: string, repoPath: string): string {
  return [
    '## Worktree session',
    '',
    'This session runs inside a dedicated git worktree, not the original repository checkout.',
    '',
    `- Your working directory (the worktree): ${worktreePath}`,
    `- Original repository checkout (do not touch): ${repoPath}`,
    '',
    'The worktree is a full checkout of the same repository on its own branch, so',
    'everything you need is reachable from your working directory. Keep every file',
    'read, edit, shell command, and git operation inside the worktree: use paths',
    'relative to your working directory, or absolute paths beginning with the',
    'worktree path above.',
    '',
    `Do not edit files under ${repoPath}, and do not target it with \`git -C\`, \`cd\`,`,
    'or any other command that moves work outside the worktree. Commits made there',
    "are invisible to this session's diff view and are easily lost.",
    '',
    'The original path being mentioned in a request is not an instruction to work',
    'there — the same files exist in your worktree, so use the worktree copy. Only',
    'if a request cannot be satisfied inside the worktree at all, explain why and ask',
    'the user to confirm before touching the original checkout.'
  ].join('\n')
}
