export interface AppNoteRecord {
  id: string
  title: string
  content: string
  path: string
  createdAt: string
  updatedAt: string
  sortOrder: number
}

export type AppNoteUpdate = Partial<Pick<AppNoteRecord, 'title' | 'content'>>
