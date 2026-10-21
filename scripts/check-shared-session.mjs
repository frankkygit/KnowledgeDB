import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localRequire = createRequire(path.join(root, 'package.json'))
const vue = localRequire('vue')
const { parse, compileScript } = localRequire('@vue/compiler-sfc')
const { transformSync } = localRequire('esbuild')
const sessionCode = transformSync(fs.readFileSync(path.join(root, 'site/.vitepress/theme/comment-session.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
const sessionModule = { exports: {} }
new Function('module', 'exports', sessionCode)(sessionModule, sessionModule.exports)
const { runCommentSessionStep } = sessionModule.exports

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const flush = async () => { for (let index = 0; index < 10; index++) await vue.nextTick() }

// Compile the real SFC setup functions and mock only GitHub/network boundaries.
function makeCommentsHarness() {
  const clients = []
  const mounted = []
  let connectGate = null
  let operationGate = null
  let onOperationStart = null
  let denied = false
  class MockComments {
    constructor(repository, branch, token) { Object.assign(this, { repository, branch, token, connects: 0, reads: 0, creates: 0, disconnects: 0 }); clients.push(this) }
    async connect() { this.connects++; if (connectGate) await connectGate.promise; if (denied) throw new Error('403 denied') }
    async read() { this.reads++; return { threads: [{ id: this.repository }], head: this.repository } }
    async create(_record, validate) { this.creates++; await validate(); return { threads: [], head: 'saved' } }
    disconnect() { this.disconnects++; this.token = '' }
  }
  const source = fs.readFileSync(path.join(root, 'site/.vitepress/theme/ReaderComments.vue'), 'utf8')
  const script = compileScript(parse(source).descriptor, { id: 'comments-session' }).content
  const code = transformSync(script, { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const output = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'vue') return { ...vue, onMounted: callback => mounted.push(callback), onBeforeUnmount() {} }
    if (name.includes('github-comments')) return { GitHubComments: MockComments, newComment: async (documentId, docsCommit, anchor, body) => {
      if (operationGate) { onOperationStart?.(); await operationGate.promise }
      return { payload: { documentId, docsCommit, anchor, body } }
    } }
    if (name.includes('comment-session')) return { runCommentSessionStep }
    if (name.includes('comment-model')) return { normalizeText: text => text, createAnchor: async (_snapshot, doc) => ({ contentRevision: doc.contentRevision }), validateAnchor: async () => {} }
    throw new Error(`Unexpected comments dependency: ${name}`)
  }, output, output.exports)
  const props = vue.reactive({ doc: { documentId: 'doc-a', contentRevision: 'rev-a' }, article: null, docsCommit: 'commit-a', docsRepository: 'owner/docs', loadSnapshot: async () => ({}), localMode: false, sharedToken: 'test-token', repository: 'owner/comments', branch: 'main', sessionKey: 'session-a' })
  const scope = vue.effectScope()
  const state = scope.run(() => output.exports.default.setup(props, { expose() {}, emit() {} }))
  return { state, props, clients, mounted, scope, connectGate: value => { connectGate = value }, operationGate: (value, started) => { operationGate = value; onOperationStart = started }, deny: value => { denied = value } }
}

function layoutHarness() {
  const docs = []
  const notes = []
  let noteGate = null
  let failNotes = false
  class MockDocs {
    constructor(config, token) { Object.assign(this, { config, token, disconnects: 0 }); docs.push(this) }
    async json(file) { return file.includes('papers') ? { papers: [] } : { items: [] } }
    disconnect() { this.disconnects++; this.token = '' }
  }
  class MockNotes {
    constructor(repository, token) { Object.assign(this, { repository, token, disconnects: 0 }); notes.push(this) }
    async connect() { if (noteGate) await noteGate.promise; if (failNotes) throw new Error('notes unavailable') }
    disconnect() { this.disconnects++; this.token = '' }
  }
  class MockCache { clear() {} forget() {} }
  const source = fs.readFileSync(path.join(root, 'site/.vitepress/theme/ReaderLayout.vue'), 'utf8')
  const script = compileScript(parse(source).descriptor, { id: 'layout-session' }).content
  const code = transformSync(script, { loader: 'ts', format: 'cjs', target: 'es2022', define: { 'import.meta.env.DEV': 'false' } }).code
  const output = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'vue') return { ...vue, onMounted() {}, onBeforeUnmount() {} }
    if (name === 'vitepress') return { withBase: value => value }
    if (name.includes('github-docs')) return { GitHubDocs: MockDocs, commentsConfig: config => ({ repository: config?.commentsRepository || 'frankkygit/KnowledgeDB-comments', branch: config?.commentsBranch || 'main' }) }
    if (name.includes('github-notes')) return { GitHubNotesStore: MockNotes }
    if (name.includes('render-cache')) return { RenderCache: MockCache, renderCacheKey: () => '' }
    if (name.includes('markdown')) return { renderMarkdown: () => '', sanitizeHtml: value => value }
    if (name.includes('ReaderComments')) return {}
    if (name.includes('OfflineNotes')) return {}
    if (name.includes('katex')) return {}
    throw new Error(`Unexpected layout dependency: ${name}`)
  }, output, output.exports)
  const scope = vue.effectScope()
  const state = scope.run(() => output.exports.default.setup({}, { expose() {} }))
  state.config.value = { repository: 'owner/docs', ref: 'a'.repeat(40), catalogPath: 'catalog/papers.json', searchPath: 'catalog/search.json' }
  return { state, docs, notes, scope, noteGate: value => { noteGate = value }, failNotes: value => { failNotes = value } }
}

