import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
const vue = require('vue')
const { parse, compileScript } = require('@vue/compiler-sfc')
const { transformSync } = require('esbuild')

function moduleFromTs(file, suppliedWindow) {
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const output = { exports: {} }
  new Function('module', 'exports', 'window', code)(output, output.exports, suppliedWindow)
  return output.exports
}

class MemoryStorage {
  data = new Map()
  denied = false
  getItem(key) { return this.data.get(key) ?? null }
  setItem(key, value) { if (this.denied) throw new Error('storage denied'); this.data.set(key, String(value)) }
  removeItem(key) { if (this.denied) throw new Error('storage denied'); this.data.delete(key) }
}
const session = new MemoryStorage(), local = new MemoryStorage()
const fakeWindow = { sessionStorage: session, localStorage: local }
const credential = moduleFromTs(path.join(root, 'site/.vitepress/theme/remember-browser.ts'), fakeWindow)
const { credentialKeys, readCredential, saveCredential, clearCredential } = credential
const identity = { base: '/knowledge/', docs: 'owner/docs', comments: 'owner/comments' }
assert.equal(saveCredential('session-token', false, identity.base, identity.docs, identity.comments), true)
assert.deepEqual(readCredential(identity.base, identity.docs, identity.comments), { token: 'session-token', remember: false })
assert.equal(readCredential('/', identity.docs, identity.comments), null, 'base path is part of the credential namespace')

session.data.clear()
assert.equal(saveCredential('remember-token', true, identity.base, identity.docs, identity.comments), true)
assert.deepEqual(readCredential(identity.base, identity.docs, identity.comments), { token: 'remember-token', remember: true })
const keys = credentialKeys(identity.base, identity.docs, identity.comments)
const stored = JSON.parse(local.getItem(keys.remember))
assert.ok(stored.expiresAt - Date.now() <= 7 * 24 * 60 * 60 * 1000 && stored.expiresAt - Date.now() > 7 * 24 * 60 * 60 * 1000 - 1000)
local.setItem(keys.remember, JSON.stringify({ token: 'expired-token', expiresAt: Date.now() - 1 }))
assert.equal(readCredential(identity.base, identity.docs, identity.comments), null)
assert.equal(local.getItem(keys.remember), null, 'expired remembered credentials are deleted')
assert.equal(saveCredential('other-repo-token', true, identity.base, identity.docs, 'owner/other-comments'), true)
assert.equal(readCredential(identity.base, identity.docs, identity.comments), null, 'comments repository is part of the credential namespace')
clearCredential(identity.base, identity.docs, identity.comments)
assert.equal(readCredential(identity.base, identity.docs, 'owner/other-comments')?.token, 'other-repo-token')
local.denied = true
assert.equal(saveCredential('denied-token', true, identity.base, identity.docs, identity.comments), false)
local.denied = false
clearCredential(identity.base, identity.docs, 'owner/other-comments')
saveCredential('old-remembered-token', true, identity.base, identity.docs, identity.comments)
local.denied = true
assert.equal(saveCredential('new-session-token', false, identity.base, identity.docs, identity.comments), false, 'a failed remembered-token removal is reported')
assert.equal(readCredential(identity.base, identity.docs, identity.comments)?.token, 'new-session-token', 'the available session store remains usable')
assert.equal(clearCredential(identity.base, identity.docs, identity.comments), false, 'failed credential removal is reported to the UI')
local.denied = false
clearCredential(identity.base, identity.docs, identity.comments)

