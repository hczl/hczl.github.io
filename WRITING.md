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

## 草稿、预览与发布

草稿放在本机仓库的 `_drafts/` 目录。这个目录已写进 `.gitignore`，不会被提交，也就不会出现在公开仓库里。不要用 `published: false` 或推送预览分支的办法藏草稿：仓库是公开的，源文件照样能被看到。

### 起稿

新建 `_drafts/英文短名.md`（文件名不带日期），内容从 `templates/post.md` 复制。短名就是将来的网址 `/notes/英文短名/`，发布后不要改。

在项目里让 Claude 起稿时，线程通过 Remote Control 直接在本机仓库的 `_drafts/` 里写文件，不再经过云端文件夹中转。

### 预览

需要兼容的 Ruby / Bundler，首次运行 `bundle install`。之后：

```sh
bundle exec jekyll serve --drafts --livereload
```

打开 http://127.0.0.1:4000 。草稿会和正式文章一起出现在首页和归档里，保存后页面自动刷新。不加 `--drafts` 就只显示已发布的文章。

修改已发布的文章时，直接改 `_posts/` 里的文件，不要在 `_drafts/` 放一份同名草稿，否则两者网址相同会冲突。

### 发布

预览满意后再发布，以本机文件为准：

```sh
git switch main
git pull
mv _drafts/英文短名.md _posts/YYYY-MM-DD-英文短名.md   # 日期填发布当天
# 把 front matter 里的 date 改成同一天
bundle exec jekyll build                               # 确认能正常构建
git add _posts/YYYY-MM-DD-英文短名.md                   # 有图片时把 assets/images/ 下的新图一并加入
git commit -m "发布文章：标题"
git push
```

推送后在仓库的 Actions 页面确认 Pages 构建成功，再打开线上文章页核对。

发布前检查正文、图片、日志、代码中是否含密钥、内部地址或不宜公开的信息。`templates/post.md` 是空白模板，不会出现在网站中。

不要上传 `_site/`、`vendor/` 或本机依赖。Pages 保持 `main` 分支、`/ (root)` 发布即可。
