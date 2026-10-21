export type PendingNoteAsset = { name: string; type: string; base64: string }

export type OfflineNoteDraft = {
  id: string
  tabId: string
  documentId?: string
  sourceDocumentId: string | null
  sourceKind: 'blog' | 'personal'
  title: string
  tags: string[]
  status: 'draft' | 'published'
  markdown: string
  baseHead: string
  assets: PendingNoteAsset[]
  pendingRequestId?: string
  pendingRequestSignature?: string
  updatedAt: string
}

const DATABASE = 'knowledge-db-offline-note-drafts'
const STORE = 'drafts'
const TAB_STORE = 'tabs'
const MAX_DRAFT_BYTES = 24 * 1024 * 1024
const ACTIVE_TAB_LEASE_MS = 60_000

function scopedDatabaseName(namespace: string) {
  let hash = 2166136261
  for (const char of namespace) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  const suffix = namespace.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'default'
  return `${DATABASE}-${suffix}-${hash.toString(16)}`
}

function openDatabase(namespace = 'default'): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('此浏览器不支持 IndexedDB。'))
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(scopedDatabaseName(namespace), 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('tabId', 'tabId', { unique: false })
      }
      if (!db.objectStoreNames.contains(TAB_STORE)) db.createObjectStore(TAB_STORE, { keyPath: 'tabId' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('无法打开本机草稿库。'))
    request.onblocked = () => reject(new Error('本机草稿库正在升级，请关闭其他知识库标签页后重试。'))
  })
}

export async function saveOfflineNoteDraft(draft: OfflineNoteDraft, namespace = 'default'): Promise<void> {
  const serializedSize = new Blob([JSON.stringify(draft)]).size
  if (serializedSize > MAX_DRAFT_BYTES) throw new Error('草稿超过本机自动保存上限 24 MB；当前编辑内容仍保留，可下载 Markdown。')
  const db = await openDatabase(namespace)
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      let ownerError: Error | null = null
      const existing = store.get(draft.id)
      existing.onsuccess = () => {
        const current = existing.result as OfflineNoteDraft | undefined
        if (current && current.tabId !== draft.tabId) {
          ownerError = new Error('这份草稿已由另一标签页接管；当前输入仍保留，请先下载或恢复为新草稿。')
          transaction.abort()
          return
        }
        store.put(draft)
      }
      existing.onerror = () => { ownerError = existing.error || new Error('无法确认本机草稿的标签页归属。'); transaction.abort() }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(ownerError || transaction.error || new Error('本机草稿保存失败。'))
      transaction.onabort = () => reject(ownerError || transaction.error || new Error('本机空间不足，草稿未能保存。'))
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/quota|space|storage/i.test(message)) throw new Error('浏览器本机存储空间不足，草稿未能自动保存；当前编辑内容仍保留，可下载 Markdown。')
    throw error
  } finally { db.close() }
}

export async function listOfflineNoteDrafts(namespace = 'default'): Promise<OfflineNoteDraft[]> {
  const db = await openDatabase(namespace)
  try {
    return await new Promise<OfflineNoteDraft[]>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
      request.onsuccess = () => resolve((request.result as OfflineNoteDraft[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
      request.onerror = () => reject(request.error || new Error('无法读取本机草稿。'))
    })
  } finally { db.close() }
}

export async function listActiveDraftTabIds(namespace = 'default'): Promise<Set<string>> {
  const db = await openDatabase(namespace)
  try {
    return await new Promise<Set<string>>((resolve, reject) => {
      const request = db.transaction(TAB_STORE, 'readonly').objectStore(TAB_STORE).getAll()
      request.onsuccess = () => {
        const cutoff = Date.now() - ACTIVE_TAB_LEASE_MS
        resolve(new Set((request.result as { tabId: string; lastSeen: number }[]).filter(tab => tab.lastSeen >= cutoff).map(tab => tab.tabId)))
      }
      request.onerror = () => reject(request.error || new Error('无法读取草稿标签状态。'))
    })
  } finally { db.close() }
}

export async function writeDraftTabLease(tabId: string, namespace = 'default'): Promise<void> {
  const db = await openDatabase(namespace)
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(TAB_STORE, 'readwrite')
      transaction.objectStore(TAB_STORE).put({ tabId, lastSeen: Date.now() })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error('无法登记草稿标签状态。'))
      transaction.onabort = () => reject(transaction.error || new Error('无法登记草稿标签状态。'))
    })
  } finally { db.close() }
}

export async function releaseDraftTabLease(tabId: string, namespace = 'default'): Promise<void> {
  const db = await openDatabase(namespace)
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(TAB_STORE, 'readwrite')
      transaction.objectStore(TAB_STORE).delete(tabId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error('无法释放草稿标签状态。'))
      transaction.onabort = () => reject(transaction.error || new Error('无法释放草稿标签状态。'))
    })
  } finally { db.close() }
}

