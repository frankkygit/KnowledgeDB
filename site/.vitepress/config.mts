import { defineConfig } from 'vitepress'
import type { Plugin } from 'vite'
import { readFile, writeFile, mkdir, access, realpath } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const noteDemoRoot = resolve(process.cwd(), 'local-data/note-demo-git')
async function ensureNoteDemo() {
  await mkdir(noteDemoRoot, { recursive: true })
  try { await access(resolve(noteDemoRoot, '.git')) } catch {
    execFileSync('git', ['init', '-q', noteDemoRoot])
    execFileSync('git', ['-C', noteDemoRoot, 'config', 'user.name', 'KnowledgeDB Offline Demo'])
    execFileSync('git', ['-C', noteDemoRoot, 'config', 'user.email', 'offline-demo@localhost'])
    await mkdir(resolve(noteDemoRoot, 'catalog'), { recursive: true })
    await writeFile(resolve(noteDemoRoot, 'catalog/notes.json'), JSON.stringify({ schemaVersion: 1, notes: [], requests: {} }, null, 2) + '\n')
    execFileSync('git', ['-C', noteDemoRoot, 'add', 'catalog/notes.json'])
    execFileSync('git', ['-C', noteDemoRoot, 'commit', '-qm', 'Initialize empty offline note demo'])
  }
}

