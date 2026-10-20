import assert from 'node:assert/strict'
import { createAnchor, validateAnchor, normalizeText, operationDate, replay, shardFor } from '../site/.vitepress/theme/comment-model.ts'
import { GitHubComments, newComment } from '../site/.vitepress/theme/github-comments.ts'
import { RenderCache, renderCacheKey } from '../site/.vitepress/theme/render-cache.ts'
import { renderMarkdownBody } from '../site/.vitepress/theme/markdown-core.ts'

const doc = { documentId: 'doc-test', path: 'content/papers/test/analysis.md', contentRevision: `sha256:${'a'.repeat(64)}` }
const snapshot = { ...doc, normalizationVersion: 'kb-text-v1', paragraphs: [{ blockId: 'block-test', text: '中文 😀 词语', sectionTitle: '方法' }] }
const anchor = await createAnchor(snapshot, doc, 'block-test', '中文 😀 词语', { start: 3, end: 4 })
assert.equal(anchor.quote.exact, '😀')
assert.equal(anchor.quote.prefix, '中文 ')
await validateAnchor(snapshot, doc, anchor)
await assert.rejects(() => validateAnchor(snapshot, doc, { ...anchor, quote: { ...anchor.quote, exact: '错' } }))
await assert.rejects(() => createAnchor({ ...snapshot, contentRevision: 'other' }, doc, 'block-test', '中文 😀 词语', null))
await assert.rejects(() => createAnchor(snapshot, doc, 'block-test', '正文已修改', null))
assert.equal(normalizeText('  e\u0301\r\n😀  '), 'é 😀')
assert.equal(operationDate('2026-10-20T16:00:00Z'), '2026-10-21')
const create = await newComment(doc.documentId, 'f'.repeat(40), anchor, '测试评论')
await assert.rejects(() => newComment(doc.documentId, 'f'.repeat(40), anchor, '😀'.repeat(4097)), /过长/)
const reply = { ...create, requestId: 'reply', payloadDigest: 'reply-digest', kind: 'comment.add', expectedThreadRevision: 1, resultThreadRevision: 2, at: '2026-10-22T01:00:00Z', payload: { commentId: 'reply-comment', body: '跨日回复' } }
assert.equal(replay([reply, create, create])[0].comments.length, 2)
assert.deepEqual(replay([reply, create])[0].originalAnchor, anchor)
assert.throws(() => replay([reply]), /修订链/)
assert.throws(() => replay([create, { ...create, payloadDigest: 'conflict' }]), /冲突/)
assert.throws(() => replay([create, { ...reply, kind: 'unknown' }]), /未知/)
const initial = shardFor(doc.documentId, '2026-10-20', [], create)
assert.match(initial.path, /2026\/10\/20\/doc-test\/part-000001.json$/)
assert.equal(shardFor(doc.documentId, '2026-10-20', [initial], reply).data.records.length, 2)
assert.throws(() => shardFor(doc.documentId, '2026-10-20', [], { ...create, payload: { body: '😀'.repeat(4097) } }), /过长/)
const full = { ...initial, data: { ...initial.data, padding: 'x'.repeat(262144) } }
assert.match(shardFor(doc.documentId, '2026-10-20', [full], create).path, /part-000002.json$/)

const key = renderCacheKey('owner/docs', 'a'.repeat(40), doc)
assert.notEqual(key, renderCacheKey('owner/docs', 'b'.repeat(40), doc))
assert.notEqual(key, renderCacheKey('owner/docs', 'a'.repeat(40), { ...doc, contentRevision: 'new' }))
const cache = new RenderCache()
assert.equal(await cache.get(key), null)
await cache.put(key, '<p>cached</p>')
assert.equal(await cache.get(key), '<p>cached</p>')
await cache.clear()
assert.equal(await cache.get(key), null)
const html = renderMarkdownBody('# 标题\n\n## 标题\n\n<!-- kb:block block-test -->\n中文 **加粗**\n\n<!-- kb:block list-test -->\n- 列表\n', doc.path)
assert.match(html, /id="kb-heading-1"/)
assert.match(html, /id="kb-heading-2"/)
assert.match(html, /<p data-comment-block="block-test">/)
assert.doesNotMatch(html, /data-comment-block="list-test"/)

