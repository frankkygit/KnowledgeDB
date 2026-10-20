import { safePath } from './github-docs.ts'
import { digest, operationDate, replay, shardFor, type Operation } from './comment-model.ts'
class GitHubError extends Error { constructor(readonly status: number) { super(status === 401 ? '评论令牌无效或已过期，请重新连接；草稿已保留。' : status === 404 ? '评论仓库或分支不可读，请检查仓库名与令牌权限。' : status === 403 || status === 429 ? '评论访问被拒绝或限流，请检查 Contents 读写权限与分支规则。' : `评论请求失败（${status}），草稿已保留。`) } }
export class GitHubComments {
  #token: string
  #abort = new AbortController()
  constructor(readonly repository: string, readonly branch: string, token: string) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token.trim()) throw new Error('请填写评论私库 owner/repo 和读写令牌。')
    safePath(branch)
    this.#token = token.trim()
  }
  async request(path: string, method = 'GET', body?: any): Promise<any> {
    // The repository metadata endpoint has no trailing slash: GitHub rejects its
    // OPTIONS preflight otherwise, hiding the 404 behind a browser fetch error.
    const url = `https://api.github.com/repos/${this.repository}${path ? `/${path}` : ''}`
    let response: Response
    try {
      response = await fetch(url, {
        method, headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/vnd.github+json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: this.#abort.signal,
      })
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw cause
      const stage = !path ? '检查评论仓库' : path.startsWith('git/ref/') ? '读取评论分支' : method === 'GET' ? '读取评论' : '保存评论'
      throw new Error(`${stage}时未能连接 GitHub API，请检查网络、代理或浏览器拦截后重试；评论草稿已保留。`)
    }
    if (!response.ok) throw new GitHubError(response.status)
    return response.json()
  }
  async connect() {
    const repo = await this.request('')
    if (repo.private !== true) throw new Error('评论必须保存在私有仓库，请选择 comments 私库。')
    await this.request(`git/ref/heads/${safePath(this.branch)}`)
  }
  async read() {
    const head = (await this.request(`git/ref/heads/${safePath(this.branch)}`)).object.sha
    const commit = await this.request(`git/commits/${head}`)
    const tree = await this.request(`git/trees/${commit.tree.sha}?recursive=1`)
    if (tree.truncated) throw new Error('评论目录过大，无法完整读取；已停止保存。')
    const entries = tree.tree.filter((e: any) => e.type === 'blob' && e.path.startsWith('annotations/'))
    const shards: { path: string; data: any }[] = []
    // Read all dates from this one immutable HEAD; never mix a moving branch into replay.
    for (const entry of entries) {
      if (!/^annotations\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9-]+\/part-\d{6}\.json$/.test(entry.path)) throw new Error('评论库含未知记录布局，已停止读取。')
      const blob = await this.request(`git/blobs/${entry.sha}`)
      if (blob.encoding !== 'base64') throw new Error('评论文件编码不受支持。')
      const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(blob.content.replace(/\s/g, '')), c => c.charCodeAt(0))))
      const expected = `annotations/${data.date?.replaceAll('-', '/')}/${data.documentId}/part-${String(data.part).padStart(6, '0')}.json`
      if (data.schemaVersion !== 1 || data.timezone !== 'Asia/Shanghai' || expected !== entry.path || !Array.isArray(data.records)) throw new Error('评论分片元数据不一致。')
      for (const record of data.records) {
        if (operationDate(record.at) !== data.date || (record.kind === 'thread.create' && record.payload?.documentId !== data.documentId)) throw new Error('评论记录的文档或日期不一致。')
      }
      shards.push({ path: entry.path, data })
    }
    const records: Operation[] = shards.flatMap(s => s.data.records)
    const threads = replay(records)
    for (const shard of shards) {
      for (const record of shard.data.records) {
        if (threads.find(t => t.id === record.threadId)?.documentId !== shard.data.documentId) throw new Error('评论记录出现在其他文档分片。')
      }
    }
    return { head, tree: commit.tree.sha, shards, records, threads }
  }
  async create(record: Operation, validateTarget: () => Promise<void>) {
    const date = operationDate(record.at)
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await this.read()
      const previous = state.records.find(r => r.requestId === record.requestId)
      if (previous) {
        if (previous.payloadDigest !== record.payloadDigest) throw new Error('同一请求的内容发生变化，请保留草稿并重新提交。')
        return { head: state.head, threads: state.threads }
      }
      if (state.threads.some(t => t.id === record.threadId)) throw new Error('讨论 ID 冲突。')
      await validateTarget()
      const shard = shardFor(record.payload.documentId, date, state.shards, record)
      const blob = await this.request('git/blobs', 'POST', { content: JSON.stringify(shard.data, null, 2) + '\n', encoding: 'utf-8' })
      const tree = await this.request('git/trees', 'POST', { base_tree: state.tree, tree: [{ path: shard.path, mode: '100644', type: 'blob', sha: blob.sha }] })
      const commit = await this.request('git/commits', 'POST', { message: `Add comment ${record.requestId}`, tree: tree.sha, parents: [state.head] })
      try {
        await this.request(`git/refs/heads/${safePath(this.branch)}`, 'PATCH', { sha: commit.sha, force: false })
        return { head: commit.sha, threads: replay([...state.records, record]) }
      } catch (cause) {
        if (!(cause instanceof GitHubError) || ![409, 422].includes(cause.status)) throw cause
        // A rule refusal is not fixed by retrying against an unchanged HEAD.
        const now = (await this.request(`git/ref/heads/${safePath(this.branch)}`)).object.sha
        if (now === state.head) throw new Error('评论分支拒绝更新，请检查分支规则；草稿已保留。')
      }
    }
    throw new Error('评论保存遇到并发更新，请重试；草稿已保留。')
  }
  disconnect() { this.#abort.abort(); this.#token = '' }
}
export async function newComment(documentId: string, docsCommit: string, anchor: any, body: string): Promise<Operation> {
  const payload = { documentId, docsCommit, expectedContentRevision: anchor.contentRevision, anchor, commentId: crypto.randomUUID(), body }
  const requestId = crypto.randomUUID()
  if (!body.trim()) throw new Error('评论内容不能为空。')
  const record: Operation = { requestId, payloadDigest: await digest(JSON.stringify({ requestId, payload })), threadId: crypto.randomUUID(), kind: 'thread.create', expectedThreadRevision: 0, resultThreadRevision: 1, at: new Date().toISOString(), actorId: 'owner', payload }
  // Reject definitive local validation errors before the UI locks an uncertain request for retries.
  shardFor(documentId, operationDate(record.at), [], record)
  return record
}
