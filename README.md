# hczl · 技术笔记

记录大模型推理、KV Cache、存储与远程开发中的学习和实验。

**[访问博客](https://hczl.github.io) · [写作指南](WRITING.md)**

## 正在研究

- vLLM 的 KV Cache 管理
- KV 卸载与存储访问
- CUDA / 昇腾开发

## 网站结构

- `_posts/`：正式文章，每篇一个 Markdown 文件。
- `_layouts/`：页面与文章模板。
- `assets/`：样式、脚本和图片。
- `_config.yml`：站点名称、简介与发布配置。
- `templates/post.md`：空白文章模板，不会发布到网站。

使用 GitHub Pages 原生 Jekyll 构建，无需额外服务器。发布源保持 `main` 分支的根目录。没有外部字体、追踪脚本或评论服务。
