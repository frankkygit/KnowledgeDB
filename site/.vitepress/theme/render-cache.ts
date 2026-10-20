// Only derived HTML is persisted. Credentials, comments, asset bytes and blob URLs never are.
export const RENDER_VERSION = 'kb-html-3'
const DATABASE = 'knowledge-reader-html'
const STORE = 'html'
type Entry = { key: string; html: string; at: number }
export function renderCacheKey(repository: string, commit: string, doc: { documentId: string; path: string; contentRevision: string }) {
  return JSON.stringify([RENDER_VERSION, repository, commit, doc.documentId, doc.path, doc.contentRevision])
}
export class RenderCache {
  #memory = new Map<string, string>()
  #epoch = 0
  async #database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' })
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('cache unavailable'))
    })
  }
  async #run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.#database()
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const request = action(tx.objectStore(STORE))
        tx.oncomplete = () => resolve(request.result)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally { db.close() }
  }
  async get(key: string): Promise<string | null> {
    const epoch = this.#epoch
    if (this.#memory.has(key)) return this.#memory.get(key)!
    try {
      const entry = await this.#run<Entry | undefined>('readonly', store => store.get(key))
      if (epoch !== this.#epoch) return null
      if (entry && typeof entry.html === 'string') { this.#memory.set(key, entry.html); return entry.html }
    } catch { /* Private browsing, quotas, or disabled storage fall back to memory. */ }
    return null
  }
  async put(key: string, html: string) {
    this.#memory.set(key, html)
    const epoch = this.#epoch
    try {
      await this.#run('readwrite', store => epoch === this.#epoch ? store.put({ key, html, at: Date.now() }) : store.delete(key))
      if (epoch !== this.#epoch) return
      const entries = await this.#run<Entry[]>('readonly', store => store.getAll())
      for (const entry of entries.sort((a, b) => b.at - a.at).slice(30)) {
        if (epoch !== this.#epoch) return
        this.#memory.delete(entry.key)
        await this.#run('readwrite', store => store.delete(entry.key))
      }
    } catch { /* Reading remains usable when storage is unavailable. */ }
  }
  forget() { this.#epoch++; this.#memory.clear() }
  async clear() {
    this.forget()
    try { await this.#run('readwrite', store => store.clear()) } catch { /* No persistent cache available. */ }
  }
}
