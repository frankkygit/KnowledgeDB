# 本地目录与手动论文处理

原始资料统一放在项目根目录 `local-data/`。整个目录由根 `.gitignore` 排除，里面不放需要提交的配置、技能或正式知识条目。首次运行 `npm run setup:local` 创建空目录；新克隆不会带回这些本地文件。

```text
local-data/
  papers/<paper-id>/<source-version>/
    original.pdf                   # 下载的原论文及其他源文件
  translations/<paper-id>/<run-id>/
    paper.md                       # 翻译技能的原始输出
    source_map.json                # 有则保留
    translation_notes.md           # 有则保留
    assets/                        # 翻译生成的图表等资源
  work/                            # OCR、解析及其他中间文件
```

当前机器对应的根目录为 `/Users/lyll/code/knowledge_db/local-data/`。约定以仓库相对路径为准；不要把机器绝对路径写进正式论文元数据。source-version 与 run-id 使用安全目录名，未确认精确论文版本时不能随意填成某个 arXiv vN。

用户手动触发检索、下载和翻译：检索默认只在对话展示候选；用户要求下载后保存至 papers，要求翻译后保存至 translations。只执行用户指定的论文和范围，不在启动脚本、构建脚本或 CI 中自动搜索、下载或翻译。不得覆盖已有原文件或历史翻译运行目录。

原始翻译不等于正式 translation.md。只有用户要求入库时，才使用项目本地技能将已审阅内容适配到独立的私有 docs 数据根目录，生成正文、稳定 ID、快照和 catalog。私有仓库未配置时停止正式入库并说明缺项，原始成果仍留在 local-data，不能把私人正文写进公开 site 或根 docs 目录。

`sources/docs/` 与 `sources/comments/` 目前仅预留本地目录，并整体忽略，尚未注册真实 Git 子模块。将来提供真实私库地址并挂载时，应先按 `docs/repository-layout.md` 配置和核对现有文件，再有意识地注册子模块；不要使用 git add -f 批量添加私人内容。

目录存在不等于私库已配置。正式入库前需确认数据根目录是对应独立仓库的真实 Git 根目录；不能因 Git 向上找到主库的 `.git` 就将本地占位目录当作独立私库。

`.gitignore` 防止普通新增文件被跟踪，不会自动取消已跟踪文件，也不等于备份。原始 PDF 和翻译的本地备份由用户独立管理。
