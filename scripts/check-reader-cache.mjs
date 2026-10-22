import assert from 'node:assert/strict'
import { SessionCache, createLimiter } from '../site/.vitepress/theme/session-cache.ts'
import { GitHubDocs } from '../site/.vitepress/theme/github-docs.ts'
import { GitHubComments } from '../site/.vitepress/theme/github-comments.ts'
import { GitHubNotesStore } from '../site/.vitepress/theme/github-notes.ts'

const lru = new SessionCache(2)
lru.set('a', 1); lru.set('b', 2); assert.equal(lru.get('a'), 1); lru.set('c', 3)
assert.equal(lru.get('b'), undefined); assert.equal(lru.get('a'), 1)
const weighted = new SessionCache(8, 3, value => value.length)
weighted.set('large', '1234'); weighted.set('a', '12'); weighted.set('b', '3')
assert.equal(weighted.get('large'), undefined, 'over-budget entries must not be retained')
assert.equal(weighted.get('a'), '12')
let loads = 0
const merged = new SessionCache(2)
const [m1, m2] = await Promise.all(['x', 'x'].map(() => merged.getOrLoad('x', async () => { loads++; await new Promise(r => setTimeout(r, 5)); return 7 })))
assert.deepEqual([m1, m2, loads], [7, 7, 1])
const limit = createLimiter(1)
let running = 0, maxRunning = 0, releaseFirst
const limitedTask = gate => limit(async () => { running++; maxRunning = Math.max(maxRunning, running); if (gate) await new Promise(r => { releaseFirst = r }); running-- })
const firstLimited = limitedTask(true)
const secondLimited = limitedTask(false)
releaseFirst()
const thirdLimited = limitedTask(false)
await Promise.all([firstLimited, secondLimited, thirdLimited])
assert.equal(maxRunning, 1, 'a newly arriving request must not steal a semaphore slot from an awakened waiter')

const originalFetch = globalThis.fetch
const calls = []
let currentHead = 'a'.repeat(40)
const heads = new Map([[currentHead, 'tree-a']])
const trees = new Map()
const payloads = new Map()
let activeBlobs = 0, maxBlobs = 0
const shard = (date, documentId, part) => ({ schemaVersion: 1, timezone: 'Asia/Shanghai', date, documentId, part, records: [] })
const addTree = (sha, shardCount, start = 0) => {
  const tree = []
  for (let i = start; i < shardCount; i++) {
    const sha = `blob-${i}`
    const date = `2026-10-${String(i + 1).padStart(2, '0')}`
    const documentId = `doc-${i}`
    tree.push({ type: 'blob', path: `annotations/${date.replaceAll('-', '/')}/${documentId}/part-000001.json`, sha })
    payloads.set(sha, shard(date, documentId, 1))
  }
  trees.set(sha, tree)
}
addTree('tree-a', 3)

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input)
  const path = url.pathname === '/repos/owner/comments' ? '' : url.pathname.replace('/repos/owner/comments/', '')
  calls.push(path)
  const json = value => new Response(JSON.stringify(value), { status: 200 })
  if (path === 'git/ref/heads/main') return json({ object: { sha: currentHead } })
  if (path.startsWith('git/commits/')) return json({ tree: { sha: heads.get(path.slice('git/commits/'.length)) } })
  if (path.startsWith('git/trees/')) return json({ truncated: false, tree: trees.get(path.slice('git/trees/'.length)) || [] })
  if (path.startsWith('git/blobs/')) {
    activeBlobs++; maxBlobs = Math.max(maxBlobs, activeBlobs)
    await new Promise(r => setTimeout(r, 8))
    activeBlobs--
    const data = payloads.get(path.slice('git/blobs/'.length))
    return json({ encoding: 'base64', content: Buffer.from(JSON.stringify(data)).toString('base64') })
  }
  if (path === '') return json({ private: true })
  throw new Error(`Unexpected request: ${path}`)
}

