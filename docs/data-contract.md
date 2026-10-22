# 内容与评论数据约定 v1

这是实施契约，字段和接口尚待代码实现。第一版所有持久数据带 `schemaVersion: 1`；后续变更通过显式迁移，不直接丢弃旧字段或记录。

存储拆分以 [多仓库与发布边界](repository-layout.md) 为准：content/、revisions/ 属于私有 docs 仓库，annotations/ 属于私有 comments 仓库。正文与评论读取使用固定 docsCommit/commentsCommit 版本对；不能假设一个 HEAD 覆盖两个仓库。

## 1. 文档与段落身份

论文条目 `paperId` 标识论文；翻译、解读、个人笔记分别有自己的 `documentId`，不能共用评论归属。文档移动或改名保留 ID。永久移除文档时保留可访问的归档入口及其评论。

正文 frontmatter 必填：

```yaml
---
schemaVersion: 1
documentId: doc-example-translation
paperId: paper-example
title: 示例论文中文翻译
type: translation
status: draft
tags: [pose-estimation]
created: 2026-10-20
updated: 2026-10-20
sources: []
---
```

论文来源登记 DOI/arXiv（有则填写）、URL、原文版本、原始文件 SHA-256；网页登记 URL 和访问日期。无法确认的字段留空并说明原因，不杜撰。正式论文条目发布前必须有可追溯来源；上面仅为格式示例。

段落 ID 使用随机 UUID，示意格式：

```markdown
<!-- kb:block b-83d733a1-8fe3-4e3c-8371-3fbcd4f0fd30 -->
这是一个可评论的段落。
```

Markdown 插件解析该标记并给对应段落附加 `data-block-id`。该插件属于 M0 待实现组件，HTML 注释本身不会自动生成属性。第一版仅普通文本段落参与；列表、代码、表格、图片和展示公式不开放内部选区。夹有行内公式的段落可整段评论，跨公式的划词范围暂禁用。

一个标记只对应一个可评论段落。校验同文档 ID 唯一、标记有目标、无重复段落 ID。不能从数组下标、标题 slug、文本哈希生成身份 ID。

### 论文入口与全文索引

论文展示遵循 [论文展示与检索规范](paper-reading.md)：analysis.md 是默认概述，index.md 是元信息与入口，translation.md 经链接在阅读区渲染；notes.md 保留用户理解。四份文档各自拥有固定 documentId，不把概述和翻译的评论混用。

私有 docs 库 catalog 中的论文条目至少记录下面的映射；示例 ID 为占位示意，不是已经存在的文档：

```json
{
  "schemaVersion": 1,
  "paperId": "paper-example",
  "title": "示例论文",
  "entryDocumentId": "doc-example-entry",
  "overviewDocumentId": "doc-example-analysis",
  "translationDocumentId": "doc-example-translation",
  "notesDocumentId": null,
  "translationStatus": "draft"
}
```

catalog 另按 documentId 记录仓库内路径、type、contentRevision 与处理状态；映射由构建校验解析，不接受任意外部 raw 链接作为私有文档入口。overviewDocumentId 缺失时为 null，阅读器显示概述待生成，不无提示打开全文翻译。左侧论文列表以 paperId 分组，右侧按目标 documentId 渲染。

全文索引包含概述、翻译、笔记和专题正文，而非只含标题/摘要。索引项至少含 documentId、paperId（非论文可为空）、type、title、sectionTitle、blockId（无可定位段落时为空）、contentRevision、规范文本及片段定位信息。docsCommit 由被读取的不可变仓库版本/发布清单提供，不能把包含索引自身的 Git commit SHA 写回索引造成循环。

检索结果附带实际读取的 docsCommit，跳转到该版本的目标文档和段落；索引与正文 revision 不一致时提示更新或退到章节定位。检索高亮不改变段落 ID，也不写入评论。索引保留在私库，授权后进入浏览器内存，不发布到 Pages。

## 2. 正文版本与快照

`contentRevision` 是正文身份版本，不是 Git commit SHA：

1. 按顺序生成规范文档 JSON，包含 documentId、type、title、完整正文 AST（含非评论块和图片/公式引用）及段落映射。
2. 使用固定键序、UTF-8、LF、Unicode NFC；排除 updated 等维护时间、评论、构建时间与版本字段本身。
3. 对规范 JSON 做 SHA-256，存为 `sha256:<hex>`。段落另有 `textDigest`，仅对规范段落纯文本计算。
4. 完整规范文档和段落快照存于 `revisions/<documentId>/<hex>.json`。已存在快照不可原地覆盖。

