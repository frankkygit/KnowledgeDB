# 个人知识库

以 Git 管理论文翻译、论文解读、个人笔记和段落评论。站点代码、正文、评论拆成三个仓库，正文和评论通过私有 Git submodule 引入。GitHub Pages 只发布阅读器程序；浏览器使用用户填写的 GitHub 令牌直接读写私库，不部署额外业务后端。

论文默认先展示技术概述，通过链接在阅读区渲染中文翻译 Markdown；采用左侧列表、右侧内容布局，并支持正文检索。

当前交付为基础目录、可本地运行的阅读器、GitHub Pages 发布流程、方案、模板与入库技能。私库连接、真实内容检索、段落评论读写和线上发布仍待实现；检索与翻译由用户手动触发。

- [论文展示与检索规范](docs/paper-reading.md)：左侧列表、右侧默认概述、翻译 Markdown 链接渲染与全文检索。
- [知识库构建执行方案](docs/execution-plan.md)：第一版范围、架构、实施顺序和验收用例。
- [内容与评论数据约定](docs/data-contract.md)：稳定 ID、正文版本、评论保留和手动重新链接。
- [评论存储与分片](docs/comment-storage.md)：年/月/日目录、多组讨论共用文件、大小上限与分页读取。
- [GitHub Pages 上线](docs/deployment.md)：首次发布设置、项目子路径和本地私有预览的区别。
- [浏览器直连 GitHub](docs/browser-github-access.md)：令牌连接、私库读取、评论提交与公开产物边界。
- [参考站点与密码方案](docs/reference-site.md)：借鉴阅读布局，说明密码入口与 GitHub 数据授权的区别。
- [多仓库与发布边界](docs/repository-layout.md)：站点主仓库、私有正文库、私有评论库及版本关联。
- [技能目录](skills/README.md)：自建技能与第三方技能的存放及使用方式。

方案依据聊天《构建知识库方案》和 2026-10-20 的补充要求：第一版即支持段落评价；不采用 Giscus 作为评论存储；正文重写后保留所有评论，待重新链接的评论在页底展示，由库主人手动关联新段落。

此处“知识库/数据库生成”指生成结构化 Markdown、元数据与索引。第一版以 Git 文件作为正式存储，暂不引入关系数据库或向量数据库。

## 本地启动与目录

```bash
npm install
npm run setup:local
npm run dev
```

构建检查：`npm run check`、`npm run build`。运行环境使用 Node.js 22；未来发布到项目子路径时用 `SITE_BASE=/knowledge_db/ npm run build` 指定路径，个人域名根路径默认使用 `/`。当前为基础阅读器骨架，后续逐步接入私库、全文检索和段落评论；不自动检索或翻译论文，不自动发布网站。

原始论文与原始翻译统一放在以下位置，整个 `local-data/` 已被 `.gitignore` 排除：

```text
local-data/papers/<paper-id>/<source-version>/       # 原论文
local-data/translations/<paper-id>/<run-id>/         # 原始翻译与附属文件
local-data/work/                                    # 解析/OCR 中间结果
```

这些原始文件不会随 Git 上传；正式入库另写私有 docs 库。目录位置与手动处理规则已写入 [AGENTS.md](AGENTS.md)，详见 [本地工作目录说明](docs/local-workspace.md)。

首次可将 knowledge.config.example.json 复制为 knowledge.config.local.json，配置本地数据路径；不要在配置中保存令牌。sources/docs 与 sources/comments 仅预留，目前没有绑定真实私有仓库。

## 本机学术检索技能

