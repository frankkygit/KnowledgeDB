import DOMPurify from 'dompurify'
import { renderMarkdownBody } from './markdown-core'

export function renderMarkdown(markdown: string, documentPath: string): string {
  return sanitizeHtml(renderMarkdownBody(markdown, documentPath))
}

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'input', 'button', 'foreignObject'],
    ADD_ATTR: ['data-kb-asset', 'data-block-id', 'data-comment-block'],
  })
}
