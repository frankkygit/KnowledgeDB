<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'

const sections = [
  { id: 'papers', label: '论文' },
  { id: 'notes', label: '笔记' },
  { id: 'topics', label: '专题' },
]
const documentTypes = [
  { id: 'analysis', label: '概述' },
  { id: 'translation', label: '翻译' },
  { id: 'notes', label: '笔记' },
]
const activeSection = ref('papers')
const activeDocument = ref('analysis')
const menuOpen = ref(false)
const query = ref('')
const papers = ref<any[]>([])
const selectedPaperId = ref('')
const isDevelopment = import.meta.env.DEV
const loadStatus = ref(isDevelopment ? '本地预览 · 载入私有 docs' : '阅读器预览 · 私库尚未连接')
const selectedPaper = computed(() => papers.value.find((paper) => paper.paperId === selectedPaperId.value))
const visiblePapers = computed(() => papers.value.filter((paper) => {
  const docs = (paper.documents || []).map((doc: any) => `${doc.title} ${doc.searchText || ''}`).join(' ')
  return `${paper.title} ${docs}`.toLowerCase().includes(query.value.trim().toLowerCase())
}))
const activeDoc = computed(() => selectedPaper.value?.documents.find((doc: any) => doc.type === activeDocument.value))

onMounted(async () => {
  if (!import.meta.env.DEV) return
  try {
    const response = await fetch('/__local_docs/catalog', { cache: 'no-store' })
    if (!response.ok) throw new Error('catalog unavailable')
    const catalog = await response.json()
    const loaded = await Promise.all((catalog.papers || []).map(async (paper: any) => {
      const documents = await Promise.all((paper.documents || []).map(async (doc: any) => {
        const result = await fetch(`/__local_docs/document?documentId=${encodeURIComponent(doc.documentId)}`, { cache: 'no-store' })
        if (!result.ok) throw new Error('document unavailable')
        return result.json()
      }))
      return { ...paper, documents }
    }))
    papers.value = loaded
    selectedPaperId.value = loaded[0]?.paperId || ''
    loadStatus.value = loaded.length ? '本地预览 · 私有 docs 草稿' : '本地预览 · 暂无论文'
  } catch {
    loadStatus.value = '本地预览 · docs 未载入'
  }
})
</script>

<template>
  <div class="reader-shell">
    <header class="topbar">
      <button class="menu-button" type="button" aria-label="切换导航" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">☰</button>
      <a class="brand" :href="withBase('/')">知识库</a>
      <span class="status">{{ loadStatus }}</span>
    </header>

    <div class="reader-grid">
      <aside class="sidebar" :class="{ open: menuOpen }">
        <nav class="section-tabs" aria-label="内容分类">
          <button v-for="section in sections" :key="section.id" :class="{ active: activeSection === section.id }" @click="activeSection = section.id">
            {{ section.label }}
          </button>
        </nav>
        <label class="search-label" for="reader-search">搜索</label>
        <input id="reader-search" v-model="query" class="search-input" type="search" placeholder="搜索标题与正文" :disabled="!papers.length" />
        <div v-if="activeSection === 'papers' && visiblePapers.length" class="paper-list">
          <button v-for="paper in visiblePapers" :key="paper.paperId" class="paper-item" :class="{ selected: selectedPaperId === paper.paperId }" @click="selectedPaperId = paper.paperId; activeDocument = 'analysis'; menuOpen = false">
            <strong>{{ paper.title }}</strong>
            <span>{{ paper.year }} · {{ paper.translationStatus === 'draft' ? '草稿' : '已整理' }}</span>
          </button>
        </div>
        <div v-else class="list-empty">
          <strong>{{ activeSection === 'papers' ? (papers.length ? '没有匹配论文' : '这里还没有论文') : `这里还没有${sections.find((item) => item.id === activeSection)?.label}` }}</strong>
          <p>{{ papers.length ? '试试其他标题或正文关键词。' : '当前没有载入目录或正文。' }}</p>
        </div>
        <p class="sidebar-foot">{{ isDevelopment ? '本地资料预览' : '连接私有资料库后即可阅读，连接功能待接入。' }}</p>
      </aside>

      <main class="content">
        <div class="content-heading">
          <div>
            <p class="eyebrow">{{ sections.find((item) => item.id === activeSection)?.label }}</p>
            <h1>{{ selectedPaper?.title || '欢迎使用知识库阅读器' }}</h1>
            <p v-if="selectedPaper" class="paper-meta">{{ selectedPaper.authors?.join('、') }} · {{ selectedPaper.year }} · {{ selectedPaper.status }}</p>
          </div>
          <span class="empty-badge">{{ selectedPaper?.status || '无文档' }}</span>
        </div>

        <nav class="document-tabs" aria-label="文档类型">
          <button v-for="doc in documentTypes" :key="doc.id" :class="{ active: activeDocument === doc.id }" :disabled="doc.id === 'notes'" @click="activeDocument = doc.id">
            {{ doc.label }}
          </button>
        </nav>

        <article v-if="activeDoc" class="document-body" v-html="activeDoc.html" />
        <section v-else class="empty-document" aria-live="polite">
          <div class="empty-icon" aria-hidden="true">文</div>
          <h2>{{ documentTypes.find((item) => item.id === activeDocument)?.label }}尚不可用</h2>
          <p>{{ papers.length ? '当前条目尚无此类文档。' : '尚未载入资料，请稍后连接资料库。' }}</p>
          <p class="hint">{{ isDevelopment ? '本地预览仅供核对阅读效果。' : '这里展示阅读器界面，私人论文和翻译尚未载入。' }}</p>
        </section>
      </main>
    </div>
  </div>
</template>
