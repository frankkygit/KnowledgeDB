# 参考站点与密码方案

参考：[chengwei 的 GitHub Pages](https://chengwei920412.github.io/index.html)。检查日期：2026-10-20。

用户希望借鉴该站设计，并明确不购买或维护服务器。下面基于公开首页 HTML、内联脚本及公开主仓库的检查，不包含输入密码或解锁受限页面。主库 docs 子模块和发布流程的核实记录，以及本项目正文/评论双私库方案，见 [多仓库与发布边界](repository-layout.md)。

## 可借鉴的阅读结构

首页生成器元信息为 MkDocs + mkdocs-gitbook，包含 GitBook 风格的分类导航与正文容器，链接分为论文阅读和知识笔记；引用了 Pagefind 搜索组件、主题脚本和 MathJax。

本项目可采用相近的信息结构，无需因此更换已选择的 VitePress：

- 左侧按论文、知识笔记和专题组织目录；目录过多时按主题或年份收起。
- 点击论文默认先读技术概述；原文信息、中文翻译和我的笔记通过入口关联，不重复铺开全文翻译。
- 提供全文搜索与公式显示；首页显示最近更新和分类入口。
- 正文增加段落评论入口与引用高亮，页底显示本文讨论和待重新链接项。

补充检查了一篇公开可读取的 [NavGPT-3 技术报告页](https://chengwei920412.github.io/paper_reading/2610.10787_NavGPT-3_Harnessing_Context_in_a_Hierarchical_Navigation_Runtime/technical_report.html)，确认其按概览、研究背景、方法、实验、见解和局限等章节组织。检查未输入密码或解锁页面；不据此认定参考站具备本项目要求的段落评论功能。

本项目明确采用左侧列表、右侧内容；论文默认展示 analysis.md 技术概述，translation.md 作为应用内链接渲染，支持正文检索与命中位置跳转。完整定义见 [论文展示与检索规范](paper-reading.md)。

## 密码校验检查结果

首页内联脚本包含一个明文密码常量，提交表单后在浏览器中比较输入；不记录或复制该密码值。验证结果写入 sessionStorage，再切换页面根节点的 `password-locked` 样式类来控制显示。

脚本通过页面的 `data-password-protected` 属性决定是否启用门槛；此次下载的首页该属性为 false。因此不能仅凭页面中存在密码表单就推断首页实际受限，更不能推断全站内容均已加密。

这一脚本自身没有正文解密或服务器认证逻辑。它可提供密码框和当前浏览器会话内的解锁体验，但不能提供对已公开下发内容的保密保证。未审查每个子页，不对所有附件、索引或其他页面是否另有保护作推断。

## 本项目采用的方式

本项目参考它的阅读布局、子模块组织和 Pages 发布方式；数据加载方式进一步调整为浏览器授权后直连私库，避免把私有内容生成到公开页面。

| 职责 | 当前统一方案 |
| --- | --- |
| 页面展示 | GitHub Pages 上的通用阅读器与主题 |
| 密码入口 | 可选前端门槛，不提供数据权限 |
| 正文、目录、搜索和附件 | 浏览器使用共享 PAT 从私库加载 |
| 评论展示和提交 | 浏览器复用共享 PAT 调用配置中的 comments 私库 GitHub API |
| 公开构建产物 | 只有程序、通用资源和版本清单，没有私人正文和索引 |

不把参考站的明文密码判断当成正文保密机制，也不继续采用先把正文公开发布、再用密码框遮住的方案。实际授权由 GitHub 私有仓库权限承担；令牌只在标签页内存使用，刷新后需重新连接。完整契约见 [浏览器直连 GitHub](browser-github-access.md)。

GitHub Pages 本身是静态托管，不承担自建业务登录或评论接口；这里直接使用 [GitHub REST 的跨域支持](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests) 和 [令牌认证](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api)。无需自备服务器或额外业务托管账户。