const originalGlobals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch }
const originalTimers = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
function makeLayoutHarness(failure = '') {
  const clients = []
  const noteStores = []
  const mounted = []
  let cacheClears = 0
  class MockDocs {
    constructor(config, token) { Object.assign(this, { config, token }); clients.push(this) }
    async json(file) {
      if (failure === '401') throw new Error('令牌无效或已过期，请重新连接。')
      if (failure === '403') throw new Error('GitHub 拒绝访问或请求限流，请检查权限或稍后重试。')
      if (failure === 'network') throw new Error('Failed to fetch')
      return file.includes('papers') ? { papers: [] } : { items: [] }
    }
    disconnect() { this.token = '' }
  }
  class MockNotes {
    constructor(repository, token) { Object.assign(this, { repository, token }); noteStores.push(this) }
    async connect() {}
    disconnect() { this.token = '' }
    clearPrivateCache() { this.cleared = true }
  }
  class MockCache { async clear() { cacheClears++ } forget() {} }
  const source = fs.readFileSync(path.join(root, 'site/.vitepress/theme/ReaderLayout.vue'), 'utf8')
  const script = compileScript(parse(source).descriptor, { id: 'reader-session-ui' }).content
  const code = transformSync(script, { loader: 'ts', format: 'cjs', target: 'es2022', define: { 'import.meta.env.DEV': 'false' } }).code
  const output = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'vue') return { ...vue, onMounted: callback => mounted.push(callback), onBeforeUnmount() {} }
    if (name === 'vitepress') return { withBase: value => value }
    if (name.includes('github-docs')) return { GitHubDocs: MockDocs, commentsConfig: config => ({ repository: config?.commentsRepository || 'owner/comments', branch: 'main' }) }
    if (name.includes('github-notes')) return { GitHubNotesStore: MockNotes }
    if (name.includes('remember-browser')) return credential
    if (name.includes('render-cache')) return { RenderCache: MockCache, renderCacheKey: () => '' }
    if (name.includes('markdown')) return { renderMarkdown: () => '', sanitizeHtml: value => value }
    if (name.includes('ReaderComments')) return {}
    if (name.includes('OfflineNotes')) return {}
    if (name.includes('katex')) return {}
    throw new Error(`Unexpected ReaderLayout dependency: ${name}`)
  }, output, output.exports)
  const state = vue.effectScope().run(() => output.exports.default.setup({}, { expose() {} }))
  const config = { repository: identity.docs, ref: 'a'.repeat(40), catalogPath: 'catalog/papers.json', searchPath: 'catalog/search.json' }
  globalThis.window = { ...fakeWindow, location: { hash: '' }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {}, scrollTo() {}, scrollY: 120 }
  globalThis.document = { addEventListener() {}, removeEventListener() {} }
  globalThis.fetch = async () => ({ ok: true, json: async () => config })
  return { state, clients, noteStores, mounted, get cacheClears() { return cacheClears } }
}

