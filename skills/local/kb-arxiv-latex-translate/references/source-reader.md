# 源码到 nature-reader 阅读版

## 输入配对

原 PDF 直接从 arXiv 下载，不编译 TeX。核实源码与 PDF 对应同一个精确 vN，必要时检查标题、摘要、图号与版本记录。源包包含多个稿件时按实际引用树和原 PDF 确定入口；无法排除歧义时问用户。

TeX 的注释、宏定义和未引用文件不是默认正文。解析章节、input/include、条件分支和 bibliography，保留来源位置，避免将重复稿件/注释内容翻译进正文。bib/bbl 用于识别原引用，不自行补造缺失条目。不得执行 Makefile、latexmkrc、源包脚本或 TeX 来提取内容。

## 公式

翻译正文默认排除作者列表及 bibliography/thebibliography/printbibliography 输出，不翻译作者姓名或参考文献条目，也不将英文列表作为 Original 块带入阅读版。作者原文只在论文身份元数据按需保留，bib/bbl 留在原件目录供核对正文引文。保留正文引文标记，不扩展文末书目；遇到参考文献章节后继续识别附录，不能直接截断余下整篇论文。用户显式指定包含这些部分时才覆盖此默认范围。

从源码保留 equation/align 等环境的数学内容，转换为 nature-reader 支持的行内 `$...$` 或独立 `$$...$$`。自定义宏、计数器、附录公式号和引用显示以原 PDF 核对；去除 TeX 排版指令时不能丢掉数学含义。不要将未展开的自定义命令裸露给 KaTeX。

按 nature-reader 的 equation-handling 规则生成 E... 锚点与 source_map 条目。PDF 上不能定位的内容不填虚构 bbox/页码；保留 TeX 源位置到 translation-map，并明确 source_map 所需定位未完成。无法核验时使用原 PDF 的公式裁图，不猜字符。

## 图片与表格

将实际引用的原图复制到本次 assets，保留原件；PDF/EPS 图片或多子图拼版不能简单以一张源图替代整幅图。可用工具转为 PNG/SVG，或从原 PDF 裁出完整图/表，保留子图标号。记录源文件、派生文件、图号与 PDF 来源位置，检查每张图均有对应说明和锚点。

图片内嵌英文默认保留；中文解释写在图注/正文。图像转换是派生处理，不覆盖原文件。表格里的数值、误差、星号、单位和合并关系应逐项对照，不为 Markdown 美观简化数据。

## 阅读顺序与输出

原 PDF 用于确定实际阅读顺序及图表首次引用，TeX 用于恢复精确文本；源码位置不等于最终版面位置。Markdown 保留内容对应关系，不承诺原 PDF 的分页/双栏布局。

nature-reader 已有输出契约优先用于 paper.md、source_map.json、translation_notes.md 和 assets，不重复造一套相近 schema。正式入库另按本仓库 data-contract 转换，nature-reader 的块 ID 不自动成为知识库稳定 ID。

## 资料

- [arXiv 版本与元数据](https://info.arxiv.org/help/api/user-manual.html)
- [arXiv TeX 源文件结构](https://info.arxiv.org/help/submit_tex.html)
