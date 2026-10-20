# 知识库协作约定

- 本仓库进入基础骨架阶段。阅读器外壳可本地启动；私库授权、全文检索和评论持久化以实际代码状态为准。实现遵循 `docs/execution-plan.md` 和 `docs/data-contract.md`，不要把设计示例当成已实现功能。
- 线上架构统一为 GitHub Pages 公开阅读器 + 浏览器令牌直连私有 docs/comments 库，遵循 `docs/browser-github-access.md`。不引入额外业务托管、不新增自建 session 或 /api 接口；Pages 产物不包含私人正文、标题目录、索引、附件或评论。
- 仓库拆分遵循 `docs/repository-layout.md`：站点代码在主库，正文和快照在私有 docs 子库，评论在私有 comments 子库。入库技能中的 content/、revisions/、annotations/ 是各自数据仓库内的逻辑路径；先解析数据根目录再写入，不在站点主库复制私人内容。
- 论文展示遵循 `docs/paper-reading.md`：左侧列表、右侧内容，默认加载 analysis.md 概述；translation.md 通过稳定文档 ID 链接在阅读器内渲染。索引必须覆盖概述、翻译与笔记正文，搜索结果定位实际命中文档。
- 论文翻译、论文解读、个人笔记分别维护。重新生成翻译或解读时，不覆盖个人笔记和人工修订；出现重叠先保留双方版本供审阅。
- 文档 ID 永久固定；段落 ID 与顺序、标题、正文哈希无关。移动不换 ID；段落拆分、合并或替换生成新 ID，不复用被移除 ID。
- 正文更新不能删除评论、重置评论 ID 或覆盖历史引用快照。生成技能不直接修改 `annotations/`；位置是否有效由版本感知的解析器判断。
- 评论逻辑上以 threadId 分组，物理上遵循 `docs/comment-storage.md`，按年/月/日/文档存操作分片；不是一条评论或一组讨论一个文件。不得把读取时聚合出的讨论对象反向覆盖正式记录。
- 文本变更后的旧评论不能仅凭相似文字或相同段落 ID 自动迁移。保留原引用与版本，转入页底待重新链接列表；由库主人确认新段落。
- 入库工作使用 `skills/local/` 中对应技能；第三方技能遵循 `skills/README.md` 的登记与更新规则。仓库内技能不等于已安装到 Agent 的自动发现目录。
- Agent 收集内容先标为 draft；文献事实、Agent 分析和个人判断必须区分，来源不明或解析不清处写明待核对。
- Git 版本可记录评论历史，但不替代独立备份。令牌仅在标签页内存使用，不写持久存储、构建产物或日志；原始私有 PDF 默认留本地。

## 本地原始论文与原始翻译（必须遵循）

- 原始资料根目录固定为仓库相对路径 `local-data/`；当前绝对路径是 `/Users/lyll/code/knowledge_db/local-data/`。整个目录由 `.gitignore` 忽略，不提交或发布。
- 用户要求下载论文时，保存至 `local-data/papers/<paper-id>/<source-version>/`；用户要求翻译时，原始生成物保存至 `local-data/translations/<paper-id>/<run-id>/`，保留 paper.md、source_map.json、translation_notes.md 及 assets（实际生成哪些就保留哪些）。不要覆盖已有下载或翻译运行目录。
- OCR、抽取与临时处理文件保存至 `local-data/work/`。首次可运行 `npm run setup:local` 创建本地目录；这些空目录不随 Git 克隆保留。
- 检索、下载、翻译仅由用户手动触发；开发、构建及 CI 不自动执行这些流程。搜索候选默认只在对话中展示。
- 原始翻译是本地工作成果；只有用户明确要求入库时，才经本地入库技能整理到已配置的私有 docs 数据根。若私库未配置，保留本地成果并报告缺项，不写入公开站点或根 docs 设计目录。
- `sources/docs/` 和 `sources/comments/` 当前是被忽略的本地预留目录，尚未注册真实子模块。不得通过强制添加普通目录来把私有正文或评论提交到主库。
- 目录详见 `docs/local-workspace.md`。不修改本机外部 nature 技能源码来写死此项目路径；调用时传入本项目输出目录。

## 本机学术检索：仅 arXiv

- 本项目的论文发现使用本机外部安装的 `nature-academic-search`；安装与环境说明见 `README.md`。不将第三方技能源码复制进本仓库。
- 执行学术检索前，读取 `/Users/lyll/.agents/skills/nature-academic-search/SKILL.md` 及当前工作流所需支持文件；不要加载无关工作流或其他第三方技能。路径不存在或 MCP 不可用时，说明缺失项，不声称已使用该技能。
- 本项目学术检索仅访问 arXiv。调用 `academic-search` 的 `search_papers` 时，每次显式传入 `sources=["arxiv"]`；查询论文详情时，调用 `get_paper_by_id` 并显式传入 `id_type="arxiv"`。不得省略来源参数使用默认多源搜索。
- 不查询 CrossRef、PubMed、OpenAlex、Semantic Scholar、Scopus 等其他学术来源，不运行查询 OpenAlex 的 `scripts/academic_search.py`，不运行多来源网络预检。arXiv 无结果时仅调整 arXiv 查询词；连接失败、限流或服务错误时报告具体失败，不自动切换来源。
- 返回实际查询来源、查询词、标题、作者、arXiv ID、原文链接和中文摘要；原摘要与 Agent 总结分开，缺失日期等字段标待核对，不推断补齐。上游可能剥离 arXiv 版本后缀，未核验时不得声称结果对应某个精确版本。
- 默认仅在对话中展示候选论文。用户要求入库时，另用 `skills/local/` 对应技能，先解析私有 docs 数据根目录、标记 draft，不向站点主库写私人正文，不修改评论记录。
- 本节是 Agent 调用约定，不是网络隔离；上游服务本身仍支持多个来源。仅允许 arXiv 的要求优先于第三方技能的多源回退说明。