// Immutable mocked GitHub store: exercise first save, retry after a lost response, and a branch race.
const originalFetch = globalThis.fetch
let records = []
let currentHead = '1'.repeat(40)
let candidateRecords = []
let refUpdates = 0
let race = true
let refuse = false
let networkFailure = false
let repoStatus = 200
const calls = []
globalThis.fetch = async (input, options) => {
  if (networkFailure) throw new TypeError('Failed to fetch')
  const url = new URL(input)
  assert.equal(url.origin, 'https://api.github.com')
  assert.equal(options.cache, 'no-store')
  assert.equal(options.redirect, 'error')
  calls.push({ path: url.pathname, method: options.method })
  assert.ok(!url.pathname.endsWith('/'), 'GitHub endpoints must not end in a slash; OPTIONS would fail')
  if (url.pathname === '/repos/owner/comments') return new Response(JSON.stringify({ private: true }), { status: repoStatus })
  const path = url.pathname.replace('/repos/owner/comments/', '')
  const body = options.body ? JSON.parse(options.body) : null
  const json = data => new Response(JSON.stringify(data), { status: 200 })
  if (path === 'git/ref/heads/main') return json({ object: { sha: currentHead } })
  if (path.startsWith('git/commits/') && options.method === 'GET') return json({ tree: { sha: 'tree' } })
  if (path === 'git/trees/tree') return json({ truncated: false, tree: records.length ? [{ type: 'blob', path: initial.path, sha: 'shard' }] : [] })
  if (path === 'git/blobs/shard') return json({ encoding: 'base64', content: Buffer.from(JSON.stringify({ ...initial.data, date: operationDate(create.at), records })).toString('base64') })
  if (path === 'git/blobs' && options.method === 'POST') { candidateRecords = JSON.parse(body.content).records; return json({ sha: 'newblob' }) }
  if (path === 'git/trees' && options.method === 'POST') return json({ sha: 'newtree' })
  if (path === 'git/commits' && options.method === 'POST') return json({ sha: '2'.repeat(40) })
  if (path === 'git/refs/heads/main' && options.method === 'PATCH') {
    refUpdates++
    assert.equal(body.force, false)
    if (refuse) return new Response('{}', { status: 422 })
    if (race) { race = false; currentHead = '3'.repeat(40); return new Response('{}', { status: 422 }) }
    records = candidateRecords; currentHead = body.sha; return json({ object: { sha: currentHead } })
  }
  throw new Error(`Unexpected mocked endpoint: ${path}`)
}
try {
  // Use the exact operation date so physical shard metadata matches replay checks.
  initial.path = `annotations/${operationDate(create.at).replaceAll('-', '/')}/${doc.documentId}/part-000001.json`
  const comments = new GitHubComments('owner/comments', 'main', 'test-only-token')
  await comments.connect()
  assert.equal(calls[0].path, '/repos/owner/comments')
  assert.equal(calls[1].path, '/repos/owner/comments/git/ref/heads/main')
  repoStatus = 401
  await assert.rejects(() => comments.connect(), /令牌无效/)
  repoStatus = 200
  networkFailure = true
  await assert.rejects(() => comments.connect(), /检查评论仓库时未能连接 GitHub API/)
  networkFailure = false
  let validations = 0
  const saved = await comments.create(create, async () => { validations++ })
  assert.equal(saved.threads.length, 1)
  assert.equal(refUpdates, 2)
  assert.equal(validations, 2)
  await comments.create(create, async () => { throw new Error('Idempotent retry must not validate a changed document') })
  assert.equal(refUpdates, 2)
  assert.equal(records.length, 1)
  refuse = true
  await assert.rejects(() => comments.create({ ...create, requestId: 'other-request', threadId: 'other-thread' }, async () => {}), /分支拒绝/)
  assert.equal(records.length, 1)
  comments.disconnect()
} finally { globalThis.fetch = originalFetch }
console.log('Reader checks passed: Unicode anchors, revision replay, date shards, limits, cache invalidation, Markdown structure, repository connection URLs, network errors, Git conflict and idempotent retries.')
