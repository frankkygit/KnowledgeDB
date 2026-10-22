const REMEMBER_DAYS = 7

export type CredentialStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type StoredCredential = { token: string; remember: boolean }

function storageKey(kind: 'session' | 'remember', base: string, docsRepository: string, commentsRepository: string) {
  const namespace = [base || '/', docsRepository, commentsRepository].join('|')
  return `knowledge-db:${kind}:${encodeURIComponent(namespace)}`
}

export function credentialKeys(base: string, docsRepository: string, commentsRepository: string) {
  return {
    session: storageKey('session', base, docsRepository, commentsRepository),
    remember: storageKey('remember', base, docsRepository, commentsRepository),
  }
}

export function readCredential(base: string, docsRepository: string, commentsRepository: string, stores = browserStores()): StoredCredential | null {
  const keys = credentialKeys(base, docsRepository, commentsRepository)
  try { const sessionToken = stores.session?.getItem(keys.session); if (sessionToken) return { token: sessionToken, remember: false } } catch { /* The persistent store may still be available. */ }
  try {
    const raw = stores.local?.getItem(keys.remember)
    if (!raw) return null
    const value = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown }
    if (typeof value.token !== 'string' || !value.token || typeof value.expiresAt !== 'number' || value.expiresAt <= Date.now()) {
      stores.local?.removeItem(keys.remember)
      return null
    }
    return { token: value.token, remember: true }
  } catch { return null }
}

export function saveCredential(token: string, remember: boolean, base: string, docsRepository: string, commentsRepository: string, stores = browserStores()): boolean {
  const keys = credentialKeys(base, docsRepository, commentsRepository)
  if (remember) {
    try { stores.session?.removeItem(keys.session) }
    catch { try { stores.session?.setItem(keys.session, token) } catch { /* Try the selected persistent mode below. */ }; return false }
    try {
      if (!stores.local) throw new Error('local storage unavailable')
      stores.local.setItem(keys.remember, JSON.stringify({ token, expiresAt: Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000 }))
      return true
    } catch {
      try { stores.session?.setItem(keys.session, token) } catch { /* Keep the connection in memory only. */ }
      return false
    }
  }
  let persistentRemoved = false
  try { if (stores.local) { stores.local.removeItem(keys.remember); persistentRemoved = true } } catch { /* Keep the current-tab credential usable while reporting incomplete cleanup. */ }
  try { if (!stores.session) return false; stores.session.setItem(keys.session, token); return persistentRemoved }
  catch { return false }
}

export function clearCredential(base: string, docsRepository: string, commentsRepository: string, stores = browserStores()): boolean {
  const keys = credentialKeys(base, docsRepository, commentsRepository)
  let cleared = true
  try { if (stores.session) stores.session.removeItem(keys.session) } catch { cleared = false }
  try { if (stores.local) stores.local.removeItem(keys.remember) } catch { cleared = false }
  return cleared && Boolean(stores.session && stores.local)
}

function browserStores() {
  let session: Storage | undefined, local: Storage | undefined
  try { session = window.sessionStorage } catch { /* Try localStorage independently. */ }
  try { local = window.localStorage } catch { /* Try sessionStorage independently. */ }
  return { session, local }
}
