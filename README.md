# hczl · 技术笔记

大模型推理中 KV Cache 卸载的学习笔记：GPU / 昇腾 NPU 显存、内存与 SSD 之间的 KV 存取。

**[访问博客](https://hczl.github.io) · [写作指南](WRITING.md)**

## 研究方向

- vLLM 的 KV Cache 管理机制
- KV Cache 向主机内存与 SSD 的分层卸载
- NVIDIA GPU（CUDA）与昇腾 NPU 上的实现与性能测试

## 网站结构

- `_posts/`：正式文章，每篇一个 Markdown 文件。
- `_layouts/`：页面与文章模板。
- `assets/`：样式、脚本和图片。
- `_config.yml`：站点名称、简介与发布配置。
- `templates/post.md`：空白文章模板，不会发布到网站。

使用 GitHub Pages 原生 Jekyll 构建，无需额外服务器。发布源保持 `main` 分支的根目录。没有外部字体、追踪脚本或评论服务。