try {
  const docs = new GitHubDocs({ repository: 'owner/docs', ref: 'c'.repeat(40), catalogPath: 'catalog/papers.json', searchPath: 'catalog/search.json' }, 'token-a')
  let contentFetches = 0
  globalThis.fetch = async (input, options) => {
    const url = new URL(input)
    assert.match(options.headers.Authorization, /^Bearer token-a$/)
    contentFetches++
    await new Promise(r => setTimeout(r, 5))
    return new Response('same immutable bytes', { status: 200 })
  }
  const [d1, d2] = await Promise.all([docs.bytes('content/a.md'), docs.bytes('content/a.md')])
  assert.equal(contentFetches, 1, 'identical content requests should merge')
  assert.deepEqual(d1, d2)
  await docs.bytes('content/a.md')
  assert.equal(contentFetches, 1, 'immutable fixed commit/path bytes should be cached')
  docs.disconnect()

  const noteCalls = []
  const noteMethods = []
  let publicNotes = false
  const noteData = new Map([
    ['notes-a', { schemaVersion: 1, notes: [], requests: {} }],
    ['documents-a', { schemaVersion: 1, documents: [] }],
    ['search-a', { schemaVersion: 1, items: [] }],
    ['notes-b', { schemaVersion: 1, notes: [], requests: { changed: true } }],
  ])
  let noteHead = 'e'.repeat(40)
  const noteTrees = new Map([
    ['tree-notes-a', [['catalog/notes.json', 'notes-a'], ['catalog/documents.json', 'documents-a'], ['catalog/search.json', 'search-a']]],
    ['tree-notes-b', [['catalog/notes.json', 'notes-b'], ['catalog/documents.json', 'documents-a'], ['catalog/search.json', 'search-a']]],
  ])
  const noteCommits = new Map([[noteHead, 'tree-notes-a']])
  const noteFetch = async (input, options = {}) => {
    const url = new URL(input)
    const path = url.pathname === '/repos/owner/docs' ? '' : url.pathname.replace('/repos/owner/docs/', '')
    noteCalls.push(path)
    noteMethods.push(options.method || 'GET')
    const json = value => new Response(JSON.stringify(value), { status: 200 })
    if (!path) return json({ private: !publicNotes })
    if (path === 'git/ref/heads/main') return json({ object: { sha: noteHead } })
    if (path.startsWith('git/commits/')) return json({ tree: { sha: noteCommits.get(path.slice('git/commits/'.length)) } })
    if (path.startsWith('git/trees/')) return json({ truncated: false, tree: (noteTrees.get(path.slice('git/trees/'.length)) || []).map(([p, sha]) => ({ path: p, sha, type: 'blob' })) })
    if (path.startsWith('git/blobs/')) return json({ encoding: 'base64', content: Buffer.from(JSON.stringify(noteData.get(path.slice('git/blobs/'.length)))).toString('base64') })
    throw new Error(`Unexpected notes request: ${path}`)
  }
  globalThis.fetch = noteFetch
  const unverifiedNotes = new GitHubNotesStore('owner/docs', 'token-notes')
  publicNotes = true
  await assert.rejects(() => unverifiedNotes.list(), /私有 docs/)
  await assert.rejects(() => unverifiedNotes.save({ documentId: 'note-public', sourceDocumentId: null, sourceKind: 'personal', title: 'x', tags: [], status: 'draft', markdown: 'x', assets: [], sources: [] }, '1'.repeat(40), '1'.repeat(36)), /私有 docs/)
  assert.equal(noteMethods.some(method => method !== 'GET'), false, 'direct writes against a public docs repository must stop before POST')
  unverifiedNotes.disconnect()
  publicNotes = false
  const notes = new GitHubNotesStore('owner/docs', 'token-notes')
  await notes.connect()
  const afterConnect = noteCalls.length
  await notes.list()
  assert.deepEqual(noteCalls.slice(afterConnect), ['git/ref/heads/main'], 'connect snapshot should satisfy the first list with only a fresh HEAD check')
  const afterFirstList = noteCalls.length
  await notes.list()
  assert.equal(noteCalls.length, afterFirstList, 'default list should reuse the same-session 30 second TTL')
  await notes.list({ force: true })
  assert.equal(noteCalls.length, afterFirstList + 1, 'force list should recheck HEAD while reusing immutable same-HEAD catalogs')

  noteHead = 'f'.repeat(40); noteCommits.set(noteHead, 'tree-notes-b')
  const beforeDelta = noteCalls.length
  const changedList = await notes.list({ force: true })
  assert.equal(changedList.head, noteHead)
  assert.deepEqual(noteCalls.slice(beforeDelta).filter(path => path.startsWith('git/blobs/')), ['git/blobs/notes-b'], 'changed HEAD should fetch only catalog blobs whose SHA changed')

  notes.clearPrivateCache()
  noteCalls.length = 0
  await Promise.all([notes.list({ force: true }), notes.list({ force: true })])
  assert.equal(noteCalls.filter(path => path === 'git/ref/heads/main').length, 1, 'simultaneous forced list calls should merge HEAD/tree/catalog reads')
  assert.equal(noteCalls.filter(path => path.startsWith('git/commits/')).length, 1)
  assert.equal(noteCalls.filter(path => path.startsWith('git/trees/')).length, 1)
  assert.equal(noteCalls.filter(path => path.startsWith('git/blobs/')).length, 3)
  notes.disconnect()

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input)
    const path = url.pathname === '/repos/owner/comments' ? '' : url.pathname.replace('/repos/owner/comments/', '')
    calls.push(path)
    const json = value => new Response(JSON.stringify(value), { status: 200 })
    if (path === 'git/ref/heads/main') return json({ object: { sha: currentHead } })
    if (path.startsWith('git/commits/')) return json({ tree: { sha: heads.get(path.slice('git/commits/'.length)) } })
    if (path.startsWith('git/trees/')) return json({ truncated: false, tree: trees.get(path.slice('git/trees/'.length)) || [] })
    if (path.startsWith('git/blobs/')) {
      activeBlobs++; maxBlobs = Math.max(maxBlobs, activeBlobs)
      await new Promise(r => setTimeout(r, 8)); activeBlobs--
      const data = payloads.get(path.slice('git/blobs/'.length))
      return json({ encoding: 'base64', content: Buffer.from(JSON.stringify(data)).toString('base64') })
    }
    if (path === '') return json({ private: true })
    throw new Error(`Unexpected request: ${path}`)
  }
  const comments = new GitHubComments('owner/comments', 'main', 'token-b')
  await comments.connect()
  const first = await comments.read()
  assert.equal(first.shards.length, 3)
  const blobCalls = () => calls.filter(path => path.startsWith('git/blobs/')).length
  const firstBlobCalls = blobCalls()
  await comments.read()
  assert.equal(blobCalls(), firstBlobCalls, 'unchanged HEAD should issue zero blob requests')
  assert.equal(calls.filter(path => path.startsWith('git/commits/')).length, 1, 'unchanged HEAD should reuse aggregate state')

  currentHead = 'b'.repeat(40); heads.set(currentHead, 'tree-b'); addTree('tree-b', 8, 0)
  trees.set('tree-b', [...trees.get('tree-a'), ...trees.get('tree-b').slice(3)])
  const beforeChanged = blobCalls()
  const changed = await comments.read()
  assert.equal(changed.shards.length, 8)
  assert.equal(blobCalls() - beforeChanged, 5, 'new HEAD should fetch only new shard SHAs')
  assert.ok(maxBlobs <= 4, `blob fetch concurrency exceeded four: ${maxBlobs}`)
  comments.disconnect()

  let release
  globalThis.fetch = async () => new Promise(resolve => { release = resolve })
  const staleDocs = new GitHubDocs({ repository: 'owner/docs', ref: 'd'.repeat(40), catalogPath: 'catalog/papers.json', searchPath: 'catalog/search.json' }, 'token-c')
  const stale = staleDocs.bytes('content/late.md')
  await new Promise(r => setImmediate(r))
  staleDocs.disconnect()
  release(new Response('late', { status: 200 }))
  await assert.rejects(stale, { name: 'AbortError' }, 'a late response must not repopulate a disconnected client cache')
} finally { globalThis.fetch = originalFetch }

console.log('Reader cache checks passed: weighted LRU bounds, request coalescing, immutable docs bytes, notes private-repo guard/TTL/forced HEAD/delta/coalescing, unchanged comment HEAD reuse, changed-shard delta, four-fetch concurrency limit, and disconnect fencing.')
