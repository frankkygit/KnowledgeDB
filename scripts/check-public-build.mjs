import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = new URL('../site/.vitepress/dist/', import.meta.url)
const forbiddenNames = /(?:^|\/)(?:local-data|sources|__local_docs|annotations|revisions|catalog)(?:\/|$)|\.(?:pdf|md|pem|key)$/i
const secret = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/
const offlineNoteLeak = /(?:__local_notes\/|note-blog-sample|note-personal-sample|示例 Blog 阅读记录|A sample article)/
let hasProductionNotesWorkspace = false

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const name = relative(root.pathname, path)
    if (entry.isSymbolicLink() || forbiddenNames.test(name)) {
      throw new Error(`Unexpected file in public build: ${name}`)
    }
    if (entry.isDirectory()) {
      await inspect(path)
    } else if (/\.(?:html|js|json|css|txt)$/.test(name)) {
      const body = await readFile(path, 'utf8')
      if (name.endsWith('.js') && body.includes('notes-sidebar-collapsed') && body.includes('保存到 GitHub') && body.includes('检查可恢复草稿')) hasProductionNotesWorkspace = true
      if (body.includes('/__local_docs/') || body.includes('/__local_notes/') || offlineNoteLeak.test(body) || secret.test(body)) {
        throw new Error(`Private preview endpoint, offline fixture or credential detected in ${name}`)
      }
    }
  }
}

await inspect(root.pathname)
if (!hasProductionNotesWorkspace) throw new Error('Production NotesWorkspace bundle was not found.')
console.log('Public build checked: no private directory exports, local endpoints, offline note fixtures or token patterns.')
