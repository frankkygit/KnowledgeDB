---
name: kb-arxiv-latex-translate
description: 从用户给定的 arXiv 链接下载同版本原 PDF 与 LaTeX 源码，使用源码和原图辅助 nature-reader 生成中文 Markdown 阅读版，不编译 LaTeX，并按用户范围衔接知识库入库发布。
---

# arXiv 源码辅助中文阅读版

这是 Agent 编排技能，不是无人值守翻译脚本。LaTeX 只作为正文、公式与图片来源；不生成中文 TeX 工程，不安装 TeX 环境，不编译原文或译文。主要交付是 nature-reader 的中英对照 Markdown 与资源。只处理用户指定论文和范围。

先读项目 `AGENTS.md`、`docs/local-workspace.md`；入库时另读 `skills/local/kb-paper-ingest/SKILL.md`（已有论文使用 `kb-content-update`）和 `docs/deployment.md`、`docs/data-contract.md`、`docs/paper-reading.md`。

## 1. 固定论文与来源

- 接受 arXiv abs/pdf/html/src 链接或明确 ID，支持现代 ID 和旧式分类/编号。校验输入，不直接把未校验 URL 或 ID 拼入命令或路径。
- 用户指定 vN 时固定该版本；未指定时通过 arXiv 原站摘要页的版本记录确定精确版本，记录核验时间。下载同版本原 PDF 与源码，不能混用 latest 和其他版本。MCP 可能剥离版本后缀，不能仅凭其 ID 判断版本。
- 查重后沿用现有 paperId；首次建立经过路径安全处理的身份。记录原始 arXiv ID、vN、摘要/源码/PDF URL、获取时间、许可证及各文件 SHA-256，缺项标待核对。
- 仅访问 arXiv 来源，不需要做主题搜索。需查询元数据时遵循项目 arXiv-only MCP 规则。

## 2. 下载并保留原件

- 保存至 `local-data/papers/<paper-id>/<source-version>/`：`original.pdf`、实际下载的 `source.archive`、解包后的 `source/` 与 `provenance.json`。已有文件只在版本和哈希核实后复用；否则建不冲突目录并记录实际 vN，不覆盖历史。
- PDF 直接从固定版本 arXiv PDF 入口下载；源码通过该版本摘要页的源码入口获取（常见为 `https://arxiv.org/src/<id>vN`）。检查 HTTP 状态、最终 URL、内容类型与实际文件头，不把 HTML 错误页或 PDF-only 响应当成源码。
- 按实际格式处理 tar、gzip tar 或单独压缩/未压缩 TeX。解包前检查路径与成员，拒绝绝对路径、路径穿越、链接、设备等非普通成员和解包体积异常；只提取目录与普通文件，保留子目录、原图、bib/bbl 与许可证。不执行源包脚本。
- 串行请求、至少间隔 3 秒；限流遵循 Retry-After，每个资源最多重试 3 次。源码缺失或不可解析时保留原 PDF，明确报告；只有用户接受 PDF/HTML 降级时才继续，不声称使用了源码。

## 3. 使用 nature-reader 翻译

- 确认本机 `nature-reader` 与 `nature-shared` 可用，读取实际 SKILL.md、manifest、always_load 和与输入有关的片段；再读本技能的 [源码到阅读版适配](references/source-reader.md)。不修改本机第三方技能源码。
- nature-reader 当前没有原生 tex 输入路由。本流程明确组合其 PDF 流程与源码辅助提取，不声称新增了第三方技能的原生能力：PDF 用于页码、顺序和视觉核对，TeX 用于正文、公式及原图。仍遵循其真实输出契约，不把 TeX 文件当作 PDF 交给解析器。
- 新建唯一 `local-data/translations/<paper-id>/<run-id>/`，向 nature-reader 传入绝对输出路径及固定版本原 PDF、解包源码路径和用户范围。临时处理文件放 `local-data/work/<run-id>/`。
- 默认翻译范围排除作者列表与参考文献：不翻译作者姓名、作者列表及参考文献条目；阅读版正文不重复附作者名单，不输出 References/Bibliography/参考文献章节或条目（包括英文原文配对）。论文身份元数据中的作者保留原文，原 PDF、源码与 bib/bbl 完整归档。正文中的引文标记及作者提及仍按原文保留，用于理解与溯源，不展开为文末参考文献。将此范围显式传给 nature-reader 及后续入库技能，优先于其默认全文输出；用户明确要求时才翻译或附上这些部分。
- 沿真实入口跟踪 input/include 与图片依赖，按章节翻译正文、标题、图注、表格说明、脚注与算法说明。不要盲目串接所有 .tex，重复备份和未引用片段不自动算论文正文。无法判断入口时列出候选并请求澄清。
- 数学符号、上下标、运算符、单位与数值不翻译；可信源码公式适配为 Markdown math，按原 PDF 核验公式编号。自定义宏只在明确含义后展开，不执行 TeX；无法可靠还原时保留原 PDF 公式截图并标低置信度。
- 原始图片完整保留到原件目录；阅读版优先引用适用格式的原图副本，必要时生成可显示的派生图片。图片内嵌英文默认保留，图注/旁注给中文说明，不重绘替换实验图。表格优先正确对应的原 PDF 裁图，并翻译说明；如转为 Markdown 表格，逐项核对数值、行列和单位。
- 保留 nature-reader 的 Original/中文 配对、章节、图表、公式及来源锚点。不承诺 Markdown 保持 PDF 的双栏、分页和字体。用户明确仅中文时按其要求调整，并记录对默认中英对照契约的变更。

