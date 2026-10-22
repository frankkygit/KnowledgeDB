import type { NoteAsset, NoteDeleteResult, NoteDocument, NoteRecord, NoteSaveInput, NoteSaveResult, NotesStore } from './note-store'
import { editableNoteMarkdown } from './note-content'

async function json(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, cache: 'no-store' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `离线笔记请求失败（${response.status}）。`)
  return data
}

export class LocalNoteStore implements NotesStore {
  readonly kind = 'local-demo' as const
  readonly namespace: string
  readonly branch = 'local'
  constructor(readonly repository = 'local-data/note-demo-git') { this.namespace = `local:${repository}:${this.branch}` }
  async list(_options?: { force?: boolean }): Promise<{ notes: NoteRecord[]; head: string }> {
    const data = await json('/__local_notes/catalog')
    return { notes: data.notes, head: data.head }
  }
  async get(documentId: string): Promise<NoteDocument> {
    const data = await json(`/__local_notes/document?documentId=${encodeURIComponent(documentId)}`)
    return { ...data, markdown: editableNoteMarkdown(data.markdown), identityMarkdown: data.markdown }
  }
  async asset(documentId: string, name: string): Promise<NoteAsset> {
    const response = await fetch(`/__local_notes/asset?documentId=${encodeURIComponent(documentId)}&name=${encodeURIComponent(name)}`, { cache: 'no-store' })
    if (!response.ok) throw new Error('本机图片读取失败。')
    return response.blob()
  }
  async save(input: NoteSaveInput, expectedHead: string, requestId: string): Promise<NoteSaveResult> {
    // The demo server allocates document IDs for new notes; it never reads or writes production docs.
    const data = await json('/__local_notes/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, documentId: input.sourceDocumentId, requestId, expectedHead }) })
    return { note: data.note, head: data.head }
  }
  async deleteNotes(documentIds: string[], expectedHead: string, requestId: string): Promise<NoteDeleteResult> {
    const data = await json('/__local_notes/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentIds, requestId, expectedHead }) })
    return { documentIds: data.documentIds, head: data.head }
  }
  disconnect() {}
}
