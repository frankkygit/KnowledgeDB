<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { GitHubComments, newComment } from './github-comments'
import { createAnchor, normalizeText, validateAnchor, type Anchor, type Operation, type Thread } from './comment-model'
const props = defineProps<{ doc: any; article: HTMLElement | null; docsCommit: string; loadSnapshot: (doc: any) => Promise<any>; localMode: boolean }>()
const repository = ref('')
const branch = ref('main')
const token = ref('')
const connected = ref(false)
const busy = ref(false)
const emit = defineEmits<{ busy: [value: boolean] }>()
watch(busy, value => emit('busy', value), { flush: 'sync' })
const error = ref('')
const status = ref('')
const quote = ref<{ blockId: string; text: string; range: Anchor['range']; exact: string } | null>(null)
const composer = ref(false)
const body = ref('')
const threads = ref<Thread[]>([])
const head = ref('')
const visible = ref(20)
const panel = ref<HTMLElement | null>(null)
const selectedParagraph = ref<HTMLElement | null>(null)
const paragraphTop = ref(0)
let client: GitHubComments | null = null
let session = 0
let pending: Operation | null = null
const drafts = new Map<string, { quote: typeof quote.value; body: string; pending: Operation | null; composer: boolean }>()
const currentThreads = computed(() => threads.value.filter(t => t.documentId === props.doc?.documentId).sort((a, b) => Number(attached(a)) - Number(attached(b))))
function attached(thread: Thread) { return thread.binding?.contentRevision === props.doc?.contentRevision && !!props.article?.querySelector(`[data-comment-block="${CSS.escape(thread.binding.blockId)}"]`) }
function captureSelection() {
  if (composer.value) return
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !props.article) { quote.value = null; return }
  const range = selection.getRangeAt(0)
  const parent = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest<HTMLElement>('p[data-comment-block]')
  const start = parent(range.startContainer)
  const end = parent(range.endContainer)
  if (!start || start !== end || !props.article.contains(start)) { quote.value = null; return }
  const fragment = range.cloneContents()
  if (fragment.querySelector('.katex, img, code') || [...start.querySelectorAll('.katex, code')].some(el => range.intersectsNode(el))) { quote.value = null; return }
  const text = normalizeText(start.textContent || '')
  const prefix = range.cloneRange(); prefix.selectNodeContents(start); prefix.setEnd(range.startContainer, range.startOffset)
  // Sentinel preserves a trailing normalized space, with code-point offsets for emoji.
  const startOffset = Array.from(normalizeText(prefix.toString() + '\u0001').slice(0, -1)).length
  const exact = normalizeText(range.toString())
  const leading = /^\s/u.test(range.toString()) && startOffset > 0 && !/\s$/u.test(prefix.toString()) ? 1 : 0
  const from = startOffset + leading
  const to = from + Array.from(exact).length
  if (!exact || Array.from(text).slice(from, to).join('') !== exact) { quote.value = null; return }
  quote.value = { blockId: start.dataset.commentBlock!, text, range: { start: from, end: to }, exact }
}
function pointParagraph(event: PointerEvent) {
  if (composer.value) return
  const target = (event.target as Element)?.closest<HTMLElement>('p[data-comment-block]')
  if (target && props.article?.contains(target)) {
    selectedParagraph.value = target
    paragraphTop.value = Math.max(70, Math.min(window.innerHeight - 70, target.getBoundingClientRect().top))
  } else if (!(event.target as Element)?.closest('.paragraph-comment')) selectedParagraph.value = null
}
function wholeParagraph() {
  const p = selectedParagraph.value
  if (!p) return
  const text = normalizeText(p.textContent || '')
  quote.value = { blockId: p.dataset.commentBlock!, text, range: null, exact: text }
  startComposer()
}
function startComposer() {
  if (!quote.value) return
  composer.value = true; selectedParagraph.value = null; error.value = ''; status.value = ''
  nextTick(() => { panel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }); panel.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }) })
}
function closeComposer() { composer.value = false; quote.value = null; body.value = ''; pending = null; error.value = '' }
async function connect() {
  const own = ++session
  client?.disconnect(); client = null; connected.value = false; threads.value = []; head.value = ''
  busy.value = true; error.value = ''
  try {
    const reader = new GitHubComments(repository.value.trim(), branch.value.trim(), token.value)
    client = reader; token.value = ''
    await reader.connect()
    const state = await reader.read()
    if (own !== session) return
    threads.value = state.threads; head.value = state.head; connected.value = true
  } catch (cause) {
    if (own !== session) return
    client?.disconnect(); client = null
    error.value = cause instanceof Error ? cause.message : '评论连接失败，草稿已保留。'
  } finally { if (own === session) busy.value = false }
}
async function refresh() {
  const own = session
  busy.value = true; error.value = ''
  try {
    const state = await client!.read()
    if (own !== session) return
    threads.value = state.threads; head.value = state.head
  } catch (cause) { if (own === session) error.value = cause instanceof Error ? cause.message : '评论读取失败。' }
  finally { if (own === session) busy.value = false }
}
async function save() {
  if (!client || !quote.value || !body.value.trim() || props.localMode) return
  const own = session
  const doc = props.doc
  const target = quote.value
  busy.value = true; error.value = ''; status.value = ''
  try {
    const snapshot = await props.loadSnapshot(doc)
    const anchor = await createAnchor(snapshot, doc, target.blockId, target.text, target.range)
    if (pending && (pending.payload.body !== body.value.trim() || JSON.stringify(pending.payload.anchor) !== JSON.stringify(anchor))) throw new Error('上次提交结果尚未确认，请先以原内容重试，确认后再新建评论。')
    if (!pending) pending = await newComment(doc.documentId, props.docsCommit, anchor, body.value.trim())
    const result = await client.create(pending, async () => {
      const current = await props.loadSnapshot(doc)
      await validateAnchor(current, doc, anchor)
    })
    if (own !== session) return
    threads.value = result.threads; head.value = result.head
    closeComposer(); status.value = '已保存到私有评论库'
  } catch (cause) { if (own === session) error.value = cause instanceof Error ? cause.message : '评论保存失败，草稿已保留，请重试。' }
  finally { if (own === session) busy.value = false }
}
function jump(thread: Thread) {
  if (!attached(thread)) return
  props.article?.querySelector(`[data-comment-block="${CSS.escape(thread.binding!.blockId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
watch(() => props.doc?.documentId, (id, old) => {
  if (old) drafts.set(old, { quote: quote.value, body: body.value, pending, composer: composer.value })
  const draft = drafts.get(id)
  quote.value = draft?.quote || null; body.value = draft?.body || ''; pending = draft?.pending || null; composer.value = draft?.composer || false
  selectedParagraph.value = null; visible.value = 20; error.value = ''; status.value = ''
})
watch(() => props.article, () => { selectedParagraph.value = null; if (!composer.value) quote.value = null })
onMounted(() => {
  document.addEventListener('selectionchange', captureSelection)
  document.addEventListener('pointerup', pointParagraph)
})
onBeforeUnmount(() => {
  session++; emit('busy', false); client?.disconnect(); token.value = ''; drafts.clear(); threads.value = []; body.value = ''; pending = null
  document.removeEventListener('selectionchange', captureSelection)
  document.removeEventListener('pointerup', pointParagraph)
})
</script>
<template>
  <button v-if="quote && !composer" type="button" class="quote-comment" @pointerdown.prevent @click="startComposer">引用并评论「{{ quote.exact.slice(0, 22) }}{{ quote.exact.length > 22 ? '…' : '' }}」</button>
  <button v-else-if="selectedParagraph && !composer" type="button" class="paragraph-comment" :style="{ top: `${paragraphTop}px` }" @pointerdown.prevent @click="wholeParagraph">评论此段</button>
  <section ref="panel" class="comments-panel" aria-label="文档评论">
    <h2>文档评论</h2>
    <p class="hint">在普通正文段落内选词，点击“引用并评论”；点击段落也可整段评论。列表、表格、代码与跨公式选词暂不开放。</p>
    <details v-if="!connected" :open="composer || undefined" class="comment-connection">
      <summary>连接私有评论库以保存、查看评论</summary>
      <form class="comment-form" @submit.prevent="connect">
        <label>评论私库（owner/repo）<input v-model="repository" placeholder="owner/私有评论库" required :disabled="busy" /></label>
        <label>分支<input v-model="branch" required :disabled="busy" /></label>
        <label>评论库读写令牌<input v-model="token" type="password" autocomplete="off" placeholder="仅授权 comments 私库 Contents 读写权限" required :disabled="busy" /></label>
        <button :disabled="busy">{{ busy ? '正在连接…' : '连接评论库' }}</button>
      </form>
      <p class="hint">请先创建并初始化私有 comments 仓库。令牌仅留在当前标签页内存，不需要正文库写权限。</p>
    </details>
    <form v-if="composer && quote" class="comment-composer" @submit.prevent="save">
      <strong>{{ quote.range ? '引用评论' : '整段评论' }}</strong><blockquote>{{ quote.exact }}</blockquote>
      <label for="comment-body">评论内容</label><textarea id="comment-body" v-model="body" rows="5" :disabled="busy" placeholder="写下你的疑问或想法…" />
      <p v-if="!connected" class="hint">尚未保存。连接评论库后可提交，连接失败会保留此草稿。</p>
      <p v-if="localMode" class="hint">本地草稿预览不提交评论，请在固定版本的私库阅读会话中保存。</p>
      <button type="submit" :disabled="busy || !connected || !body.trim() || localMode">{{ busy ? '正在保存…' : '保存评论' }}</button>
      <button type="button" :disabled="busy" @click="closeComposer">取消</button>
    </form>
    <p v-if="status" role="status">{{ status }}</p><p v-if="error" class="reader-error" role="alert">{{ error }}</p>
    <template v-if="connected">
      <div class="comment-summary"><span>共 {{ currentThreads.length }} 组讨论 · 读取版本 {{ head.slice(0, 8) }}</span><button :disabled="busy" @click="refresh">刷新评论</button></div>
      <p v-if="!currentThreads.length">本文暂无评论。</p>
      <div v-for="thread in currentThreads.slice(0, visible)" :key="thread.id" class="comment-thread">
        <span class="hint">{{ attached(thread) ? '当前版本' : '待重新链接 · 保留原引用，未自动迁移' }} · {{ thread.originalAnchor?.contentRevision?.slice(7, 15) }}</span>
        <blockquote>{{ thread.originalAnchor?.quote?.exact }}</blockquote>
        <p v-for="comment in thread.comments" :key="comment.id" class="comment-text">{{ comment.body }}</p>
        <button v-if="attached(thread)" @click="jump(thread)">跳转段落</button>
      </div>
      <button v-if="currentThreads.length > visible" @click="visible += 20">加载更多讨论</button>
    </template>
  </section>
</template>