try {
  // An existing seven-day credential autoconnects only after the real ReaderLayout mount hook loads config.
  saveCredential('auto-token', true, '/', identity.docs, identity.comments)
  const expiryBeforeReload = JSON.parse(local.getItem(credentialKeys('/', identity.docs, identity.comments).remember)).expiresAt
  let layout = makeLayoutHarness()
  await layout.mounted[0]()
  assert.equal(layout.clients[0].token, 'auto-token')
  assert.equal(layout.state.connected.value, true)
  assert.equal(JSON.parse(local.getItem(credentialKeys('/', identity.docs, identity.comments).remember)).expiresAt, expiryBeforeReload, 'automatic validation does not extend the seven-day deadline')
  layout.state.forgetAuthorization()
  assert.equal(readCredential('/', identity.docs, identity.comments), null)
  assert.equal(layout.noteStores[0].cleared, true)
  assert.equal(layout.cacheClears, 1)

  session.data.clear()
  saveCredential('session-reload-token', false, '/', identity.docs, identity.comments)
  layout = makeLayoutHarness()
  await layout.mounted[0]()
  assert.equal(layout.clients[0].token, 'session-reload-token', 'sessionStorage restores the same-tab login after refresh')
  session.data.clear()

  for (const [kind, expectedCredential] of [['401', null], ['403', 'keep-403'], ['network', 'keep-network']]) {
    saveCredential(expectedCredential || `discard-${kind}`, true, '/', identity.docs, identity.comments)
    layout = makeLayoutHarness(kind)
    await layout.mounted[0]()
    assert.equal(layout.state.connected.value, false)
    const after = readCredential('/', identity.docs, identity.comments)?.token || null
    assert.equal(after, expectedCredential, `${kind} credential cleanup policy`)
    if (kind === 'network') {
      assert.equal(layout.state.storedCredentialAvailable.value, true)
      layout.state.disconnect(false)
      assert.equal(readCredential('/', identity.docs, identity.comments)?.token, 'keep-network', 'ordinary disconnect keeps the selected browser credential')
      await layout.state.retryStoredAuthorization()
      assert.equal(layout.clients.length, 2, 'the user can explicitly retry without an automatic retry loop')
    }
  }

  // A denied browser storage write warns but does not block a manually entered, valid PAT.
  local.denied = true
  layout = makeLayoutHarness()
  layout.state.config.value = { repository: identity.docs, ref: 'a'.repeat(40), catalogPath: 'catalog/papers.json', searchPath: 'catalog/search.json' }
  layout.state.rememberBrowser.value = true
  layout.state.tokenInput.value = 'manual-token'
  await layout.state.connectWithToken()
  assert.equal(layout.state.connected.value, true)
  assert.match(layout.state.credentialNotice.value, /存储或旧授权清理不完整/)
  local.denied = false

  // The real OfflineNotes setup remains mounted while inactive; activation consults the TTL-backed store without replacing editor state.
  const hooks = { mounted: [], unmounted: [] }
  let listCalls = 0, listLoads = 0, getCalls = 0
  let listCache = null, cachedAt = 0
  const existingNote = { documentId: 'note-one', type: 'notes', contentRevision: 'rev-one', title: 'Existing', path: 'content/notes/note-one/index.md', tags: ['tag'], status: 'published', sourceKind: 'personal', sources: [], updated: '2026-10-22' }
  const noteStore = {
    kind: 'github', namespace: 'workspace-test', branch: 'main',
    async list() {
      listCalls++
      if (listCache && Date.now() - cachedAt < 30_000) return listCache
      listLoads++; cachedAt = Date.now(); listCache = { notes: [existingNote], head: 'b'.repeat(40) }; return listCache
    },
    async get(id) { getCalls++; if (this.getFailure) throw this.getFailure; return { note: { ...existingNote, documentId: id }, markdown: '# Current body', head: 'b'.repeat(40) } },
    async asset() { return new Blob() }, async save() { throw new Error('unexpected save') }, async deleteNotes() { throw new Error('unexpected delete') },
  }
  const noteWindowListeners = new Map()
  globalThis.window = { location: { hash: '' }, history: { replaceState() {} }, addEventListener(type, callback) { noteWindowListeners.set(type, callback) }, removeEventListener() {} }
  globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {}, querySelector() { return null } }
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}
  const source = fs.readFileSync(path.join(root, 'site/.vitepress/theme/OfflineNotes.vue'), 'utf8')
  const script = compileScript(parse(source).descriptor, { id: 'reader-session-notes-ui' }).content
  const code = transformSync(script, { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const output = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'vue') return { ...vue, onMounted: callback => hooks.mounted.push(callback), onBeforeUnmount: callback => hooks.unmounted.push(callback) }
    if (name === './markdown') return { renderMarkdown: () => '' }
    if (name === './note-filters') return { reconcileSavedNoteFilters: (_note, filters) => filters }
    if (name === './note-date') return { formatNoteDate: value => value }
    if (name === './note-drafts') return {
      resolveDraftTabId: async () => 'tab-session-ui', writeDraftTabLease: async () => {}, listOfflineNoteDrafts: async () => [],
      listActiveDraftTabIds: async () => new Set(), saveOfflineNoteDraft: async () => {}, claimOfflineNoteDraft: async () => ({}),
      deleteOfflineNoteDraft: async () => {}, releaseDraftTabLease: async () => {},
    }
    throw new Error(`Unexpected OfflineNotes dependency: ${name}`)
  }, output, output.exports)
  const notesProps = vue.reactive({ active: true, sidebarCollapsed: false, store: noteStore })
  const notesEvents = []
  const notesScope = vue.effectScope()
  const notesState = notesScope.run(() => output.exports.default.setup(notesProps, { expose() {}, emit(name) { notesEvents.push(name) } }))
  for (const hook of hooks.mounted) hook()
  for (let i = 0; i < 8; i++) await vue.nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(notesState.directoryReady.value, true)
  await notesState.openNote('note-one')
  notesState.sourceFilter.value = 'personal'
  notesState.search.value = 'keep-filter'
  notesState.beginEdit(false)
  notesState.title.value = 'Unsaved title'
  notesState.editMarkdown.value = '# Unsaved body'
  assert.equal(notesState.dirty.value, true)
  let leavePrompted = false
  const beforeUnload = { preventDefault() { leavePrompted = true }, returnValue: undefined }
  noteWindowListeners.get('beforeunload')(beforeUnload)
  assert.equal(leavePrompted, true, 'true page leave still prompts while the editor is dirty')
  const mountedHookCount = hooks.mounted.length
  notesProps.active = false
  await vue.nextTick()
  notesProps.active = true
  await vue.nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(hooks.mounted.length, mountedHookCount, 'category reactivation does not register or rerun mount hooks')
  assert.equal(notesScope.active, true, 'active prop changes do not dispose the live Vue setup scope')
  assert.equal(listCalls, 2, 'activation checks the store TTL without reinitializing draft scanning')
  assert.equal(listLoads, 1, 'the backing note list is reused inside its TTL')
  assert.equal(getCalls, 1, 'reactivation does not reread or replace the selected note')
  assert.equal(notesState.selectedId.value, 'note-one')
  assert.equal(notesState.sourceFilter.value, 'personal')
  assert.equal(notesState.search.value, 'keep-filter')
  assert.equal(notesState.title.value, 'Unsaved title')
  assert.equal(notesState.editMarkdown.value, '# Unsaved body')
  assert.equal(notesState.dirty.value, true)
  // A delayed 401 from a previous directory session must not invalidate the replacement store's credentials.
  let rejectDelayedList
  noteStore.list = () => new Promise((_resolve, reject) => { rejectDelayedList = reject })
  notesProps.active = false
  await vue.nextTick()
  notesProps.active = true
  await vue.nextTick()
  notesProps.store = {
    ...noteStore,
    async list() { return { notes: [existingNote], head: 'c'.repeat(40) } },
    async get() { return { note: existingNote, markdown: '# replacement', head: 'c'.repeat(40) } },
  }
  await vue.nextTick()
  await vue.nextTick()
  rejectDelayedList(Object.assign(new Error('old store unauthorized'), { status: 401 }))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(notesEvents.filter(event => event === 'auth-invalid').length, 0, 'a delayed old-store 401 cannot invalidate the replacement session')
  notesState.editing.value = false
  notesProps.store = noteStore
  notesProps.active = true
  await vue.nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await notesState.openNote('note-one')
  assert.equal(notesState.selectedId.value, 'note-one')
  const fakeImage = { dataset: { kbAsset: 'assets/image.png' }, alt: '', src: '' }
  const fakeRoot = { querySelectorAll: () => [fakeImage] }
  notesState.readerRoot.value = fakeRoot
  notesState.previewRoot.value = fakeRoot
  let rejectDelayedAsset
  noteStore.asset = () => new Promise((_resolve, reject) => { rejectDelayedAsset = reject })
  notesState.markdown.value = '# trigger stale asset'
  await vue.nextTick()
  await vue.nextTick()
  notesProps.active = false
  notesProps.store = { ...noteStore, async list() { return { notes: [existingNote], head: 'd'.repeat(40) } } }
  await vue.nextTick()
  rejectDelayedAsset(Object.assign(new Error('old asset unauthorized'), { status: 401 }))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(notesEvents.filter(event => event === 'auth-invalid').length, 0, 'a delayed old-store asset 401 cannot invalidate the replacement session')
  notesProps.store = noteStore
  notesProps.active = true
  await vue.nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  notesState.previewRoot.value = null
  await notesState.openNote('note-one')
  await vue.nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  notesState.readerRoot.value = fakeRoot
  let resolveReactivatedAsset
  let hydrationCalls = 0
  noteStore.asset = () => {
    hydrationCalls++
    if (hydrationCalls === 1) return new Promise(resolve => { resolveReactivatedAsset = resolve })
    return Promise.resolve(new Blob(['image']))
  }
  notesState.markdown.value = '# trigger reactivation hydration'
  await vue.nextTick()
  await vue.nextTick()
  assert.equal(hydrationCalls, 1, 'the initially active note starts loading its image')
  notesProps.active = false
  await vue.nextTick()
  resolveReactivatedAsset(new Blob(['stale image']))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(fakeImage.src, '', 'an image response arriving while notes are hidden is discarded')
  notesProps.active = true
  await vue.nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(hydrationCalls, 2, 'reactivating notes retries image hydration without a markdown revision')
  assert.match(fakeImage.src, /^blob:/, 'the reactivated note receives a fresh image URL')
  let currentAssetCalls = 0
  noteStore.asset = async () => { currentAssetCalls++; throw Object.assign(new Error('asset unauthorized'), { status: 401 }) }
  notesState.markdown.value = '# trigger current asset'
  await vue.nextTick()
  await vue.nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(currentAssetCalls > 0, 'selected-note image watcher invokes the active private asset reader')
  assert.equal(notesEvents.filter(event => event === 'auth-invalid').length, 1, 'a current private asset 401 invalidates the matching authorization')
  notesState.editing.value = false
  noteStore.getFailure = Object.assign(new Error('expired'), { status: 401 })
  await assert.rejects(() => notesState.openNote('note-one'), /expired/)
  assert.equal(notesEvents.filter(event => event === 'auth-invalid').length, 2, 'a current notes-store 401 is sent to the auth owner')
  noteStore.getFailure = Object.assign(new Error('forbidden'), { status: 403 })
  await assert.rejects(() => notesState.openNote('note-one'), /forbidden/)
  assert.equal(notesEvents.filter(event => event === 'auth-invalid').length, 2, 'a notes-store 403 does not invalidate credentials')
  for (const hook of hooks.unmounted) hook()
  notesScope.stop()

  console.log('Reader session UI checks passed: session/7-day credentials, autoconnect, namespace isolation, 401 clearing, 403/network retention, explicit forget, and denied-storage fallback.')
} finally {
  globalThis.window = originalGlobals.window
  globalThis.document = originalGlobals.document
  globalThis.fetch = originalGlobals.fetch
  globalThis.setInterval = originalTimers.setInterval
  globalThis.clearInterval = originalTimers.clearInterval
}
