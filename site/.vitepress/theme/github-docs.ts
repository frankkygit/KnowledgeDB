export type ReaderConfig = { repository: string; ref: string; catalogPath: string; searchPath: string }

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
  constructor(readonly config: ReaderConfig, token: string) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) || !/^[a-f0-9]{40}$/i.test(config.ref)) {
      throw new Error('资料库连接配置无效，请更新站点。')
    }
    if (!token.trim()) throw new Error('请填写只读访问令牌。')
    this.#token = token.trim()
  }

  async bytes(path: string): Promise<Uint8Array> {
    const url = `https://api.github.com/repos/${this.config.repository}/contents/${safePath(path)}?ref=${this.config.ref}`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/vnd.github.raw+json' },
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: this.#abort.signal,
    })
    if (!response.ok) {
      if (response.status === 401) throw new Error('令牌无效或已过期，请重新连接。')
      if (response.status === 404) throw new Error('无法读取该版本的资料，请检查令牌是否授权此私库及 Contents 只读权限。')
      if (response.status === 403 || response.status === 429) throw new Error('GitHub 拒绝访问或请求限流，请检查权限或稍后重试。')
      throw new Error(`资料读取失败（${response.status}），请稍后重试。`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  async text(path: string): Promise<string> { return new TextDecoder().decode(await this.bytes(path)) }
  async json(path: string): Promise<any> {
    try { return JSON.parse(await this.text(path)) }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error('资料索引格式不正确，请重新生成索引。')
      throw error
    }
  }
  disconnect() { this.#abort.abort(); this.#token = '' }
}
