# 数据仓库

sources/docs 是私有 `frankkygit/KnowledgeDB-docs` 的正式 Git 子模块；主库只保存 commit 引用。通过 `git submodule update --init sources/docs` 使用本机 GitHub SSH 权限检出。sources/comments 仍是本地预留目录。

公开 Pages 不检出或打包正文。网页使用用户填写的只读令牌读取固定版本；SSH 只负责本机推送，不给网页提供授权。原论文和原始翻译工作成果继续放在被忽略的 local-data 中。