规范纯文本算法 `kb-text-v1`：基于解析后的文本节点（不含按钮/高亮 UI），解码实体、NFC、CRLF 转 LF、连续空白折为一个空格并去除首尾空白。浏览器和构建端复用同一实现。范围偏移统一为 Unicode 码点、左闭右开，不能混用 JavaScript UTF-16 下标。行内公式使用确定的占位文本，第一版不对其内部划词。

快照至少记录 `documentId`、`contentRevision`、`normalizationVersion`、完整正文结构、各段落 ID/纯文本/digest/章节，以及附件的内容摘要。Git commit SHA 另作保存结果；评论提交不会造成正文版本变化，也不出现“正文中嵌入自身 commit SHA”的循环。

## 3. 讨论对象与物理存储

一组讨论是针对一个段落或同一引用的首评与后续回复，由稳定 `threadId` 标识；重新链接作用于整组讨论。相同段落可以有多组讨论；引用相同也不强制合并。

讨论是逻辑对象，不再要求一组一个 JSON。正式记录位于 `annotations/YYYY/MM/DD/<documentId>/part-000001.json`，同一天同一文档的多组讨论共用分片，达到上限再开下一片。新增、回复、编辑与关联保存为操作记录，按序聚合出讨论对象；完整规则见 [评论存储与分片](comment-storage.md)。

以下为读取层聚合出的讨论示例，不是直接写回磁盘的文件格式；ID/digest 为示意，实际由程序生成。

```json
{
  "schemaVersion": 1,
  "id": "thread-example",
  "documentId": "doc-example-translation",
  "revision": 1,
  "originalAnchor": {
    "contentRevision": "sha256:<original-document-digest>",
    "blockId": "b-83d733a1-8fe3-4e3c-8371-3fbcd4f0fd30",
    "blockTextDigest": "sha256:<original-block-digest>",
    "mode": "paragraph",
    "quote": {"exact": "这是一个可评论的段落。", "prefix": "", "suffix": ""},
    "range": null,
    "normalizationVersion": "kb-text-v1",
    "sectionTitle": "方法"
  },
  "binding": {
    "contentRevision": "sha256:<original-document-digest>",
    "blockId": "b-83d733a1-8fe3-4e3c-8371-3fbcd4f0fd30",
    "blockTextDigest": "sha256:<original-block-digest>",
    "mode": "paragraph",
    "quote": {"exact": "这是一个可评论的段落。", "prefix": "", "suffix": ""},
    "range": null,
    "normalizationVersion": "kb-text-v1",
    "sectionTitle": "方法"
  },
  "bindingHistory": [],
  "comments": [
    {
      "id": "comment-example",
      "authorId": "owner",
      "body": "这里需要进一步验证。",
      "revision": 1,
      "createdAt": "2026-10-20T03:00:00Z",
      "updatedAt": "2026-10-20T03:00:00Z",
      "deletedAt": null
    }
  ]
}
```

划词模式为 `quote`，`range` 保存 `{ "start": 0, "end": 5 }` 一类码点偏移，并保存 exact/prefix/suffix。整段模式保存整段原文，range 为 null。每次回复、编辑、关联更新递增讨论 revision；编辑另递增评论 revision。

`originalAnchor` 永不修改。`binding` 是最近一次用户确认的目标；撤销关联设为 null。`bindingHistory` 追加动作、操作者、UTC 时间、from/to 完整目标与请求 ID；不截断历史。评论编辑前内容由 Git 留存，正常界面只显示最新文字。

每条正式操作记录同时包含 requestId、载荷摘要与变更，在一次 commit 中提交，供持久幂等检查。创建请求的 threadId 由客户端生成一次并重试复用；requestId 相同但载荷不同返回冲突。操作历史从分片重建，不在讨论对象内重复保存不断增长的 operations 数组。原 commit 从分片的 Git 历史查询，避免在记录中包含自己的提交 SHA。

## 4. 位置状态是针对当前版本的计算结果

不把某次构建算出的失效状态覆盖进正式评论记录。浏览器适配器与 CI 校验器使用同一解析器，返回 `resolvedAgainstRevision`、`status`、`reason` 和有效目标；缓存按正文版本 + 讨论 revision 区分。聚合缓存额外绑定 comments HEAD 与已发布 docsCommit，避免漏读新日期、新分片或混用正文版本。

