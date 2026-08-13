import type { SessionProfile } from './session-profile-types'
import type { SessionRecord } from './session-types'

export interface SessionFileTreeRoot {
  label: string
  path: string
}

export function isAbsoluteFileDirectory(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~')
}

/** Resolve one profile file-directory entry against workspace or worktree root. */
export function resolveProfileFileDirectory(
  dir: string,
  workspace: string,
  worktreePath: string | null
): string {
  if (isAbsoluteFileDirectory(dir)) return dir
  const base = (worktreePath ?? workspace).replace(/\/?$/, '')
  const rel = dir.replace(/^\.\//, '')
  return `${base}/${rel}`
}

export function resolveProfileFileDirectories(
  profile: SessionProfile,
  worktreePath: string | null
): string[] {
  return profile.fileDirectories.map((dir) =>
    resolveProfileFileDirectory(dir, profile.workspace, worktreePath)
  )
}

export function filterSessionProfiles(profiles: SessionProfile[], query: string): SessionProfile[] {
  const q = query.trim().toLowerCase()
  if (!q) return profiles
  return profiles.filter(
    (profile) =>
      profile.name.toLowerCase().includes(q) || profile.workspace.toLowerCase().includes(q)
  )
}

/** Profile-driven Files tab roots — null when the session has no profile. */
export function resolveSessionProfileFileTree(
  session: Pick<SessionRecord, 'profileId' | 'projectPath' | 'worktreePath'>,
  profiles: SessionProfile[]
): { profileName: string; workspacePath: string; roots: SessionFileTreeRoot[] } | null {
  if (!session.profileId) return null
  const profile = profiles.find((p) => p.id === session.profileId)
  if (!profile) return null
  const workspacePath = session.worktreePath ?? session.projectPath
  const resolved = resolveProfileFileDirectories(profile, session.worktreePath)
  return {
    profileName: profile.name,
    workspacePath,
    roots: profile.fileDirectories.map((dir, i) => ({
      label: dir,
      path: resolved[i] ?? dir
    }))
  }
}
