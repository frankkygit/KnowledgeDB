---
name: kb-paper-ingest
description: 将本地论文 PDF 整理为本知识库的元信息、默认概述页、中文翻译草稿。已有论文的重译或版本替换配合 kb-content-update 使用。
---

# 论文入库

读取主仓库 `docs/repository-layout.md` 解析数据根目录：content/、catalog/、revisions/ 写入私有 docs 子库，annotations/ 属于私有 comments 子库。Pages 仅发布程序，不将私人正文或派生索引复制到站点主库/公开产物。

先读仓库 `AGENTS.md` 和 `docs/data-contract.md`，按文档/段落身份及来源约定输出。输入为指定 PDF，可附原文链接、论文版本、目标主题和翻译范围。未给范围时处理全文草稿，准确标明尚未完成的章节，不把部分翻译标成全文完成。

## 本地原始资料

原论文使用主库 local-data/papers/<paper-id>/<source-version>/，原始翻译使用 local-data/translations/<paper-id>/<run-id>/；读取 AGENTS.md 和 docs/local-workspace.md 中的完整约定。两者均被 Git 忽略，保留原文件和每次运行输出。只有用户要求入库时才生成或更新私有 docs 库里的正式正文；私库未配置时保留本地成果并说明，不回退写入主库。不要在建仓、构建或 CI 时自动触发检索、下载、翻译。

## 入库决策

- 按 DOI/arXiv、来源版本及 PDF SHA-256 查重。论文已存在时延用 paperId；新来源版本不重复创建整篇条目。已有正文更新时同时读取 `../kb-content-update/SKILL.md`。
- 查验实际可用的 PDF 解析工具；没有可读文件或无法提取正文时说明缺失内容，不凭论文标题补全翻译。缺元信息只标待补，不猜作者、版本或链接。
- 原始 PDF 默认留本地；登记来源及文件哈希，不把机器绝对路径写入正文。

## 输出

按主仓库 `docs/paper-reading.md` 确定展示顺序，使用 `templates/paper-overview.md` 生成概述结构。左侧点论文默认展示概述，不将全文翻译作为默认首页。

在 `content/papers/<paper-id>/` 中，`index.md` 保存元信息和入口，`analysis.md` 保存默认概述，`translation.md` 保存全文翻译；个人笔记仅在用户要求时创建或更新 `notes.md`。每份文档有独立 documentId。

概述包含一句话总结、贡献、背景动机、方法、实验结果、局限/对比、分析见解和资源，数字注明出处，缺失信息不补造。用户个人判断只来自其提供的笔记，不能自动生成“我的评价”。

翻译入口按固定 translationDocumentId 在右侧渲染 Markdown，不生成依赖私有 raw URL 的链接；未生成/部分翻译明确标记状态。翻译保留原论文章节、公式与图表编号，术语一致；缺失或 OCR 不确定处标待核对。分析区分论文结论、Agent 推断和工程建议，写明支持结论的章节/图表，不编造实验结果。

生成稳定段落 ID 和来源记录，按契约生成正文快照，同步私有 catalog 的 overviewDocumentId/translationDocumentId/notesDocumentId 映射与搜索索引。索引覆盖概述、翻译和笔记正文，保留命中章节/段落/版本，不只索引标题摘要。若解析器、模板或快照脚本尚未实现，明确交付为草稿，并列出尚未完成的校验，不宣称已生成可发布数据库。

完成后报告输出文件、处理范围、来源版本、待核对项、人工修改保留情况，以及已有评论是否受影响。仅执行用户已要求的提交或发布。