function localNoteDemo(): Plugin {
  return {
    name: 'local-note-git-demo', apply: 'serve',
    configureServer(server) {
      if (process.env.KNOWLEDGE_NOTE_OFFLINE_DEMO !== '1') return
      const git = (...args: string[]) => execFileSync('git', ['-C', noteDemoRoot, ...args], { encoding: 'utf8' }).trim()
      let saveQueue = Promise.resolve()
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost')
        if (!url.pathname.startsWith('/__local_notes/')) return next()
        const send = (status: number, body: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)) }
        try {
          await ensureNoteDemo()
          const catalogPath = resolve(noteDemoRoot, 'catalog/notes.json')
          let catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
          if (req.method === 'GET' && url.pathname === '/__local_notes/catalog') {
            for (const note of catalog.notes) {
              if (!/^note-[A-Za-z0-9-]+$/.test(note.documentId) || note.path !== `content/notes/${note.documentId}/index.md`) throw new Error('笔记目录含有无效路径。')
              const realRoot = await realpath(noteDemoRoot)
              const actual = await realpath(resolve(noteDemoRoot, note.path))
              if (actual !== resolve(realRoot, note.path)) throw new Error('笔记路径解析到演示库之外。')
              note._text = await readFile(actual, 'utf8')
            }
            return send(200, { ...catalog, head: git('rev-parse', 'HEAD') })
          }
          if (req.method === 'GET' && url.pathname === '/__local_notes/document') {
            const note = catalog.notes.find((item: any) => item.documentId === url.searchParams.get('documentId'))
            if (!note) return send(404, { error: '笔记不存在。' })
            if (!/^note-[A-Za-z0-9-]+$/.test(note.documentId) || note.path !== `content/notes/${note.documentId}/index.md`) return send(400, { error: '笔记路径无效。' })
            const realRoot = await realpath(noteDemoRoot)
            const actual = await realpath(resolve(noteDemoRoot, note.path))
            if (actual !== resolve(realRoot, note.path)) return send(400, { error: '笔记路径解析到演示库之外。' })
            return send(200, { note, markdown: await readFile(actual, 'utf8'), head: git('rev-parse', 'HEAD') })
          }
          if (req.method === 'GET' && url.pathname === '/__local_notes/asset') {
            const note = catalog.notes.find((item: any) => item.documentId === url.searchParams.get('documentId'))
            const name = url.searchParams.get('name') || ''
            if (!note || !/^[A-Za-z0-9_.-]{1,100}\.(?:png|jpe?g|gif|webp|avif)$/i.test(name)) return send(404, { error: '附件不存在。' })
            if (!/^note-[A-Za-z0-9-]+$/.test(note.documentId) || note.path !== `content/notes/${note.documentId}/index.md`) return send(400, { error: '附件笔记路径无效。' })
            const assetPath = resolve(noteDemoRoot, dirname(note.path), 'assets', name)
            const root = await realpath(noteDemoRoot)
            const actual = await realpath(assetPath)
            if (!actual.startsWith(`${resolve(root, 'content/notes', note.documentId, 'assets')}/`)) return send(400, { error: '附件路径越界。' })
            const mime = name.toLowerCase().endsWith('.png') ? 'image/png' : name.toLowerCase().endsWith('.jpg') || name.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : name.toLowerCase().endsWith('.gif') ? 'image/gif' : 'image/webp'
            res.statusCode = 200; res.setHeader('Content-Type', mime); res.setHeader('Cache-Control', 'no-store'); return res.end(await readFile(actual))
          }
          if (req.method === 'POST' && url.pathname === '/__local_notes/save') {
            const host = req.headers.host || ''
            const origin = req.headers.origin
            if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) || (origin && !origin.startsWith(`http://${host}/`) && origin !== `http://${host}`)) return send(403, { error: '离线写入仅允许来自本机开发页面的请求。' })
            let body = ''
            for await (const chunk of req) { body += chunk; if (body.length > 55_000_000) return send(413, { error: '演示保存内容超过 55 MB 限制。' }) }
            const input = JSON.parse(body)
            if (!/^[a-f0-9-]{36}$/i.test(input.requestId || '')) return send(400, { error: '保存请求缺少有效 requestId。' })
            const payloadHash = createHash('sha256').update(JSON.stringify({ documentId: input.documentId || null, title: input.title, tags: input.tags, status: input.status, markdown: input.markdown, assets: input.assets })).digest('hex')
            let unlock!: () => void
            const previousSave = saveQueue
            saveQueue = new Promise<void>(resolve => { unlock = resolve })
            await previousSave
            try {
            catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
            catalog.requests ||= {}
            if (catalog.requests[input.requestId]) {
              if (catalog.requests[input.requestId].operation === 'delete' || catalog.requests[input.requestId].payloadHash !== payloadHash) return send(409, { error: 'requestId 已用于不同操作或内容，拒绝重复提交。' })
              const previousNote = catalog.notes.find((item: any) => item.documentId === catalog.requests[input.requestId].documentId)
              const originalCommit = git('log', '--format=%H', '--grep', `Note-Request: ${input.requestId}`, '-n', '1')
              if (!originalCommit) return send(409, { error: '幂等记录存在但对应提交不可用，请保留草稿并检查本地 Git 历史。' })
              return send(200, { note: previousNote, head: originalCommit, message: '已识别此前保存的本地 Git 提交；远端尚未接通。' })
            }
            const head = git('rev-parse', 'HEAD')
            if (input.expectedHead !== head) return send(409, { error: '本地版本已被其他窗口更新，请重新载入后合并修改。', head })
            if (git('status', '--porcelain')) return send(409, { error: '本地演示库存在未提交文件；为避免把失败草稿混入其他提交，请先检查或重置演示库。', head })
            if (!input.title?.trim() || !input.markdown?.trim() || !['draft', 'published'].includes(input.status) || !Array.isArray(input.tags)) return send(400, { error: '标题、正文、状态或标签无效。' })
            if (!Array.isArray(input.assets) || input.assets.length > 10) return send(400, { error: '附件数量无效。' })
            const validatedAssets = [] as { name: string; bytes: Buffer }[]
            for (const asset of input.assets) {
              if (!/^[A-Za-z0-9_.-]{1,100}\.(?:png|jpe?g|gif|webp|avif)$/i.test(asset.name || '') || !/^image\/(?:png|jpeg|gif|webp|avif)$/.test(asset.type || '') || typeof asset.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.base64)) return send(400, { error: '仅支持有效的 PNG、JPEG、GIF、WebP、AVIF 图片。' })
              const bytes = Buffer.from(asset.base64, 'base64')
              if (!bytes.length || bytes.length > 5_000_000) return send(400, { error: '单张图片需小于 5 MB。' })
              validatedAssets.push({ name: asset.name, bytes })
            }
            let note = catalog.notes.find((item: any) => item.documentId === input.documentId)
            if (input.documentId && !note) return send(404, { error: '目标笔记不存在。' })
            if (!note) {
              const id = `note-${crypto.randomUUID()}`
              note = { documentId: id, sourceKind: 'personal', path: `content/notes/${id}/index.md`, created: new Date().toISOString(), sources: [] }
              catalog.notes.push(note)
            }
            note.title = input.title.trim(); note.status = input.status
            note.tags = [...new Set(input.tags.map((tag: string) => tag.trim()).filter(Boolean))]
            note.updated = new Date().toISOString()
            if (!new RegExp(`^content/notes/${note.documentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/index\\.md$`).test(note.path)) return send(400, { error: '笔记路径不符合演示库约束。' })
            const notePath = resolve(noteDemoRoot, note.path)
            if (!notePath.startsWith(`${noteDemoRoot}/`)) return send(400, { error: '笔记路径越界。' })
            try {
              await mkdir(resolve(noteDemoRoot, dirname(note.path)), { recursive: true })
              const assetsPath = resolve(noteDemoRoot, dirname(note.path), 'assets')
              await mkdir(assetsPath, { recursive: true })
              const realRoot = await realpath(noteDemoRoot)
              const realAssetsPath = await realpath(assetsPath)
              if (realAssetsPath !== resolve(realRoot, 'content/notes', note.documentId, 'assets')) return send(400, { error: '附件目录路径越界。' })
              try {
                const existingNotePath = await realpath(notePath)
                if (existingNotePath !== resolve(realRoot, note.path)) return send(400, { error: '笔记正文不能指向演示库之外。' })
              } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
              const assetPaths: string[] = []
              for (const asset of validatedAssets) {
                await writeFile(resolve(realAssetsPath, asset.name), asset.bytes, { flag: 'wx' })
                assetPaths.push(`${note.path.replace(/\/index\.md$/, '')}/assets/${asset.name}`)
              }
              const markdown = input.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim() + '\n'
              await writeFile(notePath, markdown)
              catalog.requests[input.requestId] = { operation: 'save', payloadHash, documentId: note.documentId }
              await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n')
              git('add', 'catalog/notes.json', note.path, ...assetPaths)
              git('commit', '-m', `Update note: ${note.title}`, '-m', `Note-Request: ${input.requestId}`)
            } catch (error) {
              if (git('rev-parse', 'HEAD') === head) { git('reset', '--hard', head); git('clean', '-fd') }
              throw error
            }
            return send(200, { note, head: git('rev-parse', 'HEAD'), message: '已保存到本地 Git 演示库；远端尚未接通。' })
            } finally { unlock() }
          }
          if (req.method === 'POST' && url.pathname === '/__local_notes/delete') {
            const host = req.headers.host || ''
            const origin = req.headers.origin
            if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) || (origin && !origin.startsWith(`http://${host}/`) && origin !== `http://${host}`)) return send(403, { error: '离线写入仅允许来自本机开发页面的请求。' })
            let body = ''
            for await (const chunk of req) { body += chunk; if (body.length > 1_000_000) return send(413, { error: '删除请求过大。' }) }
            const input = JSON.parse(body)
            if (!/^[a-f0-9-]{36}$/i.test(input.requestId || '') || !Array.isArray(input.documentIds) || !input.documentIds.length || input.documentIds.some((id: unknown) => typeof id !== 'string' || !/^note-[A-Za-z0-9-]+$/.test(id))) return send(400, { error: '删除目标或 requestId 无效。' })
            const ids = [...new Set(input.documentIds)].sort()
            if (ids.length !== input.documentIds.length) return send(400, { error: '删除目标包含重复笔记。' })
            const payloadHash = createHash('sha256').update(JSON.stringify({ operation: 'delete', expectedHead: input.expectedHead, documentIds: ids })).digest('hex')
            let unlock!: () => void
            const previousSave = saveQueue
            saveQueue = new Promise<void>(resolve => { unlock = resolve })
            await previousSave
            try {
              catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
              catalog.requests ||= {}
              const prior = catalog.requests[input.requestId]
              if (prior) {
                if (prior.operation !== 'delete' || prior.payloadHash !== payloadHash || JSON.stringify(prior.documentIds) !== JSON.stringify(ids)) return send(409, { error: 'requestId 已用于不同操作或笔记集合，拒绝重复删除。' })
                const originalCommit = git('log', '--format=%H', '--grep', `Note-Request: ${input.requestId}`, '-n', '1')
                if (!originalCommit) return send(409, { error: '幂等记录存在但对应提交不可用；保留选择后重试。' })
                return send(200, { documentIds: ids, head: originalCommit })
              }
              const head = git('rev-parse', 'HEAD')
              if (input.expectedHead !== head) return send(409, { error: '本地版本已更新；请刷新目录并重新确认删除。', head })
              if (git('status', '--porcelain')) return send(409, { error: '本地演示库存在未提交文件；请先检查演示库状态。', head })
              const targets = ids.map((id: string) => catalog.notes.find((item: any) => item.documentId === id && item.path === `content/notes/${id}/index.md`))
              if (targets.some((note: any) => !note)) return send(404, { error: '一个或多个目标笔记已不存在；当前选择仍保留。' })
              catalog.notes = catalog.notes.filter((note: any) => !ids.includes(note.documentId))
              catalog.requests[input.requestId] = { operation: 'delete', payloadHash, documentIds: ids }
              try {
                await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n')
                git('add', 'catalog/notes.json')
                for (const note of targets) git('rm', '--', note.path)
                const label = targets.length === 1 ? targets[0].title : `${targets.length} 篇笔记`
                git('commit', '-m', `Delete note: ${label}`, '-m', `Note-Request: ${input.requestId}`)
              } catch (error) {
                if (git('rev-parse', 'HEAD') === head) { git('reset', '--hard', head); git('clean', '-fd') }
                throw error
              }
              return send(200, { documentIds: ids, head: git('rev-parse', 'HEAD'), message: '已删除本地 Git 演示笔记；历史版本仍保留。' })
            } finally { unlock() }
          }
          return send(405, { error: 'Method not allowed' })
        } catch (error) { return send(500, { error: error instanceof Error ? error.message : '离线演示库不可用。' }) }
      })
    },
  }
}

