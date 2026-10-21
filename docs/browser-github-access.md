# 浏览器直连 GitHub：访问与保存

日期：2026-10-20。状态：正文只读接入已实现；评论首评读写适配器已加入，首评创建已通过用户真实私库测试，并发场景仍待实测。这是第一版唯一的线上访问方案：GitHub Pages 发布程序，浏览器以用户自己的 GitHub 凭据访问私有正文和评论仓库。不部署额外业务后端，不要求自备服务器。

## 1. 内容在何处

| 位置 | 内容 | 无数据仓库权限的访问者可得到什么 |
| --- | --- | --- |
| GitHub Pages | 页面外壳、主题、公开程序、字体、通用图标、仓库连接配置、版本清单 | 能打开程序与连接界面 |
| 私有 docs 仓库 | Markdown 正文、文档目录、标签、搜索索引、附件、正文快照 | 不能通过 GitHub API 读取这些源文件 |
| 私有 comments 仓库 | 年/月/日分片的评论与关联历史 | 不能通过 GitHub API 读取或写入 |
| 已授权浏览器内存 | 本次读取的正文、索引、附件、评论和令牌 | 只在当前阅读会话使用 |

Pages 发布目录采用公开文件白名单，不能包含私人正文、标题目录、文章路由列表、摘要、全文索引、附件或评论。公开程序中的路由只描述阅读器，不嵌入具体文章内容。documentId、仓库地址与版本 SHA 可用于定位，不保证隐藏仓库名称或流量元信息。

VitePress 用于公开外壳、导航框架与主题；私人内容不进入其静态文章构建或客户端预加载包。阅读器从私库获取 Markdown，用受控渲染器生成正文和稳定段落标识。搜索索引也从私库读取，在浏览器中检索。页面遵循 [论文展示与检索规范](paper-reading.md)：左侧列表、右侧默认概述；中文翻译链接通过 documentId 加载并渲染 translation.md，保持段落评论。

## 2. 密码入口与真正授权

可参考站点保留密码输入界面，作为防误开页面的可选入口门槛。它不提供私库访问权限，不能替代 GitHub 凭据；不再描述为服务端登录或私人数据的保护依据。

真正的数据访问通过 fine-grained personal access token（PAT）完成。第一版是个人工具，选择手动填写令牌，不把“当前浏览器已登录 github.com”误当成 API 已授权，也不实现需要机密凭据交换的 OAuth 服务。

进入阅读器时填写一次 PAT。该 PAT 需在 fine-grained token 中同时选择 `KnowledgeDB-docs` 与 `KnowledgeDB-comments`，并为两个仓库都授予 Contents 读写权限：docs 用于正文、索引、快照及在线笔记；comments 用于评论读取、提交与编辑。评论仓库和分支来自公开连接配置，阅读器连接 docs 后会自动尝试连接 comments。评论权限失败只影响评论区，可在评论区重试，不影响正文阅读。

令牌权限按目标 GitHub REST 端点再核对；不申请工作流管理、账户管理或其他仓库权限。正文已连接但评论未连接时可以阅读，评论区提示连接评论库。评论写权限不足时保留输入，不假装保存成功。GitHub 的仓库权限才是最终授权，页面中的 owner 标记不构成权限控制。

同一个 PAT 只保存在当前标签页内存，不能写进源码、页面 URL、Git commit、日志、localStorage、sessionStorage 或 IndexedDB。刷新/关闭或断开后需要重新填写；第一版明确接受此体验取舍。不在聊天中索要令牌，凭据在实际站点的连接界面填写。

请求只将对应令牌放入 `https://api.github.com` 的 Authorization 头，不转发到附件地址或第三方域名。退出清理令牌、正文、索引、评论与附件 Blob URL。按用户本次要求新增的浏览器派生 HTML 缓存是持久存储的有限例外，授权门槛、版本键及清理规则见 [阅读器功能说明](reader-features.md)。读取私库的 fetch 使用 no-store，不启用无需授权即可阅读私人内容的离线入口或 Service Worker；不能承诺清除用户已自行下载的内容。

## 3. 读取与本地索引

