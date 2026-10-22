export type NoteRecord = {
  documentId: string
  sourceKind: 'blog' | 'personal'
  title: string
  status: 'draft' | 'published'
  tags: string[]
  created: string
  updated: string
  sources: any[]
  path: string
  _text?: string
}

export type NoteSaveInput = {
  documentId: string
  sourceDocumentId: string | null
  sourceKind: 'blog' | 'personal'
  title: string
  tags: string[]
  status: 'draft' | 'published'
  markdown: string
  assets: { name: string; type: string; base64: string }[]
  sources: any[]
}

export type NoteSaveResult = { note: NoteRecord; head: string }
export type NoteDeleteResult = { documentIds: string[]; head: string }
export type NoteDocument = { note: NoteRecord; markdown: string; identityMarkdown?: string; head: string }
export type NoteAsset = Blob

export interface NotesStore {
  readonly kind: 'local-demo' | 'github'
  readonly namespace: string
  readonly repository: string
  readonly branch: string
  list(options?: { force?: boolean }): Promise<{ notes: NoteRecord[]; head: string }>
  get(documentId: string): Promise<NoteDocument>
  asset(documentId: string, name: string): Promise<NoteAsset>
  save(input: NoteSaveInput, expectedHead: string, requestId: string): Promise<NoteSaveResult>
  deleteNotes(documentIds: string[], expectedHead: string, requestId: string): Promise<NoteDeleteResult>
  disconnect(): void
  clearPrivateCache?(): void
}
