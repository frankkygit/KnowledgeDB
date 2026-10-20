import DOMPurify from 'dompurify'
import { renderMarkdownBody } from './markdown-core'

export function renderMarkdown(markdown: string, documentPath: string): string {
  return DOMPurify.sanitize(renderMarkdownBody(markdown, documentPath), {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'input', 'button', 'foreignObject'],
    ADD_ATTR: ['data-kb-asset', 'data-block-id'],
  })
}
