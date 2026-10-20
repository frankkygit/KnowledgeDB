import MarkdownIt from 'markdown-it'
import katex from 'katex'

export function relativeAsset(documentPath: string, href: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href) || /[\\?#\u0000]/.test(href)) return null
  const parts = documentPath.split('/').slice(0, -1)
  for (const part of href.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop() }
    else if (part && part !== '.') parts.push(part)
  }
  const path = parts.join('/')
  return path.startsWith('content/') && /\.(?:png|jpe?g|gif|webp|avif)$/i.test(path) ? path : null
}

function math(source: string, displayMode: boolean): string {
  return katex.renderToString(source, { displayMode, throwOnError: false, trust: false, strict: 'ignore', maxExpand: 500, maxSize: 20 })
}

const md = new MarkdownIt({ html: false, linkify: false, breaks: false })

md.inline.ruler.before('escape', 'kb-math', (state: any, silent: boolean) => {
  const start = state.pos
  const delimiter = state.src.startsWith('\\(', start) ? '\\(' : state.src[start] === '$' ? '$' : null
  if (!delimiter || state.src.startsWith('$$', start)) return false
  const closing = delimiter === '\\(' ? '\\)' : '$'
  const end = state.src.indexOf(closing, start + delimiter.length)
  if (end < 0 || end === start + delimiter.length || state.src.slice(start, end).includes('\n')) return false
  if (!silent) state.push('kb-math', 'math', 0).content = state.src.slice(start + delimiter.length, end)
  state.pos = end + closing.length
  return true
})
md.renderer.rules['kb-math'] = (tokens: any[], idx: number) => math(tokens[idx].content, false)

md.block.ruler.before('fence', 'kb-math-block', (state: any, line: number, endLine: number, silent: boolean) => {
  const first = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]).trim()
  if (first !== '$$' && first !== '\\[') return false
  const close = first === '$$' ? '$$' : '\\]'
  let end = line + 1
  while (end < endLine && state.src.slice(state.bMarks[end] + state.tShift[end], state.eMarks[end]).trim() !== close) end++
  if (end === endLine) return false
  if (silent) return true
  // Ingestion may place stable paragraph markers inside a display equation.
  // Keep their anchors, but never pass metadata to KaTeX.
  const content = state.getLines(line + 1, end, state.blkIndent, false).replace(
    /^\s*<!-- kb:block ([A-Za-z0-9-]+) -->\s*$/gm,
    (_marker: string, id: string) => {
      state.push('kb-anchor', 'span', 0).content = id
      return ''
    },
  )
  state.push('kb-math-block', 'math', 0).content = content
  state.line = end + 1
  return true
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
md.renderer.rules['kb-math-block'] = (tokens: any[], idx: number) => `<div class="math-display">${math(tokens[idx].content, true)}</div>`

md.block.ruler.before('paragraph', 'kb-anchor', (state: any, line: number, _endLine: number, silent: boolean) => {
  const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
  const match = /^\s*<!-- kb:block ([A-Za-z0-9-]+) -->\s*$/.exec(text)
  if (!match) return false
  if (silent) return true
  state.push('kb-anchor', 'span', 0).content = match[1]
  state.line = line + 1
  return true
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
md.renderer.rules['kb-anchor'] = (tokens: any[], idx: number) => `<span class="block-anchor" id="block-${tokens[idx].content}" data-block-id="${tokens[idx].content}"></span>`

// Accept only empty, named source anchors; arbitrary document HTML stays escaped.
md.block.ruler.before('paragraph', 'source-anchor', (state: any, line: number, _endLine: number, silent: boolean) => {
  const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
  const match = /^\s*<a\s+id=["']([A-Za-z][A-Za-z0-9_.:-]*)["']\s*>\s*<\/a>\s*$/.exec(text)
  if (!match) return false
  if (silent) return true
  state.push('source-anchor', 'span', 0).content = match[1]
  state.line = line + 1
  return true
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
md.renderer.rules['source-anchor'] = (tokens: any[], idx: number) => `<span id="${tokens[idx].content}"></span>`

md.renderer.rules.image = (tokens: any[], idx: number, _options: any, env: any) => {
  const token = tokens[idx]
  const path = relativeAsset(env.documentPath, token.attrGet('src') || '')
  const alt = md.utils.escapeHtml(token.content || '图片')
  return path ? `<img alt="${alt}" data-kb-asset="${md.utils.escapeHtml(path)}" loading="lazy">` : `<span class="image-unavailable">[${alt}：外部图片未加载]</span>`
}

export function renderMarkdownBody(markdown: string, documentPath: string): string {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  return md.render(body, { documentPath })
}
