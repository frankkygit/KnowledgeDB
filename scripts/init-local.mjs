import { mkdir, access } from 'node:fs/promises'
import { resolve } from 'node:path'

const directories = [
  'sources/docs',
  'sources/docs/content/papers',
  'sources/docs/content/notes',
  'sources/docs/content/topics',
  'sources/docs/content/inbox',
  'sources/docs/catalog',
  'sources/docs/revisions',
  'sources/comments',
  'sources/comments/annotations',
  'local-data/papers',
  'local-data/translations',
  'local-data/work',
]

for (const directory of directories) {
  const path = resolve(process.cwd(), directory)
  await mkdir(path, { recursive: true })
  try {
    await access(path)
  } catch {
    throw new Error(`Could not initialize ${directory}`)
  }
}

console.log('Local placeholder directories are ready. No repositories were cloned or initialized.')
