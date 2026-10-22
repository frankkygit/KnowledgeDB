export type ReaderConfig = { repository: string; ref: string; catalogPath: string; searchPath: string; notesBranch?: string; commentsRepository?: string; commentsBranch?: string }
import { SessionCache, createLimiter } from './session-cache.ts'
export class DocsAccessError extends Error { constructor(readonly status: number, message: string) { super(message) } }
export const DEFAULT_COMMENTS_REPOSITORY = 'frankkygit/KnowledgeDB-comments'
export const DEFAULT_COMMENTS_BRANCH = 'main'
export function commentsConfig(config: ReaderConfig | null | undefined) {
  return { repository: config?.commentsRepository || DEFAULT_COMMENTS_REPOSITORY, branch: config?.commentsBranch || DEFAULT_COMMENTS_BRANCH }
}

export function safePath(path: string): string {
  const parts = path.split('/')
  if (!path || path.startsWith('/') || /[\\?#\u0000]/.test(path) || parts.some(p => !p || p === '.' || p === '..')) {
    throw new Error('资料路径无效。')
  }
  return parts.map(encodeURIComponent).join('/')
}

export class GitHubDocs {
  #token: string
  #abort = new AbortController()
  #cache = new SessionCache<string, Uint8Array>(96, 32 * 1024 * 1024, bytes => bytes.byteLength)
  #limit = createLimiter(4)
  #disconnected = false
  constructor(readonly config: ReaderConfig, token: string) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) || !/^[a-f0-9]{40}$/i.test(config.ref)) {
      throw new Error('资料库连接配置无效，请更新站点。')
    }
    if (!token.trim()) throw new Error('请填写只读访问令牌。')
    this.#token = token.trim()
  }

  async bytes(path: string): Promise<Uint8Array> {
    return (await this.#cache.getOrLoad(`${this.config.ref}:${path}`, () => this.#limit(() => this.#fetchBytes(path)))).slice()
  }

  async #fetchBytes(path: string): Promise<Uint8Array> {
    if (this.#disconnected) throw new DOMException('资料库会话已断开。', 'AbortError')
    const url = `https://api.github.com/repos/${this.config.repository}/contents/${safePath(path)}?ref=${this.config.ref}`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/vnd.github.raw+json' },
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: this.#abort.signal,
    })
    if (!response.ok) {
      if (response.status === 401) throw new DocsAccessError(401, '令牌无效或已过期，请重新连接。')
      if (response.status === 404) throw new DocsAccessError(404, '无法读取该版本的资料，请检查令牌是否授权此私库及 Contents 只读权限。')
      if (response.status === 403 || response.status === 429) throw new DocsAccessError(response.status, 'GitHub 拒绝访问或请求限流，请检查权限或稍后重试。')
      throw new DocsAccessError(response.status, `资料读取失败（${response.status}），请稍后重试。`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (this.#disconnected) throw new DOMException('资料库会话已断开。', 'AbortError')
    return bytes
  }

  async text(path: string): Promise<string> { return new TextDecoder().decode(await this.bytes(path)) }
  async json(path: string): Promise<any> {
    try { return JSON.parse(await this.text(path)) }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error('资料索引格式不正确，请重新生成索引。')
      throw error
    }
  }
  disconnect() { this.#disconnected = true; this.#cache.clear(); this.#abort.abort(); this.#token = '' }
}
