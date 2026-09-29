# 写文章

博客地址：https://hczl.github.io

## 最简单的方式：在 GitHub 网页写

1. 打开博客仓库，点击 **Add file → Create new file**。
2. 文件名填 `_posts/2026-09-29-my-first-note.md`。将日期改为发布当天，后面的英文短名作为文章网址，发布后尽量不改。
3. 复制下面的开头，接着写正文：

```markdown
---
title: "文章标题"
description: "用一句话说明这篇文章解决什么问题。"
date: 2026-09-29 12:00:00 +0800
tags: [vLLM, KV Cache]
---

开头说清楚问题。

## 一个具体例子

正文……

## 验证与边界

哪些是实测，哪些还不确定。
```

4. 预览文字后，提交到 `main`。GitHub Pages 会自动构建，首页、归档、RSS 会自动更新。在 Actions 查看是否成功。

文章标题会自动显示，正文从二级标题 `##` 开始即可。目录根据 `##` 和 `###` 自动生成。

## 图片与代码

图片上传到 `assets/images/`，正文使用 `![图的说明](/assets/images/example.png)`。

代码使用三个反引号包围，并标明语言，例如 `python`、`cpp`、`bash`。文章页会自动高亮并提供复制按钮。

## 草稿

未准备公开的草稿请留在本机。此仓库是公开的：即便使用 `_drafts` 或 `published: false`，源文件仍可被人看到。

发布前检查图片、日志、代码中是否含密钥、内部地址或不宜公开的信息。`templates/post.md` 是空白模板，不会出现在网站中。

## 本地预览（可选）

日常网页写作无需在 Mac 安装这些工具。如已有兼容的 Ruby / Bundler：

```sh
bundle install
bundle exec jekyll serve
```

打开 http://127.0.0.1:4000 。正式构建：`bundle exec jekyll build`。

不要上传 `_site/`、`vendor/` 或本机依赖。Pages 保持 `main` 分支、`/ (root)` 发布即可。
