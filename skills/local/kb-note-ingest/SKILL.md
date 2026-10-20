---
name: kb-note-ingest
description: 将网页资料或用户自己的总结整理为本知识库的可追溯笔记，区分来源要点、个人理解与验证记录。
---

# 资料与笔记入库

读取主仓库 `docs/repository-layout.md` 解析数据根目录：content/、catalog/、revisions/ 写入私有 docs 子库，annotations/ 属于私有 comments 子库。Pages 仅发布程序，不将私人正文或派生索引复制到站点主库/公开产物。

先读仓库 `AGENTS.md` 和 `docs/data-contract.md`。输入可为 URL、原文摘录或用户总结；只根据实际访问或提供的内容整理。无法访问 URL 时标明未读取，不把背景知识说成该页面结论。

按规范 URL 和现有 documentId 查重；更新已有条目时读取 `../kb-content-update/SKILL.md`。规范 URL 可去除跟踪参数，但保留会影响资源身份的查询参数。

输出包含：来源信息、来源要点、我的理解、验证记录、关联论文/专题、待解决问题。原文事实、用户判断、Agent 推断清楚区分；未执行的命令或实验标为建议，不写成验证结果。

Agent 收集的内容写入 `content/inbox/` 并标 draft；用户已整理的总结可按其意图放入 `content/notes/<category>/`。跨资料比较写入 topics，并链接被比较的条目。保留必要短引文与来源，优先摘要和自己的分析。

赋予文档和段落稳定 ID，填写访问日期，按数据契约检查元数据与关联链接，更新私有 catalog 目录与全文搜索索引，记录 documentId、章节、可用 blockId 和版本，使仅在笔记正文出现的内容也可检索。实现工具缺失时交付草稿并说明缺口；不声称已完成网站构建或发布。

完成后给出输出文件、去重/更新决策、来源可访问情况、待核对项与关联条目。已有笔记中的人工修改和评论不得被重建覆盖。
