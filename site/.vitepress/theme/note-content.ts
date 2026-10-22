import { digest as digestText, normalizeText } from './comment-model.ts'
import { markdownBody, parseMarkdownBody } from './markdown-core.ts'
import type { NoteSaveInput } from './note-store'

export type NoteParagraph = { blockId: string; text: string; textDigest: string; sectionTitle: string }
export type NoteAssetDigest = { path: string; digest: string }

function flattenInline(tokens: any[] = []): string {
  return tokens.map(token => {
    if (token.type === 'text' || token.type === 'code_inline') return token.content
    if (token.type === 'image') return token.content || (token.children || []).map((child: any) => child.content || '').join('')
    if (token.type === 'kb-math') return `公式 ${token.content}`
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' '
    return token.children ? flattenInline(token.children) : ''
  }).join('')
}

function tokenAst(token: any): any {
  return {
    type: token.type,
    tag: token.tag || '',
    nesting: token.nesting || 0,
    level: token.level || 0,
    attrs: token.attrs ? token.attrs.map(([key, value]: [string, string]) => [key, value]) : [],
    content: token.content || '',
    markup: token.markup || '',
    info: token.info || '',
    block: !!token.block,
    hidden: !!token.hidden,
    children: token.children ? token.children.map(tokenAst) : null,
  }
}

function blockMarkers(body: string): Map<number, string> {
  const lines = body.split('\n')
  const markers = new Map<number, string>()
  let fence: { char: string; length: number } | null = null
  for (let index = 0; index < lines.length; index++) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[index])
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) fence = { char: marker[0], length: marker.length }
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = null
      continue
    }
    if (fence) continue
    const match = /^\s*<!-- kb:block ([A-Za-z0-9-]+) -->\s*$/.exec(lines[index])
    if (match) markers.set(index + 1, match[1])
  }
  return markers
}

function oldParagraphs(body: string, documentPath: string): NoteParagraph[] {
  const tokens = parseMarkdownBody(body, documentPath)
  const markers = blockMarkers(markdownBody(body))
  const paragraphs: NoteParagraph[] = []
  let sectionTitle = ''
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.type === 'heading_open') {
      const inline = tokens[index + 1]
      if (inline?.type === 'inline') sectionTitle = normalizeText(flattenInline(inline.children || []))
    }
    if (token.type !== 'paragraph_open' || token.level !== 0) continue
    const inline = tokens[index + 1]
    if (inline?.type !== 'inline') continue
    const line = token.map?.[0] ?? -1
    const blockId = markers.get(line) || ''
    const text = normalizeText(flattenInline(inline.children || []))
    if (blockId && text) paragraphs.push({ blockId, text, textDigest: '', sectionTitle })
  }
  return paragraphs
}

function normalizeBody(markdown: string): string {
  const body = markdownBody(markdown).normalize('NFC').replace(/\r\n?/g, '\n').replace(/\n*$/, '\n')
  return body
}

function markdownImagePaths(body: string, path: string): string[] {
  const paths: string[] = []
  for (const token of parseMarkdownBody(body, path)) {
    if (token.type !== 'inline') continue
    for (const child of token.children || []) if (child.type === 'image') {
      const href = child.attrGet('src') || ''
      if (/^(?:assets\/)[A-Za-z0-9_.-]{1,100}\.(?:png|jpe?g|gif|webp|avif)$/i.test(href)) paths.push(`${path.slice(0, path.lastIndexOf('/') + 1)}${href}`)
    }
  }
  return [...new Set(paths)]
}

export function noteReferencedAssets(markdown: string, path: string): string[] { return markdownImagePaths(markdownBody(markdown), path) }

export function editableNoteMarkdown(markdown: string): string {
  const body = normalizeBody(markdownBody(markdown))
  const markerLines = new Set([...blockMarkers(body).keys()].map(line => line - 1))
  return body.split('\n').filter((_line, index) => !markerLines.has(index)).join('\n').replace(/\n*$/, '\n')
}

