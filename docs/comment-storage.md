# 评论存储与分片 v1

状态：已加入首评创建与分片读取适配器，首评创建已通过用户真实私库测试；回复、编辑和重新链接界面待实施。完整实施范围见 [阅读器功能说明](reader-features.md)。当前无迁移数据。此约定取代早期“一组讨论一个 JSON 文件”的物理布局；`threadId` 的逻辑含义不变。路径 annotations/ 相对于私有 comments 子库，正文和快照在私有 docs 子库，详见 [多仓库与发布边界](repository-layout.md)。

## 1. 两种粒度分开管理

- 逻辑粒度：一组讨论针对一个段落或一处引用，包含首评与后续回复。通过 threadId 关联，重新链接作用于整组。
- 存储粒度：同一日期、同一文档的多组讨论操作共用一个分片；达到大小上限再开下一片。不是每条评论一个文件，也不是把全天所有文档塞进一个文件。

例如，一篇论文的三个段落产生了四组讨论、共十五条评论；在文件未超限时可以全部存于同一日期分片。明天继续回复其中一组，新增操作写到明天目录，页面仍按原 threadId 显示同一组讨论。

## 2. 年/月/日目录

```text
annotations/
  2026/
    10/
      20/
        doc-example-translation/
          part-000001.json
          part-000002.json
        doc-example-analysis/
          part-000001.json
      21/
        doc-example-translation/
          part-000001.json
```

日期按浏览器适配器首次发起操作时的 `Asia/Shanghai` 自然日划分；createdAt 等字段保存 UTC ISO 8601，重试复用时间和日期。年四位，月/日两位。适配器校验并派生仓库内路径，CI 复核；没有业务服务端为操作提供可信时间戳。

回复、编辑、重新链接记录在各自首次发起操作的日期，新操作不移动或改写原始评论所属的旧日期文件。网络重试先按 requestId 查既有记录：若昨天已保存，今天重试仍返回昨天的结果，不重复写今天。

午夜前发起的请求，即使跨日重试也写入首次尝试的日期；不把同一 requestId 分散到多个日期。该操作日期目录的最后分片允许因迟到重试继续追加，已满分片不再追加。成功定义为 commit 已进入目标分支；未进入分支的候选 commit 不算已保存。

## 3. 单文件增长上限

第一版采用项目默认阈值，可在真实使用后调整：

| 项目 | 初始值 | 行为 |
| --- | --- | --- |
| 单个 JSON 分片 | 最大 256 KiB，按实际格式化后的 UTF-8 字节计 | 追加后超限则开下一个编号；不截断旧记录 |
| 单条操作记录 | 最大 64 KiB | 超限拒绝并保留草稿，提示缩短或拆成多条评论 |
| 单条评论正文 | 最大 16 KiB UTF-8 | 适配器写入前校验，CI 复核；附件另存，不内嵌 base64 |
| 列表页 | 默认 20 组，最多 100 组 | cursor 分页，按需加载评论 |

单组讨论的评论可以跨多个文件和日期，因而不受一个 JSON 文件大小限制。长引用使用版本快照与范围定位，操作中可只存受限的引用预览；完整原文由不可变快照恢复。数据契约中的完整 anchor 是读取视图，持久形式可引用快照，但必须能无损恢复 originalAnchor，不能静默截断后丢失原引用。

一个分片是 `schemaVersion`、date、timezone、documentId、part 和 records 数组构成的 JSON 对象。只对操作所属日期最后一片追加，满片保持不变；旧日期记录保留。没有评论操作的日期不创建空文件或文件夹。

## 4. 操作记录与聚合

分片记录的是可重放的操作，而非反复保存整组讨论的所有副本：

```json
{
  "schemaVersion": 1,
  "date": "2026-10-20",
  "timezone": "Asia/Shanghai",
  "documentId": "doc-example-translation",
  "part": 1,
  "records": [
    {
      "requestId": "request-example",
      "payloadDigest": "sha256:<canonical-request-digest>",
      "threadId": "thread-example",
      "kind": "comment.add",
      "expectedThreadRevision": 1,
      "resultThreadRevision": 2,
      "at": "2026-10-20T03:00:00Z",
      "actorId": "owner",
      "payload": {
        "commentId": "comment-example-2",
        "body": "这里需要增加一组实验。"
      }
    }
  ]
}
```

支持的操作及最小业务内容：

