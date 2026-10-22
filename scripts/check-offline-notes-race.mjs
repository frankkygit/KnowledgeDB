import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(path.join(root, 'package.json'))
const vue = req('vue'), { parse, compileScript } = req('@vue/compiler-sfc'), { transformSync } = req('esbuild')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 12; i++) await vue.nextTick() }
globalThis.document = { addEventListener(){}, removeEventListener(){}, querySelector(){ return null }, activeElement: null }
globalThis.window = { addEventListener(){}, removeEventListener(){}, location: { hash: '' }, history: { replaceState(){} } }
globalThis.crypto ||= { randomUUID: () => `uuid-${Math.random()}` }
const source = fs.readFileSync(path.join(root, 'site/.vitepress/theme/OfflineNotes.vue'), 'utf8')
const script = compileScript(parse(source).descriptor, { id: 'offline-notes-race' }).content
const code = transformSync(script, { loader: 'ts', format: 'cjs', target: 'es2022' }).code
let hooks
function harness(store, drafts = []) {
  hooks = { mounted: [], unmounted: [] }
  const output = { exports: {} }
  new Function('require','module','exports',code)(name => {
    if (name === 'vue') return { ...vue, onMounted: fn => hooks.mounted.push(fn), onBeforeUnmount: fn => hooks.unmounted.push(fn) }
    if (name.endsWith('/markdown') || name === './markdown') return { renderMarkdown: () => '' }
    if (name.endsWith('/note-filters') || name === './note-filters') return { reconcileSavedNoteFilters: (_note, f) => f }
    if (name.endsWith('/note-drafts') || name === './note-drafts') return {
      resolveDraftTabId: async () => 'tab-a', writeDraftTabLease: async()=>{}, listOfflineNoteDrafts: async()=>drafts,
      listActiveDraftTabIds: async()=>new Set(), saveOfflineNoteDraft: async draft => { drafts.splice(0, drafts.length, draft) },
      claimOfflineNoteDraft: async id => drafts.find(d => d.id === id), deleteOfflineNoteDraft: async()=>{}, releaseDraftTabLease: async()=>{}
    }
    throw new Error(`Unexpected dependency ${name}`)
  }, output, output.exports)
  const props = vue.reactive({ sidebarCollapsed: false, store })
  const scope = vue.effectScope()
  const state = scope.run(() => output.exports.default.setup(props, { expose() {}, emit() {} }))
  return { state, props, scope, mount: () => hooks.mounted.forEach(fn => fn()), unmount: () => hooks.unmounted.forEach(fn => fn()) }
}
function makeStore(list) {
  const store = { kind:'github', namespace:'test', repository:'owner/docs', branch:'main', saves:[], saveCalls:[], lists:0,
    list(){ this.lists++; return list() }, async get(id){ return { note:{ documentId:id,title:'Existing',tags:[],status:'published',sourceKind:'personal',sources:[],path:'content/notes/x.md' }, markdown:'# old', head:'b'.repeat(40) } },
    async save(payload, head){ this.saves.push(head); this.saveCalls.push(JSON.parse(JSON.stringify(payload))); if (!/^[a-f0-9]{40}$/i.test(head)) throw Error('草稿没有有效的 docs HEAD 基线；请刷新目录后重新编辑。'); if (this.expectedHead && head !== this.expectedHead) throw Error('HEAD conflict'); return { note:{ documentId:payload.documentId,title:payload.title,tags:payload.tags,status:payload.status,sourceKind:'personal',sources:[],path:'content/notes/x.md',created:'2026-10-22',updated:'2026-10-22' },head:'c'.repeat(40) } }, asset:async()=>new Blob(), deleteNotes:async()=>({head:'d'.repeat(40)}) }
  return store
}
// A delayed directory cannot expose the new-note path or let direct beginEdit bypass the gate.
let gate = deferred(); let store = makeStore(() => gate.promise); let h = harness(store); h.mount(); await flush()
assert.equal(h.state.draftScopeReady.value, true)
assert.equal(h.state.directoryReady.value, false)
h.state.beginEdit(true)
assert.equal(h.state.editing.value, false)
gate.resolve({notes:[],head:'a'.repeat(40)}); await new Promise(r=>setTimeout(r,0)); await flush()
assert.equal(h.state.directoryReady.value, true)
h.state.beginEdit(true); assert.equal(h.state.editorBaseHead.value, 'a'.repeat(40))
h.state.title.value='A'; h.state.tagsText.value='tag-a, tag-b'; h.state.status.value='published'; h.state.editMarkdown.value='# A'; h.state.pendingAssets.value=[{name:'a.png',type:'image/png',base64:'YQ=='}]; await h.state.save()
assert.deepEqual(store.saves,['a'.repeat(40)])
assert.equal(store.saveCalls.length,1); assert.deepEqual(store.saveCalls[0].tags,['tag-a','tag-b']); assert.equal(store.saveCalls[0].markdown,'# A'); assert.equal(store.saveCalls[0].status,'published'); assert.deepEqual(store.saveCalls[0].assets,[{name:'a.png',type:'image/png',base64:'YQ=='}])
assert.equal(h.state.error.value,''); assert.match(h.state.message.value,/已保存到 GitHub docs/); assert.equal(h.state.editing.value,false); assert.equal(h.state.selectedId.value,store.saveCalls[0].documentId)
h.unmount(); h.scope.stop()
// An invalid-base new draft is safely rebased after list, preserving content and assets.
const asset={name:'x.png',type:'image/png',base64:'YWJj'}
const recovered={id:'d1',tabId:'old',documentId:'note-stable',sourceDocumentId:null,sourceKind:'personal',title:'Keep me',tags:['tag'],status:'draft',markdown:'![x](assets/x.png)',baseHead:'',assets:[asset],pendingRequestId:'pending',pendingRequestSignature:'sig',updatedAt:new Date().toISOString()}
let d=[recovered]; store=makeStore(async()=>({notes:[],head:'e'.repeat(40)})); h=harness(store,d); h.mount(); await new Promise(r=>setTimeout(r,0)); await flush()
await h.state.restoreDraft(recovered)
assert.equal(h.state.editorBaseHead.value,'e'.repeat(40)); assert.equal(h.state.title.value,'Keep me'); assert.deepEqual(h.state.pendingAssets.value,[asset]); assert.deepEqual(d[0].assets,[asset]); assert.equal(d[0].baseHead,'e'.repeat(40));
h.state.editMarkdown.value += '\nmore'; await h.state.save(); assert.deepEqual(store.saves,['e'.repeat(40)])
h.unmount(); h.scope.stop()
// A previously valid older baseline is preserved and conflicts at the store's strict save boundary.
const old={...recovered,id:'old',baseHead:'f'.repeat(40)}; store=makeStore(async()=>({notes:[],head:'1'.repeat(40)})); store.expectedHead='1'.repeat(40); h=harness(store,[old]); h.mount(); await new Promise(r=>setTimeout(r,0)); await flush(); await h.state.restoreDraft(old)
assert.equal(h.state.editorBaseHead.value,'f'.repeat(40)); await h.state.save(); assert.deepEqual(store.saves,['f'.repeat(40)]); assert.match(h.state.error.value,/HEAD conflict/)
h.unmount(); h.scope.stop()
// A malformed new draft whose stable document ID is now occupied remains untouched for download/review.
const occupied={...recovered,id:'occupied',documentId:'note-stable',baseHead:''}; store=makeStore(async()=>({notes:[{documentId:'note-stable'}],head:'4'.repeat(40)})); d=[occupied]; h=harness(store,d); h.mount(); await new Promise(r=>setTimeout(r,0)); await flush(); await h.state.restoreDraft(occupied)
assert.equal(h.state.editing.value,true); assert.equal(h.state.editMarkdown.value,occupied.markdown); assert.equal(h.state.editorBaseHead.value,''); assert.equal(d[0].baseHead,''); assert.match(h.state.error.value,/现有笔记发生冲突/)
h.unmount(); h.scope.stop()
// An existing-note draft without a usable baseline stays intact and cannot overwrite the note.
const noBaseExisting={...recovered,id:'existing-no-base',documentId:'note-existing',sourceDocumentId:'note-existing',markdown:'# Keep body',baseHead:''}; store=makeStore(async()=>({notes:[{documentId:'note-existing'}],head:'5'.repeat(40)})); d=[noBaseExisting]; h=harness(store,d); h.mount(); await new Promise(r=>setTimeout(r,0)); await flush(); await h.state.restoreDraft(noBaseExisting)
assert.equal(h.state.editMarkdown.value,'# Keep body'); await h.state.save(); assert.equal(store.saves.length,0); assert.match(h.state.error.value,/原始版本/); assert.equal(h.state.editMarkdown.value,'# Keep body')
h.unmount(); h.scope.stop()
// A failed list leaves edits gated and offers a retry; the retry can establish the base.
let calls=0; store=makeStore(async()=>{ if(++calls===1) throw Error('offline'); return {notes:[],head:'2'.repeat(40)} }); h=harness(store); h.mount(); await new Promise(r=>setTimeout(r,0)); await flush(); assert.equal(h.state.directoryReady.value,false); assert.match(h.state.directoryError.value,/暂未加载完成/); await h.state.initialize(true); await flush(); assert.equal(h.state.directoryReady.value,true)
h.unmount(); h.scope.stop()
// A late list after unmount cannot mutate component state.
gate=deferred(); store=makeStore(()=>gate.promise); h=harness(store); h.mount(); await flush(); h.unmount(); gate.resolve({notes:[],head:'3'.repeat(40)}); await new Promise(r=>setTimeout(r,0)); await flush(); assert.equal(h.state.head.value,'')
h.scope.stop()
console.log('OfflineNotes delayed-list, recovery, conflict, retry, and unmount checks passed')