使用 npx 在本机全局安装第三方技能，不将技能源码、Conda 环境或机器配置复制进本项目。项目维护安装说明与 [仅 arXiv 调用规则](AGENTS.md)。来源为 [Yuan1z0825/nature-skills](https://github.com/Yuan1z0825/nature-skills)，许可证 [Apache-2.0](https://github.com/Yuan1z0825/nature-skills/blob/main/LICENSE)。

### 当前安装状态（2026-10-20 实机检查）

| 项目 | 状态 |
| --- | --- |
| Node.js | v22.22.1，npx 可用 |
| Conda 环境 | `/Users/lyll/Applications/anaconda/anaconda3/envs/nature-search`，Python 3.11.17 |
| nature-reader | 已安装并被当前会话发现；SKILL.md 版本 2.1.1，实际论文任务待验证 |
| nature-shared | 已安装，作为 reader 的同级支持目录 |
| nature-academic-search | 已安装并被当前会话发现；联网查询待用户验证 |
| academic-search MCP | 已添加本机 Codex 配置；Python 依赖导入通过；服务启动及联网查询待用户验证 |

本机技能根目录为 `/Users/lyll/.agents/skills/`。npx 安装记录在 `/Users/lyll/.agents/.skill-lock.json`；当前 reader 的 skillFolderHash 为 `547cd103d79b18f7976379513892323f78810021`，shared 为 `3d42a198b72809a026e1460ce7155f10a149cc53`。这是文件夹指纹，不是已核验的上游 commit；当前精确 commit 未记录，不宣称固定到某个提交。

### 1. 已完成：安装阅读与翻译技能

```bash
npx skills add Yuan1z0825/nature-skills --global --agent codex \
  --skill nature-reader --skill nature-shared --yes --copy
```

不需要额外 clone 或手建符号链接。仅阅读/翻译已有论文时可直接使用 `$nature-reader`；不需要 academic-search MCP。PDF 解析依赖按实际输入格式和当前可用工具处理，不把技能文件安装等同于所有运行依赖均可用。

使用示例：提供真实本地 PDF 路径，请求使用 nature-reader 翻译指定章节，保留公式和来源位置。原始生成物默认保存至 local-data/translations/<paper-id>/<run-id>/，原论文保存至 local-data/papers/<paper-id>/<source-version>/，均被 Git 忽略。只有要求正式入库时才解析私有 docs 根目录，使用 skills/local/ 对应技能整理 draft，不在主库保存正式私人正文。

### 2. 已完成：安装检索技能

```bash
npx skills add Yuan1z0825/nature-skills --global --agent codex \
  --skill nature-academic-search --yes --copy
npx skills list --global --agent codex --json
```

安装后确认 `/Users/lyll/.agents/skills/nature-academic-search/` 包含 SKILL.md、manifest.yaml、static/、references/、scripts/ 与 mcp-server/ 等支持文件；审阅服务脚本、依赖和许可证。只安装该技能，不全量安装。

### 3. 已完成：安装检索服务依赖

已有 Python 3.11.17 的 nature-search 环境，无需再次创建。直接使用绝对路径，避免终端仍调用系统 Python 3.9.6。

```bash
/Users/lyll/Applications/anaconda/anaconda3/envs/nature-search/bin/python -m pip install -r /Users/lyll/.agents/skills/nature-academic-search/mcp-server/requirements.txt
/Users/lyll/Applications/anaconda/anaconda3/envs/nature-search/bin/python -m pip check
```

仅查询 arXiv 无需其他数据库账号或 API key；依赖按上游清单安装以满足模块导入。其他机器若需创建环境，可运行 `conda create -n nature-search python=3.11 pip -y`，再根据实际环境路径配置。

### 4. 已完成：配置 Codex 本机检索服务

编辑 `/Users/lyll/.codex/config.toml`，保留已有内容，追加以下独立表；已有同名表时修改原表，不重复追加。

```toml
[mcp_servers.academic-search]
command = "/Users/lyll/Applications/anaconda/anaconda3/envs/nature-search/bin/python"
args = ["/Users/lyll/.agents/skills/nature-academic-search/mcp-server/academic_search_server.py"]
cwd = "/Users/lyll/.agents/skills/nature-academic-search/mcp-server"
enabled_tools = ["search_papers", "get_paper_by_id"]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

这是本机工具进程，不是阅读网站业务后端。工具白名单不能限制 search_papers 的来源参数；仅 arXiv 的约束由项目 AGENTS.md 和每次调用的 sources 参数落实。服务可在其他项目出现，本项目的来源规则仅适用于本项目。

### 5. 验证与版本记录

```bash
cd /Users/lyll/.agents/skills/nature-academic-search/mcp-server
/Users/lyll/Applications/anaconda/anaconda3/envs/nature-search/bin/python -c 'import academic_search_server; print("server import OK")'
codex mcp list
```

新开 knowledge_db 对话；若未发现新技能或服务则重启 Codex。发送：

```text
使用 $nature-academic-search，遵循项目 AGENTS.md，仅检索 arXiv 中关于 retrieval augmented generation 的 5 篇论文。调用 search_papers 时显式传入 sources=["arxiv"]，报告实际查询来源、查询词、标题、作者、arXiv 链接和中文摘要。仅在对话中返回，不入库。
```

实际调用参数必须包含 `sources=["arxiv"]`，响应的 sources_queried 应仅有 arxiv，且无来源错误。失败时报告具体错误，不回退其他来源；备用 academic_search.py 查询 OpenAlex，不可用于本项目检索。

验证后补记安装状态、安装记录中的指纹、验证日期和结果。npx 的安装记录应保留；指纹不能替代可复现安装所需的明确上游 commit。可将实际依赖版本保存到本机：

```bash
/Users/lyll/Applications/anaconda/anaconda3/envs/nature-search/bin/python -m pip freeze > /Users/lyll/nature-academic-search-requirements.lock.txt
```

不配置自动更新。更新前保留安装记录、确认明确上游版本并审阅差异；更新后重新检查依赖、仅 arXiv 参数和实际查询结果，再更新本文状态。

安装方式参考 [上游安装说明](https://github.com/Yuan1z0825/nature-skills#5-安装)、[Codex 技能文档](https://learn.chatgpt.com/docs/build-skills) 与 [MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。
