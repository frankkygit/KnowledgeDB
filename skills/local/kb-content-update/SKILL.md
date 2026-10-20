---
name: kb-content-update
description: 更新本知识库已有翻译、解读或笔记，保留人工修改、稳定身份及评论，生成正文改版后的评论影响报告。
---

# 已有内容更新

读取主仓库 `docs/repository-layout.md` 解析数据根目录：content/、catalog/、revisions/ 写入私有 docs 子库，annotations/ 属于私有 comments 子库。Pages 仅发布程序，不将私人正文或派生索引复制到站点主库/公开产物。

先读 `AGENTS.md`、`docs/data-contract.md`；需要了解发布门槛时读 `docs/execution-plan.md` 第 7、8 节及 `docs/browser-github-access.md`。输入为已有 documentId 与改动目标；若仅有标题或路径，先定位固定 ID，不能因路径变化重建身份。

## 本地原始资料

原论文使用主库 local-data/papers/<paper-id>/<source-version>/，原始翻译使用 local-data/translations/<paper-id>/<run-id>/；读取 AGENTS.md 和 docs/local-workspace.md 中的完整约定。两者均被 Git 忽略，保留原文件和每次运行输出。只有用户要求入库时才生成或更新私有 docs 库里的正式正文；私库未配置时保留本地成果并说明，不回退写入主库。不要在建仓、构建或 CI 时自动触发检索、下载、翻译。

## 修改正文

- 读取当前正文、人工修订、对应版本快照和该文档全部讨论，不只读取成功匹配的讨论。遵循 `docs/comment-storage.md`，汇总所有日期与分片中的操作；不能只读当天文件或把一个分片当成完整讨论。
- 保存旧版基线；保留翻译、解读、个人笔记的文件职责。生成更新候选并合并人工改动，有歧义时保留双方文本而非覆盖。
- 更新默认概述遵循 `docs/paper-reading.md`，analysis.md 继续作为主内容，translation.md 保留链接渲染；同步 catalog 入口映射，概述与翻译评论按独立 documentId 保留。
- 文档 ID 不变。未变段落移动保留 ID；同一段落的修订可保留 ID，但 digest 变化后旧评论需重新确认；拆分、合并、替换使用新 ID，并在影响报告记录旧到新关系仅作建议。
- 全篇重译无法证明对应关系时分配新段落 ID，旧评论全部进入待重新链接状态。不能按段号或相似句子强行沿用关系。

## 评论保留

不写入或删除 `annotations/`，不改 originalAnchor、comments 或 bindingHistory。由解析器依据新正文算 pending；用户通过阅读界面确认才会写入新 binding。

按线程输出影响报告：仍有效、原段已改、段落移除/拆分/合并、需人工确认；列出 threadId、原引用、原因与可选候选段落。建议不能当成用户确认。

按契约生成新快照并保留所有旧快照，同步正文库内的 catalog 和全文搜索索引，保留命中文档/章节/段落/版本；检查“仅出现在翻译或笔记正文中的词”仍有检索记录。检查更新前后的讨论 ID/评论 ID 集合未减少，个人笔记未被覆盖，内部链接及元数据有效。若当前没有解析器或校验命令，人工检查可观察项并明确剩余验证，不能伪报通过。

最终交付正文变更、评论影响、待核对项和验证结果。正文改版允许有待重新链接评论，但不允许漏评论或漏历史快照。按当前用户授权决定是否提交；发布不能由技能隐式触发。
