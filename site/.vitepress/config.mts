import { defineConfig } from 'vitepress'
import type { Plugin } from 'vite'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'

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
  vite: { plugins: [localPrivateDocsPreview()] },
})
