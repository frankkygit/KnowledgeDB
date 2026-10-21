export type SavedNoteFilterTarget = {
  documentId: string
  sourceKind: 'blog' | 'personal'
  title: string
  status: 'draft' | 'published'
  tags: string[]
  sources?: { siteName?: string; originalTitle?: string }[]
  _text?: string
}

export type NoteFilterState = {
  source: 'all' | 'blog' | 'personal'
  status: 'all' | 'draft' | 'published'
  tags: string[]
  search: string
}

export function reconcileSavedNoteFilters(note: SavedNoteFilterTarget, filters: NoteFilterState): NoteFilterState {
  const next = { ...filters, tags: [...filters.tags] }
  if (next.source !== 'all' && next.source !== note.sourceKind) next.source = note.sourceKind
  if (next.status !== 'all' && next.status !== note.status) next.status = note.status
  if (!next.tags.some(tag => note.tags.includes(tag))) next.tags = []

  const needle = next.search.trim().normalize('NFC').toLocaleLowerCase()
  if (needle) {
    const searchable = `${note.title} ${note.tags.join(' ')} ${(note.sources || []).map(source => `${source.siteName || ''} ${source.originalTitle || ''}`).join(' ')} ${note.documentId} ${note._text || ''}`
      .normalize('NFC')
      .toLocaleLowerCase()
    if (!searchable.includes(needle)) next.search = ''
  }
  return next
}
