# GitHub Pages 上线

当前上线范围：公开阅读器程序。`npm run preview:private` 使用的本地论文接口不会部署到 Pages；阅读器使用用户输入的 GitHub PAT 读取固定版本的私有 docs，并直接读写私有 comments。在线笔记新增、编辑和删除也会直接提交到私有 docs。PAT 需同时获得两库 Contents 读写权限；用户可选择七天本机浏览器存储以便刷新后自动连接。SSH 仅用于本机提交。原文、翻译和评论不会因本次上线变为公开内容。

## 首次设置

1. 在 GitHub 创建站点代码仓库 `KnowledgeDB`，不要添加原文或翻译资料。普通公开 Pages 可使用公开代码仓库，数据仓库继续私有。
2. 将当前项目代码推送到 main。`.gitignore` 排除 local-data、sources/docs、sources/comments、令牌和机器私有配置。
3. 在仓库 Settings → Pages → Build and deployment → Source 选择 GitHub Actions。
4. 在 Actions 中运行 Deploy reader to GitHub Pages。也可在 main 下一次 push 时自动触发。
5. 等待工作流成功，在 github-pages 部署记录打开真实发布地址，确认资源及页面正常。

发布工作流是 `.github/workflows/deploy-pages.yml`，仅上传 `site/.vitepress/dist`。不检出私有子模块，不开启本地私有预览，不需要填写论文仓库访问凭据。Pages 的项目子路径由 configure-pages 输出自动设置，无须将账户名硬编码进配置。

预计地址格式为 `https://<GitHub用户名>.github.io/KnowledgeDB/`；以部署任务返回的 page_url 为准，未成功部署前不将预计地址称为可用站点。

## 本地复现线上版本

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
SITE_BASE=/KnowledgeDB/ npm run build
npm run check:public
npm run preview
```

打开预览服务下的 `/KnowledgeDB/`。这是生产构建，不是本地私有论文预览；未填写有权限的令牌前不会加载正文；连接后才能显示目录、概述、翻译与搜索结果。

产物检查只覆盖禁止导出的目录/文件、本地私有接口和常见令牌格式，不能替代未来完整的数据隔离验证。参考 [VitePress 发布说明](https://vitepress.dev/guide/deploy#github-pages) 和 [GitHub Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

## 更新私有正文

先在 sources/docs 中提交并推送。然后在主库提交 sources/docs 的 gitlink，同时更新 release-manifest.json 和 site/public/reader-config.json 中 docs commit；三个值必须一致。推送主库后 Pages 自动构建，不需要 CI 读取私库或保存个人访问令牌。

第一次创建网页令牌：GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens，同时选择 `KnowledgeDB-docs` 与 `KnowledgeDB-comments`，并为两个仓库都设为 Contents Read and write。用户在阅读器中填写 PAT，可选“记住此浏览器（7 天）”；该选项会将 PAT 明文保存到本机浏览器，不应在共享或不可信设备上启用。也可不勾选，凭据仅在标签页会话范围恢复。令牌由用户手动生成并粘贴到站点，不在聊天中提供。评论仓库 `frankkygit/KnowledgeDB-comments` 与分支 `main` 由 `site/public/reader-config.json` 配置，评论连接失败可在评论区重试，不会阻止 docs 阅读。
