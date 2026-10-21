<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderMarkdown } from './markdown'
import { reconcileSavedNoteFilters } from './note-filters'
import { claimOfflineNoteDraft, deleteOfflineNoteDraft, listActiveDraftTabIds, listOfflineNoteDrafts, releaseDraftTabLease, resolveDraftTabId, saveOfflineNoteDraft, writeDraftTabLease, type OfflineNoteDraft } from './note-drafts'
import type { NotesStore, NoteRecord } from './note-store'
const props = defineProps<{ sidebarCollapsed: boolean; store: NotesStore }>()
const emit = defineEmits<{ (event: 'select-section', section: string): void; (event: 'toggle-sidebar'): void }>()

type Note = NoteRecord
const notes = ref<Note[]>([])
const head = ref('')
const selectedId = ref('')
const multiSelect = ref(false)
const selectedForDeletion = ref<string[]>([])
const rowMenuId = ref('')
const deleteDialog = ref(false)
const deleteBusy = ref(false)
const deleteHead = ref('')
const deleteIds = ref<string[]>([])
const pendingDelete = ref<{ signature: string; id: string } | null>(null)
const deleteReturnFocus = ref<HTMLElement | null>(null)
const deleteDialogRoot = ref<HTMLElement | null>(null)
const discardDialogRoot = ref<HTMLElement | null>(null)
const selectAllCheckbox = ref<HTMLInputElement | null>(null)
const selected = ref<Note | null>(null)
const markdown = ref('')
const busy = ref(false)
const error = ref('')
const message = ref('')
const sourceFilter = ref('all')
const statusFilter = ref('published')
const tagFilter = ref<string[]>([])
const search = ref('')
const tagsExpanded = ref(false)
const editing = ref(false)
const creating = ref(false)
const discardPrompt = ref(false)
const title = ref('')
const tagsText = ref('')
const status = ref<'draft' | 'published'>('draft')
const editMarkdown = ref('')
const pendingAssets = ref<{ name: string; type: string; base64: string }[]>([])
const editorBaseHead = ref('')
const editorSourceDocumentId = ref<string | null>(null)
const editorDocumentId = ref('')
const tabDraftId = ref('')
const draftScopeReady = ref(false)
const currentDraftId = ref('')
const recoveryDrafts = ref<OfflineNoteDraft[]>([])
const draftStorageState = ref<'idle' | 'saving' | 'saved' | 'error' | 'unavailable'>('idle')
const draftStorageMessage = ref('')
const draftStorageWarning = ref('')
const draftSavedAt = ref('')
const recoveryRefreshing = ref(false)
const syncPanelOpen = ref(false)
const readerRoot = ref<HTMLElement | null>(null)
const previewRoot = ref<HTMLElement | null>(null)
const editor = ref<HTMLTextAreaElement | null>(null)
const previewMode = ref(false)
const noteSidebarCollapsed = computed(() => props.sidebarCollapsed)
const isLocalStore = computed(() => props.store.kind === 'local-demo')
const isDraggingImage = ref(false)
let editSession = 0
let loadSession = 0
let lastSelection = { start: 0, end: 0, scrollTop: 0 }
let imageInsertionTail = Promise.resolve()
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null
let draftLeaseTimer: ReturnType<typeof setInterval> | null = null
let lastDraftSerialized = ''
let draftSaveTail: Promise<void> = Promise.resolve()
let draftRevision = 0
const objectUrls: string[] = []
const editBaseline = ref('')
const pendingRequest = ref<{ signature: string; id: string } | null>(null)
const dirty = computed(() => editing.value && `${title.value}\n${tagsText.value}\n${status.value}\n${editMarkdown.value}` !== editBaseline.value)
let pendingDiscardAction: (() => void) | null = null
let deleteAfterDiscard = false
let pendingLeaveResolve: ((leave: boolean) => void) | null = null
const preview = computed(() => renderMarkdown(editMarkdown.value, selected.value?.path || 'content/notes/new/index.md'))
const baseFilteredNotes = computed(() => notes.value.filter(note =>
  (sourceFilter.value === 'all' || note.sourceKind === sourceFilter.value) &&
  (statusFilter.value === 'all' || note.status === statusFilter.value) &&
  (!search.value.trim() || `${note.title} ${(note.tags || []).join(' ')} ${(note.sources || []).map(source => `${source.siteName || ''} ${source.originalTitle || ''}`).join(' ')} ${note.documentId} ${note._text || ''}`.normalize('NFC').toLocaleLowerCase().includes(search.value.trim().normalize('NFC').toLocaleLowerCase()))
))
const tagCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const note of baseFilteredNotes.value) for (const tag of new Set(note.tags || [])) counts.set(tag, (counts.get(tag) || 0) + 1)
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
})
const allTags = computed(() => tagCounts.value.map(([tag]) => tag))
const shownTags = computed(() => {
  const currentTags = tagsExpanded.value || allTags.value.length <= 6 ? allTags.value : allTags.value.slice(0, 6)
  return [...new Set([...tagFilter.value, ...currentTags])]
})
const visible = computed(() => baseFilteredNotes.value.filter(note => !tagFilter.value.length || tagFilter.value.some(tag => (note.tags || []).includes(tag))).sort((a, b) => b.updated.localeCompare(a.updated)))

