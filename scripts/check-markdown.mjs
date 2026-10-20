import assert from 'node:assert/strict'
import { renderMarkdownBody } from '../site/.vitepress/theme/markdown-core.ts'

const fixture = String.raw`<a id="E001"></a>
<!-- kb:block source-1 -->
**Source:** Eq. (3)

$$
<!-- kb:block equation-1 -->
\mathcal{L}=\sum_{i=1}^{M}\left[s_i+\lambda\right]
$$

中文说明：$\lambda$。
<!-- kb:block following-1 -->
后续段落
`
const html = renderMarkdownBody(fixture, 'content/papers/example/translation.md')
for (const id of ['source-1', 'equation-1', 'following-1']) {
  assert.equal(html.split(`data-block-id="${id}"`).length - 1, 1)
}
assert.ok(html.includes('id="E001"'))
assert.ok(html.indexOf('data-block-id="equation-1"') < html.indexOf('class="math-display"'))
assert.equal(html.match(/class="katex"/g)?.length, 2)
assert.doesNotMatch(html, /kb:block|katex-error|&lt;a /)
assert.ok(html.includes('<strong>Source:</strong>'))
assert.ok(renderMarkdownBody('```html\n<a id="E001"></a>\n<!-- kb:block example -->\n```', '').includes('&lt;!-- kb:block example --&gt;'))
assert.ok(renderMarkdownBody('<a id="E001" onclick="alert(1)"></a>', '').includes('&lt;a'))
assert.ok(renderMarkdownBody('before\n\\[\nx^2\n\\]\nafter', '').includes('class="math-display"'))
console.log('Markdown regression checks passed.')