| kind | payload 内容 | 聚合结果 |
| --- | --- | --- |
| thread.create | documentId、原始 anchor 或无损快照引用、首评 ID/正文 | revision 从 0 到 1；生成 originalAnchor 与初始 binding |
| comment.add | 新 commentId、正文 | 追加评论，comment revision 为 1 |
| comment.edit | commentId、expectedCommentRevision、新正文 | 评论 ID 不变，评论 revision 加一，旧正文仍在旧操作中 |
| binding.set | 新 anchor 或 null、目标正文版本 | 更新 binding，追加链接历史，不修改 originalAnchor |

每条操作带相邻的 expected/result thread revision。聚合器按同一讨论的修订链重放，不依赖目录遍历顺序或客户端时间排序。重复 requestId 且摘要相同只应用一次；摘要不同、修订链缺口、冲突分支、未知操作类型必须报错，不能跳过记录后宣称恢复完整。

operation 的 at 为浏览器首次尝试时生成的 UTC 时间，重试不变；创建/编辑后的评论时间和链接历史由操作时间恢复。Git commit 时间可供核对，不能将客户端时间当作可信审计时间。请求摘要基于规范业务请求计算，不包含重试时变化的目录、候选提交时间或 GitHub 返回结果，确保跨日重试仍能识别同一请求。

## 5. 保存、幂等与并发

一次评论操作只追加一条记录至一个分片，并产生一次 commit。新建分片与追加既有分片具有同样的保存语义；请求 ID 和业务变更在同一记录中，不会出现评论已写但幂等记录遗漏。

写入前从同一个 comments HEAD 获取讨论修订、requestId 记录和当前分片；正文目标从已发布的固定 docsCommit 获取。提交基于该 comments HEAD；更新分支失败则重读：先查幂等，再查讨论修订和已发布正文版本，最后重新选片。不能仅用当天分片的 blob SHA 检查跨日期的讨论并发。两个子库不能原子提交；正文发布交错时保留旧版目标，后续解析为 pending，具体见多仓库约定。

使用 [GitHub Git 对象 API](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database) 构造 commit，非强制更新分支。最多重试三次；仍有争用返回可重试错误并保留草稿，不用强制推送解决冲突。原 commit 从 requestId 首次进入分片的 Git 历史定位；缓存可加速查询，但不能作为唯一幂等凭据。

## 6. 查找与分页

存储按日期组织，阅读仍按文章与讨论组织，用户不需要自己找日期文件。

- 浏览器适配器或私有 CI 校验器从指定 comments HEAD 汇总文件树，建立 documentId → 分片、threadId → 讨论及 requestId → 操作位置的派生索引。
- 按文档和日期分区缓存索引，避免每次请求重读全库。缓存绑定 comments HEAD 与已发布 docsCommit；增量更新完成前不能把旧索引用于写入校验，缓存丢失可从 Git 重建。
- 浏览器按文档聚合并分页显示讨论摘要与评论；派生分页数据只能在私库或内存中，不能发布到 Pages。页底优先列待链接讨论，通过分页查看全部，不把“第一页”当成全部评论。
- cursor 绑定读取的 comments HEAD/docsCommit 版本对；读取过程中任一版本变化时继续读该快照，或明确返回刷新要求，不能混用版本导致漏条/重复。
- 一篇文章跨多年的讨论照常聚合；正文重新翻译只影响位置解析，不影响日期目录或讨论身份。

日期目录不能减少 Git 总历史体积，也不能单独防止 JSON 增长；目录分区、文件大小上限、操作增量记录和分页读取分别处理这些问题。Git 体量与浏览器重建时间持续增长时，先优化私库的分区派生索引；数据库读取副本属于后续需另行评估的扩展，不是第一版依赖。

## 7. 实施验收补充

必须覆盖：跨日回复不拆讨论、跨日重试不重复、单组讨论跨片后评论完整、超限自动开片、中文/emoji 按 UTF-8 字节校验、跨片并发编辑冲突、索引丢失可重建、分页无漏条、操作重放后 originalAnchor 与链接历史无损。

当前仓库尚无旧格式评论数据，不需要迁移。以后若导入旧版一组一个 JSON 的数据，先导出初始对象及历史操作、保存原备份，校验 ID/数量/引用/历史一致后再启用新布局；不得仅复制最新状态而丢弃旧评论修订。
