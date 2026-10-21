# 多仓库与发布边界

日期：2026-10-20。状态：基础骨架与本地 Git 仓库已建立；尚未创建远程仓库或注册实际子模块。

## 1. 参考仓库的已验证结构

已读取 [站点主仓库](https://github.com/chengwei920412/chengwei920412.github.io) 默认 master 分支，检查时 HEAD 为 `4edfb253da930461802961595057868e98589b16`：

- [.gitmodules](https://github.com/chengwei920412/chengwei920412.github.io/blob/4edfb253da930461802961595057868e98589b16/.gitmodules) 将 `docs` 注册为 Git submodule，指向独立的 `chengwei920412/docs` 仓库。主库保存子库 commit 引用，而非正文源文件。
- [发布工作流](https://github.com/chengwei920412/chengwei920412.github.io/blob/4edfb253da930461802961595057868e98589b16/.github/workflows/deploy.yml) 使用 `SUBMODULE_SSH_KEY` 拉取子模块，在构建后上传 `docs/site` 并部署到 GitHub Pages。
- [构建脚本](https://github.com/chengwei920412/chengwei920412.github.io/blob/4edfb253da930461802961595057868e98589b16/scripts/mkdocs.sh) 在 docs 子库目录运行 MkDocs。

当前连接读取独立 docs 仓库返回 404，只能确认当前不可访问，不能据此断言其可见性或内部实现。公开主库中未发现独立评论子模块；评论拆库是本项目新增的设计。

## 2. 本项目采用三个仓库

| 仓库 | 可见性 | 保存内容 |
| --- | --- | --- |
| site 主仓库 | 可公开，或按需私有 | Pages 阅读器、主题、GitHub 适配器、构建脚本、skills、设计文档、子模块版本引用 |
| docs 正文仓库 | 私有 | 翻译、解读、笔记、专题、元数据、私有 catalog/搜索索引、附件、正文快照 |
| comments 评论仓库 | 私有 | 按年/月/日/文档分片的评论操作、编辑与关联历史 |

此处“第三方库”按独立 Git 子仓库理解，由用户自己管理；与 `skills/third-party/` 中的第三方技能不同。

```text
site/
  docs/                         # 当前项目的设计文档，保持不动
  site/                         # 公开阅读器、GitHub 适配器与主题
  sources/
    docs/                       # 私有 Git submodule
      content/papers/
      content/notes/
      content/topics/
      content/inbox/
      catalog/                  # 私有文档目录、分页搜索索引
      revisions/
    comments/                   # 私有 Git submodule
      annotations/2026/10/20/<documentId>/part-000001.json
  skills/local/
  skills/third-party/
  scripts/
  local-data/                   # 完全忽略：原始论文、原始翻译及中间文件
  .github/workflows/
  release-manifest.json
```

其他文档和技能里的 content/、catalog/、revisions/ 相对于 docs 子库，annotations/ 相对于 comments 子库。实现时将 DOCS_ROOT/COMMENTS_ROOT 作为显式配置，避免把私有数据误写入站点主库。

CI 拉取凭据与浏览器个人连接令牌分开配置；CI 只读两个数据仓库，浏览器共享 PAT 对 docs 和 comments 分别授权 Contents 读写。更新翻译的 Agent 在 docs 库提交，不能因此获得修改评论的职责。参考仓库具体实现可借鉴结构；未确认许可证前不直接复制其脚本或主题资源。

## 3. Pages 的公开产物边界

Pages 仅发布通用程序、主题、图标、连接配置和版本 SHA；不在构建时预渲染私人正文，不发布私人标题目录、摘要、搜索索引、附件、快照或评论 JSON。入口密码可作为参考站式的界面门槛，但不能用于获得私库数据。

正文、目录、索引、附件与在线笔记在用户填写共享 PAT 后通过 GitHub API 读取或写入；同一 PAT 还用于 comments 私库。令牌须对 docs 与 comments 两库分别授予 Contents 读写权限。没有私库授权的人可以访问程序，但不能获取私人数据。浏览器已经登录 github.com 不等于 REST API 已获授权。细节见 [浏览器直连 GitHub](browser-github-access.md)。

这样将 GitHub Pages 作为确定的托管方案，不再保留第三方业务后端作为默认路径。公开主库仍可能暴露子库名称、地址、版本 SHA 与代码；不承诺隐藏这些元信息。已经读取的数据可被获授权者自行保存，退出只清理程序管理的内存。

## 4. 固定版本与跨库一致性

子模块固定 commit，不在构建中无记录地拉取分支最新版本。一次发布的公开清单包含 docsCommit、commentsCommit、站点版本和构建时间，不含私人标题或摘要。正文快照与 catalog 在 docs 库内，和正文一起提交；catalog 包含概述/翻译/笔记入口映射及全文段落索引，展示约定见 [论文展示与检索规范](paper-reading.md)；评论按 documentId/contentRevision 关联。

初次读取以公开清单的版本对为准；连接评论库后允许主动刷新到 comments HEAD，界面单独标明最新评论版本。讨论聚合、幂等和并发检查针对选定 comments HEAD；正文目标针对已读取的不可变 docsCommit。缓存和分页 cursor 同时绑定这两个版本，避免混用数据。

两个 Git 仓库不能一次原子提交。正文发布和评论重新链接交错时，保留评论所引用的旧正文版本，针对新正文计算 pending；不删除记录或误认已绑定新版。浏览器已检测到清单更新时提示刷新；提交期间未检测到的变化通过后续解析处理，不宣称存在跨库服务端事务。

## 5. 更新与自动发布

Agent 只在 docs 库提交正文、catalog 和快照；浏览器只在 comments 库提交评论。主库子模块指针不会自动前移，也不会因子库 push 自动触发构建。

数据子库工作流显式通知主库，主库以受控 CI 身份更新经过校验的两个子模块指针与版本清单，再发布阅读器程序。提供手动触发入口，通知保持幂等，避免相互触发循环。浏览器令牌无需主库工作流管理权限，CI 的跨库通知凭据独立配置。

CI 可读取私库做链接、段落、操作链与索引一致性校验，但日志、上传的 Pages artifact 和公开缓存中不能包含这些内容。构建公开程序时不将数据子库交给文章静态生成入口；通过测试标记检查最终产物未包含私人数据。

最新评论写入后通过 GitHub API 刷新即可显示，不依赖 Pages 重建；公开清单更新是可重现的发布记录，不是评论保存成功条件。界面区分已保存到 Git 与发布清单已更新。

备份保存三个仓库和发布清单；恢复时检出指定版本，校验文档/评论 ID、数量、原引用及链接历史。只保存主库的子模块指针不能替代两个数据仓库的备份。