globalThis.document = { addEventListener() {}, removeEventListener() {} }
globalThis.window = { location: { hash: '' }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {}, scrollTo() {} }

// The real component performs one automatic comments connection with the shared PAT and keeps drafts per repo and revision.
let comments = makeCommentsHarness()
await flush()
assert.equal(comments.clients.length, 1)
assert.equal(comments.clients[0].token, 'test-token')
assert.equal(comments.clients[0].connects, 1)
assert.equal(comments.state.connected.value, true)
for (const mount of comments.mounted) mount()
await flush()
assert.equal(comments.clients.length, 1, 'mount hooks must not duplicate the automatic connection')
comments.state.body.value = 'draft-a'
comments.state.composer.value = true
comments.state.quote.value = { blockId: 'a', text: 'a', range: null, exact: 'a' }
comments.props.doc = { documentId: 'doc-b', contentRevision: 'rev-b' }
await flush()
assert.equal(comments.state.body.value, '')
comments.props.doc = { documentId: 'doc-a', contentRevision: 'rev-a' }
await flush()
assert.equal(comments.state.body.value, 'draft-a')
comments.props.doc = { documentId: 'doc-a', contentRevision: 'rev-new' }
await flush()
assert.equal(comments.state.body.value, '')
comments.props.doc = { documentId: 'doc-a', contentRevision: 'rev-a' }
await flush()
comments.props.repository = 'owner/other-comments'
await flush()
assert.equal(comments.state.body.value, '')
comments.props.repository = 'owner/comments'
await flush()
assert.equal(comments.state.body.value, 'draft-a')
comments.props.branch = 'release'
await flush()
assert.equal(comments.state.body.value, '')
comments.props.branch = 'main'
await flush()
assert.equal(comments.state.body.value, 'draft-a')
comments.scope.stop()

// Replacing credentials invalidates a pending connection; its late completion cannot read or restore the old client.
comments = makeCommentsHarness()
await flush()
const connectGate = deferred()
comments.connectGate(connectGate)
const oldConnect = comments.state.connect()
const oldClient = comments.clients.at(-1)
comments.props.sharedToken = 'replacement-token'
await flush()
const newClient = comments.clients.at(-1)
connectGate.resolve()
await oldConnect
await flush()
assert.equal(oldClient.reads, 0)
assert.equal(newClient.reads, 1)
assert.equal(comments.state.connected.value, true)
assert.equal(oldClient.token, '')
comments.scope.stop()