| 计算状态 | 条件 | 展示 |
| --- | --- | --- |
| attached | binding 在当前版本的可信延续段落中有效，段落 digest 未变，quote/range 校验通过 | 段落入口/高亮 + 页底记录 |
| pending | binding 不存在、段落已改/删除、全文替换、选区不唯一或定位校验失败 | 页底待重新链接 + 原引用；不画误导高亮 |
| archived | 整篇文档归档 | 归档页保留全部评论与旧正文 |

解析顺序：检查文档 ID → 检查绑定 → 检查段落身份延续 → 比较纯文本 digest → 校验 quote/range。仅段落移动、其他段落变化或纯格式变化时，未改文字可继续定位。不同段落的同句不作为自动目标；模糊匹配最多作为手动选择建议。

重新链接后，binding 指向用户确认的新版本、新段落和新引用，历史链条仍指向原始引用。后续新目标再变化，重新 pending。若全篇重译即使偶有文字相同，构建产生的替换报告也必须把不可信延续的旧段落标为移除，不能机械复用旧 ID。

## 5. 浏览器数据适配器契约

Pages 不提供自建 HTTP API。以下是浏览器内函数，不是 /api 路径；生产适配器直接调用 GitHub REST API，本地演示适配器使用同样的数据约定。授权、权限和凭据生命周期见 [浏览器直连 GitHub](browser-github-access.md)。

| 操作 | 作用 | 核心参数 |
| --- | --- | --- |
| connectDocs | 连接私有正文库 | docs 仓库配置、用户输入 token，标签页会话或用户选择的七天本机存储 |
| connectComments | 连接私有评论库 | comments 仓库配置、共享 token；失败不阻塞 docs |
| disconnect | 清理当前会话数据 | 内存令牌、内存索引、正文、Blob URL；保留用户选择的浏览器凭据 |
| listThreads | 分页讨论摘要及定位状态 | documentId、docsCommit、commentsCommit、cursor、limit |
| listComments | 某组讨论的分页评论 | threadId、固定版本对、cursor、limit |
| createThread | 创建讨论与首评 | requestId、threadId、documentId、docsCommit、expectedContentRevision、anchor、body |
| addComment | 追加 | requestId、threadId、commentId、expectedRevision、body |
| editComment | 编辑 | requestId、threadId、commentId、expectedRevision、expectedCommentRevision、body |
| setBinding | 重新链接或撤销 | requestId、threadId、expectedRevision、docsCommit、expectedContentRevision、target 或 null |

重新链接调用 setBinding。目标必须属于同一文档；适配器根据固定 docsCommit 校验引用和段落，不依据浏览器页面 DOM 猜测身份。评论库实际写权限由 GitHub 校验；owner 标记只是个人工具的界面约定。追加与编辑允许讨论 pending。

删除不进入第一版必做界面；后续采用 tombstone，不删除历史文件。客户端检查字段、路径、长度、目标和修订；CI 对正式记录重放校验。客户端约束不被描述为不可绕过的服务端授权。

适配器返回稳定错误类别，例如 unauthorized、forbidden、conflict、invalid-target、rate-limited、network-error，并附必要的 GitHub 状态码。正文过期/讨论修订变化产生本地 conflict，不假称来自自建 HTTP 409 接口。

写入成功返回 threadId、revision、commitSha、recordedAt；这些字段只有 GitHub 确认目标分支更新成功才返回。清单更新状态单独显示，私库评论读取不依赖 Pages 重建。重试先检查持久 requestId，再判断客户端预期修订。操作时间由浏览器在首次尝试时生成并在重试中复用，不宣称服务端可信时间。

## 6. 必须保持的完整性

- 评论总量和 ID 集合不会因正文重建而减少；评论历史及 originalAnchor 可恢复。
- 每条评论属于一个存在或归档的 documentId；翻译与解读不混用归属。
- 每个绑定指向可验证的版本快照；发布不允许遗漏被引用的历史快照。
- 当前正文变化时，页底列表仍展示全文档全部讨论，不只查询“成功匹配”的记录。
- Markdown、快照和评论有不同写入职责；构建产物不反向覆盖正式数据。
- 年/月/日分目录控制文件分布，按大小分片控制单文件增长；跨日记录通过 documentId/threadId 聚合，不因目录不同拆散讨论。