## 4. 核验并归档阅读版

- 保存实际生成的 `paper.md`、`source_map.json`、`translation_notes.md` 和 `assets/`；另保留 `provenance.json` 和必要的 `translation-map.json`（TeX 相对路径/位置与阅读版块的映射）。源位置映射不是正式 documentId/blockId，也不能冒充真实 PDF 页码/坐标。
- 按 nature-reader 说明执行其实际存在的公式校验脚本，检查图片路径、公式展示、引用/图表编号和全文覆盖；在目标阅读器或预览中检查每个生成章节，逐项对照原 PDF 的公式与图表。缺页、未翻译章节、缺图、未核验源位置和不支持宏写入说明，不用摘要冒充全文。
- 在 translation_notes.md 记录“按默认范围省略作者列表和参考文献，原件保留”；这两部分属于有意排除，不计为漏译或因此单独判为未完成。核验 paper.md 和正式 translation.md 未重新附上名单/文献列表，正文引文标记保留，且未删除参考文献之后仍在范围内的附录或补充正文。
- 不生成或声称生成中文 PDF，也不通过编译 TeX 获取图像；从原 PDF 裁图或用现有图像转换工具处理资源即可。若以后用户另行要求中文 PDF，单独确定输出方式。
- 依赖不可用、图片转换失败或数学校验失败时保留 draft 与具体缺项；最多 3 次有针对性的修复后报告阻塞，不用删正文/图表换取通过。

## 5. 衔接知识库

- 用户明确仅翻译/仅本地/暂不入库或发布时停在指定节点；否则按项目默认流程继续。
- 使用 kb-paper-ingest（已有论文改用 kb-content-update），传入 paperId/vN、原件目录、paper.md/source_map/assets、验证状态与用户范围；直接整理本次翻译，不重下载或重译。确认私有 docs 根是独立 Git 子库，生成概述、翻译、稳定 ID、快照与覆盖正文的 catalog 索引，保留人工修改与评论历史。
- 核验入口映射、资源链接、稳定 ID、快照与索引同步及公开产物边界；运行项目 check、build、check:public，必要校验未通过时保留草稿并报告。正式 Markdown 的数学宏与私有资源须可渲染，不能发布本地绝对路径或 TeX 原路径。
- 按 docs/deployment.md 先提交推送 docs 子库，再将主库 gitlink、release-manifest.json 和 site/public/reader-config.json 的 docs 引用同步为同一 SHA，检查后提交推送主库；不强推。等待对应 Pages 工作流成功并打开真实 page_url，验证授权后的论文概述、翻译与检索。凭据不足或无法授权阅读器时报告具体状态，不把推送成功等同于线上论文已验证。令牌仅在标签页内存使用。
- 正式 ID、快照、索引和人工修改/评论保护遵循本地入库或更新技能。原 PDF、源包、原始阅读版留在被忽略的 local-data；不写公开站点或根 docs 设计目录。

## 交付

报告精确来源版本、原 PDF/源码路径和哈希、阅读版目录与翻译范围、公式图表核验情况及缺项，再按实际完成情况报告入库/部署状态。创建技能不代表真实论文端到端已验证，不在构建或 CI 中自动执行。