export async function deleteOfflineNoteDraft(id: string, expectedTabId: string, namespace = 'default'): Promise<void> {
  const db = await openDatabase(namespace)
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      let ownerError: Error | null = null
      const existing = store.get(id)
      existing.onsuccess = () => {
        const current = existing.result as OfflineNoteDraft | undefined
        if (!current) return
        if (current.tabId !== expectedTabId) {
          ownerError = new Error('这份草稿已由另一标签页接管，未删除。')
          transaction.abort()
          return
        }
        store.delete(id)
      }
      existing.onerror = () => { ownerError = existing.error || new Error('无法确认本机草稿的标签页归属。'); transaction.abort() }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(ownerError || transaction.error || new Error('无法清除本机草稿。'))
      transaction.onabort = () => reject(ownerError || transaction.error || new Error('无法清除本机草稿。'))
    })
  } finally { db.close() }
}

export async function claimOfflineNoteDraft(id: string, tabId: string, namespace = 'default'): Promise<OfflineNoteDraft> {
  const db = await openDatabase(namespace)
  try {
    return await new Promise<OfflineNoteDraft>((resolve, reject) => {
      const transaction = db.transaction([STORE, TAB_STORE], 'readwrite')
      const drafts = transaction.objectStore(STORE)
      const tabs = transaction.objectStore(TAB_STORE)
      let claimed: OfflineNoteDraft | null = null
      let claimError: Error | null = null
      const request = drafts.get(id)
      request.onsuccess = () => {
        const draft = request.result as OfflineNoteDraft | undefined
        if (!draft) { claimError = new Error('这份本机草稿已被清除。'); return }
        if (draft.tabId === tabId) { claimed = draft; return }
        const leaseRequest = tabs.get(draft.tabId)
        leaseRequest.onsuccess = () => {
          const lease = leaseRequest.result as { lastSeen: number } | undefined
          if (lease && lease.lastSeen >= Date.now() - ACTIVE_TAB_LEASE_MS) {
            claimError = new Error('另一标签页正在编辑这份草稿，请先在该标签页保存或关闭。')
            return
          }
          claimed = { ...draft, tabId, updatedAt: new Date().toISOString() }
          drafts.put(claimed)
        }
        leaseRequest.onerror = () => { claimError = leaseRequest.error || new Error('无法确认草稿是否仍在其他标签页编辑。') }
      }
      request.onerror = () => { claimError = request.error || new Error('无法读取本机草稿。') }
      transaction.oncomplete = () => claimed ? resolve(claimed) : reject(claimError || new Error('无法恢复本机草稿。'))
      transaction.onerror = () => reject(transaction.error || claimError || new Error('无法恢复本机草稿。'))
      transaction.onabort = () => reject(transaction.error || claimError || new Error('无法恢复本机草稿。'))
    })
  } finally { db.close() }
}

export function draftTabScopeKey(namespace = 'default'): string { return `knowledge-db-note-draft-tab-scope:${scopedDatabaseName(namespace)}` }

const tabChannels = new Map<string, BroadcastChannel>()
const resolvedTabIds = new Map<string, string>()

export async function resolveDraftTabId(namespace = 'default'): Promise<string> {
  const databaseName = scopedDatabaseName(namespace)
  const cachedTabId = resolvedTabIds.get(databaseName)
  if (cachedTabId) return cachedTabId
  const storageKey = draftTabScopeKey(namespace)
  let tabId: string
  let persistentSession = true
  try {
    tabId = sessionStorage.getItem(storageKey) || crypto.randomUUID()
    sessionStorage.setItem(storageKey, tabId)
  } catch {
    persistentSession = false
    tabId = `memory-${crypto.randomUUID()}`
  }
  const startedAt = Date.now()
  const instanceId = crypto.randomUUID()
  let collision = false
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(`knowledge-db-note-draft-tabs:${databaseName}`)
    tabChannels.set(databaseName, channel)
    channel.onmessage = event => {
      const message = event.data as { type?: string; tabId?: string; startedAt?: number; instanceId?: string }
      const peerStartedAt = message.startedAt ?? 0
      const peerWins = peerStartedAt < startedAt || (peerStartedAt === startedAt && (message.instanceId || '') < instanceId)
      if (message.type === 'probe' && message.tabId === tabId) {
        collision ||= peerWins
        channel.postMessage({ type: 'hello', tabId, startedAt, instanceId })
      } else if (message.type === 'hello' && message.tabId === tabId) {
        collision ||= peerWins
      }
    }
    channel.postMessage({ type: 'probe', tabId, startedAt, instanceId })
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  if (collision) {
    tabId = crypto.randomUUID()
    try { sessionStorage.setItem(storageKey, tabId) }
    catch { persistentSession = false; tabId = `memory-${crypto.randomUUID()}` }
  }
  if (!persistentSession && !tabId.startsWith('memory-')) tabId = `memory-${crypto.randomUUID()}`
  resolvedTabIds.set(databaseName, tabId)
  return tabId
}
