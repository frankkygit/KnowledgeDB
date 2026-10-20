<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'
import { GitHubDocs, type ReaderConfig } from './github-docs'
import { renderMarkdown } from './markdown'
import 'katex/dist/katex.min.css'

const sections = [{ id: 'papers', label: '论文' }, { id: 'notes', label: '笔记' }, { id: 'topics', label: '专题' }]
const documentTypes = [{ id: 'analysis', label: '概述' }, { id: 'translation', label: '翻译' }, { id: 'notes', label: '笔记' }]
const isDevelopment = import.meta.env.DEV
const activeSection = ref('papers')
const activeDocument = ref('analysis')
const menuOpen = ref(false)
const query = ref('')
const papers = ref<any[]>([])
const searchItems = ref<any[]>([])
const selectedPaperId = ref('')
const config = ref<ReaderConfig | null>(null)
const tokenInput = ref('')
const connected = ref(false)
const connecting = ref(false)
const loadingDocument = ref(false)
const error = ref('')
const loadStatus = ref('尚未连接资料库')
const renderedHtml = ref('')
const article = ref<HTMLElement | null>(null)
let client: GitHubDocs | null = null
let localMode = false
let generation = 0
let documentGeneration = 0
let objectUrls: string[] = []
const selectedPaper = computed(() => activeSection.value === 'papers' ? papers.value.find(p => p.paperId === selectedPaperId.value) : null)
const activeDoc = computed(() => selectedPaper.value?.documents.find((d: any) => d.type === activeDocument.value))
const needle = computed(() => query.value.normalize('NFC').trim().toLocaleLowerCase())
const results = computed(() => needle.value ? searchItems.value.filter(i => `${i.title} ${i.sectionTitle} ${i.text}`.normalize('NFC').toLocaleLowerCase().includes(needle.value)).slice(0, 30) : [])
const visiblePapers = computed(() => needle.value ? papers.value.filter(p => `${p.title}`.toLocaleLowerCase().includes(needle.value) || results.value.some(i => i.paperId === p.paperId)) : papers.value)

