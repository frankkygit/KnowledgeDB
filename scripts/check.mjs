import { readFile } from 'node:fs/promises'

const required = [
  'package.json',
  'knowledge.config.example.json',
  'release-manifest.json',
  'site/index.md',
  'site/.vitepress/config.mts',
  'site/.vitepress/theme/index.ts',
]

for (const file of required) await readFile(new URL(`../${file}`, import.meta.url))

const config = JSON.parse(await readFile(new URL('../knowledge.config.example.json', import.meta.url), 'utf8'))
if (config.dataRoots.docs !== 'sources/docs' || config.dataRoots.comments !== 'sources/comments') {
  throw new Error('Local data roots must point to the documented placeholder directories.')
}

console.log(`Repository skeleton check passed (${required.length} required files).`)
