import { build } from "esbuild";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const TEST_TOKEN = "test-private-docs-token";
class MockGitHub {
  repository = "test-owner/private-docs";
  branch = "main";
  privateRepository = true;
  head = "";
  requests = [];
  blobs = /* @__PURE__ */ new Map();
  trees = /* @__PURE__ */ new Map();
  commits = /* @__PURE__ */ new Map();
  sequence = 0;
  failWriteStatus = 0;
  losePatchReply = false;
  concurrentPatch = false;
  nextBlobGate = null;
  delayNextBlob() {
    let markStarted, release;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    this.nextBlobGate = { markStarted, blocked };
    return { started, release };
  }
  constructor(files) {
    const tree = /* @__PURE__ */ new Map();
    for (const [p, c] of Object.entries(files)) tree.set(p, this.blob(typeof c === "string" ? new TextEncoder().encode(c) : c));
    this.head = this.commit(this.tree(tree), [], "Seed synthetic documents");
  }
  hash(type, bytes) {
    return createHash("sha1").update(`${type} ${bytes.byteLength}\0`).update(bytes).digest("hex");
  }
  blob(bytes) {
    const sha = this.hash("blob", bytes);
    this.blobs.set(sha, bytes.slice());
    return sha;
  }
  tree(value) {
    const sha = createHash("sha1").update(JSON.stringify([...value].sort())).digest("hex");
    this.trees.set(sha, new Map(value));
    return sha;
  }
  commit(tree, parents, message) {
    const value = { tree: { sha: tree }, parents: parents.map((sha2) => ({ sha: sha2 })), message };
    const sha = createHash("sha1").update(JSON.stringify(value) + ++this.sequence).digest("hex");
    this.commits.set(sha, { sha, ...value });
    return sha;
  }
  advance() {
    const old = this.head;
    this.head = this.commit(this.commits.get(old).tree.sha, [old], "Concurrent unrelated update");
    return this.head;
  }
  files(ref = this.head) {
    return new Map([...this.trees.get(this.commits.get(ref).tree.sha)].map(([path, sha]) => [path, new TextDecoder().decode(this.blobs.get(sha))]));
  }
  response(status, data) {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }
  fetch = async (urlArg, init = {}) => {
    const url = new URL(String(urlArg));
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init.cache, "no-store");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${TEST_TOKEN}`);
    const prefix = `/repos/${this.repository}`;
    assert.ok(url.pathname === prefix || url.pathname.startsWith(prefix + "/"));
    const path = decodeURIComponent(url.pathname.slice(prefix.length).replace(/^\//, ""));
    const method = init.method || "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : void 0;
    this.requests.push({ method, path, query: url.search, body });
    if (method !== "GET" && this.failWriteStatus) return this.response(this.failWriteStatus, { message: "Synthetic permission/network test" });
    if (method === "GET" && !path) return this.response(200, { private: this.privateRepository, default_branch: this.branch, full_name: this.repository });
    if (method === "GET" && path === `git/ref/heads/${this.branch}`) return this.response(200, { object: { sha: this.head } });
    if (method === "GET" && path.startsWith("git/commits/")) {
      const c = this.commits.get(path.slice(12));
      return c ? this.response(200, c) : this.response(404, { message: "Unknown commit" });
    }
    if (method === "GET" && path.startsWith("git/trees/")) {
      const sha = path.slice(10), tree = this.trees.get(sha);
      return tree ? this.response(200, { sha, truncated: false, tree: [...tree].map(([path2, sha2]) => ({ path: path2, sha: sha2, type: "blob", mode: "100644" })) }) : this.response(404, { message: "Unknown tree" });
    }
    if (method === "GET" && path.startsWith("git/blobs/")) {
      const sha = path.slice(10), bytes = this.blobs.get(sha);
      if (this.nextBlobGate) {
        const gate = this.nextBlobGate;
        this.nextBlobGate = null;
        gate.markStarted();
        await gate.blocked;
      }
      return bytes ? this.response(200, { sha, encoding: "base64", size: bytes.length, content: Buffer.from(bytes).toString("base64") }) : this.response(404, { message: "Unknown blob" });
    }
    if (method === "GET" && path.startsWith("contents/")) {
      const ref = url.searchParams.get("ref") || this.head;
      const resolved = this.commits.has(ref) ? ref : ref === this.branch ? this.head : "";
      if (!resolved) return this.response(404, { message: "Unknown ref" });
      const file = path.slice(9), sha = this.trees.get(this.commits.get(resolved).tree.sha)?.get(file);
      if (!sha) return this.response(404, { message: "Not found" });
      const bytes = this.blobs.get(sha);
      if (headers.get("Accept")?.includes("raw")) return new Response(bytes, { status: 200 });
      return this.response(200, { path: file, sha, encoding: "base64", content: Buffer.from(bytes).toString("base64") });
    }
    if (method === "POST" && path === "git/blobs") {
      const bytes = body.encoding === "base64" ? Buffer.from(body.content, "base64") : new TextEncoder().encode(body.content);
      return this.response(201, { sha: this.blob(bytes) });
    }
    if (method === "POST" && path === "git/trees") {
      const files = new Map(this.trees.get(body.base_tree) || []);
      for (const item of body.tree) {
        if (item.sha === null) files.delete(item.path);
        else if (item.content !== void 0) files.set(item.path, this.blob(new TextEncoder().encode(item.content)));
        else {
          assert.ok(this.blobs.has(item.sha));
          files.set(item.path, item.sha);
        }
      }
      return this.response(201, { sha: this.tree(files) });
    }
    if (method === "POST" && path === "git/commits") {
      assert.ok(this.trees.has(body.tree));
      return this.response(201, { sha: this.commit(body.tree, body.parents, body.message) });
    }
    if (method === "PATCH" && path === `git/refs/heads/${this.branch}`) {
      assert.equal(body.force, false, "Force push forbidden");
      if (this.concurrentPatch) {
        this.concurrentPatch = false;
        this.advance();
      }
      const c = this.commits.get(body.sha);
      if (!c?.parents.some((p) => p.sha === this.head)) return this.response(422, { message: "Not a fast forward" });
      this.head = body.sha;
      if (this.losePatchReply) {
        this.losePatchReply = false;
        throw new TypeError("Synthetic response lost after GitHub ref updated");
      }
      return this.response(200, { object: { sha: this.head } });
    }
    if (method === "GET" && path === "commits") {
      const history = [];
      let cursor = this.head;
      while (cursor) {
        const c = this.commits.get(cursor);
        history.push({ sha: cursor, commit: { message: c.message }, parents: c.parents });
        cursor = c.parents[0]?.sha;
      }
      return this.response(200, history);
    }
    throw new Error(`Mock missing endpoint: ${method} ${path}`);
  };
}
function seedFiles() {
  return { "catalog/papers.json": JSON.stringify({ schemaVersion: 1, papers: [{ paperId: "paper-synthetic", title: "Synthetic paper", documents: [{ documentId: "doc-paper", type: "analysis", path: "content/papers/synthetic/analysis.md", title: "Synthetic paper", contentRevision: "sha256:" + "a".repeat(64) }] }] }), "catalog/documents.json": JSON.stringify({ schemaVersion: 1, documents: [{ documentId: "doc-paper", type: "analysis", path: "content/papers/synthetic/analysis.md", title: "Synthetic paper", status: "published", contentRevision: "sha256:" + "a".repeat(64) }] }), "catalog/search.json": JSON.stringify({ schemaVersion: 1, normalizationVersion: "kb-text-v1", items: [{ paperId: "paper-synthetic", documentId: "doc-paper", type: "analysis", title: "Synthetic paper", sectionTitle: "Preserved", blockId: "b-paper", text: "Must remain in paper search", contentRevision: "sha256:" + "a".repeat(64) }] }), "content/papers/synthetic/analysis.md": "# Synthetic paper\n\n<!-- kb:block b-paper -->\nPreserve this paper.\n", ["revisions/doc-paper/" + "a".repeat(64) + ".json"]: JSON.stringify({ documentId: "doc-paper", contentRevision: "sha256:" + "a".repeat(64), paragraphs: [] }), "annotations/2026/10/21/doc-paper.jsonl": "{\"operationId\":\"preserve-comment\"}\n" };
}
const built = await build({ stdin: { contents: "export {GitHubNotesStore} from './site/.vitepress/theme/github-notes.ts'; export {buildNoteContent,editableNoteMarkdown} from './site/.vitepress/theme/note-content.ts'; export {formatNoteDate} from './site/.vitepress/theme/note-date.ts'", resolveDir: process.cwd(), sourcefile: "check-notes-entry.ts", loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
const { GitHubNotesStore, buildNoteContent, editableNoteMarkdown, formatNoteDate } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
async function checkContent() {
  assert.equal(formatNoteDate("2026-10-21"), "2026-10-21", "Legacy date-only timestamps must not gain an invented time");
  const timestamp = "2026-10-21T12:34:56.789Z";
  assert.equal(formatNoteDate(timestamp), new Date(timestamp).toLocaleString(), "Timestamped note dates should display their local time");
  const input = { documentId: "note-review-content", sourceDocumentId: null, sourceKind: "personal", title: "\u89C4\u8303\u5185\u5BB9", tags: ["A"], status: "draft", sources: [], markdown: "# Heading\n\nAlpha plain.\n\n- ListOnlyNeedle\n\n```js\nCodeOnlyNeedle\n```\n\n| H |\n|---|\n| TableOnlyNeedle |\n\n$$\nMathOnlyNeedle\n$$\n\n![ImageOnlyNeedle](assets/synthetic.png)", assets: [] };
  const assets = /* @__PURE__ */ new Map([["content/notes/note-review-content/assets/synthetic.png", new Uint8Array([1, 2, 3])]]);
  const a = await buildNoteContent(input, "", assets, "2026-10-21", "2026-10-21");
  {
    const { contentRevision, normalizationVersion, ...canonical } = a.snapshot;
    assert.equal(normalizationVersion, "kb-text-v1");
    assert.equal(contentRevision, "sha256:" + createHash("sha256").update(JSON.stringify(canonical)).digest("hex"));
    assert.equal(a.snapshot.attachments[0].digest, "sha256:" + createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex"));
  }
  const failures = [];
  const check = (label, fn) => {
    try {
      fn();
      console.log("PASS", label);
    } catch (e) {
      failures.push(label + ": " + e.message);
      console.log("FAIL", label, e.message);
    }
  };
  check("full AST retains code and table", () => {
    assert.ok(a.snapshot.ast.some((t) => t.type === "fence"));
    assert.ok(a.snapshot.ast.some((t) => t.type === "table_open"));
  });
  check("fulltext covers every block category", () => {
    const indexed = a.searchItems.map((x) => x.text).join(" ");
    for (const needle of ["Alpha plain.", "ListOnlyNeedle", "CodeOnlyNeedle", "TableOnlyNeedle", "MathOnlyNeedle"]) assert.ok(indexed.includes(needle), needle + " missing");
  });
  check("image-only block is not commentable", () => assert.ok(!a.paragraphs.some((p) => p.text.includes("ImageOnlyNeedle"))));
  const edited = await buildNoteContent({ ...input, markdown: a.markdown.replace("Alpha plain.", "Alpha replaced.") }, a.markdown, assets, "2026-10-21", "2026-10-22");
  check("replacement changes paragraph id", () => assert.notEqual(a.paragraphs.find((p) => p.text === "Alpha plain.").blockId, edited.paragraphs.find((p) => p.text === "Alpha replaced.").blockId));
  check("markers one-to-one with commentable paragraphs", () => {
    const ids = [...edited.markdown.matchAll(/<!-- kb:block ([A-Za-z0-9-]+) -->/g)].map((m) => m[1]);
    assert.equal(ids.length, edited.paragraphs.length);
    assert.deepEqual(new Set(ids), new Set(edited.paragraphs.map((p) => p.blockId)));
  });
  const repeated = await buildNoteContent({ ...input, markdown: a.markdown }, a.markdown, assets, "2026-10-21", "2026-11-01");
  check("maintenance dates excluded from revision", () => assert.equal(a.contentRevision, repeated.contentRevision));
  const bytesChanged = await buildNoteContent({ ...input, markdown: a.markdown }, a.markdown, /* @__PURE__ */ new Map([["content/notes/note-review-content/assets/synthetic.png", new Uint8Array([1, 2, 4])]]), "2026-10-21", "2026-10-21");
  check("attachment digest affects revision", () => assert.notEqual(a.contentRevision, bytesChanged.contentRevision));
  if (failures.length) throw new Error(failures.join("\n"));
  const literal = "<!-- kb:block b-literal-code-example -->";
  const fenced = await buildNoteContent({ ...input, assets: [], markdown: "```html\n" + literal + "\n```\n\nPlain." }, "", /* @__PURE__ */ new Map(), "2026-10-21", "2026-10-21");
  assert.ok(fenced.markdown.includes(literal), "Marker-shaped literal inside code fence was deleted");
  const duplicate = await buildNoteContent({ ...input, assets: [], markdown: "Same text.\n\nSame text." }, "", /* @__PURE__ */ new Map(), "2026-10-21", "2026-10-21");
  assert.equal(new Set(duplicate.searchItems.filter((x) => x.text === "Same text.").map((x) => x.blockId)).size, 2, "Repeated paragraphs search must target distinct actual block IDs");
  console.log("PASS code-literal preservation and repeated paragraph search identities");
}
async function checkEditingIdentity() {
  const input = { documentId: "note-editing-identity", sourceDocumentId: null, sourceKind: "personal", title: "Editing identity", tags: [], status: "draft", sources: [], assets: [], markdown: "Alpha one.\n\nBeta two." };
  const make = (markdown, previous = "") => buildNoteContent({ ...input, markdown }, previous, new Map(), "2026-10-21", "2026-10-21");
  const original = await make(input.markdown);
  const editable = editableNoteMarkdown(original.markdown);
  assert.ok(!editable.startsWith("---"));
  assert.ok(!editable.includes("<!-- kb:block"));
  const unchanged = await make(editable, original.markdown);
  assert.deepEqual(unchanged.paragraphs.map(p => p.blockId), original.paragraphs.map(p => p.blockId));
  assert.equal(unchanged.contentRevision, original.contentRevision);
  const moved = await make("Beta two.\n\nAlpha one.", original.markdown);
  assert.deepEqual(moved.paragraphs.map(p => p.blockId), original.paragraphs.map(p => p.blockId).reverse());
  const split = await make("Alpha.\n\none.\n\nBeta two.", original.markdown);
  assert.ok(!split.paragraphs.some(p => p.blockId === original.paragraphs[0].blockId));
  const merged = await make("Alpha one. Beta two.", original.markdown);
  assert.ok(merged.paragraphs.every(p => !original.paragraphs.some(old => old.blockId === p.blockId)));
  const duplicates = await make("Same.\n\nSame.");
  const ambiguous = await make(editableNoteMarkdown(duplicates.markdown), duplicates.markdown);
  assert.equal(new Set(ambiguous.paragraphs.map(p => p.blockId)).size, 2);
  assert.ok(ambiguous.paragraphs.every(p => !duplicates.paragraphs.some(old => old.blockId === p.blockId)));
  const literal = "<!-- kb:block b-code-literal -->";
  assert.ok(editableNoteMarkdown("```html\n" + literal + "\n```\n").includes(literal));
  console.log("PASS clean editor hides metadata, preserves unique unchanged/moved IDs, replaces split/merged IDs, gives ambiguous duplicates fresh IDs, and preserves literal code.");
}
async function checkAdapter() {
  const mock = new MockGitHub(seedFiles()), originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fetch;
  const initial = mock.files();
  const store = new GitHubNotesStore(mock.repository, TEST_TOKEN, "main");
  const input = { documentId: "note-production-review", sourceDocumentId: null, sourceKind: "personal", title: "Synthetic production review", status: "draft", tags: ["A"], sources: [], markdown: "# Heading\n\nA private synthetic paragraph.\n\n- SearchListNeedle\n\n![test](assets/test.png)", assets: [{ name: "test.png", type: "image/png", base64: "aGVsbG8=" }] };
  try {
    await store.connect();
    const listed = await store.list();
    assert.equal(listed.notes.length, 0);
    assert.match(listed.head, /^[a-f0-9]{40}$/);
    assert.equal(store.namespace, `github:${mock.repository}:main`);
    const requestId = crypto.randomUUID();
    const saved = await store.save(input, listed.head, requestId);
    assert.equal(saved.head, mock.head);
    const files = mock.files();
    for (const [p, c] of initial) if (!["catalog/documents.json", "catalog/search.json"].includes(p)) assert.equal(files.get(p), c, p + " modified");
    const notes = JSON.parse(files.get("catalog/notes.json"));
    assert.equal(notes.notes.length, 1);
    assert.equal(notes.notes[0].status, "draft");
    assert.match(notes.notes[0].created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(notes.notes[0].updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const noteBody = files.get(notes.notes[0].path);
    assert.ok(noteBody.includes(`created: ${JSON.stringify(notes.notes[0].created)}`), "Frontmatter created must match the catalog timestamp");
    assert.ok(noteBody.includes(`updated: ${JSON.stringify(notes.notes[0].updated)}`), "Frontmatter updated must match the catalog timestamp");
    assert.match(notes.notes[0].contentRevision, /^sha256:[a-f0-9]{64}$/);
    const revisionPath = `revisions/${input.documentId}/${notes.notes[0].contentRevision.slice(7)}.json`;
    assert.ok(files.has(revisionPath));
    assert.ok(files.has(`content/notes/${input.documentId}/assets/test.png`));
    assert.equal(mock.requests.filter((r) => r.method === "POST" && r.path === "git/trees").length, 1);
    assert.equal(mock.requests.filter((r) => r.method === "PATCH").length, 1);
    assert.ok(mock.requests.filter((r) => r.method === "POST" && r.path === "git/trees")[0].body.tree.every((e) => !e.path.startsWith("annotations/")));
    assert.deepEqual(JSON.parse(files.get("catalog/documents.json")).documents.find((x) => x.documentId === "doc-paper"), JSON.parse(initial.get("catalog/documents.json")).documents[0]);
    assert.deepEqual(JSON.parse(files.get("catalog/search.json")).items.find((x) => x.documentId === "doc-paper"), JSON.parse(initial.get("catalog/search.json")).items[0]);
    assert.ok(JSON.parse(files.get("catalog/search.json")).items.some((x) => x.text.includes("SearchListNeedle")));
    const beforeReplay = mock.requests.filter((r) => r.method === "PATCH").length;
    assert.equal((await store.save(input, listed.head, requestId)).head, saved.head);
    assert.equal(mock.requests.filter((r) => r.method === "PATCH").length, beforeReplay);
    await assert.rejects(store.save({ ...input, title: "different payload" }, listed.head, requestId), /不同内容|同一保存请求/);
    const current = mock.head;
    const postsBefore = mock.requests.filter((r) => r.method !== "GET").length;
    await assert.rejects(store.save({ ...input, documentId: "note-stale-review" }, listed.head, crypto.randomUUID()), /并发|更新/);
    assert.equal(mock.requests.filter((r) => r.method !== "GET").length, postsBefore);
    const lostInput = { ...input, documentId: "note-lost-reply", markdown: "Lost reply paragraph", assets: [] };
    mock.losePatchReply = true;
    const lostId = crypto.randomUUID();
    await assert.rejects(store.save(lostInput, current, lostId), /连接 GitHub/);
    const afterLost = mock.head;
    assert.notEqual(afterLost, current);
    assert.equal((await store.save(lostInput, current, lostId)).head, afterLost);
    assert.equal(mock.head, afterLost);
    const conflictInput = { ...lostInput, documentId: "note-concurrent-review" };
    mock.concurrentPatch = true;
    await assert.rejects(store.save(conflictInput, mock.head, crypto.randomUUID()), /并发/);
    assert.ok(!mock.files().has("content/notes/note-concurrent-review/index.md"));
    const readonlyHead = mock.head;
    mock.failWriteStatus = 403;
    await assert.rejects(store.save({ ...lostInput, documentId: "note-readonly-review" }, readonlyHead, crypto.randomUUID()), /拒绝|权限/);
    assert.equal(mock.head, readonlyHead);
    mock.failWriteStatus = 0;
    await assert.rejects(store.save({ ...lostInput, documentId: "note-invalid-asset", assets: [{ name: "../outside.png", type: "image/png", base64: "aGVsbG8=" }] }, mock.head, crypto.randomUUID()), /附件无效/);
    const one = { ...input, documentId: "note-delete-one", title: "Delete one" };
    const oneSave = await store.save(one, mock.head, crypto.randomUUID());
    const beforeOneDelete = mock.head;
    const beforeOneDeletePatches = mock.requests.filter(r => r.method === "PATCH").length;
    const oneDeleteId = crypto.randomUUID();
    const oneDelete = await store.deleteNotes([one.documentId], oneSave.head, oneDeleteId);
    assert.notEqual(oneDelete.head, beforeOneDelete);
    const afterOneFiles = mock.files();
    assert.ok(!afterOneFiles.has(`content/notes/${one.documentId}/index.md`));
    assert.ok(afterOneFiles.has(`revisions/${one.documentId}/${JSON.parse(mock.files(oneSave.head).get('catalog/notes.json')).notes.find(n => n.documentId === one.documentId).contentRevision.slice(7)}.json`));
    assert.ok(afterOneFiles.has(`content/notes/${one.documentId}/assets/test.png`));
    assert.equal(afterOneFiles.get("annotations/2026/10/21/doc-paper.jsonl"), initial.get("annotations/2026/10/21/doc-paper.jsonl"));
    assert.ok(JSON.parse(afterOneFiles.get("catalog/documents.json")).documents.some(d => d.documentId === "doc-paper"));
    assert.ok(JSON.parse(afterOneFiles.get("catalog/search.json")).items.some(i => i.documentId === "doc-paper"));
    assert.equal(mock.requests.filter(r => r.method === "PATCH").length, beforeOneDeletePatches + 1, "one delete request must create exactly one ref update");
    await assert.rejects(store.save({ ...one, sourceDocumentId: one.documentId }, oneSave.head, oneDeleteId), /requestId|请求 ID|不同操作/);
    const batchA = { ...lostInput, documentId: "note-delete-a", title: "Delete A" };
    const batchB = { ...lostInput, documentId: "note-delete-b", title: "Delete B" };
    const a = await store.save(batchA, mock.head, crypto.randomUUID());
    const b = await store.save(batchB, a.head, crypto.randomUUID());
    const batchIds = [batchA.documentId, batchB.documentId];
    const batchDeleteId = crypto.randomUUID();
    mock.losePatchReply = true;
    await assert.rejects(store.deleteNotes(batchIds, b.head, batchDeleteId), /连接 GitHub/);
    const afterLostDelete = mock.head;
    const patchesAfterDelete = mock.requests.filter(r => r.method === "PATCH").length;
    const retry = await store.deleteNotes([...batchIds].reverse(), b.head, batchDeleteId);
    assert.equal(retry.head, afterLostDelete);
    assert.equal(mock.requests.filter(r => r.method === "PATCH").length, patchesAfterDelete, "lost reply retry must find original delete commit");
    assert.ok(!mock.files().has(`content/notes/${batchA.documentId}/index.md`));
    assert.ok(!mock.files().has(`content/notes/${batchB.documentId}/index.md`));
    await assert.rejects(store.deleteNotes([batchA.documentId], b.head, batchDeleteId), /requestId|操作或笔记集合/);
    const stale = await store.list(); mock.advance();
    await assert.rejects(store.deleteNotes([lostInput.documentId], stale.head, crypto.randomUUID()), /并发|更新/);
    const protectedHead = mock.head; mock.failWriteStatus = 403;
    await assert.rejects(store.deleteNotes([lostInput.documentId], protectedHead, crypto.randomUUID()), /拒绝|权限/);
    mock.failWriteStatus = 0;
    console.log("PASS synthetic GitHub deletion: single and batch atomic commits, active body/catalog/search removed, snapshot/assets/comments/papers/history preserved, idempotent lost-reply retry with order-normalized payload binding, cross-operation request ID rejection, stale HEAD and 403 retain content.");
  } finally {
    store.disconnect();
    globalThis.fetch = originalFetch;
  }
}
async function checkFixedReads() {
  const mock = new MockGitHub(seedFiles()), oldFetch = globalThis.fetch;
  globalThis.fetch = mock.fetch;
  const writer = new GitHubNotesStore(mock.repository, TEST_TOKEN), reader = new GitHubNotesStore(mock.repository, TEST_TOKEN);
  const input = { documentId: "note-fixed-read", sourceDocumentId: null, sourceKind: "blog", title: "Fixed read", status: "draft", tags: [], sources: [{ canonicalUrl: "https://example.org/original", originalTitle: "Original attribution", author: "Original author" }], markdown: "Original fixed paragraph.\n\n![img](assets/fixed.png)", assets: [{ name: "fixed.png", type: "image/png", base64: "aGVsbG8=" }] };
  try {
    await writer.connect();
    const initial = await writer.list();
    const first = await writer.save(input, initial.head, crypto.randomUUID());
    await reader.connect();
    const pinned = await reader.list();
    const before = await writer.get(input.documentId);
    assert.ok(!before.markdown.startsWith("---"));
    assert.ok(!before.markdown.includes("<!-- kb:block"));
    assert.ok(before.identityMarkdown.includes("<!-- kb:block"));
    const changed = { ...input, sourceDocumentId: input.documentId, markdown: before.markdown.replace("Original fixed paragraph.", "Externally updated paragraph."), sources: [{ canonicalUrl: "javascript:alert(1)", originalTitle: "Tampered attribution" }], assets: [] };
    const second = await writer.save(changed, first.head, crypto.randomUUID());
    assert.equal(second.note.created, first.note.created, "Updating a note must preserve its original created timestamp");
    assert.deepEqual(second.note.sources, input.sources, "Original Blog attribution must not be overwritten");
    const refReads = mock.requests.filter((r) => r.path.startsWith("git/ref/")).length;
    const old = await reader.get(input.documentId);
    assert.equal(old.head, pinned.head);
    assert.ok(old.markdown.includes("Original fixed paragraph."));
    await reader.asset(input.documentId, "fixed.png");
    assert.equal(mock.requests.filter((r) => r.path.startsWith("git/ref/")).length, refReads, "get/asset must use one cached immutable read snapshot");
    const refreshed = await reader.list({ force: true });
    assert.equal(refreshed.head, second.head);
    assert.ok((await reader.get(input.documentId)).markdown.includes("Externally updated paragraph."));
    const latestFiles = mock.files();
    assert.equal([...latestFiles.keys()].filter((path) => path.startsWith("revisions/note-fixed-read/")).length, 2);
    console.log("PASS fixed read snapshot across list/get/asset; explicit list refresh advances; Blog original attribution protected; old note snapshots retained.");
  } finally {
    writer.disconnect();
    reader.disconnect();
    globalThis.fetch = oldFetch;
  }
}
async function checkWritesBypassOlderReads() {
  const waitFor = async predicate => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail("timed out waiting for a fresh write HEAD request");
  };
  const check = async mode => {
    const mock = new MockGitHub(seedFiles()), oldFetch = globalThis.fetch;
    globalThis.fetch = mock.fetch;
    const store = new GitHubNotesStore(mock.repository, TEST_TOKEN);
    const expectedHead = mock.head;
    const gate = mock.delayNextBlob();
    const oldList = store.list(mode === "delete" ? { force: true } : undefined);
    await gate.started;
    mock.advance();
    const requestStart = mock.requests.length;
    const write = mode === "delete"
      ? store.deleteNotes(["note-write-race"], expectedHead, crypto.randomUUID())
      : store.save({ documentId: "note-write-race", sourceDocumentId: null, sourceKind: "personal", title: "Write race", tags: [], status: "draft", markdown: "Body", assets: [], sources: [] }, expectedHead, crypto.randomUUID());
    await waitFor(() => mock.requests.slice(requestStart).some(request => request.method === "GET" && request.path === "git/ref/heads/main"));
    assert.ok(mock.requests.slice(requestStart).some(request => request.path === "git/ref/heads/main"), `${mode} must GET a fresh branch HEAD while an older read is pending`);
    gate.release();
    await oldList;
    await assert.rejects(() => write, /并发|更新/);
    const writeRequests = mock.requests.slice(requestStart);
    assert.equal(writeRequests.some(request => request.method !== "GET"), false, `${mode} must reject a stale expected HEAD before POST/PATCH`);
    store.disconnect();
    globalThis.fetch = oldFetch;
  };
  await check("save");
  await check("delete");
  console.log("PASS save/delete bypass older pending reads, fetch a fresh HEAD, and stop on stale baselines before any write request.");
}
await checkContent();
await checkEditingIdentity();
await checkAdapter();
await checkFixedReads();
await checkWritesBypassOlderReads();
console.log("Production notes regression passed with synthetic GitHub only.");