function clearImages() { objectUrls.forEach(url => URL.revokeObjectURL(url)); objectUrls = [] }
function disconnect() {
  generation++; documentGeneration++
  client?.disconnect(); client = null; localMode = false
  clearImages(); tokenInput.value = ''; papers.value = []; searchItems.value = []
  renderedHtml.value = ''; selectedPaperId.value = ''; query.value = ''
  connected.value = false; connecting.value = false; loadingDocument.value = false
  loadStatus.value = '尚未连接资料库'; error.value = ''
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
  clearImages(); renderedHtml.value = ''; error.value = ''
  loadingDocument.value = false
  const doc = activeDoc.value
  if (!doc) return
  loadingDocument.value = true
  try {
    let html: string
    if (localMode) html = doc.html
    else {
      const reader = client
      if (!reader) return
      html = renderMarkdown(await reader.text(doc.path), doc.path)
    }
    if (current !== documentGeneration || session !== generation) return
    renderedHtml.value = html
    await nextTick()
    if (!localMode && client && article.value) {
      const reader = client
      // Asset URLs are resolved through authenticated GitHub requests, never public raw URLs.
      for (const image of article.value.querySelectorAll<HTMLImageElement>('img[data-kb-asset]')) {
        try {
          const path = image.dataset.kbAsset!
          const bytes = await reader.bytes(path)
          if (current !== documentGeneration || session !== generation) return
          const ext = path.split('.').pop()?.toLowerCase()
          const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' }
          const url = URL.createObjectURL(new Blob([bytes], { type: mime[ext || ''] || 'application/octet-stream' }))
          objectUrls.push(url); image.src = url
        } catch {
          if (current === documentGeneration) image.alt += '（图片读取失败）'
        }
      }
    }
    if (current !== documentGeneration) return
    if (blockId) document.getElementById(`block-${blockId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    else window.scrollTo({ top: 0 })
  } catch (cause) {
    if (current === documentGeneration && session === generation) error.value = cause instanceof Error ? cause.message : '文档读取失败，请重试。'
  } finally {
    if (current === documentGeneration) loadingDocument.value = false
  }
}

async function selectSection(id: string) {
  activeSection.value = id; documentGeneration++; clearImages(); renderedHtml.value = ''; loadingDocument.value = false
  if (id === 'papers' && selectedPaper.value) await showDocument()
}
async function openPaper(paper: any) {
  selectedPaperId.value = paper.paperId; activeSection.value = 'papers'
  const overview = paper.documents.find((d: any) => d.documentId === paper.overviewDocumentId)
  activeDocument.value = overview?.type || 'analysis'; menuOpen.value = false
  window.history.replaceState(null, '', `#/paper/${encodeURIComponent(paper.paperId)}`)
  await showDocument()
}
async function openType(type: string) {
  activeDocument.value = type
  if (activeDoc.value) window.history.replaceState(null, '', `#/document/${encodeURIComponent(activeDoc.value.documentId)}`)
  await showDocument()
}
async function openResult(item: any) {
  const paper = papers.value.find(p => p.documents.some((d: any) => d.documentId === item.documentId))
  const doc = paper?.documents.find((d: any) => d.documentId === item.documentId)
  if (!doc) { error.value = '索引对应的文档不存在，请更新目录。'; return }
  selectedPaperId.value = paper.paperId; activeSection.value = 'papers'; activeDocument.value = doc.type
  menuOpen.value = false
  window.history.replaceState(null, '', `#/document/${encodeURIComponent(doc.documentId)}${item.blockId ? `?block=${encodeURIComponent(item.blockId)}` : ''}`)
  await showDocument(item.blockId || '')
}
async function restoreRoute() {
  const hash = window.location.hash.slice(1)
  const [path, params = ''] = hash.split('?')
  const [, kind, rawId] = path.split('/')
  const id = rawId ? decodeURIComponent(rawId) : ''
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
  disconnect()
  connecting.value = true; loadStatus.value = '正在读取私有资料…'
  const session = generation
  try {
    if (!config.value) throw new Error('站点连接配置未加载，请刷新页面。')
    const reader = new GitHubDocs(config.value, token)
    client = reader
    const catalog = await reader.json(config.value.catalogPath)
    if (session !== generation) return
    papers.value = normalizeCatalog(catalog)
    const search = await reader.json(config.value.searchPath)
    if (session !== generation) return
    if (!Array.isArray(search.items)) throw new Error('全文索引格式不正确。')
    searchItems.value = search.items
    connected.value = true; loadStatus.value = `已连接 · ${papers.value.length} 篇论文`
    await restoreRoute()
  } catch (cause) {
    if (session !== generation) return
    client?.disconnect(); client = null
    papers.value = []; searchItems.value = []; renderedHtml.value = ''; connected.value = false
    loadStatus.value = '连接未完成'
    error.value = cause instanceof Error ? cause.message : '连接失败，请检查网络。'
  } finally { if (session === generation) connecting.value = false }
}

onMounted(async () => {
  window.addEventListener('pagehide', disconnect)
  window.addEventListener('hashchange', restoreRoute)
  try {
    const result = await fetch(withBase('/reader-config.json'), { cache: 'no-store' })
    if (!result.ok) throw new Error()
    config.value = await result.json()
  } catch { error.value = '站点连接配置未加载，请刷新页面。' }
  if (import.meta.env.DEV) {
    try {
      const response = await fetch('/__local_docs/catalog', { cache: 'no-store' })
      if (!response.ok) return
      const catalog = await response.json()
      const loaded = await Promise.all(catalog.papers.map(async (paper: any) => ({ ...paper, documents: await Promise.all(paper.documents.map(async (doc: any) => {
        const response = await fetch(`/__local_docs/document?documentId=${encodeURIComponent(doc.documentId)}`, { cache: 'no-store' })
        if (!response.ok) throw new Error()
        return response.json()
      })) })))
      papers.value = normalizeCatalog({ papers: loaded }); localMode = true; connected.value = true; error.value = ''
      searchItems.value = loaded.flatMap(p => p.documents.map((d: any) => ({ ...d, paperId: p.paperId, text: d.searchText || '' })))
      loadStatus.value = '本地预览 · 私有 docs 草稿'; await restoreRoute()
    } catch { /* The GitHub connection form remains available without local preview data. */ }
  }
})
onBeforeUnmount(() => { window.removeEventListener('pagehide', disconnect); window.removeEventListener('hashchange', restoreRoute); disconnect() })
</script>

<template>
  <div class="reader-shell">
    <header class="topbar">
      <button class="menu-button" type="button" aria-label="切换导航" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">☰</button>
      <a class="brand" :href="withBase('/')">知识库</a>
      <span class="status" role="status">{{ loadStatus }}</span>
      <button v-if="connected" class="disconnect-button" @click="disconnect">断开连接</button>
    </header>
    <div class="reader-grid">
      <aside class="sidebar" :class="{ open: menuOpen }">
        <nav class="section-tabs" aria-label="内容分类">
          <button v-for="section in sections" :key="section.id" :class="{ active: activeSection === section.id }" @click="selectSection(section.id)">{{ section.label }}</button>
        </nav>
        <label class="search-label" for="reader-search">搜索</label>
        <input id="reader-search" v-model="query" class="search-input" type="search" placeholder="搜索标题与正文" :disabled="!connected" />
        <div v-if="needle && results.length" class="search-results">
          <button v-for="(item, index) in results" :key="index" class="search-result" @click="openResult(item)">
            <strong>{{ item.title }}</strong><small>{{ item.type === 'translation' ? '翻译' : '概述' }} · {{ item.sectionTitle }}</small><span>{{ item.text.slice(Math.max(0, item.text.toLowerCase().indexOf(needle) - 28), Math.max(0, item.text.toLowerCase().indexOf(needle) - 28) + 110) }}</span>
          </button>
        </div>
        <div v-else-if="activeSection === 'papers' && visiblePapers.length" class="paper-list">
          <button v-for="paper in visiblePapers" :key="paper.paperId" class="paper-item" :class="{ selected: selectedPaperId === paper.paperId }" @click="openPaper(paper)">
            <strong>{{ paper.title }}</strong><span>{{ paper.year }} · {{ paper.status === 'draft' ? '草稿' : '已整理' }}</span>
          </button>
        </div>
        <div v-else class="list-empty"><strong>{{ !connected ? '连接资料库后查看内容' : needle ? '没有匹配内容' : '这里还没有内容' }}</strong><p>{{ connected ? '可切换分类或搜索正文关键词。' : '正文与翻译保存在私有仓库。' }}</p></div>
        <p class="sidebar-foot">{{ isDevelopment ? '本地或私库阅读' : '私人内容仅在授权后的当前会话加载。' }}</p>
      </aside>
      <main class="content">
        <div v-if="!connected" class="connection-card">
          <p class="eyebrow">私人知识库</p><h1>连接你的资料库</h1>
          <p>连接后查看论文概述、中文翻译和全文搜索结果。</p>
          <form @submit.prevent="connectWithToken">
            <label for="github-repository">资料仓库</label>
            <input id="github-repository" :value="config?.repository || '正在加载配置…'" readonly />
            <label for="github-token">GitHub 只读访问令牌</label>
            <input id="github-token" v-model="tokenInput" type="password" autocomplete="off" spellcheck="false" placeholder="仅授权此资料库的 Contents 只读权限" :disabled="connecting" />
            <button type="submit" :disabled="connecting || !config || !tokenInput.trim()">{{ connecting ? '正在连接…' : '连接并加载' }}</button>
          </form>
          <p class="hint">令牌只在当前标签页内存使用，刷新或断开后需要重新填写。请勿把令牌发到聊天中。</p>
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">创建 fine-grained 只读令牌</a>
        </div>
        <template v-else>
          <div class="content-heading"><div><p class="eyebrow">{{ sections.find(s => s.id === activeSection)?.label }}</p><h1>{{ selectedPaper?.title || '知识库' }}</h1><p v-if="selectedPaper" class="paper-meta">{{ selectedPaper.authors?.join('、') }} · {{ selectedPaper.year }} · {{ selectedPaper.status }}</p></div><span class="empty-badge">{{ selectedPaper?.status || '暂无文档' }}</span></div>
          <nav v-if="selectedPaper" class="document-tabs" aria-label="文档类型"><button v-for="doc in documentTypes" :key="doc.id" :class="{ active: activeDocument === doc.id }" :disabled="!selectedPaper.documents.some((d: any) => d.type === doc.id)" @click="openType(doc.id)">{{ doc.label }}</button></nav>
          <p v-if="loadingDocument" role="status">正在加载文档…</p>
          <article v-if="renderedHtml" ref="article" class="document-body" v-html="renderedHtml" />
          <section v-else-if="!loadingDocument" class="empty-document"><h2>暂无可展示内容</h2><p>当前分类或文档尚未整理。</p></section>
        </template>
        <p v-if="error" class="reader-error" role="alert">{{ error }}</p>
      </main>
    </div>
  </div>
</template>
