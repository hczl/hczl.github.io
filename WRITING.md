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

### 存放位置

每篇文章的图片放在 `assets/images/英文短名/` 下，目录名与文章短名一致，例如 `assets/images/ai-coding-tools/`。文件名用小写英文、数字和连字符，按出现顺序加编号：`01-overview.svg`、`02-nvme-bandwidth.png`。

格式选择：

- 结构图、流程图优先用 SVG，放大不糊，体积小。
- 截图、终端输出、性能曲线用 PNG。
- 照片类用 JPG 或 WebP。

单张图尽量控制在 500 KB 以内，宽度不超过 2000 px。截图发布前检查有没有主机名、内网 IP、用户名、密钥或公司内部信息，必要时打码后再放进来。

### AI 配图

示意图可以用 AI 生成，风格统一为 Excalidraw 手绘白板风。提示词模板和注意事项见 `templates/image-prompt.md`。生成的图先存在仓库外，选定后再压缩、改名放进 `assets/images/英文短名/`。

### 正文写法

普通图片直接用 Markdown，图片会自适应正文宽度并居中：

```markdown
![vLLM 调度器把 KV block 换出到 CPU 内存的流程](/assets/images/英文短名/01-swap-out.svg)
```

需要图注或限制宽度时用 `figure`：

```liquid
{% include figure.html src="/assets/images/英文短名/02-nvme-bandwidth.png" alt="四块 NVMe 盘并发读的带宽曲线" caption="图 2：fio 顺序读，块大小 1 MiB" width="70%" %}
```

- `alt` 必填，写图里画了什么，图片加载失败或读屏时会显示。
- `caption` 可省略，支持行内 Markdown（链接、`代码`）。
- `width` 可省略，竖图、窄截图可设为 `60%` 之类，避免撑满正文后过大；手机上不生效，图片按屏宽自适应。
- 带 `figure` 的图可点击查看原图。

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
git add _posts/YYYY-MM-DD-英文短名.md assets/images/英文短名/   # 没有图片时去掉后半
git commit -m "发布文章：标题"
git push
```

推送后在仓库的 Actions 页面确认 Pages 构建成功，再打开线上文章页核对。

发布前检查正文、图片、日志、代码中是否含密钥、内部地址或不宜公开的信息。`templates/post.md` 是空白模板，不会出现在网站中。

不要上传 `_site/`、`vendor/` 或本机依赖。Pages 保持 `main` 分支、`/ (root)` 发布即可。
