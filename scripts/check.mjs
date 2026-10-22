import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const required = [
  'package.json',
  'knowledge.config.example.json',
  'release-manifest.json',
  'site/index.md',
  'site/.vitepress/config.mts',
  'site/.vitepress/theme/index.ts',
  'site/public/reader-config.json',
]

for (const file of required) await readFile(new URL(`../${file}`, import.meta.url))

const config = JSON.parse(await readFile(new URL('../knowledge.config.example.json', import.meta.url), 'utf8'))
if (config.dataRoots.docs !== 'sources/docs' || config.dataRoots.comments !== 'sources/comments') {
  throw new Error('Local data roots must point to the documented placeholder directories.')
}

const manifest = JSON.parse(await readFile(new URL('../release-manifest.json', import.meta.url), 'utf8'))
const reader = JSON.parse(await readFile(new URL('../site/public/reader-config.json', import.meta.url), 'utf8'))
if (!/^[a-f0-9]{40}$/.test(reader.ref) || reader.ref !== manifest.docsCommit || reader.repository !== manifest.docsRepository) {
  throw new Error('Reader configuration and release manifest must pin the same docs repository and commit.')
}
const gitlink = execFileSync('git', ['ls-files', '--stage', 'sources/docs'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' }).trim()
if (!gitlink.startsWith(`160000 ${reader.ref} 0\t`)) {
  throw new Error('The docs submodule gitlink must match the published docs commit.')
}

execFileSync(process.execPath, ['--experimental-transform-types', 'scripts/check-reader.mjs'], { cwd: new URL('../', import.meta.url), stdio: 'inherit' })
execFileSync(process.execPath, ['scripts/check-shared-session.mjs'], { cwd: new URL('../', import.meta.url), stdio: 'inherit' })
execFileSync(process.execPath, ['scripts/check-reader-session-ui.mjs'], { cwd: new URL('../', import.meta.url), stdio: 'inherit' })
execFileSync(process.execPath, ['--experimental-transform-types', 'scripts/check-reader-cache.mjs'], { cwd: new URL('../', import.meta.url), stdio: 'inherit' })
execFileSync(process.execPath, ['scripts/check-offline-notes-race.mjs'], { cwd: new URL('../', import.meta.url), stdio: 'inherit' })
execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/check-markdown.mjs'], { cwd: new URL('../', import.meta.url), stdio: 'inherit' })

console.log(`Repository skeleton check passed (${required.length} required files).`)