export async function buildNoteContent(input: NoteSaveInput, existingMarkdown: string, assets: Map<string, Uint8Array>, created: string, updated: string) {
  const documentId = input.documentId
  if (!/^note-[A-Za-z0-9-]+$/.test(documentId)) throw new Error('笔记 ID 格式无效。')
  const path = `content/notes/${documentId}/index.md`
  const body = normalizeBody(input.markdown)
  const oldBody = normalizeBody(existingMarkdown)
  const previous = oldParagraphs(oldBody, path)
  const previousById = new Map(previous.map(paragraph => [paragraph.blockId, paragraph]))

  const tokens = parseMarkdownBody(body, path)
  const markers = blockMarkers(body)
  const originalLines = body.split('\n')
  const markerLineIndexes = new Set([...markers.keys()].map(line => line - 1))
  const cleanedBefore: number[] = []
  let cleanLineCount = 0
  for (let index = 0; index < originalLines.length; index++) {
    cleanedBefore[index] = cleanLineCount
    if (!markerLineIndexes.has(index)) cleanLineCount++
  }
  const lines = originalLines.filter((_line, index) => !markerLineIndexes.has(index))
  const paragraphs: NoteParagraph[] = []
  const blockAtLine = new Map<number, string>()
  const used = new Set<string>()
  const previousByText = new Map<string, NoteParagraph[]>()
  for (const paragraph of previous) previousByText.set(paragraph.text, [...(previousByText.get(paragraph.text) || []), paragraph])
  const currentTextCounts = new Map<string, number>()
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.type !== 'paragraph_open' || token.level !== 0 || tokens[index + 1]?.type !== 'inline') continue
    const children = tokens[index + 1].children || []
    if (children.length && children.every((child: any) => ['image', 'softbreak', 'hardbreak'].includes(child.type))) continue
    const text = normalizeText(flattenInline(children))
    if (text) currentTextCounts.set(text, (currentTextCounts.get(text) || 0) + 1)
  }
  let sectionTitle = ''
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.type === 'heading_open') {
      const inline = tokens[index + 1]
      if (inline?.type === 'inline') sectionTitle = normalizeText(flattenInline(inline.children || []))
    }
    if (token.type !== 'paragraph_open' || token.level !== 0) continue
    const inline = tokens[index + 1]
    if (inline?.type !== 'inline') continue
    const startLine = token.map?.[0]
    if (!Number.isInteger(startLine)) continue
    const text = normalizeText(flattenInline(inline.children || []))
    if (!text) continue
    const children = inline.children || []
    if (children.length > 0 && children.every((child: any) => ['image', 'softbreak', 'hardbreak'].includes(child.type))) continue
    const explicit = markers.get(startLine)
    let blockId = explicit && previousById.get(explicit)?.text === text ? explicit : ''
    const oldMatches = previousByText.get(text) || []
    if (!blockId && oldMatches.length === 1 && currentTextCounts.get(text) === 1) blockId = oldMatches[0].blockId
    if (!blockId || used.has(blockId)) blockId = `b-${crypto.randomUUID()}`
    used.add(blockId)
    blockAtLine.set(cleanedBefore[startLine], blockId)
    paragraphs.push({ blockId, text, textDigest: await digestText(text), sectionTitle })
  }
  for (const [line, blockId] of [...blockAtLine.entries()].sort(([a], [b]) => b - a)) lines.splice(line, 0, `<!-- kb:block ${blockId} -->`)
  const markedBody = lines.join('\n').normalize('NFC').replace(/\r\n?/g, '\n').replace(/\n*$/, '\n')
  const ast = parseMarkdownBody(markedBody, path).map(tokenAst)
  const referencedPaths = markdownImagePaths(markedBody, path)
  const attachments: NoteAssetDigest[] = []
  for (const assetPath of referencedPaths) {
    const bytes = assets.get(assetPath)
    if (!bytes) throw new Error(`图片附件缺失：${assetPath}`)
    attachments.push({ path: assetPath, digest: await digestBytes(bytes) })
  }
  const canonical = { schemaVersion: 1, documentId, type: 'notes', title: input.title.normalize('NFC').trim(), ast, paragraphs: paragraphs.map(({ blockId, text, textDigest, sectionTitle: heading }) => ({ blockId, text, textDigest, sectionTitle: heading })), attachments }
  const canonicalJson = JSON.stringify(canonical)
  const contentRevision = await digestText(canonicalJson)
  const snapshot = { schemaVersion: 1, ...canonical, contentRevision, normalizationVersion: 'kb-text-v1' }
  const tags = [...new Set(input.tags.map(tag => tag.normalize('NFC').trim()).filter(Boolean))]
  const sources = input.sourceKind === 'blog' ? input.sources : []
  const frontmatter = [
    '---',
    'schemaVersion: 1',
    `documentId: ${documentId}`,
    `type: notes`,
    `sourceKind: ${input.sourceKind}`,
    `title: ${JSON.stringify(input.title.normalize('NFC').trim())}`,
    `status: ${input.status}`,
    `tags: ${JSON.stringify(tags)}`,
    `created: ${JSON.stringify(created)}`,
    `updated: ${JSON.stringify(updated)}`,
    `sources: ${JSON.stringify(sources)}`,
    '---',
  ].join('\n')
  const searchItems = buildSearchItems(markedBody, path, documentId, input.title.trim(), contentRevision, paragraphs)
  return { path, markdown: `${frontmatter}\n${markedBody}`, snapshot, contentRevision, paragraphs, assetPaths: referencedPaths, searchItems }
}

