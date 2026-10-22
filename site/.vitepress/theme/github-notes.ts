import { safePath } from './github-docs.ts'
import { buildNoteContent, editableNoteMarkdown, noteReferencedAssets } from './note-content.ts'
import { digest } from './comment-model.ts'
import { SessionCache, createLimiter } from './session-cache.ts'
import type { NoteDeleteResult, NoteDocument, NoteRecord, NoteSaveInput, NoteSaveResult, NotesStore } from './note-store'

type TreeEntry = { path: string; mode: string; type: string; sha: string; size?: number }
type State = { head: string; tree: string; entries: Map<string, TreeEntry>; notes: any; documents: any; search: any }
class NotesGitHubError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function decodeBase64(content: string): Uint8Array {
  const binary = atob(content.replace(/\s/g, ''))
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}
function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
function parseJson(bytes: Uint8Array, label: string): any {
  try { return JSON.parse(new TextDecoder().decode(bytes)) }
  catch { throw new Error(`${label} 格式无效；已停止保存，以保护现有目录。`) }
}
function validId(value: string) { return /^note-[A-Za-z0-9-]+$/.test(value) }

export class GitHubNotesStore implements NotesStore {
  readonly kind = 'github' as const
  readonly namespace: string
  readonly branch: string
  #token: string
  #abort = new AbortController()
  #snapshot: State | null = null
  #cache = new SessionCache<string, Uint8Array>(256, 32 * 1024 * 1024, bytes => bytes.byteLength)
  #limit = createLimiter(4)
  #listCache: { at: number; value: { notes: NoteRecord[]; head: string } } | null = null
  #disconnected = false
  #epoch = 0
  #statePending = new Map<boolean, Promise<State>>()
  #stateSequence = 0
  #privateConfirmed = false
  #privatePending: Promise<void> | null = null
  constructor(readonly repository: string, token: string, branch = 'main') {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token.trim()) throw new Error('请填写 docs 私库 owner/repo 和 Contents 读写令牌。')
    safePath(branch)
    this.branch = branch
    this.namespace = `github:${repository}:${branch}`
    this.#token = token.trim()
  }

  async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    if (this.#disconnected) throw new DOMException('docs 会话已断开。', 'AbortError')
    let response: Response
    try {
      response = await fetch(`https://api.github.com/repos/${this.repository}${path ? `/${path}` : ''}`, {
        method,
        headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/vnd.github+json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: this.#abort.signal,
      })
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw cause
      throw new Error(`连接 GitHub docs 私库失败，请检查网络或浏览器拦截；输入仍保留。`)
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: 'docs 令牌无效或已过期；编辑输入和本机草稿仍保留。',
        403: 'GitHub 拒绝 docs 写入；请确认令牌对私有 KnowledgeDB-docs 有 Contents 读写权限及分支允许更新。编辑输入和草稿仍保留。',
        404: 'docs 仓库、main 分支或所需目录不可读；请检查仓库和 Contents 访问权限。',
        409: 'docs 分支已并发更新或 Git 对象冲突；请刷新后检查内容。编辑输入和草稿仍保留。',
        422: 'GitHub 拒绝此 Git 对象或分支更新；可能是分支保护规则。编辑输入和草稿仍保留。',
        429: 'GitHub 请求过于频繁，请稍后重试；编辑输入和草稿仍保留。',
      }
      throw new NotesGitHubError(response.status, messages[response.status] || `GitHub docs 请求失败（${response.status}）；编辑输入和草稿仍保留。`)
    }
    const data = response.status === 204 ? null : await response.json()
    if (this.#disconnected) throw new DOMException('docs 会话已断开。', 'AbortError')
    return data
  }

  async connect() {
    await this.ensurePrivate()
    const state = await this.readState(true)
    if (this.#disconnected) throw new DOMException('docs 会话已断开。', 'AbortError')
    if (!state.documents || !Array.isArray(state.documents.documents)) throw new Error('catalog/documents.json 无效，已停止连接。')
    if (!state.search || !Array.isArray(state.search.items)) throw new Error('catalog/search.json 无效，已停止连接。')
  }

  private async ensurePrivate(): Promise<void> {
    if (this.#privateConfirmed) return
    if (this.#privatePending) return this.#privatePending
    const epoch = this.#epoch
    const pending = (async () => {
      const repo = await this.request('')
      if (this.#disconnected || epoch !== this.#epoch) throw new DOMException('docs 会话已断开。', 'AbortError')
      if (repo.private !== true) throw new Error('笔记必须保存在私有 docs 仓库，请检查仓库设置。')
      this.#privateConfirmed = true
    })()
    this.#privatePending = pending
    try { await pending }
    finally { if (this.#privatePending === pending) this.#privatePending = null }
  }

  readState(force = false): Promise<State> {
    const pending = this.#statePending.get(force)
    if (pending) return pending
    const request = this.#loadState(force).finally(() => {
      if (this.#statePending.get(force) === request) this.#statePending.delete(force)
    })
    this.#statePending.set(force, request)
    return request
  }

  /** Writes bypass any older read pending and inspect the moving ref themselves. */
  private readWriteState(): Promise<State> { return this.#loadState(true) }

  async #loadState(force = false): Promise<State> {
    await this.ensurePrivate()
    const epoch = this.#epoch
    const sequence = ++this.#stateSequence
    const ref = await this.request(`git/ref/heads/${safePath(this.branch)}`)
    const head = ref.object?.sha
    if (!/^[a-f0-9]{40}$/i.test(head || '')) throw new Error('docs main 分支 HEAD 无效。')
    if (this.#snapshot?.head === head) return this.#snapshot
    const commit = await this.request(`git/commits/${head}`)
    const treeResult = await this.request(`git/trees/${commit.tree.sha}?recursive=1`)
    if (treeResult.truncated) throw new Error('docs 仓库目录过大，无法安全更新索引。')
    const entries = new Map<string, TreeEntry>((treeResult.tree || []).filter((entry: TreeEntry) => entry.type === 'blob').map((entry: TreeEntry) => [entry.path, entry]))
    const read = async (path: string, required: boolean) => {
      const entry = entries.get(path)
      if (!entry) {
        if (required) throw new Error(`${path} 不存在；已停止保存以避免覆盖或重建现有目录。`)
        return null
      }
      return this.readBlob(entry.sha)
    }
    const [notesBytes, documentsBytes, searchBytes] = await Promise.all([
      read('catalog/notes.json', false), read('catalog/documents.json', true), read('catalog/search.json', true),
    ])
    const notes = notesBytes ? parseJson(notesBytes, 'catalog/notes.json') : { schemaVersion: 1, notes: [], requests: {} }
    const documents = parseJson(documentsBytes!, 'catalog/documents.json')
    const search = parseJson(searchBytes!, 'catalog/search.json')
    if (notes.schemaVersion !== 1 || !Array.isArray(notes.notes) || (notes.requests && typeof notes.requests !== 'object')) throw new Error('catalog/notes.json 格式不兼容，已停止保存。')
    notes.requests ||= {}
    if (documents.schemaVersion !== 1 || !Array.isArray(documents.documents)) throw new Error('catalog/documents.json 格式不兼容，已停止保存。')
    if (search.schemaVersion !== 1 || !Array.isArray(search.items)) throw new Error('catalog/search.json 格式不兼容，已停止保存。')
    const state = { head, tree: commit.tree.sha, entries, notes, documents, search }
    if (!this.#disconnected && epoch === this.#epoch && sequence === this.#stateSequence) this.#snapshot = state
    return state
  }

  async readBlob(sha: string): Promise<Uint8Array> {
    return this.#cache.getOrLoad(sha, async () => {
      const blob = await this.#limit(() => this.request(`git/blobs/${sha}`))
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('GitHub 返回了不支持的 blob 编码。')
      return decodeBase64(blob.content)
    })
  }

  async list(options: { force?: boolean } = {}): Promise<{ notes: NoteRecord[]; head: string }> {
    const epoch = this.#epoch
    if (!options.force && this.#listCache && Date.now() - this.#listCache.at < 30_000) return this.#listCache.value
    const state = await this.readState(Boolean(options.force))
    if (this.#disconnected || epoch !== this.#epoch) throw new DOMException('docs 会话已断开。', 'AbortError')
    const notes: NoteRecord[] = state.notes.notes.map((note: any) => {
      if (!validId(note.documentId) || note.path !== `content/notes/${note.documentId}/index.md` || !['blog', 'personal'].includes(note.sourceKind) || !['draft', 'published'].includes(note.status) || !Array.isArray(note.tags) || !Array.isArray(note.sources)) throw new Error('笔记目录记录无效；已停止读取。')
      const searchable = state.search.items.filter((item: any) => item.documentId === note.documentId).map((item: any) => item.text || '').join(' ')
      return { ...note, _text: searchable }
    })
    const result = { notes, head: state.head }
    if (!this.#disconnected && epoch === this.#epoch) this.#listCache = { at: Date.now(), value: result }
    return result
  }

  async get(documentId: string): Promise<NoteDocument> {
    const epoch = this.#epoch
    if (!validId(documentId)) throw new Error('笔记 ID 格式无效。')
    const state = this.#snapshot || await this.readState()
    if (this.#disconnected || epoch !== this.#epoch) throw new DOMException('docs 会话已断开。', 'AbortError')
    this.#snapshot ||= state
    const note = state.notes.notes.find((item: any) => item.documentId === documentId)
    if (!note || note.path !== `content/notes/${documentId}/index.md`) throw new Error('该笔记不在当前 docs 分支目录中。')
    const entry = state.entries.get(note.path)
    if (!entry) throw new Error('笔记正文在目录中缺失。')
    const identityMarkdown = new TextDecoder().decode(await this.readBlob(entry.sha))
    if (this.#disconnected) throw new DOMException('docs 会话已断开。', 'AbortError')
    return { note, markdown: editableNoteMarkdown(identityMarkdown), identityMarkdown, head: state.head }
  }

  async asset(documentId: string, name: string): Promise<Blob> {
    const epoch = this.#epoch
    if (!validId(documentId) || !/^[A-Za-z0-9_.-]{1,100}\.(?:png|jpe?g|gif|webp|avif)$/i.test(name)) throw new Error('附件路径无效。')
    const state = this.#snapshot || await this.readState()
    if (this.#disconnected || epoch !== this.#epoch) throw new DOMException('docs 会话已断开。', 'AbortError')
    this.#snapshot ||= state
    const path = `content/notes/${documentId}/assets/${name}`
    const entry = state.entries.get(path)
    if (!entry) throw new Error('笔记图片附件不存在。')
    const mime = name.toLowerCase().endsWith('.png') ? 'image/png' : name.toLowerCase().endsWith('.jpg') || name.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : name.toLowerCase().endsWith('.gif') ? 'image/gif' : name.toLowerCase().endsWith('.avif') ? 'image/avif' : 'image/webp'
    const bytes = await this.readBlob(entry.sha)
    if (this.#disconnected || epoch !== this.#epoch) throw new DOMException('docs 会话已断开。', 'AbortError')
    return new Blob([bytes], { type: mime })
  }

  async save(input: NoteSaveInput, expectedHead: string, requestId: string): Promise<NoteSaveResult> {
    if (!/^[a-f0-9]{40}$/i.test(expectedHead)) throw new Error('草稿没有有效的 docs HEAD 基线；请刷新目录后重新编辑。')
    if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error('保存请求 ID 无效。')
    if (!input.title.trim() || !input.markdown.trim() || !['draft', 'published'].includes(input.status) || !['personal', 'blog'].includes(input.sourceKind)) throw new Error('标题、正文、来源或状态无效。')
    const state = await this.readWriteState()
    const payloadHash = await digest(JSON.stringify(input))
    const prior = state.notes.requests[requestId]
    if (prior) {
      if (prior.operation === 'delete') throw new NotesGitHubError(409, '此 requestId 已用于删除操作，不能再次保存。')
      if (prior.payloadHash !== payloadHash || prior.documentId !== input.documentId) throw new NotesGitHubError(409, '同一保存请求 ID 对应不同内容，拒绝重复写入。')
      const note = state.notes.notes.find((item: any) => item.documentId === prior.documentId)
      if (!note) throw new Error('保存请求记录找不到对应笔记，已停止重复保存。')
      const originalCommit = await this.findRequestCommit(requestId)
      await this.readWriteState()
      return { note, head: originalCommit }
    }
    if (state.head !== expectedHead) throw new NotesGitHubError(409, 'docs main 已被其他窗口或编辑者更新。请刷新后合并，再保存；当前输入已保留。')
    if (!validId(input.documentId)) throw new Error('新笔记 ID 无效。')
    const existing = input.sourceDocumentId ? state.notes.notes.find((item: any) => item.documentId === input.sourceDocumentId) : null
    if (input.sourceDocumentId && (!existing || input.documentId !== input.sourceDocumentId)) throw new Error('目标笔记已不存在或 ID 不匹配；已停止保存。')
    if (existing && (existing.created == null || existing.sourceKind !== input.sourceKind)) throw new Error('笔记的创建时间或来源类别不一致；已停止保存。')
    if (!existing && (state.entries.has(`content/notes/${input.documentId}/index.md`) || state.documents.documents.some((doc: any) => doc.documentId === input.documentId))) throw new NotesGitHubError(409, '新文档 ID 已存在，已停止覆盖。')
    const notePath = `content/notes/${input.documentId}/index.md`
    const oldMarkdown = existing && state.entries.has(notePath) ? new TextDecoder().decode(await this.readBlob(state.entries.get(notePath)!.sha)) : ''
    const now = new Date().toISOString()
    const safeInput: NoteSaveInput = existing?.sourceKind === 'blog' ? { ...input, sources: existing.sources } : input
    const created = existing?.created
    const oldAssetPaths = noteReferencedAssets(oldMarkdown, notePath)
    const pendingAssets = new Map<string, Uint8Array>()
    const newAssetPaths = new Set<string>()
    for (const asset of input.assets) {
      if (!/^[A-Za-z0-9_.-]{1,100}\.(?:png|jpe?g|gif|webp|avif)$/i.test(asset.name) || !/^image\/(?:png|jpeg|gif|webp|avif)$/.test(asset.type) || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.base64)) throw new Error('图片附件无效；当前输入仍保留。')
      const bytes = decodeBase64(asset.base64)
      if (!bytes.length || bytes.length > 5_000_000) throw new Error('单张图片需小于 5 MB。')
      const path = `content/notes/${input.documentId}/assets/${asset.name}`
      if (state.entries.has(path)) throw new NotesGitHubError(409, '图片附件文件名已存在，拒绝覆盖。')
      if (pendingAssets.has(path)) throw new Error('图片附件名称重复。')
      pendingAssets.set(path, bytes); newAssetPaths.add(path)
    }
    const bodyAssetPaths = noteReferencedAssets(input.markdown, notePath)
    const allAssetBytes = new Map<string, Uint8Array>(pendingAssets)
    for (const path of bodyAssetPaths) {
      if (allAssetBytes.has(path)) continue
      const entry = state.entries.get(path)
      if (!entry || !oldAssetPaths.includes(path)) throw new Error(`正文引用了未上传或不属于此笔记的图片：${path}`)
      allAssetBytes.set(path, await this.readBlob(entry.sha))
    }
    const content = await buildNoteContent(safeInput, oldMarkdown, allAssetBytes, created || now, now)
    const revisionHash = content.snapshot.contentRevision.slice('sha256:'.length)
    const snapshotPath = `revisions/${input.documentId}/${revisionHash}.json`
    const snapshotBytes = new TextEncoder().encode(`${JSON.stringify(content.snapshot, null, 2)}\n`)
    const existingSnapshot = state.entries.get(snapshotPath)
    if (existingSnapshot) {
      const priorBytes = await this.readBlob(existingSnapshot.sha)
      if (new TextDecoder().decode(priorBytes) !== new TextDecoder().decode(snapshotBytes)) throw new Error('内容版本摘要与既有快照冲突；已停止覆盖。')
    }
    const note: NoteRecord & { contentRevision: string } = {
      documentId: input.documentId, sourceKind: input.sourceKind, title: input.title.normalize('NFC').trim(), status: input.status,
      tags: [...new Set(input.tags.map(tag => tag.normalize('NFC').trim()).filter(Boolean))], created: created || now, updated: now,
      sources: input.sourceKind === 'blog' ? safeInput.sources : [], path: notePath, contentRevision: content.contentRevision,
    }
    const notes = { ...state.notes, schemaVersion: 1, notes: [...state.notes.notes.filter((item: any) => item.documentId !== note.documentId), note], requests: { ...state.notes.requests, [requestId]: { payloadHash, documentId: note.documentId } } }
    const docEntry = { documentId: note.documentId, type: 'notes', path: note.path, title: note.title, status: note.status, contentRevision: note.contentRevision, sourceKind: note.sourceKind }
    const documents = { ...state.documents, documents: [...state.documents.documents.filter((item: any) => item.documentId !== note.documentId), docEntry] }
    const search = { ...state.search, items: [...state.search.items.filter((item: any) => item.documentId !== note.documentId), ...content.searchItems] }
    const writes = new Map<string, { content: string; encoding: 'utf-8' | 'base64' }>()
    writes.set(note.path, { content: content.markdown, encoding: 'utf-8' })
    writes.set(snapshotPath, { content: new TextDecoder().decode(snapshotBytes), encoding: 'utf-8' })
    writes.set('catalog/notes.json', { content: `${JSON.stringify(notes, null, 2)}\n`, encoding: 'utf-8' })
    writes.set('catalog/documents.json', { content: `${JSON.stringify(documents, null, 2)}\n`, encoding: 'utf-8' })
    writes.set('catalog/search.json', { content: `${JSON.stringify(search, null, 2)}\n`, encoding: 'utf-8' })
    for (const path of newAssetPaths) writes.set(path, { content: encodeBase64(allAssetBytes.get(path)!), encoding: 'base64' })

    const treeEntries = []
    for (const [path, value] of writes) {
      if (existingSnapshot && path === snapshotPath) continue
      const blob = await this.request('git/blobs', 'POST', value)
      treeEntries.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
    }
    const tree = await this.request('git/trees', 'POST', { base_tree: state.tree, tree: treeEntries })
    const commit = await this.request('git/commits', 'POST', { message: `Update note: ${note.title}\n\nNote-Request: ${requestId}`, tree: tree.sha, parents: [state.head] })
    try {
      await this.request(`git/refs/heads/${safePath(this.branch)}`, 'PATCH', { sha: commit.sha, force: false })
    } catch (cause) {
      if (cause instanceof NotesGitHubError && [409, 422].includes(cause.status)) {
        const latest = await this.request(`git/ref/heads/${safePath(this.branch)}`)
        if (latest.object?.sha !== state.head) throw new NotesGitHubError(409, '保存期间 docs main 已并发更新；请刷新并合并，当前输入已保留。')
        throw new NotesGitHubError(cause.status, 'GitHub 拒绝更新 docs main；请检查分支保护规则，当前输入已保留。')
      }
      throw cause
    }
    await this.readWriteState()
    this.#listCache = null
    return { note, head: commit.sha }
  }

  async deleteNotes(documentIds: string[], expectedHead: string, requestId: string): Promise<NoteDeleteResult> {
    if (!/^[a-f0-9]{40}$/i.test(expectedHead)) throw new Error('删除请求没有有效的 docs HEAD 基线；请刷新目录后重试。')
    if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error('删除请求 ID 无效。')
    if (!Array.isArray(documentIds) || !documentIds.length || documentIds.some(id => !validId(id))) throw new Error('删除目标笔记 ID 无效。')
    const ids = [...new Set(documentIds)].sort()
    if (ids.length !== documentIds.length) throw new Error('删除目标包含重复笔记。请刷新后重试。')
    const payloadHash = await digest(JSON.stringify({ operation: 'delete', expectedHead, documentIds: ids }))
    const state = await this.readWriteState()
    const prior = state.notes.requests[requestId]
    if (prior) {
      if (prior.operation !== 'delete' || prior.payloadHash !== payloadHash || JSON.stringify(prior.documentIds) !== JSON.stringify(ids)) throw new NotesGitHubError(409, '此 requestId 已用于不同操作或笔记集合，拒绝重复删除。')
      return { documentIds: ids, head: await this.findRequestCommit(requestId) }
    }
    if (state.head !== expectedHead) throw new NotesGitHubError(409, 'docs main 已被其他窗口或编辑者更新。请刷新目录后确认删除；当前选择仍保留。')
    const targets = ids.map(id => {
      const matchingNotes = state.notes.notes.filter((item: any) => item.documentId === id)
      const matchingDocs = state.documents.documents.filter((item: any) => item.documentId === id)
      const note = matchingNotes[0]
      const doc = matchingDocs[0]
      const body = state.entries.get(`content/notes/${id}/index.md`)
      const otherSearchRecords = state.search.items.filter((item: any) => item.documentId === id && item.type !== 'notes')
      if (matchingNotes.length !== 1 || matchingDocs.length !== 1 || !note || note.path !== `content/notes/${id}/index.md` || !doc || doc.type !== 'notes' || doc.path !== note.path || !body || body.type !== 'blob' || body.mode !== '100644' || otherSearchRecords.length) throw new Error(`笔记 ${id} 在活动目录中不存在或映射异常；已停止删除。`)
      return note
    })
    const notes = { ...state.notes, notes: state.notes.notes.filter((item: any) => !ids.includes(item.documentId)), requests: { ...state.notes.requests, [requestId]: { operation: 'delete', payloadHash, documentIds: ids } } }
    const documents = { ...state.documents, documents: state.documents.documents.filter((item: any) => !ids.includes(item.documentId) || item.type !== 'notes' || item.path !== `content/notes/${item.documentId}/index.md`) }
    const search = { ...state.search, items: state.search.items.filter((item: any) => !ids.includes(item.documentId)) }
    const title = targets.length === 1 ? targets[0].title : `${targets.length} 篇笔记`
    const writes = new Map([
      ['catalog/notes.json', `${JSON.stringify(notes, null, 2)}\n`],
      ['catalog/documents.json', `${JSON.stringify(documents, null, 2)}\n`],
      ['catalog/search.json', `${JSON.stringify(search, null, 2)}\n`],
    ])
    const treeEntries: { path: string; mode: string; type: string; sha: string | null }[] = targets.map(note => ({ path: note.path, mode: '100644', type: 'blob', sha: null }))
    for (const [path, content] of writes) {
      const blob = await this.request('git/blobs', 'POST', { content, encoding: 'utf-8' })
      treeEntries.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
    }
    const tree = await this.request('git/trees', 'POST', { base_tree: state.tree, tree: treeEntries })
    const commit = await this.request('git/commits', 'POST', { message: `Delete note: ${title}\n\nNote-Request: ${requestId}`, tree: tree.sha, parents: [state.head] })
    try {
      await this.request(`git/refs/heads/${safePath(this.branch)}`, 'PATCH', { sha: commit.sha, force: false })
    } catch (cause) {
      if (cause instanceof NotesGitHubError && [409, 422].includes(cause.status)) {
        const latest = await this.request(`git/ref/heads/${safePath(this.branch)}`)
        if (latest.object?.sha !== state.head) throw new NotesGitHubError(409, '删除期间 docs main 已并发更新；请刷新目录并重新确认，当前选择仍保留。')
        throw new NotesGitHubError(cause.status, 'GitHub 拒绝更新 docs main；请检查分支保护规则，当前选择仍保留。')
      }
      throw cause
    }
    await this.readWriteState()
    this.#listCache = null
    return { documentIds: ids, head: commit.sha }
  }

  async findRequestCommit(requestId: string): Promise<string> {
    for (let page = 1; page <= 100; page++) {
      const commits = await this.request(`commits?path=catalog/notes.json&per_page=100&page=${page}`)
      if (!Array.isArray(commits)) throw new Error('无法核验此前的保存提交；请保留草稿并重试。')
      const match = commits.find((commit: any) => commit.commit?.message?.split('\n').includes(`Note-Request: ${requestId}`))
      if (match) return match.sha
      if (commits.length < 100) break
    }
    throw new Error('找到幂等记录但无法定位原始 Git 提交；保留草稿且不重复创建提交。')
  }

  clearPrivateCache() { this.#epoch++; this.#cache.clear(); this.#snapshot = null; this.#listCache = null; this.#statePending.clear(); this.#privateConfirmed = false; this.#privatePending = null }
  disconnect() { this.#disconnected = true; this.clearPrivateCache(); this.#abort.abort(); this.#token = '' }
}