function localPrivateDocsPreview(): Plugin {
  return {
    name: 'local-private-docs-preview',
    apply: 'serve',
    configureServer(server) {
      if (process.env.KNOWLEDGE_LOCAL_PRIVATE_PREVIEW !== '1') return

      const docsRoot = resolve(process.cwd(), 'sources/docs')
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost')
        if (!url.pathname.startsWith('/__local_docs/')) return next()
        if (req.method !== 'GET') {
          res.statusCode = 405
          return res.end('Method not allowed')
        }

        try {
          if (url.pathname === '/__local_docs/catalog' || url.pathname === '/__local_docs/search') {
            const data = await readFile(resolve(docsRoot, url.pathname.endsWith('/search') ? 'catalog/search.json' : 'catalog/papers.json'), 'utf8')
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.setHeader('Cache-Control', 'no-store')
            return res.end(data)
          }

          if (url.pathname === '/__local_docs/document') {
            const documentId = url.searchParams.get('documentId')
            if (!documentId) {
              res.statusCode = 400
              return res.end('Missing documentId')
            }
            const catalog = JSON.parse(await readFile(resolve(docsRoot, 'catalog/papers.json'), 'utf8'))
            const paper = catalog.papers.find((item: any) => item.documents.some((doc: any) => doc.documentId === documentId))
            const document = paper?.documents.find((item: any) => item.documentId === documentId)
            if (!paper || !document) {
              res.statusCode = 404
              return res.end('Document not found')
            }
            const markdown = await readFile(resolve(docsRoot, document.path), 'utf8')
            const snapshot = JSON.parse(await readFile(resolve(docsRoot, `revisions/${document.documentId}/${document.contentRevision.slice(7)}.json`), 'utf8'))
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.setHeader('Cache-Control', 'no-store')
            return res.end(JSON.stringify({ ...document, markdown, snapshot }))
          }

          if (url.pathname.startsWith('/__local_docs/assets/')) {
            const [, , , paperId, ...assetParts] = url.pathname.split('/').map(decodeURIComponent)
            if (!paperId || assetParts.length !== 2 || assetParts[0] !== 'assets' || assetParts.some((part) => part === '.' || part === '..')) {
              res.statusCode = 400
              return res.end('Invalid asset path')
            }
            const catalog = JSON.parse(await readFile(resolve(docsRoot, 'catalog/papers.json'), 'utf8'))
            const knownPaperFolder = catalog.papers.some((paper: any) => paper.documents.some((doc: any) => basename(dirname(doc.path)) === paperId))
            if (!knownPaperFolder) {
              res.statusCode = 404
              return res.end('Paper asset not found')
            }
            const assetPath = resolve(docsRoot, 'content/papers', paperId, ...assetParts)
            const allowedRoot = resolve(docsRoot, 'content/papers', paperId, 'assets')
            if (!assetPath.startsWith(`${allowedRoot}/`)) {
              res.statusCode = 400
              return res.end('Invalid asset path')
            }
            const bytes = await readFile(assetPath)
            const mime = extname(assetPath) === '.png' ? 'image/png' : 'application/octet-stream'
            res.setHeader('Content-Type', mime)
            res.setHeader('Cache-Control', 'no-store')
            return res.end(bytes)
          }

          res.statusCode = 404
          return res.end('Not found')
        } catch (error) {
          res.statusCode = 503
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          return res.end('Local private docs preview is unavailable.')
        }
      })
    },
  }
}

export default defineConfig({
  title: '私人知识库',
  description: '本地知识库阅读器骨架',
  base: process.env.SITE_BASE || '/',
  cleanUrls: true,
  markdown: { math: true },
  vite: { plugins: [localPrivateDocsPreview(), localNoteDemo()] },
})