function buildSearchItems(body: string, path: string, documentId: string, title: string, contentRevision: string, paragraphs: NoteParagraph[]) {
  const tokens = parseMarkdownBody(body, path)
  const paragraphById = new Map(paragraphs.map(paragraph => [paragraph.blockId, paragraph]))
  const markers = blockMarkers(body)
  const items: any[] = []
  const add = (text: string, sectionTitle: string, blockId: string | null) => {
    const normalized = normalizeText(text)
    if (!normalized) return
    items.push({ documentId, paperId: null, type: 'notes', title, sectionTitle, blockId, contentRevision, text: normalized })
  }
  let sectionTitle = ''
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.type === 'heading_open' && token.level === 0) {
      const inline = tokens[index + 1]
      if (inline?.type === 'inline') {
        sectionTitle = normalizeText(flattenInline(inline.children || []))
        add(sectionTitle, sectionTitle, null)
      }
    }
    if (token.type === 'paragraph_open' && token.level === 0) {
      const inline = tokens[index + 1]
      if (inline?.type !== 'inline') continue
      const text = normalizeText(flattenInline(inline.children || []))
      const children = inline.children || []
      const imageOnly = children.length > 0 && children.every((child: any) => ['image', 'softbreak', 'hardbreak'].includes(child.type))
      const blockId = markers.get(token.map?.[0] ?? -1)
      const paragraph = blockId ? paragraphById.get(blockId) : undefined
      if (imageOnly || !paragraph) add(text, sectionTitle, null)
      else add(text, sectionTitle, paragraph.blockId)
    }
    if (['fence', 'code_block', 'kb-math-block'].includes(token.type)) add(token.content || '', sectionTitle, null)
    if (['bullet_list_open', 'ordered_list_open', 'blockquote_open', 'table_open'].includes(token.type) && token.level === 0) {
      let depth = 0
      let text = ''
      for (let cursor = index; cursor < tokens.length; cursor++) {
        const nested = tokens[cursor]
        if (nested.nesting === 1) depth++
        if (nested.nesting === -1) depth--
        if (nested.type === 'inline') text += `${flattenInline(nested.children || [])} `
        if (['fence', 'code_block', 'kb-math-block'].includes(nested.type)) text += `${nested.content || ''} `
        if (depth === 0 && cursor > index) { index = cursor; break }
      }
      add(text, sectionTitle, null)
    }
  }
  return items
}

async function digestBytes(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`
}