// A delayed docs snapshot cannot assign a pending operation or submit against a newly selected repository/document.
comments = makeCommentsHarness()
await flush()
const snapshotGate = deferred()
comments.props.loadSnapshot = () => snapshotGate.promise
comments.state.body.value = 'old draft'
comments.state.quote.value = { blockId: 'a', text: 'a', range: null, exact: 'a' }
const staleSave = comments.state.save()
comments.props.repository = 'owner/new-comments'
await flush()
snapshotGate.resolve({})
await staleSave
assert.equal(comments.clients.reduce((total, client) => total + client.creates, 0), 0)
assert.equal(comments.state.pending, null)
comments.scope.stop()

// The same session helper allows a valid save and prevents a late newComment from populating a new draft context.
comments = makeCommentsHarness()
await flush()
comments.state.body.value = 'saved draft'
comments.state.quote.value = { blockId: 'a', text: 'a', range: null, exact: 'a' }
await comments.state.save()
assert.equal(comments.clients[0].creates, 1)
assert.equal(comments.state.status.value, '已保存到私有评论库')
comments.scope.stop()

comments = makeCommentsHarness()
await flush()
const operationGate = deferred()
const operationStarted = deferred()
comments.operationGate(operationGate, operationStarted.resolve)
comments.state.body.value = 'late operation'
comments.state.quote.value = { blockId: 'a', text: 'a', range: null, exact: 'a' }
const lateOperationSave = comments.state.save()
await operationStarted.promise
comments.props.repository = 'owner/new-comments'
await flush()
operationGate.resolve()
await lateOperationSave
assert.equal(comments.state.pending, null)
assert.equal(comments.clients.reduce((total, client) => total + client.creates, 0), 0)
comments.scope.stop()

comments = makeCommentsHarness()
await flush()
comments.props.loadSnapshot = async () => ({})
comments.state.body.value = 'old document'
comments.state.quote.value = { blockId: 'a', text: 'a', range: null, exact: 'a' }
const staleDocumentSave = comments.state.save()
comments.props.doc = { documentId: 'doc-b', contentRevision: 'rev-b' }
await flush()
await staleDocumentSave
assert.equal(comments.clients.reduce((total, client) => total + client.creates, 0), 0)
comments.scope.stop()

// Comments authorization errors remain local to comments and allow a retry using the same shared credential.
comments = makeCommentsHarness()
await flush()
comments.deny(true)
await comments.state.connect()
assert.equal(comments.state.connected.value, false)
assert.match(comments.state.error.value, /403/)
comments.deny(false)
await comments.state.connect()
assert.equal(comments.state.connected.value, true)
comments.scope.stop()

// The parent retains one token only for the active docs and notes session, then clears clients on failure/disconnect.
let layout = layoutHarness()
layout.state.tokenInput.value = 'shared-test-token'
await layout.state.connectWithToken()
assert.equal(layout.state.sharedToken.value, 'shared-test-token')
assert.equal(layout.state.tokenInput.value, '')
layout.state.disconnect(false)
assert.equal(layout.state.sharedToken.value, '')
assert.equal(layout.docs[0].token, '')
assert.equal(layout.notes[0].token, '')
layout.scope.stop()

layout = layoutHarness()
layout.failNotes(true)
layout.state.tokenInput.value = 'shared-test-token'
await layout.state.connectWithToken()
assert.equal(layout.state.connected.value, false)
assert.equal(layout.state.sharedToken.value, '')
assert.equal(layout.docs[0].token, '')
assert.equal(layout.notes[0].token, '')
layout.scope.stop()

layout = layoutHarness()
const notesGate = deferred()
layout.noteGate(notesGate)
layout.state.tokenInput.value = 'shared-test-token'
const pendingConnection = layout.state.connectWithToken()
await flush()
assert.equal(layout.notes.length, 1)
layout.state.disconnect(false)
assert.equal(layout.notes[0].token, '')
notesGate.resolve()
await pendingConnection
assert.equal(layout.state.connected.value, false)
assert.equal(layout.state.sharedToken.value, '')
layout.scope.stop()

console.log('Shared-session component regressions passed: automatic comments auth, draft isolation, stale connect/save cancellation, permission retry, shared PAT cleanup, and docs/notes failure isolation.')