读取固定 docsCommit 中的私有文档目录与分页索引。正文库中的 `catalog/` 是由入库脚本生成的派生数据，与正文和快照一同提交，保持版本一致；可从正文重建。它包含标题、标签、论文文档映射和正文分片索引，不复制到 Pages。论文列表默认加载 analysis.md 概述；检索覆盖概述、翻译、笔记与专题正文，结果携带文档、章节、段落和版本，打开实际命中文档。

评论通过固定 commentsCommit 聚合，支持用户主动刷新到 comments HEAD。界面区分“发布清单中的版本”和“已从 GitHub 读取的最新版本”，不把两者混成一个快照。分页 cursor 绑定 docsCommit/commentsCommit，版本变化时重置分页。

附件通过已认证的私库内容/blob API 读取，再转换为内存 Blob URL。不可把私有下载地址或 API 令牌拼进公开 img/src；对超出所选 API 大小限制的附件给出明确下载入口或限制提示，不默认转存为公共附件。原始 PDF 仍默认留本地。

对文档与评论内容限制可执行 HTML、脚本和外部嵌入。运行时依赖固定版本、自托管到 Pages，不让第三方远程脚本与评论正文获得令牌。错误诊断输出状态和请求 ID，不输出 Authorization 或私人正文。

## 4. 评论写入

浏览器内的 GitHub 适配器负责：

1. 读取 comments HEAD，聚合目标讨论、已有 requestId 和当天最后分片。
2. 根据已读取的 docsCommit/contentRevision 校验段落目标；客户端可检测到新版发布时要求刷新。
3. 检查讨论修订、请求摘要、正文长度与分片大小，生成一条操作记录。
4. 使用 GitHub Git 对象 API 创建 blob/tree/commit，以当前 comments HEAD 为父提交，非强制更新分支。
5. 更新成功后才显示“已保存到 Git”，返回 commit SHA；失败保留草稿并最多重读重试三次。

GitHub 校验令牌和仓库写权限；浏览器适配器校验业务结构。单用户第一版不将客户端校验视为不可绕过的服务端规则。CI 重放评论操作并校验修订链；若用户绕过阅读器手动提交损坏数据，阻止发布、报告问题，不能自动删除历史记录。

并发与幂等以私库中的操作记录为依据，不依赖本地缓存。分支保护拒绝直接提交时显示明确原因；不能强制推送或自动放宽仓库规则，部署前需选定允许个人工具提交的目标分支。

## 5. 时间与发布

日期按 `Asia/Shanghai` 计算。无自建业务服务端，第一次写入时用浏览器生成的 UTC 时间作为操作时间；跨冲突重试复用该时间、requestId 和日期。Git commit 时间用于事后核对，不宣称具有不可篡改的服务端时间。

comment.add、comment.edit、binding.set 都在 comments 私库产生独立 commit。浏览器直接刷新私库即可读到最新记录，无须等 Pages 重建。跨库通知推动主库更新两个子模块指针与公开版本清单；只发布程序和版本信息。

## 6. 验收要求

- 无令牌或无私库权限时，Pages HTML、程序包、源码映射、路由与搜索文件中找不到测试正文、标题、评论或附件。
- 一次输入的 PAT 对 docs 与 comments 分别发送到对应 GitHub 仓库；comments 权限失败时 docs 阅读仍可用。
- 真实跨域读取、创建 commit、分支冲突和授权撤销都完成浏览器验证；不把本地模拟当作已经打通 GitHub。
- 令牌过期、限流、网络失败、分支规则拒绝时保留草稿，显示可操作的错误。
- 退出后清理当前内存；检查持久存储、URL、日志与构建产物没有令牌。
- 私库内容不预渲染到 Pages；两栏概述阅读、翻译链接渲染、正文搜索定位、图片和评论高亮在授权读取后正常显示。

## 7. 技术依据

以下官方资料于 2026-10-20 查阅：

- [GitHub REST API CORS](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests)：浏览器可以跨域请求，包括 Authorization 头及写入方法。
- [GitHub REST API 认证](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api)：个人访问令牌与端点权限。
- [GitHub Git 对象 API](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database)：通过 blob、tree、commit 和分支引用保存变更。

这是产品方案，不代表已实现或完成安全验证；上述验收属于第一版发布前的实际工作。
