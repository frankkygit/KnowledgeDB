import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = new URL('../site/.vitepress/dist/', import.meta.url)
const forbiddenNames = /(?:^|\/)(?:local-data|sources|__local_docs|annotations|revisions|catalog)(?:\/|$)|\.(?:pdf|md|pem|key)$/i
const secret = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/

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
      if (body.includes('/__local_docs/') || secret.test(body)) {
        throw new Error(`Private preview endpoint or credential detected in ${name}`)
      }
    }
  }
}

await inspect(root.pathname)
console.log('Public build checked: no private directory exports, local preview endpoint or token patterns.')
