/** Saved session profile — workspace cwd plus optional extra file roots. */
export interface SessionProfile {
  id: string
  name: string
  workspace: string
  fileDirectories: string[]
}
