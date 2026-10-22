<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { withBase } from 'vitepress'
import { commentsConfig, GitHubDocs, type ReaderConfig } from './github-docs'
import { renderMarkdown, sanitizeHtml } from './markdown'
import { RenderCache, renderCacheKey } from './render-cache'
import ReaderComments from './ReaderComments.vue'
import { GitHubNotesStore } from './github-notes'
import type { NotesStore } from './note-store'
import { clearCredential, readCredential, saveCredential } from './remember-browser'
import 'katex/dist/katex.min.css'

const sections = [{ id: 'papers', label: '论文' }, { id: 'notes', label: '笔记' }, { id: 'topics', label: '专题' }]
const documentTypes = [{ id: 'analysis', label: '概述' }, { id: 'translation', label: '翻译' }, { id: 'notes', label: '笔记' }]
const isDevelopment = import.meta.env.DEV
const OfflineNotes = defineAsyncComponent(() => import('./OfflineNotes.vue'))
const offlineNotesRef = ref<{ confirmLeave: () => Promise<boolean> } | null>(null)
const notesSidebarCollapsed = ref(false)
const activeSection = ref('papers')
const activeDocument = ref('analysis')
const menuOpen = ref(false)
const query = ref('')
const papers = ref<any[]>([])
const searchItems = ref<any[]>([])
const selectedPaperId = ref('')
const config = ref<ReaderConfig | null>(null)
const commentStoreConfig = computed(() => commentsConfig(config.value))
const tokenInput = ref('')
const rememberBrowser = ref(false)
const storedCredentialAvailable = ref(false)
const credentialNotice = ref('')
const notesEverVisited = ref(false)
const sharedToken = ref('')
const connected = ref(false)
const notesStore = shallowRef<NotesStore | null>(null)
const connecting = ref(false)
const loadingDocument = ref(false)
const error = ref('')
const loadStatus = ref('尚未连接资料库')
const renderedHtml = ref('')
const article = ref<HTMLElement | null>(null)
const headings = ref<{ id: string; title: string; level: number }[]>([])
const activeHeadingId = ref('')
const outlineOpen = ref(false)
const outlineRoot = ref<HTMLElement | null>(null)
let headingObserver: ResizeObserver | null = null
let headingFrame = 0
const cacheStatus = ref('')
const commentsBusy = ref(false)
const htmlCache = new RenderCache()
function goTop() { article.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
function jumpHeading(id: string) {
  closeOutline()
  const target = article.value?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' }); target?.focus({ preventScroll: true })
}
function updateActiveHeading() {
  headingFrame = 0
  const elements = headings.value.map(item => article.value?.querySelector<HTMLElement>(`#${CSS.escape(item.id)}`)).filter((item): item is HTMLElement => Boolean(item))
  if (!elements.length) { activeHeadingId.value = ''; return }
  const threshold = 150
  let active = elements[0]
  for (const heading of elements) {
    if (heading.getBoundingClientRect().top <= threshold) active = heading
    else break
  }
  activeHeadingId.value = active.id
}
function scheduleActiveHeading() {
  if (activeSection.value === 'papers' && !headingFrame) headingFrame = requestAnimationFrame(updateActiveHeading)
}
function observeArticleLayout() {
  headingObserver?.disconnect()
  headingObserver = null
  if (typeof ResizeObserver !== 'undefined' && article.value) {
    headingObserver = new ResizeObserver(scheduleActiveHeading)
    headingObserver.observe(article.value)
  }
  scheduleActiveHeading()
}
function resetHeadingState() {
  headings.value = []; activeHeadingId.value = ''; outlineOpen.value = false
  headingObserver?.disconnect(); headingObserver = null
  if (headingFrame) cancelAnimationFrame(headingFrame)
  headingFrame = 0
}
function closeOutline() {
  outlineOpen.value = false
  if (outlineRoot.value?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
}
function toggleOutline(event: MouseEvent) {
  outlineOpen.value = !outlineOpen.value
  if (!outlineOpen.value) (event.currentTarget as HTMLElement).blur()
}
async function clearHtmlCache() { await htmlCache.clear(); cacheStatus.value = '已清除 HTML 缓存' }
async function loadSnapshot(doc: any) {
  if (import.meta.env.DEV && localMode) {
    const response = await fetch(`/__local_docs/document?documentId=${encodeURIComponent(doc.documentId)}`, { cache: 'no-store' })
    if (!response.ok) throw new Error('无法读取本地版本快照。')
    return (await response.json()).snapshot
  }
  if (!client || !/^sha256:[a-f0-9]{64}$/.test(doc.contentRevision) || !/^[A-Za-z0-9-]+$/.test(doc.documentId)) throw new Error('文档版本无效，请重新连接。')
  return client.json(`revisions/${doc.documentId}/${doc.contentRevision.slice(7)}.json`)
}
function articleLink(event: MouseEvent) {
  const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]')
  if (!link || !article.value?.contains(link)) return
  const href = link.getAttribute('href') || ''
  if (href.startsWith('#') && !href.startsWith('#/')) {
    event.preventDefault()
    try { jumpHeading(decodeURIComponent(href.slice(1))) } catch { /* Ignore malformed source anchors. */ }
  }
}

let client: GitHubDocs | null = null
let pendingNotesStore: GitHubNotesStore | null = null
let localMode = false
let generation = 0
let documentGeneration = 0
let objectUrls: string[] = []
let suppressAutoReconnect = false
let paperScrollTop = 0
let notesScrollTop = 0
let notesSidebarScrollTop = 0
const selectedPaper = computed(() => papers.value.find(p => p.paperId === selectedPaperId.value) || null)
const activeDoc = computed(() => selectedPaper.value?.documents.find((d: any) => d.type === activeDocument.value))
const needle = computed(() => query.value.normalize('NFC').trim().toLocaleLowerCase())
const results = computed(() => needle.value ? searchItems.value.filter(i => i.paperId && `${i.title} ${i.sectionTitle} ${i.text}`.normalize('NFC').toLocaleLowerCase().includes(needle.value)).slice(0, 30) : [])
const visiblePapers = computed(() => needle.value ? papers.value.filter(p => `${p.title}`.toLocaleLowerCase().includes(needle.value) || results.value.some(i => i.paperId === p.paperId)) : papers.value)

function clearImages() { objectUrls.forEach(url => URL.revokeObjectURL(url)); objectUrls = [] }
function disconnect(purgeCache = true) {
  suppressAutoReconnect = true
  generation++; documentGeneration++
  sharedToken.value = ''
  client?.disconnect(); client = null; localMode = false
  pendingNotesStore?.disconnect(); pendingNotesStore = null
  notesStore.value?.disconnect(); notesStore.value = null
  if (purgeCache) void htmlCache.clear(); else htmlCache.forget()
  resetHeadingState(); cacheStatus.value = ''
  clearImages(); tokenInput.value = ''; papers.value = []; searchItems.value = []
  renderedHtml.value = ''; selectedPaperId.value = ''; query.value = ''
  connected.value = false; connecting.value = false; loadingDocument.value = false
  loadStatus.value = '尚未连接资料库'; error.value = ''
  notesEverVisited.value = false; paperScrollTop = 0; notesScrollTop = 0; notesSidebarScrollTop = 0
}
function credentialNamespace() {
  return { base: withBase('/'), docs: config.value?.repository || '', comments: commentStoreConfig.value.repository }
}
function forgetAuthorization() {
  const namespace = credentialNamespace()
  const cleared = clearCredential(namespace.base, namespace.docs, namespace.comments)
  storedCredentialAvailable.value = false; rememberBrowser.value = false
  notesStore.value?.clearPrivateCache?.()
  disconnect(true)
  credentialNotice.value = cleared
    ? '已退出并清除本机授权；未保存草稿仍保留在本机。'
    : '已断开会话，但浏览器拒绝确认授权已删除；请在浏览器设置中清除此站点的数据。未保存草稿仍保留。'
}
function invalidateAuthorization() {
  const namespace = credentialNamespace()
  const cleared = clearCredential(namespace.base, namespace.docs, namespace.comments)
  rememberBrowser.value = false
  storedCredentialAvailable.value = false
  disconnect(true)
  credentialNotice.value = cleared ? '授权已失效，本机保存的授权已清除。' : '授权已失效；浏览器拒绝确认授权已删除，请在浏览器设置中清除此站点的数据。'
  error.value = 'GitHub 返回 401；请重新连接有效的 PAT。'
}

function normalizeCatalog(catalog: any) {
  if (!Array.isArray(catalog.papers)) throw new Error('论文目录格式不正确。')
  const ids = new Set<string>()
  for (const paper of catalog.papers) {
    if (!paper.paperId || !Array.isArray(paper.documents)) throw new Error('论文目录缺少入口信息。')
    for (const doc of paper.documents) {
      if (!doc.documentId || ids.has(doc.documentId) || !/^content\/.+\.md$/.test(doc.path)) throw new Error('文档映射不正确。')
      ids.add(doc.documentId)
    }
  }
  return catalog.papers
}

async function showDocument(blockId = '') {
  const current = ++documentGeneration
  const session = generation
  clearImages(); renderedHtml.value = ''; resetHeadingState(); cacheStatus.value = ''; error.value = ''
  loadingDocument.value = false
  const doc = activeDoc.value
  if (!doc) return
  loadingDocument.value = true
  try {
    let html: string
    if (import.meta.env.DEV && localMode) {
      const response = await fetch(`/__local_docs/document?documentId=${encodeURIComponent(doc.documentId)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('本地文档读取失败。')
      const data = await response.json()
      // Development drafts may change without a new published revision; never persist them.
      html = renderMarkdown(data.markdown, doc.path)
      cacheStatus.value = '本地草稿预览'
    } else {
      const reader = client
      if (!reader) return
      const key = renderCacheKey(reader.config.repository, reader.config.ref, doc)
      const cached = await htmlCache.get(key)
      if (current !== documentGeneration || session !== generation) return
      if (cached !== null) { html = sanitizeHtml(cached); cacheStatus.value = '已加载 HTML 缓存' }
      else {
        html = renderMarkdown(await reader.text(doc.path), doc.path)
        if (current !== documentGeneration || session !== generation) return
        void htmlCache.put(key, html)
        cacheStatus.value = '已渲染并缓存 HTML'
      }
    }
    if (current !== documentGeneration || session !== generation) return
    renderedHtml.value = html
    await nextTick()
    if (current !== documentGeneration || session !== generation) return
    headings.value = Array.from(article.value?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6') || []).map((heading, index) => {
      if (!heading.id) heading.id = `kb-heading-${index + 1}`
      heading.tabIndex = -1
      return { id: heading.id, title: heading.textContent || '', level: Number(heading.tagName.slice(1)) }
    })
    observeArticleLayout()
    article.value?.addEventListener('load', scheduleActiveHeading, true)
    if (activeSection.value === 'papers') {
      if (blockId) document.getElementById(`block-${blockId}`)?.scrollIntoView({ block: 'start' })
      else window.scrollTo({ top: 0 })
    }
    loadingDocument.value = false
    if (article.value && (client || (import.meta.env.DEV && localMode))) {
      const reader = client
      // Asset URLs are resolved through authenticated GitHub requests, never public raw URLs.
      for (const image of article.value.querySelectorAll<HTMLImageElement>('img[data-kb-asset]')) {
        try {
          const path = image.dataset.kbAsset!
          let bytes: Uint8Array
          if (import.meta.env.DEV && localMode) {
            const response = await fetch(`/__local_docs/assets/${path.split('/').slice(2).map(encodeURIComponent).join('/')}`, { cache: 'no-store' })
            if (!response.ok) throw new Error('asset unavailable')
            bytes = new Uint8Array(await response.arrayBuffer())
          } else bytes = await reader!.bytes(path)
          if (current !== documentGeneration || session !== generation) return
          const ext = path.split('.').pop()?.toLowerCase()
          const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' }
          const url = URL.createObjectURL(new Blob([bytes], { type: mime[ext || ''] || 'application/octet-stream' }))
          objectUrls.push(url); image.src = url
        } catch (cause) {
          if (current === documentGeneration && session === generation && (cause as any)?.status === 401) { invalidateAuthorization(); return }
          if (current === documentGeneration) image.alt += '（图片读取失败）'
        }
      }
    }
    if (current !== documentGeneration) return

  } catch (cause) {
    if (current === documentGeneration && session === generation && (cause as any)?.status === 401) { invalidateAuthorization(); return }
    if (current === documentGeneration && session === generation) error.value = cause instanceof Error ? cause.message : '文档读取失败，请重试。'
  } finally {
    if (current === documentGeneration) loadingDocument.value = false
  }
}

async function selectSection(id: string) {
  if (commentsBusy.value) return
  if (activeSection.value === id) return
  if (activeSection.value === 'notes' && id !== 'notes') {
    notesScrollTop = window.scrollY
    notesSidebarScrollTop = document.querySelector<HTMLElement>('.notes-sidebar')?.scrollTop || 0
  }
  if (id === 'notes') {
    closeOutline()
    if (headingFrame) cancelAnimationFrame(headingFrame)
    headingFrame = 0
    notesEverVisited.value = true
    paperScrollTop = window.scrollY
  }
  activeSection.value = id
  if (id === 'notes') window.history.replaceState(null, '', '#/notes')
  else if (id === 'papers' && selectedPaper.value) window.history.replaceState(null, '', `#/paper/${encodeURIComponent(selectedPaper.value.paperId)}`)
  if (id === 'papers' && selectedPaper.value) {
    await nextTick()
    if (renderedHtml.value) window.scrollTo({ top: paperScrollTop })
    else await showDocument()
  } else if (id === 'notes') {
    await nextTick()
    window.scrollTo({ top: notesScrollTop })
    const sidebar = document.querySelector<HTMLElement>('.notes-sidebar')
    if (sidebar) sidebar.scrollTop = notesSidebarScrollTop
  }
}
async function openPaper(paper: any) {
  if (commentsBusy.value) return
  selectedPaperId.value = paper.paperId; activeSection.value = 'papers'
  const overview = paper.documents.find((d: any) => d.documentId === paper.overviewDocumentId)
  activeDocument.value = overview?.type || 'analysis'; menuOpen.value = false
  window.history.replaceState(null, '', `#/paper/${encodeURIComponent(paper.paperId)}`)
  await showDocument()
}
async function openType(type: string) {
  if (commentsBusy.value) return
  activeDocument.value = type
  if (activeDoc.value) window.history.replaceState(null, '', `#/document/${encodeURIComponent(activeDoc.value.documentId)}`)
  await showDocument()
}
async function openResult(item: any) {
  if (commentsBusy.value) return
  const paper = papers.value.find(p => p.documents.some((d: any) => d.documentId === item.documentId))
  const doc = paper?.documents.find((d: any) => d.documentId === item.documentId)
  if (!doc) { error.value = '索引对应的文档不存在，请更新目录。'; return }
  selectedPaperId.value = paper.paperId; activeSection.value = 'papers'; activeDocument.value = doc.type
  menuOpen.value = false
  window.history.replaceState(null, '', `#/document/${encodeURIComponent(doc.documentId)}${item.blockId ? `?block=${encodeURIComponent(item.blockId)}` : ''}`)
  await showDocument(item.blockId || '')
}
async function restoreRoute() {
  if (commentsBusy.value) return
  const hash = window.location.hash.slice(1)
  if (hash && !hash.startsWith('/')) return // Native source anchors stay in this document.
  const [path, params = ''] = hash.split('?')
  const [, kind, rawId] = path.split('/')
  const id = rawId ? decodeURIComponent(rawId) : ''
  if (kind === 'notes' || kind === 'note') { activeSection.value = 'notes'; notesEverVisited.value = true; return }
  if (kind === 'document' && id) {
    const blockId = new URLSearchParams(params).get('block') || ''
    const paper = papers.value.find(p => p.documents.some((d: any) => d.documentId === id))
    if (paper) { await openResult({ documentId: id, blockId }); return }
  }
  const paper = kind === 'paper' ? papers.value.find(p => p.paperId === id) : papers.value[0]
  if (paper) await openPaper(paper)
}
async function connectWithToken() {
  const token = tokenInput.value
  await connectUsingToken(token, rememberBrowser.value)
}
async function retryStoredAuthorization() {
  const namespace = credentialNamespace()
  const saved = readCredential(namespace.base, namespace.docs, namespace.comments)
  if (!saved) { storedCredentialAvailable.value = false; return }
  rememberBrowser.value = saved.remember
  await connectUsingToken(saved.token, saved.remember, true)
}
async function connectUsingToken(token: string, remember: boolean, automatic = false) {
  disconnect(false)
  suppressAutoReconnect = false
  connecting.value = true; loadStatus.value = '正在读取私有资料…'
  const session = generation
  try {
    if (!config.value) throw new Error('站点连接配置未加载，请刷新页面。')
    const reader = new GitHubDocs(config.value, token)
    client = reader
    const [catalog, search] = await Promise.all([reader.json(config.value.catalogPath), reader.json(config.value.searchPath)])
    if (session !== generation) return
    papers.value = normalizeCatalog(catalog)
    if (!Array.isArray(search.items)) throw new Error('全文索引格式不正确。')
    searchItems.value = search.items
    const namespace = credentialNamespace()
    if (!automatic) {
      const storageComplete = saveCredential(token, remember, namespace.base, namespace.docs, namespace.comments)
      storedCredentialAvailable.value = Boolean(readCredential(namespace.base, namespace.docs, namespace.comments))
      credentialNotice.value = storageComplete ? '' : '本机授权存储或旧授权清理不完整；本次连接仍可使用，但浏览器中可能仍有旧授权，请检查此站点的存储设置。'
    } else credentialNotice.value = ''
    const noteStore = new GitHubNotesStore(config.value.repository, token, config.value.notesBranch || 'main')
    if (session !== generation || client !== reader) { noteStore.disconnect(); return }
    notesStore.value = noteStore
    sharedToken.value = token
    connected.value = true; loadStatus.value = `已连接 · ${papers.value.length} 篇论文`
    tokenInput.value = ''
    await restoreRoute()
  } catch (cause) {
    if (session !== generation) return
    sharedToken.value = ''
    pendingNotesStore?.disconnect(); pendingNotesStore = null
    client?.disconnect(); client = null; notesStore.value?.disconnect(); notesStore.value = null
    papers.value = []; searchItems.value = []; renderedHtml.value = ''; connected.value = false
    loadStatus.value = '连接未完成'
    error.value = cause instanceof Error ? cause.message : '连接失败，请检查网络。'
    if ((cause as any)?.status === 401 || /令牌无效或已过期/.test(error.value)) {
      invalidateAuthorization()
    } else if (automatic) credentialNotice.value = '自动连接未成功，本机授权仍保留供稍后重试。'
  } finally { if (session === generation) connecting.value = false }
}

onMounted(async () => {
  window.addEventListener('scroll', scheduleActiveHeading, { passive: true })
  window.addEventListener('resize', scheduleActiveHeading, { passive: true })
  window.addEventListener('pagehide', leavePage)
  window.addEventListener('hashchange', restoreRoute)
  document.addEventListener('pointerdown', closeOutlineOutside)
  document.addEventListener('keydown', closeOutlineOnEscape)
  try {
    const result = await fetch(withBase('/reader-config.json'), { cache: 'no-store' })
    if (!result.ok) throw new Error()
    config.value = await result.json()
  } catch { error.value = '站点连接配置未加载，请刷新页面。' }
  if (import.meta.env.DEV) {
    let hasLocalDocs = false
    try {
      const response = await fetch('/__local_docs/catalog', { cache: 'no-store' })
      if (response.ok) {
        const catalog = await response.json()
        papers.value = normalizeCatalog(catalog); localMode = true; connected.value = true; error.value = ''
        const search = await fetch('/__local_docs/search', { cache: 'no-store' })
        if (search.ok) searchItems.value = (await search.json()).items || []
        loadStatus.value = '本地预览 · 私有 docs 草稿'; hasLocalDocs = true
      }
    } catch { /* Fall through to the independent notes-only demo probe. */ }
    if (!hasLocalDocs) {
      try {
        const response = await fetch('/__local_notes/catalog', { cache: 'no-store' })
        if (!response.ok) return
        const catalog = await response.json()
        if (!Array.isArray(catalog.notes) || !/^[a-f0-9]{40}$/i.test(catalog.head || '')) throw new Error('本地笔记演示目录无效。')
        const { LocalNoteStore } = await import('./local-note-store')
        notesStore.value = new LocalNoteStore()
        connected.value = true; localMode = false; loadStatus.value = '离线笔记演示 · 本地 Git，远端未接通'; error.value = ''
      } catch { /* The GitHub connection form remains available without local demo data. */ }
    }
    if (connected.value) await restoreRoute()
  }
  if (!connected.value && config.value && !suppressAutoReconnect) {
    const namespace = credentialNamespace()
    const saved = readCredential(namespace.base, namespace.docs, namespace.comments)
    storedCredentialAvailable.value = Boolean(saved)
    if (saved) {
      rememberBrowser.value = saved.remember
      await connectUsingToken(saved.token, saved.remember, true)
    }
  }
})
function leavePage() { disconnect(false) }
function closeOutlineOutside(event: PointerEvent) { if (!outlineRoot.value?.contains(event.target as Node)) closeOutline() }
function closeOutlineOnEscape(event: KeyboardEvent) { if (event.key === 'Escape') closeOutline() }
onBeforeUnmount(() => { window.removeEventListener('pagehide', leavePage); window.removeEventListener('hashchange', restoreRoute); window.removeEventListener('scroll', scheduleActiveHeading); window.removeEventListener('resize', scheduleActiveHeading); document.removeEventListener('pointerdown', closeOutlineOutside); document.removeEventListener('keydown', closeOutlineOnEscape); article.value?.removeEventListener('load', scheduleActiveHeading, true); resetHeadingState(); disconnect(false) })
</script>

<template>
  <div class="reader-shell">
    <header class="topbar">
      <button class="menu-button" :class="{ 'notes-menu-button': activeSection === 'notes' }" type="button" :aria-label="activeSection === 'notes' ? (notesSidebarCollapsed ? '展开侧边栏' : '收起侧边栏') : '切换导航'" :aria-expanded="activeSection === 'notes' ? !notesSidebarCollapsed : menuOpen" @click="activeSection === 'notes' ? notesSidebarCollapsed = !notesSidebarCollapsed : menuOpen = !menuOpen">{{ activeSection === 'notes' ? (notesSidebarCollapsed ? '›|' : '|‹') : '☰' }}</button>
      <a class="brand" :href="withBase('/')">知识库</a>
      <span class="status" role="status">{{ activeSection === 'notes' ? (notesStore?.kind === 'local-demo' ? '离线笔记演示 · 本地 Git，远端未接通' : notesStore ? `GitHub docs · ${notesStore.branch}` : loadStatus) : loadStatus }}</span>
      <button v-if="connected" class="disconnect-button" @click="disconnect()">断开连接</button>
      <button v-if="connected" class="disconnect-button" @click="forgetAuthorization">退出并清除本机授权</button>
    </header>
    <div class="reader-grid" :class="{ 'notes-active': activeSection === 'notes' }">
      <aside class="sidebar" :class="{ open: menuOpen }">
        <nav class="section-tabs" aria-label="内容分类">
          <button v-for="section in sections" :disabled="commentsBusy" :key="section.id" :class="{ active: activeSection === section.id }" @click="selectSection(section.id)">{{ section.label }}</button>
        </nav>
        <label class="search-label" for="reader-search">搜索</label>
        <input id="reader-search" v-model="query" class="search-input" type="search" placeholder="搜索标题与正文" :disabled="!connected" />
        <div v-if="needle && results.length" class="search-results">
          <button v-for="(item, index) in results" :key="index" :disabled="commentsBusy" class="search-result" @click="openResult(item)">
            <strong>{{ item.title }}</strong><small>{{ item.type === 'translation' ? '翻译' : '概述' }} · {{ item.sectionTitle }}</small><span>{{ item.text.slice(Math.max(0, item.text.toLowerCase().indexOf(needle) - 28), Math.max(0, item.text.toLowerCase().indexOf(needle) - 28) + 110) }}</span>
          </button>
        </div>
        <div v-else-if="activeSection === 'papers' && visiblePapers.length" class="paper-list">
          <button v-for="paper in visiblePapers" :key="paper.paperId" :disabled="commentsBusy" class="paper-item" :class="{ selected: selectedPaperId === paper.paperId }" @click="openPaper(paper)">
            <strong>{{ paper.title }}</strong><span>{{ paper.year }} · {{ paper.status === 'draft' ? '草稿' : '已整理' }}</span>
          </button>
        </div>
        <div v-else class="list-empty"><strong>{{ !connected ? '连接资料库后查看内容' : needle ? '没有匹配内容' : '这里还没有内容' }}</strong><p>{{ connected ? '可切换分类或搜索正文关键词。' : '正文与翻译保存在私有仓库。' }}</p></div>
        <p class="sidebar-foot">{{ isDevelopment ? '本地或私库阅读' : '私人内容仅在授权后的当前会话加载。' }}</p>
      </aside>
      <main class="content" :class="{ 'notes-content': activeSection === 'notes' }">
        <div v-if="notesEverVisited && notesStore" v-show="activeSection === 'notes'" class="notes-kept-workspace">
          <KeepAlive><component :is="OfflineNotes" ref="offlineNotesRef" :active="activeSection === 'notes'" :sidebar-collapsed="notesSidebarCollapsed" :store="notesStore" @toggle-sidebar="notesSidebarCollapsed = !notesSidebarCollapsed" @select-section="selectSection" @auth-invalid="invalidateAuthorization" /></KeepAlive>
        </div>
        <div v-if="activeSection === 'notes' && !notesStore && !connected" class="connection-card">
          <p class="eyebrow">私人知识库</p><h1>连接你的资料库</h1><p>笔记将直接保存在私有 KnowledgeDB-docs 仓库。请选择有 Contents 读写权限的令牌。</p>
          <form @submit.prevent="connectWithToken"><label for="github-repository">资料仓库</label><input id="github-repository" :value="config?.repository || '正在加载配置…'" readonly /><label for="github-token">GitHub 资料库令牌</label><input id="github-token" v-model="tokenInput" type="password" autocomplete="off" spellcheck="false" placeholder="授权私有 docs 仓库 Contents 读写权限" :disabled="connecting" /><button type="submit" :disabled="connecting || !config || !tokenInput.trim()">{{ connecting ? '正在连接…' : '连接并加载' }}</button></form>
          <label class="remember-choice"><input v-model="rememberBrowser" type="checkbox" />记住此浏览器（7 天）</label>
          <p class="hint">勾选后 PAT 会明文保存在这台设备的浏览器本机存储中，最长 7 天；请仅在个人设备上使用。否则仅在标签页会话中恢复。</p>
          <button v-if="storedCredentialAvailable" type="button" class="stored-auth-retry" :disabled="connecting" @click="retryStoredAuthorization">{{ connecting ? '正在验证本机授权…' : '使用本机授权重试' }}</button>
          <p v-if="credentialNotice" class="hint" role="status">{{ credentialNotice }}</p>
        </div>
        <div v-if="activeSection === 'notes' && !notesStore && connected" class="empty-document"><h2>笔记库连接未完成</h2><p>{{ error || '请检查 docs 笔记访问权限后重试。' }}</p></div>
        <div v-show="activeSection !== 'notes'" class="paper-workspace">
        <div v-if="!connected" class="connection-card">
          <p class="eyebrow">私人知识库</p><h1>连接你的资料库</h1>
          <p>连接后查看论文概述、中文翻译和全文搜索结果。</p>
          <form @submit.prevent="connectWithToken">
            <label for="github-repository">资料仓库</label>
            <input id="github-repository" :value="config?.repository || '正在加载配置…'" readonly />
            <label for="github-token">GitHub 资料库令牌</label>
            <input id="github-token" v-model="tokenInput" type="password" autocomplete="off" spellcheck="false" placeholder="docs 与 comments 私库 Contents 读写权限" :disabled="connecting" />
            <button type="submit" :disabled="connecting || !config || !tokenInput.trim()">{{ connecting ? '正在连接…' : '连接并加载' }}</button>
          </form>
          <label class="remember-choice"><input v-model="rememberBrowser" type="checkbox" />记住此浏览器（7 天）</label>
          <p class="hint">勾选后，PAT 会保存在这台设备的浏览器本机存储中，最长 7 天。请只在个人设备上使用，并为 docs 与 comments 私库都授予 Contents 读写权限。</p>
          <button v-if="storedCredentialAvailable" type="button" class="stored-auth-retry" :disabled="connecting" @click="retryStoredAuthorization">{{ connecting ? '正在验证本机授权…' : '使用本机授权重试' }}</button>
          <p v-if="credentialNotice" class="hint" role="status">{{ credentialNotice }}</p>
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">创建 fine-grained 令牌</a>
        </div>
        <template v-else>
          <div class="content-heading"><div><p class="eyebrow">{{ sections.find(s => s.id === activeSection)?.label }}</p><h1>{{ selectedPaper?.title || '知识库' }}</h1><p v-if="selectedPaper" class="paper-meta">{{ selectedPaper.authors?.join('、') }} · {{ selectedPaper.year }} · {{ selectedPaper.status }}</p></div><span class="empty-badge">{{ selectedPaper?.status || '暂无文档' }}</span></div>
          <nav v-if="selectedPaper" class="document-tabs" aria-label="文档类型"><button v-for="doc in documentTypes" :key="doc.id" :class="{ active: activeDocument === doc.id }" :disabled="commentsBusy || !selectedPaper.documents.some((d: any) => d.type === doc.id)" @click="openType(doc.id)">{{ doc.label }}</button></nav>
          <p v-if="loadingDocument" role="status">正在加载文档…</p>
          <div v-if="renderedHtml" class="reading-tools">
            <button type="button" @click="goTop">返回文首</button>
            <span class="hint" role="status">{{ cacheStatus }}</span><button type="button" @click="clearHtmlCache">清除 HTML 缓存</button>
          </div>
          <article v-if="renderedHtml" ref="article" class="document-body" @click="articleLink" v-html="renderedHtml" />
          <nav v-if="renderedHtml && headings.length" ref="outlineRoot" class="floating-outline" :class="{ 'is-open': outlineOpen }" aria-label="本页章节目录">
            <button type="button" class="outline-toggle" :aria-expanded="outlineOpen" :aria-label="outlineOpen ? '收起目录' : '展开目录'" @click="toggleOutline">{{ outlineOpen ? '收起目录' : '☰' }}</button>
            <button v-for="heading in headings" :key="heading.id" type="button" class="outline-item" :class="{ active: activeHeadingId === heading.id }" :aria-current="activeHeadingId === heading.id ? 'location' : undefined" :aria-label="heading.title" :title="heading.title" :style="{ '--outline-level': heading.level }" @click="jumpHeading(heading.id)"><span class="outline-mark" aria-hidden="true"></span><span class="outline-title">{{ heading.title }}</span></button>
          </nav>
          <ReaderComments v-if="activeDoc" :active="activeSection === 'papers'" :doc="activeDoc" :article="article" :docs-commit="config?.ref || ''" :docs-repository="config?.repository || ''" :load-snapshot="loadSnapshot" :local-mode="localMode" :shared-token="sharedToken" :repository="commentStoreConfig.repository" :branch="commentStoreConfig.branch" :session-key="String(generation)" @busy="commentsBusy = $event" @auth-invalid="invalidateAuthorization" />
          <button v-if="renderedHtml" class="back-to-top" type="button" aria-label="返回文档首行" @click="goTop">↑ 返回文首</button>
          <section v-if="!renderedHtml && !loadingDocument" class="empty-document"><h2>暂无可展示内容</h2><p>当前分类或文档尚未整理。</p></section>
        </template>
        </div>
        <p v-if="credentialNotice && activeSection !== 'papers'" class="hint" role="status">{{ credentialNotice }}</p>
        <p v-if="error" class="reader-error" role="alert">{{ error }}</p>
      </main>
    </div>
  </div>
</template>