async function refresh(keepSelection = true) {
  const data = await props.store.list()
  notes.value = data.notes
  head.value = data.head
  if (!keepSelection || !notes.value.some(note => note.documentId === selectedId.value)) selectedId.value = ''
  if (selectedId.value) await openNote(selectedId.value)
}
async function openNote(id: string, discardConfirmed = false) {
  if (dirty.value && !discardConfirmed) { requestDiscard(() => openNote(id, true)); return }
  editSession++
  void clearActiveDraft()
  editing.value = false; creating.value = false; previewMode.value = false
  selectedId.value = id
  const session = ++loadSession
  const data = await props.store.get(id)
  if (session !== loadSession || selectedId.value !== id) return
  selected.value = data.note
  markdown.value = data.markdown
  head.value = data.head
  editing.value = false; creating.value = false
}
function toggleMultiSelect() {
  multiSelect.value = !multiSelect.value
  rowMenuId.value = ''
  if (!multiSelect.value) selectedForDeletion.value = []
}
function toggleDeleteSelection(id: string) {
  selectedForDeletion.value = selectedForDeletion.value.includes(id) ? selectedForDeletion.value.filter(item => item !== id) : [...selectedForDeletion.value, id]
}
function selectAllVisible() {
  const ids = visible.value.map(note => note.documentId)
  const selected = new Set(selectedForDeletion.value)
  selectedForDeletion.value = [...selected, ...ids.filter(id => !selected.has(id))]
}
function toggleVisibleSelection() {
  const ids = visible.value.map(note => note.documentId)
  const selected = new Set(selectedForDeletion.value)
  const allSelected = ids.length > 0 && ids.every(id => selected.has(id))
  selectedForDeletion.value = allSelected ? selectedForDeletion.value.filter(id => !ids.includes(id)) : [...selected, ...ids.filter(id => !selected.has(id))]
}
function openDeleteDialog(ids: string[], trigger?: HTMLElement) {
  error.value = ''
  deleteIds.value = [...ids]
  deleteHead.value = head.value
  const signature = JSON.stringify({ ids: [...ids].sort(), head: head.value })
  if (!pendingDelete.value || pendingDelete.value.signature !== signature) pendingDelete.value = { signature, id: crypto.randomUUID() }
  deleteReturnFocus.value = trigger || document.activeElement as HTMLElement
  rowMenuId.value = ''
  deleteDialog.value = true
  nextTick(() => deleteDialogRoot.value?.querySelector<HTMLButtonElement>('button')?.focus())
}
function restoreDeleteFocus() {
  const trigger = deleteReturnFocus.value
  if (trigger?.isConnected) trigger.focus()
  else document.querySelector<HTMLButtonElement>('.note-list-heading button')?.focus()
}
function requestDelete(ids: string[], trigger?: HTMLElement) {
  if (dirty.value && ids.includes(editorSourceDocumentId.value || '')) {
    deleteAfterDiscard = true
    const scope = JSON.stringify({ filters: [sourceFilter.value, statusFilter.value, tagFilter.value, search.value], visible: visible.value.map(note => note.documentId).sort() })
    requestDiscard(() => {
      const currentScope = JSON.stringify({ filters: [sourceFilter.value, statusFilter.value, tagFilter.value, search.value], visible: visible.value.map(note => note.documentId).sort() })
      if (scope !== currentScope || ids.some(id => !visible.value.some(note => note.documentId === id))) {
        selectedForDeletion.value = []
        error.value = '筛选结果已变化，请重新选择要删除的笔记。'
        return
      }
      openDeleteDialog(ids, trigger)
    })
    return
  }
  openDeleteDialog(ids, trigger)
}
async function deleteSelectedNotes() {
  if (deleteBusy.value || !deleteIds.value.length) return
  deleteBusy.value = true; busy.value = true; error.value = ''; message.value = ''
  const ids = [...deleteIds.value]
  const signature = JSON.stringify({ ids: [...ids].sort(), head: deleteHead.value })
  if (!pendingDelete.value || pendingDelete.value.signature !== signature) pendingDelete.value = { signature, id: crypto.randomUUID() }
  try {
    const result = await props.store.deleteNotes(ids, deleteHead.value, pendingDelete.value.id)
    loadSession++
    if (ids.includes(editorSourceDocumentId.value || '') && editing.value) {
      await clearActiveDraft()
      editSession++
      editing.value = false; creating.value = false; previewMode.value = false
      selected.value = null; selectedId.value = ''
      markdown.value = ''; editMarkdown.value = ''; pendingAssets.value = []; pendingRequest.value = null
    }
    const currentWasDeleted = ids.includes(selectedId.value)
    selectedForDeletion.value = selectedForDeletion.value.filter(id => !ids.includes(id))
    deleteDialog.value = false; deleteIds.value = []
    multiSelect.value = selectedForDeletion.value.length > 0
    rowMenuId.value = ''
    pendingDelete.value = null
    notes.value = notes.value.filter(note => !ids.includes(note.documentId)); head.value = result.head
    if (currentWasDeleted) { selected.value = null; selectedId.value = ''; markdown.value = '' }
    message.value = `${ids.length} 篇笔记已删除；Git 历史版本已保留。`
    try {
      const latest = await props.store.list()
      notes.value = latest.notes; head.value = latest.head
    } catch (cause) { error.value = `笔记已删除，但列表刷新失败：${cause instanceof Error ? cause.message : '请稍后刷新。'}` }
    nextTick(restoreDeleteFocus)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '删除失败；笔记与选择仍保留。'
  } finally { busy.value = false; deleteBusy.value = false }
}
function handleDeleteKeydown(event: KeyboardEvent) {
  if (!deleteDialog.value) return
  if (event.key === 'Escape' && !deleteBusy.value) { deleteDialog.value = false; nextTick(restoreDeleteFocus); return }
  if (event.key !== 'Tab') return
  const controls = [...(deleteDialogRoot.value?.querySelectorAll<HTMLElement>('button:not([disabled])') || [])]
  if (!controls.length) return
  if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
  else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus() }
}
function handleDiscardKeydown(event: KeyboardEvent) {
  if (!discardPrompt.value) return
  if (event.key === 'Escape') { event.preventDefault(); keepEditing(); return }
  if (event.key !== 'Tab') return
  const controls = [...(discardDialogRoot.value?.querySelectorAll<HTMLElement>('button:not([disabled])') || [])]
  if (!controls.length) return
  if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
  else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus() }
}
watch(visible, current => {
  const ids = new Set(current.map(note => note.documentId))
  selectedForDeletion.value = selectedForDeletion.value.filter(id => ids.has(id))
  if (rowMenuId.value && !ids.has(rowMenuId.value)) rowMenuId.value = ''
}, { deep: true })
watch([sourceFilter, statusFilter, tagFilter, search], () => {
  selectedForDeletion.value = []
  if (deleteDialog.value) { deleteDialog.value = false; deleteIds.value = [] }
  if (deleteAfterDiscard) { deleteAfterDiscard = false; discardPrompt.value = false; pendingDiscardAction = null; error.value = '筛选结果已变化，请重新选择要删除的笔记。' }
  rowMenuId.value = ''
})
watch([selectedForDeletion, visible], () => nextTick(() => {
  if (selectAllCheckbox.value) selectAllCheckbox.value.indeterminate = visible.value.some(note => selectedForDeletion.value.includes(note.documentId)) && !visible.value.every(note => selectedForDeletion.value.includes(note.documentId))
}), { flush: 'post' })
function beginEdit(create = false, discardConfirmed = false) {
  if (dirty.value && !discardConfirmed) { requestDiscard(() => beginEdit(create, true)); return }
  if (editing.value) void clearActiveDraft()
  error.value = ''; message.value = ''; creating.value = create; editing.value = true; previewMode.value = false; editSession++
  editorBaseHead.value = head.value
  editorSourceDocumentId.value = create ? null : selected.value?.documentId || selectedId.value || null
  editorDocumentId.value = create ? `note-${crypto.randomUUID()}` : editorSourceDocumentId.value || ''
  currentDraftId.value = create ? `${tabDraftId.value}:new:${crypto.randomUUID()}` : `${tabDraftId.value}:note:${selected.value?.documentId || selectedId.value}`
  lastDraftSerialized = ''
  pendingAssets.value = []
  if (create) { selected.value = null; selectedId.value = ''; title.value = ''; tagsText.value = ''; status.value = 'draft'; editMarkdown.value = '# 新笔记\n\n' }
  else { title.value = selected.value?.title || ''; tagsText.value = (selected.value?.tags || []).join(', '); status.value = selected.value?.status || 'draft'; editMarkdown.value = markdown.value }
  editBaseline.value = `${title.value}\n${tagsText.value}\n${status.value}\n${editMarkdown.value}`
}
function cancelEdit(discardConfirmed = false) {
  if (dirty.value && !discardConfirmed) { requestDiscard(() => cancelEdit(true)); return }
  void clearActiveDraft()
  editing.value = false; creating.value = false; previewMode.value = false; editSession++
}
function requestDiscard(action: () => void) { pendingDiscardAction = action; discardPrompt.value = true; nextTick(() => discardDialogRoot.value?.querySelector<HTMLButtonElement>('button')?.focus()) }
function keepEditing() {
  discardPrompt.value = false; pendingDiscardAction = null; deleteAfterDiscard = false
  const resolve = pendingLeaveResolve; pendingLeaveResolve = null; resolve?.(false)
  if (editing.value) nextTick(() => editor.value?.focus())
}
function discardEdits() {
  discardPrompt.value = false
  const preserveForDelete = deleteAfterDiscard
  deleteAfterDiscard = false
  if (!preserveForDelete) void clearActiveDraft()
  const action = pendingDiscardAction; pendingDiscardAction = null
  const resolve = pendingLeaveResolve; pendingLeaveResolve = null
  action?.(); resolve?.(true)
}
function confirmLeave(): Promise<boolean> {
  if (!dirty.value) return Promise.resolve(true)
  return new Promise(resolve => { pendingLeaveResolve = resolve; discardPrompt.value = true })
}
function downloadDraft() {
  const blob = new Blob([editMarkdown.value], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${(title.value || 'note').replace(/[^\p{L}\p{N}-]+/gu, '-')}.md`; anchor.click()
  URL.revokeObjectURL(url)
}
function captureSelection() {
  if (editor.value) lastSelection = { start: editor.value.selectionStart, end: editor.value.selectionEnd, scrollTop: editor.value.scrollTop }
}
function replaceEditorRange(start: number, end: number, replacement: string) {
  const el = editor.value
  if (!el) return
  el.focus()
  el.setSelectionRange(start, end)
  // insertText joins the browser's native textarea undo stack with toolbar edits.
  if (!document.execCommand('insertText', false, replacement)) {
    editMarkdown.value = editMarkdown.value.slice(0, start) + replacement + editMarkdown.value.slice(end)
  }
}
function wrapSelection(before: string, after = before, placeholder = '文本') {
  const el = editor.value
  if (!el) return
  const start = el.selectionStart, end = el.selectionEnd
  const selectedText = editMarkdown.value.slice(start, end) || placeholder
  const replacement = `${before}${selectedText}${after}`
  replaceEditorRange(start, end, replacement)
  nextTick(() => el.setSelectionRange(start + before.length, start + before.length + selectedText.length))
}
function prefixLines(prefix: string) {
  const el = editor.value
  if (!el) return
  const value = editMarkdown.value, start = el.selectionStart, end = el.selectionEnd
  const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const lineEndIndex = value.indexOf('\n', end)
  const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex
  const chunk = value.slice(lineStart, lineEnd)
  const replacement = chunk.split('\n').map(line => `${prefix}${line}`).join('\n')
  replaceEditorRange(lineStart, lineEnd, replacement)
  nextTick(() => el.setSelectionRange(lineStart, lineStart + replacement.length))
}
function applyTool(tool: string) {
  if (tool === 'bold') return wrapSelection('**')
  if (tool === 'italic') return wrapSelection('*')
  if (tool === 'strike') return wrapSelection('~~')
  if (tool === 'quote') return prefixLines('> ')
  if (tool === 'code') return wrapSelection('`', '`', '代码')
  if (tool === 'link') return wrapSelection('[', '](https://)', '链接文字')
  if (tool === 'bullet') return prefixLines('- ')
  if (tool === 'number') return prefixLines('1. ')
  if (tool === 'task') return prefixLines('- [ ] ')
  if (tool === 'heading') return prefixLines('## ')
  if (tool === 'undo') { document.execCommand('undo'); editor.value?.focus() }
  if (tool === 'redo') { document.execCommand('redo'); editor.value?.focus() }
}
async function insertImages(files: FileList | File[]) {
  if (busy.value) return
  const session = editSession
  const start = lastSelection.start, end = lastSelection.end
  const accepted = Array.from(files).filter(file => /^image\/(?:png|jpeg|gif|webp|avif)$/.test(file.type) && file.size <= 5_000_000)
  if (accepted.length !== files.length) error.value = '仅支持小于 5 MB 的 PNG、JPEG、GIF、WebP 或 AVIF 图片。'
  if (!accepted.length) return
  const marker = `<!-- kb-image-pending:${crypto.randomUUID()} -->`
  editMarkdown.value = editMarkdown.value.slice(0, start) + marker + editMarkdown.value.slice(end)
  lastSelection = { start: start + marker.length, end: start + marker.length, scrollTop: lastSelection.scrollTop }
  const job = async () => {
    const additions: typeof pendingAssets.value = []
    const links: string[] = []
    for (const file of accepted) {
      const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' } as Record<string, string>)[file.type]
      const name = `${crypto.randomUUID()}.${extension}`
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''; bytes.forEach(byte => { binary += String.fromCharCode(byte) })
      additions.push({ name, type: file.type, base64: btoa(binary) })
      links.push(`![${file.name.replace(/[\[\]]/g, '')}](assets/${name})`)
    }
    if (session !== editSession || !editing.value) return
    const markerAt = editMarkdown.value.indexOf(marker)
    if (markerAt < 0) { error.value = '图片占位已被移除，附件未加入笔记。'; return }
    pendingAssets.value.push(...additions)
    const current = editMarkdown.value
    const insertion = `${markerAt > 0 && current[markerAt - 1] !== '\n' ? '\n\n' : ''}${links.join('\n')}`
    editMarkdown.value = current.slice(0, markerAt) + insertion + current.slice(markerAt + marker.length)
    lastSelection = { start: markerAt + insertion.length, end: markerAt + insertion.length, scrollTop: lastSelection.scrollTop }
    message.value = '图片已加入，待随笔记保存。'
  }
  imageInsertionTail = imageInsertionTail.then(job, job)
  await imageInsertionTail
}
function pasteImages(event: ClipboardEvent) {
  if (busy.value) { event.preventDefault(); return }
  const files = Array.from(event.clipboardData?.items || []).filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => file !== null)
  if (!files.length) return
  event.preventDefault(); captureSelection(); void insertImages(files)
}
function dropImages(event: DragEvent) {
  if (busy.value) { event.preventDefault(); isDraggingImage.value = false; return }
  const files = Array.from(event.dataTransfer?.files || []).filter(file => file.type.startsWith('image/'))
  if (!files.length) return
  event.preventDefault(); isDraggingImage.value = false
  void insertImages(files)
}
function saveSelection() { captureSelection() }
function togglePreview() {
  if (!previewMode.value) captureSelection()
  previewMode.value = !previewMode.value
  if (!previewMode.value) nextTick(() => {
    const el = editor.value
    if (!el) return
    el.focus(); el.setSelectionRange(lastSelection.start, lastSelection.end); el.scrollTop = lastSelection.scrollTop
    requestAnimationFrame(() => { if (editor.value === el) el.scrollTop = lastSelection.scrollTop })
  })
}
async function save() {
  if (busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try {
    let currentInsertions: Promise<void>
    do { currentInsertions = imageInsertionTail; await currentInsertions } while (currentInsertions !== imageInsertionTail)
    const payload = { documentId: editorDocumentId.value, sourceDocumentId: editorSourceDocumentId.value, sourceKind: selected.value?.sourceKind || 'personal', title: title.value, tags: tagsText.value.split(',').map(value => value.trim()).filter(Boolean), status: status.value, markdown: editMarkdown.value, assets: pendingAssets.value, sources: selected.value?.sources || [] }
    const signature = JSON.stringify(payload)
    if (!pendingRequest.value || pendingRequest.value.signature !== signature) pendingRequest.value = { signature, id: crypto.randomUUID() }
    await persistActiveDraft()
    const data = await props.store.save(payload, editorBaseHead.value, pendingRequest.value.id)
    head.value = data.head
    await clearActiveDraft()
    const savedStatus = payload.status === 'draft' ? '草稿' : '正式'
    message.value = isLocalStore.value ? `已保存到本地测试库（${savedStatus}）；列表已更新，尚未同步 GitHub。` : `已保存到 GitHub docs（${savedStatus}）；列表已更新。`
    const matchingNote = { ...data.note, title: payload.title, status: payload.status, tags: payload.tags, sources: data.note.sources || selected.value?.sources || [], _text: payload.markdown }
    const nextFilters = reconcileSavedNoteFilters(matchingNote, { source: sourceFilter.value, status: statusFilter.value, tags: tagFilter.value, search: search.value })
    sourceFilter.value = nextFilters.source; statusFilter.value = nextFilters.status; tagFilter.value = nextFilters.tags; search.value = nextFilters.search
    pendingRequest.value = null; pendingAssets.value = []; editing.value = false; creating.value = false
    await refresh(false); await openNote(data.note.documentId)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败。输入仍保留在编辑器中。' }
  finally { busy.value = false }
}
function toggleTag(tag: string) { tagFilter.value = tagFilter.value.includes(tag) ? tagFilter.value.filter(item => item !== tag) : [...tagFilter.value, tag] }
function clearFilters() { sourceFilter.value = 'all'; statusFilter.value = 'all'; tagFilter.value = []; search.value = '' }
function date(value: string) { return new Date(value).toLocaleString() }
function safeSourceUrl(value: unknown) {
  if (typeof value !== 'string') return ''
  try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '' } catch { return '' }
}
function currentOfflineDraft(): OfflineNoteDraft | null {
  if (!editing.value || !currentDraftId.value || !tabDraftId.value) return null
  return {
    id: currentDraftId.value,
    tabId: tabDraftId.value,
    documentId: editorDocumentId.value,
    sourceDocumentId: editorSourceDocumentId.value,
    sourceKind: selected.value?.sourceKind || (editorSourceDocumentId.value ? notes.value.find(note => note.documentId === editorSourceDocumentId.value)?.sourceKind || 'personal' : 'personal'),
    title: title.value,
    tags: tagsText.value.split(',').map(value => value.trim()).filter(Boolean),
    status: status.value,
    markdown: editMarkdown.value,
    baseHead: editorBaseHead.value,
    assets: pendingAssets.value.map(asset => ({ ...asset })),
    pendingRequestId: pendingRequest.value?.id,
    pendingRequestSignature: pendingRequest.value?.signature,
    updatedAt: new Date().toISOString(),
  }
}
async function persistActiveDraft() {
  const draft = currentOfflineDraft()
  if (!draft) return
  const revision = ++draftRevision
  const serialized = JSON.stringify(draft)
  if (serialized === lastDraftSerialized) return
  draftStorageState.value = 'saving'; draftStorageMessage.value = ''
  draftSaveTail = draftSaveTail.then(async () => {
    await saveOfflineNoteDraft(draft, props.store.namespace)
    lastDraftSerialized = serialized
    if (revision === draftRevision) {
      draftStorageState.value = 'saved'; draftSavedAt.value = draft.updatedAt
      draftStorageMessage.value = ''
    }
  }).catch(cause => {
    if (revision === draftRevision) {
      draftStorageState.value = 'error'
      draftStorageMessage.value = cause instanceof Error ? cause.message : '本机草稿保存失败；当前输入仍保留，可下载 Markdown。'
    }
  })
  await draftSaveTail
}
function scheduleDraftSave() {
  if (!editing.value) return
  draftRevision++
  draftStorageState.value = tabDraftId.value ? 'saving' : 'unavailable'
  if (!tabDraftId.value) { draftStorageMessage.value ||= '无法建立独立的标签页草稿空间；当前输入仍保留，可下载 Markdown。'; return }
  if (draftSaveTimer) clearTimeout(draftSaveTimer)
  draftSaveTimer = setTimeout(() => { void persistActiveDraft() }, 500)
}
async function clearActiveDraft() {
  if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null }
  const id = currentDraftId.value
  if (!id) return
  currentDraftId.value = ''
  try {
    await draftSaveTail
    await deleteOfflineNoteDraft(id, tabDraftId.value, props.store.namespace)
    recoveryDrafts.value = recoveryDrafts.value.filter(draft => draft.id !== id)
    lastDraftSerialized = ''
    if (!currentDraftId.value) { draftStorageState.value = 'idle'; draftStorageMessage.value = '' }
  } catch (cause) {
    draftStorageState.value = 'error'
    draftStorageMessage.value = cause instanceof Error ? cause.message : '无法清理本机草稿。'
  }
}
async function discardRecoveredDraft(draft: OfflineNoteDraft) {
  try {
    await claimOfflineNoteDraft(draft.id, tabDraftId.value, props.store.namespace)
    await deleteOfflineNoteDraft(draft.id, tabDraftId.value, props.store.namespace)
    recoveryDrafts.value = recoveryDrafts.value.filter(item => item.id !== draft.id)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '无法清理本机草稿。' }
}
async function restoreDraft(draft: OfflineNoteDraft) {
  if (editing.value) { error.value = '请先保存或结束当前编辑，再恢复另一份本机草稿。'; return }
  error.value = ''; message.value = ''
  let claimed: OfflineNoteDraft
  try { claimed = await claimOfflineNoteDraft(draft.id, tabDraftId.value, props.store.namespace) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '无法独占恢复这份草稿。'; return }
  if (claimed.sourceDocumentId) {
    try { await openNote(claimed.sourceDocumentId, true) }
    catch (cause) { error.value = cause instanceof Error ? cause.message : '原笔记读取失败；草稿已保留，不能按新笔记保存。'; return }
  } else { selected.value = null; selectedId.value = '' }
  creating.value = !claimed.sourceDocumentId
  editing.value = true; previewMode.value = false; editSession++
  currentDraftId.value = claimed.id; editorBaseHead.value = claimed.baseHead; editorSourceDocumentId.value = claimed.sourceDocumentId; editorDocumentId.value = claimed.documentId || claimed.sourceDocumentId || `note-${crypto.randomUUID()}`
  title.value = claimed.title; tagsText.value = claimed.tags.join(', '); status.value = claimed.status
  editMarkdown.value = claimed.markdown; pendingAssets.value = claimed.assets.map(asset => ({ ...asset }))
  pendingRequest.value = claimed.pendingRequestId && claimed.pendingRequestSignature
    ? { id: claimed.pendingRequestId, signature: claimed.pendingRequestSignature }
    : null
  editBaseline.value = `${selected.value?.title || ''}\n${(selected.value?.tags || []).join(', ')}\n${selected.value?.status || 'draft'}\n${markdown.value}`
  lastDraftSerialized = ''
  draftStorageState.value = 'saved'; draftSavedAt.value = claimed.updatedAt
  recoveryDrafts.value = recoveryDrafts.value.filter(item => item.id !== claimed.id)
}
async function refreshRecoveryDrafts() {
  if (!tabDraftId.value || recoveryRefreshing.value) return
  recoveryRefreshing.value = true
  try {
    const [allDrafts, activeTabs] = await Promise.all([listOfflineNoteDrafts(props.store.namespace), listActiveDraftTabIds(props.store.namespace)])
    recoveryDrafts.value = allDrafts.filter(draft => draft.id !== currentDraftId.value && (draft.tabId === tabDraftId.value || !activeTabs.has(draft.tabId)))
    if (!editing.value && recoveryDrafts.value.length) draftStorageState.value = 'saved'
  } catch (cause) {
    draftStorageMessage.value = cause instanceof Error ? cause.message : '无法读取本机草稿；当前编辑仍可继续。'
  } finally { recoveryRefreshing.value = false }
}
async function findRecoveryDrafts() {
  try {
    tabDraftId.value = await resolveDraftTabId(props.store.namespace)
    await writeDraftTabLease(tabDraftId.value, props.store.namespace)
    if (tabDraftId.value.startsWith('memory-')) draftStorageWarning.value = '浏览器不允许保存标签页识别信息；草稿仍保存在本机，但关闭后恢复可能需要等待其他标签页租约过期。'
    await refreshRecoveryDrafts()
    draftLeaseTimer = setInterval(() => {
      if (!tabDraftId.value) return
      void writeDraftTabLease(tabDraftId.value, props.store.namespace).then(refreshRecoveryDrafts).catch(() => {})
    }, 15_000)
  } catch (cause) {
    draftStorageState.value = 'unavailable'
    draftStorageMessage.value = cause instanceof Error ? cause.message : '无法读取本机草稿；当前编辑仍可继续。'
  } finally { draftScopeReady.value = true }
}
function refreshRecoveredDraftsOnReturn() { void refreshRecoveryDrafts() }
onMounted(async () => {
  await findRecoveryDrafts()
  try { await refresh(false) } catch (cause) { error.value = cause instanceof Error ? cause.message : '无法读取离线笔记。' }
})
watch([editing, title, tagsText, status, editMarkdown, pendingAssets, editorBaseHead], scheduleDraftSave)
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onMounted(() => {
  window.addEventListener('pagehide', persistBeforePageHide)
  window.addEventListener('focus', refreshRecoveredDraftsOnReturn)
  window.addEventListener('pageshow', refreshRecoveredDraftsOnReturn)
})
function persistBeforePageHide() { void persistActiveDraft(); if (tabDraftId.value) void releaseDraftTabLease(tabDraftId.value, props.store.namespace) }
onBeforeUnmount(() => { editSession++; void persistActiveDraft(); if (draftLeaseTimer) clearInterval(draftLeaseTimer); if (tabDraftId.value) void releaseDraftTabLease(tabDraftId.value, props.store.namespace); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('pagehide', persistBeforePageHide); window.removeEventListener('focus', refreshRecoveredDraftsOnReturn); window.removeEventListener('pageshow', refreshRecoveredDraftsOnReturn) })
onBeforeUnmount(() => { objectUrls.forEach(url => URL.revokeObjectURL(url)) })
defineExpose({ hasUnsavedChanges: () => dirty.value, confirmLeave })
watch([() => selected.value?.documentId, markdown, editMarkdown, editing, previewMode], async () => {
  objectUrls.forEach(url => URL.revokeObjectURL(url)); objectUrls.length = 0
  await nextTick()
  for (const root of [readerRoot.value, previewRoot.value]) {
    if (!root) continue
    for (const image of root.querySelectorAll<HTMLImageElement>('img[data-kb-asset]')) {
      const asset = image.dataset.kbAsset || ''
      const name = asset.split('/').pop() || ''
      const pending = pendingAssets.value.find(item => item.name === name)
      if (pending) { image.src = `data:${pending.type};base64,${pending.base64}`; continue }
      const docId = selected.value?.documentId
      if (!docId) continue
      try {
        const objectUrl = URL.createObjectURL(await props.store.asset(docId, name)); objectUrls.push(objectUrl); image.src = objectUrl
      } catch { image.alt += '（图片读取失败）' }
    }
  }
})
</script>

<template>
  <section class="offline-notes" :class="{ 'notes-sidebar-collapsed': noteSidebarCollapsed }">
    <aside class="notes-sidebar" :aria-hidden="noteSidebarCollapsed">
      <nav class="section-tabs note-section-tabs" aria-label="内容分类"><button type="button" :disabled="busy" @click="emit('select-section', 'papers')">论文</button><button type="button" class="active" aria-current="page">笔记</button><button type="button" :disabled="busy" @click="emit('select-section', 'topics')">专题</button></nav>
      <label class="notes-search"><span>搜索笔记</span><div class="notes-search-field"><svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input v-model="search" type="search" placeholder="搜索标题与正文" :disabled="busy || deleteDialog" /></div></label>
      <button type="button" class="new-note-button" title="新建笔记" :disabled="busy || !draftScopeReady" @click="beginEdit(true)"><span aria-hidden="true">＋</span> 新建笔记</button>
      <div class="note-filter-group"><span>来源</span><div><button v-for="item in [{ id: 'all', label: '全部' }, { id: 'blog', label: 'Blog' }, { id: 'personal', label: '个人' }]" :key="item.id" type="button" :disabled="busy || deleteDialog" :class="{ active: sourceFilter === item.id }" @click="sourceFilter = item.id">{{ item.label }}</button></div></div>
      <div class="note-filter-group"><span>状态</span><div><button v-for="item in [{ id: 'published', label: '正式' }, { id: 'draft', label: '草稿' }, { id: 'all', label: '全部' }]" :key="item.id" type="button" :disabled="busy || deleteDialog" :class="{ active: statusFilter === item.id }" @click="statusFilter = item.id">{{ item.label }}</button></div></div>
      <div class="note-filter-group tag-filters"><div class="tag-header"><span>标签（任意匹配）</span><button v-if="allTags.length > 6" type="button" :disabled="busy || deleteDialog" class="tag-expand-button" :aria-label="tagsExpanded ? '收起标签' : '展开全部标签'" :aria-expanded="tagsExpanded" :title="tagsExpanded ? '收起标签' : '展开全部标签'" @click="tagsExpanded = !tagsExpanded">{{ tagsExpanded ? '收起' : '展开' }} <svg viewBox="0 0 16 16" :class="{ rotated: tagsExpanded }"><path d="m4 6 4 4 4-4" /></svg></button></div><div class="tag-chips" :class="{ 'is-expanded': tagsExpanded }"><button v-for="tag in shownTags" :key="tag" type="button" :disabled="busy || deleteDialog" :title="`当前来源、状态和搜索结果中有 ${tagCounts.find(([name]) => name === tag)?.[1] || 0} 篇笔记使用此标签；同一篇只计一次`" :class="{ active: tagFilter.includes(tag) }" @click="toggleTag(tag)">{{ tag }} <small>({{ tagCounts.find(([name]) => name === tag)?.[1] || 0 }})</small></button><small v-if="!allTags.length">暂无标签</small></div><small v-if="allTags.length" class="tag-count-hint">计数按当前来源、状态和搜索统计，不受标签筛选影响；已选多个标签时匹配任意一个</small></div>
      <div class="note-list-heading"><strong>笔记列表</strong><button type="button" :disabled="busy" @click="toggleMultiSelect">{{ multiSelect ? '取消' : '多选' }}</button></div>
      <div v-if="multiSelect" class="note-selection-toolbar"><label><input ref="selectAllCheckbox" type="checkbox" :checked="visible.length > 0 && visible.every(note => selectedForDeletion.includes(note.documentId))" :aria-checked="visible.some(note => selectedForDeletion.includes(note.documentId)) && !visible.every(note => selectedForDeletion.includes(note.documentId)) ? 'mixed' : undefined" :disabled="busy || !visible.length" @change="toggleVisibleSelection" />全选当前筛选</label><span>已选 {{ selectedForDeletion.length }} 篇</span><button type="button" class="note-delete-button" :disabled="busy || !selectedForDeletion.length" @click="requestDelete(selectedForDeletion)">删除所选（{{ selectedForDeletion.length }}）</button></div>
      <nav class="note-list" aria-label="笔记列表"><div v-for="note in visible" :key="note.documentId" class="note-list-row" :class="{ selected: selectedId === note.documentId, 'is-checked': selectedForDeletion.includes(note.documentId) }"><input v-if="multiSelect" type="checkbox" :aria-label="`选择笔记：${note.title}`" :checked="selectedForDeletion.includes(note.documentId)" :disabled="busy" @change="toggleDeleteSelection(note.documentId)" /><button class="note-row-open" type="button" :disabled="busy" :title="note.title" @click="multiSelect ? toggleDeleteSelection(note.documentId) : openNote(note.documentId)"><strong>{{ note.title }}</strong><small>{{ note.sourceKind === 'blog' ? 'Blog' : '个人' }} · {{ note.tags.slice(0, 2).join(' · ') || (note.status === 'draft' ? '草稿' : '正式') }}</small><time>{{ date(note.updated) }}</time></button><div v-if="!multiSelect" class="note-row-menu"><button type="button" class="note-row-menu-trigger" :aria-label="`笔记操作：${note.title}`" :aria-expanded="rowMenuId === note.documentId" :disabled="busy" @click.stop="rowMenuId = rowMenuId === note.documentId ? '' : note.documentId">⋯</button><div v-if="rowMenuId === note.documentId" class="note-row-menu-popup"><button type="button" :disabled="busy" @click="requestDelete([note.documentId], $event.currentTarget as HTMLElement)">删除笔记</button></div></div></div><p v-if="!visible.length" class="hint">没有匹配的笔记。</p></nav>
      <p class="notes-private-hint">ⓘ 私人内容仅在授权后加载</p>
    </aside>
    <nav v-if="noteSidebarCollapsed" class="notes-rail" aria-label="笔记快捷操作"><button type="button" :disabled="busy" title="论文" aria-label="论文" @click="emit('select-section', 'papers')"><svg viewBox="0 0 24 24"><path d="M5 4.5h10.5A3.5 3.5 0 0 1 19 8v11H8a3 3 0 0 1-3-3zM8 19v-3h11M8 8h7M8 11h7"/></svg></button><button type="button" class="active" title="笔记" aria-label="笔记"><svg viewBox="0 0 24 24"><path d="M6 4h12v16H6zM9 8h6M9 12h6M9 16h4"/></svg></button><button type="button" :disabled="busy" title="专题" aria-label="专题" @click="emit('select-section', 'topics')"><svg viewBox="0 0 24 24"><path d="M4 7h6l2 2h8v10H4zM4 7V5h7l2 2"/></svg></button><button type="button" title="搜索笔记" aria-label="搜索笔记" @click="emit('toggle-sidebar')"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg></button><button type="button" :disabled="busy || !draftScopeReady" title="新建笔记" aria-label="新建笔记" @click="beginEdit(true)"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button></nav>
    <div class="notes-workspace">
    <header v-if="editing" class="notes-heading"><div class="notes-heading-actions"><span class="draft-storage-status" :class="`is-${draftStorageState}`">{{ draftStorageState === 'saving' ? '本机草稿保存中…' : draftStorageState === 'saved' ? `本机草稿已保存${draftSavedAt ? ` · ${date(draftSavedAt)}` : ''}` : draftStorageState === 'error' ? '本机草稿未保存' : draftStorageState === 'unavailable' ? '本机自动草稿不可用' : '本机草稿自动保存' }}</span><span v-if="isLocalStore" class="offline-status"><i></i> 本地 Git · 未同步</span><span v-else class="offline-status"><i></i> GitHub docs · {{ store.branch }}</span><button type="button" class="action-button action-secondary preview-toggle" :disabled="busy" @click="togglePreview"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M1.5 8s2.3-4 6.5-4 6.5 4 6.5 4-2.3 4-6.5 4-6.5-4-6.5-4Z"/><circle cx="8" cy="8" r="1.8"/></svg>{{ previewMode ? '关闭预览' : '预览' }}</button><button type="button" class="action-button action-primary save-note-button" :disabled="busy || !title.trim() || !editMarkdown.trim()" @click="save"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="m3 8 3.2 3.2L13 4.8"/></svg>{{ busy ? '正在保存…' : isLocalStore ? '保存到本地 Git' : '保存到 GitHub' }}</button><button v-if="isLocalStore" type="button" class="action-button action-secondary sync-note-button" :aria-expanded="syncPanelOpen" @click="syncPanelOpen = !syncPanelOpen"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M4.3 11.8H3.7a2.7 2.7 0 0 1 0-5.4 4.4 4.4 0 0 1 8.4-.7 3.1 3.1 0 0 1 .2 6.1h-.6M8 13V7.8m-2 2 2-2 2 2"/></svg>同步到 GitHub</button></div></header>
    <p v-if="head" class="notes-commit"><details><summary>{{ isLocalStore ? '本地保存详情' : 'GitHub 保存详情' }}</summary><code>{{ head }}</code></details></p>
    <div v-if="discardPrompt" class="discard-backdrop" role="presentation" @keydown="handleDiscardKeydown"><section ref="discardDialogRoot" class="discard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="discard-title" tabindex="-1"><h2 id="discard-title">修改尚未保存</h2><p>{{ deleteAfterDiscard ? '确认放弃修改后，将继续核对删除的笔记；取消删除不会丢失当前输入。' : '继续编辑可保留当前输入；放弃修改后才会继续离开。' }}</p><div><button type="button" @click="keepEditing">继续编辑</button><button type="button" class="discard-action" @click="discardEdits">放弃修改</button></div></section></div>
    <div v-if="deleteDialog" class="discard-backdrop" role="presentation" @keydown="handleDeleteKeydown"><section ref="deleteDialogRoot" class="delete-note-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" tabindex="-1"><h2 id="delete-title">删除 {{ deleteIds.length }} 篇笔记？</h2><p>删除后将从笔记列表和搜索结果中移除，并提交到 {{ isLocalStore ? '本地 Git 演示库' : 'GitHub' }}。</p><small>历史版本保留在 Git 中。</small><ul><li v-for="id in deleteIds" :key="id">{{ notes.find(note => note.documentId === id)?.title || id }}</li></ul><p v-if="error" class="delete-dialog-error" role="alert">{{ error }}</p><div><button type="button" :disabled="deleteBusy" @click="deleteDialog = false; nextTick(restoreDeleteFocus)">取消</button><button type="button" class="note-delete-button" :disabled="deleteBusy" @click="deleteSelectedNotes">{{ deleteBusy ? '正在删除…' : '删除并提交' }}</button></div></section></div>
    <p v-if="error" class="reader-error" role="alert">{{ error }}</p><p v-if="message" class="notes-success" role="status">{{ message }}</p>
    <p v-if="draftStorageMessage || draftStorageWarning" class="draft-storage-warning" role="alert">{{ draftStorageMessage || draftStorageWarning }}<button type="button" class="action-button action-secondary" @click="downloadDraft">下载当前 Markdown</button></p>
    <section class="draft-recovery-area" aria-label="本机未完成草稿"><button type="button" class="action-button action-secondary recovery-check-button" :disabled="recoveryRefreshing || !draftScopeReady" title="标签页异常关闭未释放租约时，通常约 60 秒后可恢复；也可手动检查。" @click="refreshRecoveryDrafts"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M13.3 6A5.5 5.5 0 1 0 13.5 9M13.3 2.8V6h-3.2"/></svg>{{ recoveryRefreshing ? '正在检查…' : '检查可恢复草稿' }}</button><small v-if="!recoveryDrafts.length">已自动保存的草稿，可在重新打开后恢复。</small><section v-if="recoveryDrafts.length" class="draft-recovery" aria-labelledby="draft-recovery-title"><div><h2 id="draft-recovery-title">发现本机未完成草稿</h2><p>恢复不会覆盖已保存内容；保存时仍会用草稿原来的版本基线检查冲突。</p></div><ul><li v-for="draft in recoveryDrafts" :key="draft.id"><span><strong>{{ draft.title || '新建笔记' }}</strong><small>{{ draft.sourceDocumentId ? `编辑已有笔记 · ${draft.sourceKind === 'blog' ? 'Blog' : '个人笔记'}` : '新建个人笔记' }} · {{ date(draft.updatedAt) }} · 基线 {{ draft.baseHead.slice(0, 10) || '无' }}</small></span><span><button type="button" class="action-button action-secondary" :disabled="editing" @click="restoreDraft(draft)">恢复</button><button type="button" class="action-button action-secondary discard-draft-button" :disabled="editing" @click="discardRecoveredDraft(draft)">丢弃</button></span></li></ul><p v-if="editing" class="hint">请先保存或结束当前编辑，再恢复或丢弃其他草稿。</p></section></section>
    <section v-if="isLocalStore && syncPanelOpen" class="sync-info-panel" role="region" aria-label="GitHub 同步说明"><div><h2>GitHub 同步尚未接通</h2><button type="button" class="action-button action-secondary" aria-label="关闭同步说明" @click="syncPanelOpen = false">关闭</button></div><p>当前笔记只保存到此设备的本地测试 Git 库，不会上传到 GitHub 或导入私有知识库。</p><p>真实同步接通后，需要由你在 KnowledgeDB 站点填写 <code>KnowledgeDB-docs</code> 的 Contents 读写令牌；令牌只在当前标签页内存使用。此演示没有令牌输入，也不会请求 GitHub。</p></section>
      <div class="note-content">
        <template v-if="editing">
          <div class="note-title-area"><input v-model="title" :readonly="busy" aria-label="笔记标题" placeholder="无标题笔记" /><div class="note-meta"><label>来源<select :value="selected?.sourceKind || 'personal'" disabled><option value="personal">个人笔记</option><option value="blog">Blog 阅读</option></select></label><label>状态<select v-model="status" :disabled="busy"><option value="draft">草稿</option><option value="published">正式</option></select></label><div class="note-tags"><button :disabled="busy" v-for="tag in tagsText.split(',').map(tag => tag.trim()).filter(Boolean)" :key="tag" type="button" @click="tagsText = tagsText.split(',').map(value => value.trim()).filter(value => value && value !== tag).join(', ')">{{ tag }} <span aria-hidden="true">×</span></button><input v-model="tagsText" :readonly="busy" aria-label="标签，使用逗号分隔" placeholder="添加标签，逗号分隔" /></div></div></div>
          <div v-if="!previewMode" class="editor-toolbar" role="toolbar" aria-label="Markdown 格式工具"><button type="button" :disabled="busy" title="标题" aria-label="标题" @click="applyTool('heading')">H1</button><i></i><button type="button" :disabled="busy" title="加粗" aria-label="加粗" @click="applyTool('bold')"><b>B</b></button><button type="button" :disabled="busy" title="斜体" aria-label="斜体" @click="applyTool('italic')"><em>I</em></button><button type="button" :disabled="busy" title="删除线" aria-label="删除线" @click="applyTool('strike')"><s>S</s></button><i></i><button type="button" :disabled="busy" title="无序列表" aria-label="无序列表" @click="applyTool('bullet')"><svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".8"/><circle cx="4.5" cy="12" r=".8"/><circle cx="4.5" cy="18" r=".8"/></svg></button><button type="button" :disabled="busy" title="编号列表" aria-label="编号列表" @click="applyTool('number')">1.</button><button type="button" :disabled="busy" title="任务列表" aria-label="任务列表" @click="applyTool('task')"><svg viewBox="0 0 24 24"><path d="M4 5h6v6H4zM6 8l1.5 1.5L10 6M13 7h7M13 16h7M4 14h6v6H4z"/></svg></button><i></i><button type="button" :disabled="busy" title="引用" aria-label="引用" @click="applyTool('quote')">“</button><button type="button" :disabled="busy" title="代码" aria-label="代码" @click="applyTool('code')">&lt;/&gt;</button><button type="button" :disabled="busy" title="链接" aria-label="链接" @click="applyTool('link')"><svg viewBox="0 0 24 24"><path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7M14 10.5a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 19.2l1.7-1.7"/></svg></button><span></span><button type="button" :disabled="busy" title="撤销" aria-label="撤销" @click="applyTool('undo')"><svg viewBox="0 0 24 24"><path d="M9 8 5 12l4 4M5 12h8a6 6 0 0 1 6 6"/></svg></button><button type="button" :disabled="busy" title="重做" aria-label="重做" @click="applyTool('redo')"><svg viewBox="0 0 24 24"><path d="m15 8 4 4-4 4M19 12h-8a6 6 0 0 0-6 6"/></svg></button></div>
          <div v-if="previewMode" class="note-preview-stage"><article ref="previewRoot" class="document-body" v-html="preview" /></div>
          <div v-else class="note-editor-wrap" :class="{ 'drag-active': isDraggingImage }" @dragenter.prevent="captureSelection(); isDraggingImage = true" @dragover.prevent="isDraggingImage = true" @dragleave="isDraggingImage = false" @drop="dropImages"><textarea ref="editor" v-model="editMarkdown" :readonly="busy" spellcheck="false" aria-label="Markdown 正文" placeholder="开始记录你的想法…" @select="saveSelection" @keyup="saveSelection" @click="saveSelection" @scroll="saveSelection" @paste="pasteImages" /><div v-if="isDraggingImage" class="drop-hint">松开以插入图片</div></div>
          <div class="editor-footer"><span>{{ previewMode ? '实时预览' : 'Markdown' }}</span><span v-if="pendingAssets.length" role="status">{{ pendingAssets.length }} 张图片待随笔记保存</span><span v-else>粘贴或拖入图片，自动插入</span><span>{{ editMarkdown.length }} 字</span></div>
          <p v-if="selected?.sourceKind === 'blog'" class="source-card"><strong>原始出处保持关联</strong><br />{{ selected.sources?.[0]?.originalTitle }} · {{ selected.sources?.[0]?.author || '作者待核对' }} · {{ selected.sources?.[0]?.siteName }}<br /><a v-if="safeSourceUrl(selected.sources?.[0]?.canonicalUrl)" :href="safeSourceUrl(selected.sources?.[0]?.canonicalUrl)" target="_blank" rel="noopener noreferrer">{{ selected.sources?.[0]?.canonicalUrl }}</a> · 访问于 {{ selected.sources?.[0]?.accessedAt }}</p>
          <button v-if="error || draftStorageState === 'error' || draftStorageState === 'unavailable'" type="button" class="action-button action-secondary" @click="downloadDraft">下载当前草稿</button>
        </template>
        <template v-else-if="selected">
          <div class="note-view-actions"><span v-if="isLocalStore" class="offline-status"><i></i> 本地 Git · 未同步</span><span v-else class="offline-status"><i></i> GitHub docs · {{ store.branch }}</span><button type="button" class="action-button action-primary save-note-button" :disabled="!draftScopeReady" @click="beginEdit(false)">编辑笔记</button><button v-if="isLocalStore" type="button" class="action-button action-secondary sync-note-button" :aria-expanded="syncPanelOpen" @click="syncPanelOpen = !syncPanelOpen"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M4.3 11.8H3.7a2.7 2.7 0 0 1 0-5.4 4.4 4.4 0 0 1 8.4-.7 3.1 3.1 0 0 1 .2 6.1h-.6M8 13V7.8m-2 2 2-2 2 2"/></svg>同步到 GitHub</button></div><p class="eyebrow">{{ selected.sourceKind === 'blog' ? 'Blog 阅读记录' : '个人笔记' }} · {{ selected.status === 'draft' ? '草稿' : '正式' }}</p><h2>{{ selected.title }}</h2><p class="hint">{{ selected.tags.join(' · ') }} · 更新于 {{ date(selected.updated) }}</p>
          <div v-if="selected.sourceKind === 'blog'" class="source-card"><strong>原始出处</strong><p>{{ selected.sources?.[0]?.originalTitle }} · {{ selected.sources?.[0]?.author || '作者待核对' }} · {{ selected.sources?.[0]?.siteName }}</p><a v-if="safeSourceUrl(selected.sources?.[0]?.canonicalUrl)" :href="safeSourceUrl(selected.sources?.[0]?.canonicalUrl)" target="_blank" rel="noopener noreferrer">{{ selected.sources?.[0]?.canonicalUrl }}</a><p>访问于 {{ selected.sources?.[0]?.accessedAt }}</p></div>
          <article ref="readerRoot" class="document-body note-read-body" v-html="renderMarkdown(markdown, selected.path)" />
        </template>
          <div v-else class="empty-document"><h2>选择一篇笔记开始</h2><p>Blog 和个人笔记平铺显示，可组合筛选、编辑并保存。</p><button type="button" class="action-button action-primary save-note-button" :disabled="!draftScopeReady" @click="beginEdit(true)">＋ 新建笔记</button></div>
      </div>
    </div>
  </section>
</template>
