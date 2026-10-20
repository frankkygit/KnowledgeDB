export const normalizeText = (text: string) => text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\s+/gu, ' ').trim()
export async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return `sha256:${Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')}`
}
export type Anchor = {
  contentRevision: string; blockId: string; blockTextDigest: string; mode: 'quote' | 'paragraph';
  quote: { exact: string; prefix: string; suffix: string }; range: { start: number; end: number } | null;
  normalizationVersion: string; sectionTitle: string
}
export type Operation = {
  requestId: string; payloadDigest: string; threadId: string; kind: string;
  expectedThreadRevision: number; resultThreadRevision: number; at: string; actorId: string; payload: any
}
export type Thread = { id: string; documentId: string; revision: number; originalAnchor: Anchor; binding: Anchor | null; comments: any[] }
export function replay(records: Operation[]): Thread[] {
  const requests = new Map<string, string>()
  const groups = new Map<string, Operation[]>()
  for (const record of records) {
    if (!record.requestId || !record.payloadDigest || !record.threadId || !Number.isInteger(record.expectedThreadRevision) || record.resultThreadRevision !== record.expectedThreadRevision + 1) throw new Error('评论记录格式不正确，已停止读取。')
    if (requests.has(record.requestId)) {
      if (requests.get(record.requestId) !== JSON.stringify(record)) throw new Error('评论请求记录冲突。')
      continue
    }
    requests.set(record.requestId, JSON.stringify(record))
    groups.set(record.threadId, [...(groups.get(record.threadId) || []), record])
  }
  const threads: Thread[] = []
  for (const [id, operations] of groups) {
    let thread: Thread | null = null
    for (const op of operations.sort((a, b) => a.expectedThreadRevision - b.expectedThreadRevision)) {
      if ((thread?.revision || 0) !== op.expectedThreadRevision) throw new Error('评论修订链缺失或冲突。')
      const p = op.payload
      const comment = { id: p.commentId, body: p.body, revision: 1, createdAt: op.at }
      if (op.kind === 'thread.create' && !thread) thread = { id, documentId: p.documentId, revision: 0, originalAnchor: p.anchor, binding: p.anchor, comments: [comment] }
      else if (op.kind === 'comment.add' && thread && !thread.comments.some(c => c.id === p.commentId)) thread.comments.push(comment)
      else if (op.kind === 'comment.edit' && thread) {
        const target = thread.comments.find(c => c.id === p.commentId)
        if (!target || target.revision !== p.expectedCommentRevision) throw new Error('评论编辑修订冲突。')
        target.body = p.body; target.revision++; target.updatedAt = op.at
      } else if (op.kind === 'binding.set' && thread) thread.binding = p.anchor ?? p.target ?? null
      else throw new Error('未知或无效的评论操作，不能完整恢复讨论。')
      thread.revision = op.resultThreadRevision
    }
    if (thread) threads.push(thread)
  }
  return threads
}
export async function createAnchor(snapshot: any, doc: any, blockId: string, text: string, range: Anchor['range']): Promise<Anchor> {
  if (snapshot.documentId !== doc.documentId || snapshot.contentRevision !== doc.contentRevision || snapshot.normalizationVersion !== 'kb-text-v1') throw new Error('正文快照版本不一致，请刷新文档后重选。')
  const paragraphs = snapshot.paragraphs.filter((p: any) => p.blockId === blockId)
  if (paragraphs.length !== 1 || normalizeText(paragraphs[0].text) !== text) throw new Error('此段与版本快照不一致，暂不能评论，请先核对正文。')
  const points = Array.from(text)
  if (range && (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > points.length)) throw new Error('选词范围无效，请重新选择。')
  return {
    contentRevision: doc.contentRevision, blockId, blockTextDigest: await digest(text),
    mode: range ? 'quote' : 'paragraph', normalizationVersion: 'kb-text-v1', sectionTitle: paragraphs[0].sectionTitle || '', range,
    quote: { exact: range ? points.slice(range.start, range.end).join('') : text, prefix: range ? points.slice(Math.max(0, range.start - 32), range.start).join('') : '', suffix: range ? points.slice(range.end, range.end + 32).join('') : '' },
  }
}
export async function validateAnchor(snapshot: any, doc: any, anchor: Anchor) {
  const paragraph = snapshot.paragraphs?.find((p: any) => p.blockId === anchor.blockId)
  if (!paragraph) throw new Error('引用段落不存在。')
  const expected = await createAnchor(snapshot, doc, anchor.blockId, normalizeText(paragraph.text), anchor.range)
  if (JSON.stringify(expected) !== JSON.stringify(anchor)) throw new Error('引用与版本快照不一致，请重新选择。')
}
export function operationDate(at: string) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at))
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-')
}
export function shardFor(documentId: string, date: string, existing: { path: string; data: any }[], record: Operation) {
  if (!/^[A-Za-z0-9-]+$/.test(documentId)) throw new Error('文档 ID 无效。')
  const bytes = (value: any) => new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n').byteLength
  if (bytes(record) > 65536 || new TextEncoder().encode(record.payload.body || '').byteLength > 16384) throw new Error('评论或引用过长，请缩短后重试（评论最多 16 KiB）。')
  const prefix = `annotations/${date.replaceAll('-', '/')}/${documentId}/`
  const shards = existing.filter(s => s.path.startsWith(prefix)).sort((a, b) => a.data.part - b.data.part)
  const last = shards.at(-1)
  if (last) {
    const data = { ...last.data, records: [...last.data.records, record] }
    if (bytes(data) <= 262144) return { path: last.path, data }
  }
  const part = (last?.data.part || 0) + 1
  const data = { schemaVersion: 1, date, timezone: 'Asia/Shanghai', documentId, part, records: [record] }
  if (bytes(data) > 262144) throw new Error('评论分片超限。')
  return { path: `${prefix}part-${String(part).padStart(6, '0')}.json`, data }
}
