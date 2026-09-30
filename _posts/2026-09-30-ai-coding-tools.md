---
title: "用过的 AI 编程工具：体感、安装与使用方式"
description: "Claude Code、Cursor、Codex、zcode、OpenCode 和 Gemini 在实际开发中的表现、订阅档位、价格和安装方法。"
date: 2026-09-30 12:00:00 +0800
tags: [AI 工具, Claude Code, Cursor, Codex]
---

过去一段时间，我先后用 Claude Code、Cursor、Codex、zcode 和 OpenCode 做过开发，也用它们写过文档；模型方面用过 Claude、GPT、GLM、DeepSeek、Grok 和 Gemini。下面按工具记下我用下来的感受，以及安装方法和常用链接。工具和模型更新很快，文中的版本、价格和额度都以 2026 年 9 月 30 日为准。

## 我用过的工具和套餐

| 工具               | 订阅                           | 主要使用的模型                    |
| ---------------- | ---------------------------- | -------------------------- |
| Claude Code（桌面端） | Claude Pro                   | Claude Opus 5.5            |
| Codex（桌面端）       | ChatGPT Pro 200（原 Pro 20x）   | GPT-6 Astra、GPT-6.1 Sol    |
| Cursor           | Ultra                        | Auto、Composer 2.5、Grok     |
| zcode            | GLM Coding Plan Max          | GLM，截至 GLM-5.3             |
| OpenCode         | DeepSeek API、GLM Coding Plan | DeepSeek V4.1 Flash、GLM    |
| Gemini           | Google AI Pro，单月订阅           | Gemini 3 Pro、3.1 Pro、Flash |

## Claude Code

Claude Code 是 Anthropic 的编程 Agent，能直接读写本地项目的代码并执行命令，有命令行、桌面端和 IDE 插件几种用法。我用的是 Claude 桌面应用里的 Code 标签页，不用开终端，改动可以在 diff 视图里逐个文件查看。我开的是 Claude Pro，模型一直用 Opus 5.5。想用 Claude Code 至少得订 Pro，免费账号用不了。

在我用过的工具里，Claude Code 的体验最好，Opus 5.5 的智力和写代码的能力也是这几家里最强的。麻烦在于账号一直有被封的风险，原因这里不展开。如果愿意为了模型性能折腾一下，Claude Code 值得用。

### 安装

桌面端不需要装 Node.js 或命令行工具，Claude Code 已经包含在桌面应用里：

1. 从官方文档的桌面端页面下载安装包（macOS 为 Intel 和 Apple Silicon 通用版，Windows 有 x64 和 ARM64 两个版本，Linux 目前是 beta，用 apt 或 deb 安装），安装后用 Claude 账号登录。
2. 点顶部中间的 Code 标签页。如果提示升级，说明账号还不是付费套餐。
3. 选择 Local，点 Select folder 选中项目目录。也可以选 Cloud 在云端运行，关掉应用后任务继续；Windows 上还可以选 WSL。
4. 在发送按钮旁的下拉框里选择模型，在权限模式里选择 Manual（每次修改前询问）、Accept edits（自动接受文件修改）、Plan（只出方案不改文件）或 Auto。
5. 输入任务。第一次在项目里用，可以先让它生成一份 CLAUDE.md，写清楚项目约束。

如果也想在终端里用，命令行版单独安装。macOS、Linux 和 WSL：

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://claude.ai/install.ps1 | iex
```

装好后在项目目录运行 `claude`，第一次启动会打开浏览器登录；安装有问题时运行 `claude doctor` 检查。

### 常用链接

- 官方文档：<https://code.claude.com/docs>
- 桌面端入门：<https://code.claude.com/docs/en/desktop-quickstart>
- 命令行版安装：<https://code.claude.com/docs/en/setup>
- API 价格：<https://platform.claude.com/docs/en/about-claude/pricing>

## Codex 与 GPT

Codex 是 OpenAI 的编程 Agent，有命令行、IDE 插件、桌面应用和网页几种用法，用 ChatGPT 账号登录，额度算在 ChatGPT 的订阅里。我用的是桌面端，订阅是 Pro 200，也就是原来的 Pro 20x；模型用 GPT-6 Astra 和 9 月 29 日刚发布的 GPT-6.1 Sol。

GPT 和 Claude 一直在竞争，按我的使用感受，GPT 始终略逊一筹。它比 Claude 强的地方是额度：在 OpenAI 做 Codex 的 Tibo（Thibault Sottiaux，X 账号 @thsottiaux）经常在推特上宣布给所有付费用户重置用量，能用的量比 Claude 多得多。但它时常出现降智，所以有了经典的鹈鹕测试（最早是 Simon Willison 拿来横向比较各家模型的）：如果你觉得它降智了，是时候输入“用 HTML 画一张鹈鹕骑自行车的 SVG”了。

9 月 29 日的 DevDay 上，OpenAI 宣布 Pro 200 的 Codex 额度从 20x 降到 10x，10 月 30 日生效，同时推出了每月 500 美元的 Pro 500。额度减半以后，我打算根据 GPT 当时降智的程度，决定后面是用 GPT 还是 Claude。

### 安装

原来单独的 Codex 桌面应用现在已经并入新版 ChatGPT 桌面应用，支持 macOS 和 Windows。已经装了 Codex 应用的，照常更新就会变成新版 ChatGPT 应用，原来的 Codex 对话和项目会保留。

1. 从 <https://chatgpt.com/features/desktop/> 下载对应系统的安装包并安装。
2. 打开后用 ChatGPT 账号登录。
3. 在左上角的菜单里切换到 Codex。Codex 是独立的视图，历史记录和 ChatGPT 的对话分开。
4. 打开项目文件夹，输入任务。

也想在终端里用的话，命令行版单独安装：

```bash
npm install -g @openai/codex
```

在项目目录运行 `codex`，选择 Sign in with ChatGPT 登录，用 `/model` 切换模型和推理强度。

### 常用链接

- 桌面应用说明：<https://learn.chatgpt.com/docs/app>
- 迁移到新版 ChatGPT 桌面应用：<https://help.openai.com/en/articles/20001276-moving-to-the-new-chatgpt-desktop-app>
- Codex CLI 文档：<https://learn.chatgpt.com/docs/codex/cli>
- 源码：<https://github.com/openai/codex>
- ChatGPT Pro 各档说明：<https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers>
- Tibo 的 X 账号（额度重置消息一般先在这里发）：<https://x.com/thsottiaux>

## Cursor

Cursor 是在 VS Code 基础上改出来的编辑器，界面、快捷键和插件与 VS Code 基本一致。从原来手写代码转到 Agent 编程，Cursor 是我用过过渡最顺的，因为编辑器本身还是熟悉的 VS Code。我订的是 Ultra，每月 200 美元。

### 额度规则

Cursor 的付费套餐把用量分成两个池子：

- 第三方模型（Other Models）：Claude、GPT、Gemini 等，按模型的 API 标价从额度里扣。Ultra 每月有 400 美元的额度。
- Cursor 自有模型（Cursor Models）：目前是 Composer 2.5 和 Grok 4.5、4.6、4.7。这几个 Grok 是 Cursor 和 SpaceXAI 联合训练的，Grok 4.7 在 9 月 21 日上线。这个池子的额度比第三方模型多得多，标价也低：Composer 2.5 输入每百万 token 0.5 美元、输出 2.5 美元，Grok 输入 2 美元、输出 6 美元。

Auto 模式由 Cursor 按请求自动选择模型，可能是 Composer、Grok，也可能是第三方模型。从 2026 年 8 月 24 日起，Auto 按实际选中的那个模型的标价计费，不再是原来的统一费率。

Cursor 的价格页和文档只写了“包含用量”，没有公布每个池子的具体金额。

### 我的用法

第三方模型在 Cursor 里按 API 标价扣费，同样是用 Claude 和 GPT，直接订 Claude 和 ChatGPT 的官方套餐要划算得多。所以 Claude 和 GPT 我不经过 Cursor 用，在 Cursor 里主要用 Auto、Composer 2.5 和 Grok。这部分额度我一直用不完，对我来说相当于不限量。Grok 的智力比 DeepSeek 好，拿来做生产开发没有问题。不过我手上有 Claude 和 GPT，所以对 Grok 没怎么关注。

### 安装

1. 从官网下载安装包：<https://cursor.com/download>，macOS、Windows 和 Linux 都有，按系统提示安装。
2. 首次启动时登录 Cursor 账号，可以选择导入 VS Code 的扩展和设置。
3. 在 Agent 面板的模型选择器里选择模型，或者选 Auto 让 Cursor 自动路由。
4. 想用自己的 API Key，在 Settings > Models 中填入。

### 常用链接

- 官方文档：<https://cursor.com/docs>
- 模型与计费：<https://cursor.com/docs/models-and-pricing>
- Grok 4.7：<https://cursor.com/grok>

## zcode 与 GLM

zcode 是智谱官方的编程客户端，GLM 模型原本在开源模型榜单上处于领先位置，但客户端和模型的使用情况一直不温不火。

2026 年 9 月，企业用户太原承明科技向智谱发函，称 zcode 存在自动触发、批量上传数据的行为：它的 Repo Wiki（代码库检索）功能会把项目上传到服务器建立索引，上传内容包括完整源代码、版本控制历史、数据库口令和云服务凭证等，超出了隐私政策载明的收集范围；承明科技还称 zcode 的部分网络请求指向新加坡主体，要求智谱说明数据存储地点和是否跨境传输。智谱随后致歉，移除了 Repo Wiki 功能，请第三方机构做了审计，并把 zcode 开源到 GitHub。不过开源出来的仓库只有两个提交，开发历史和负责上传的那部分代码都不在里面，我去看的时候仓库也没有开放 issue。

这件事之后，zcode 的使用情况急转直下。除此之外，它的响应速度极慢，性价比也不高。至少截至 GLM-5.3，我完全不推荐使用。

### 安装

zcode 是桌面应用，支持 macOS、Windows 和 Linux，安装包在官方文档的安装页下载。macOS 把 ZCode.app 拖进“应用程序”；Windows 运行安装向导；Linux 可以用 AppImage、deb 或 rpm，AppImage 需要先加执行权限：

```bash
chmod +x ZCode-*.AppImage
./ZCode-*.AppImage
```

启动后按引导选择项目目录，点左下角 Connect，用 Z.ai 账号、BigModel 账号或 API Key 登录。

### 常用链接

- 安装文档：<https://zcode.z.ai/en/docs/install>
- 开源仓库：<https://github.com/zai-org/ZCode>
- GLM Coding Plan：<https://bigmodel.cn/glm-coding>

## OpenCode 与 DeepSeek

OpenCode 我接的是 DeepSeek 和 GLM Coding Plan 的 API，这里主要说 DeepSeek。

DeepSeek V4.1 Flash 是我用过最便宜的模型。到了 2026 年，还能用到这样低价又能投入生产的模型，是我没有想到的。它的能力不如最顶级的模型，但价格只有顶级模型的几十分之一：按官网价格，输出每百万 token 0.6 美元（高峰时段 1.2 美元），Claude Opus 5.5 是 20 美元，GPT-6 Astra 是 50 美元，完整对比见文末的价格表。我把 DeepSeek 看作模型的“斩杀线”：其他模型要卖得比它贵，就得在能力上拉开足够大的差距。

速度也是它的长处。我在 DeepSeek Harness（DeepSeek 官方 8 月开源的 Agent 工具）里看到的输出速度在 200 tokens/s 左右；第三方评测 Artificial Analysis 测得 DeepSeek 官方 API 上的输出速度是 213.4 tokens/s，在它统计的 116 个模型里排第 4。

配合 DeepSeek Harness 使用，表现相当不错。不过模型能力偏弱，对使用者也有要求：需要写大量的约束和指导，它才能把活干好。

### 安装 OpenCode

```bash
curl -fsSL https://opencode.ai/install | bash
# 或者
npm install -g opencode-ai
# macOS / Linux 也可以用 Homebrew
brew install anomalyco/tap/opencode
```

Windows 可以用 npm，也可以 `choco install opencode` 或 `scoop install opencode`。DeepSeek 官方建议把 OpenCode 升级到 1.18.30 及以上，避免兼容问题。

进入项目目录运行 `opencode`，然后：

1. 接 DeepSeek：输入 `/connect`，搜索 deepseek 并选中，粘贴在 DeepSeek 开放平台创建的 API Key。
2. 接 GLM Coding Plan：输入 `/connect`，选择 Zhipu AI Coding Plan（海外 z.ai 账号选 Z.AI 下的 Coding Plan），粘贴智谱开放平台的 API Key。Coding Plan 要用专用端点 `https://open.bigmodel.cn/api/coding/paas/v4`，不要用通用 API 端点。
3. 输入 `/models` 选择模型。
4. 第一次在项目里使用时可以运行 `/init`，OpenCode 会分析项目并在根目录生成 `AGENTS.md`。DeepSeek 需要大量约束和指导，这个文件就是写这些规则的地方。

### 安装 DeepSeek Harness

DeepSeek Harness 需要 Node.js，在项目目录运行：

```bash
npx @deepseek-ai/dsh web
```

浏览器会打开 `http://127.0.0.1:3080` 的 Web 界面，端口被占用时加 `--port 3081`。在设置的模型页面里填入 DeepSeek API Key，再选择工作目录，就可以开始用了。

### 常用链接

- OpenCode 文档：<https://opencode.ai/docs/>
- OpenCode 接入 DeepSeek（DeepSeek 官方文档）：<https://api-docs.deepseek.com/quick_start/agent_integrations/opencode/>
- DeepSeek Harness：<https://github.com/deepseek-ai/deepseek-harness>
- DeepSeek API Key：<https://platform.deepseek.com/api_keys>
- DeepSeek 价格：<https://api-docs.deepseek.com/quick_start/pricing/>
- GLM Coding Plan 快速开始：<https://docs.bigmodel.cn/cn/coding-plan/quick-start>

## Gemini

Gemini 3 Pro 在 2025 年 11 月刚发布的时候让我很惊艳：智商高，写出来的文字人味也很重，拿来写文章几乎挑不出毛病。

我自己单独订过一个月的 Google AI Pro，美国区原价是每月 19.99 美元。Google 目前的学生优惠是免费 12 个月，美国学生领的是 Google AI Pro，其他 140 多个市场的学生领的是 Google AI Plus，需要在 2026 年 12 月 31 日前领取。

但从 3.1 Pro 之后，Google 就一直在更新 Flash：2026 年 5 月的 3.5 Flash、8 月的 3.7 Flash、9 月的 3.8 Flash。Flash 刚出的时候勉强还行，用一段时间以后质量就开始往下掉。所以不是学生党的话，我不推荐把 Gemini 用于生产。

### 使用方式

Gemini 不需要安装，登录 Google 账号后打开 <https://gemini.google.com> 就能用，在 Google One 页面订阅 Google AI Pro。学生优惠要先完成学生身份验证，并绑定支付方式。

### 常用链接

- Gemini 网页版：<https://gemini.google.com>
- 学生优惠说明：<https://blog.google/innovation-and-ai/products/gemini-app/student-offer-google-ai/>

## API 价格参考

以下是 2026 年 9 月 30 日查到的官方 API 价格，单位是每百万 token。订阅套餐的实际成本和 API 价格不是一回事，这张表只用来比较量级。

| 模型                  | 输入              | 缓存命中输入             | 输出             |
| ------------------- | --------------- | ------------------ | -------------- |
| Claude Opus 5.5     | 4 美元            | 0.2 美元             | 20 美元          |
| GPT-6 Astra         | 10 美元           | 1 美元               | 50 美元          |
| GPT-6.1 Sol         | 2 美元            | 0.1 美元             | 10 美元          |
| GLM-5.3             | 8 元             | 2 元                | 28 元           |
| DeepSeek V4.1 Flash | 0.15 美元（高峰 0.3） | 0.003 美元（高峰 0.006） | 0.6 美元（高峰 1.2） |

DeepSeek 的高峰时段是工作日 UTC 01:00–04:00 和 06:00–10:00（北京时间 9:00–12:00、14:00–18:00），其余时间按低谷价计费。Grok 我只在 Cursor 里用过，没有单独用 API，不列入；Cursor 自有模型的标价见上文 Cursor 一节。

## 参考资料

- [企业用户发函质疑ZCode上传数据，智谱致歉称已整改并引入第三方审计](https://m.sohu.com/a/1078901073_121347613)，新黄河，2026-09-21
- [Z.ai apologised, open-sourced ZCode, and wiped the commit history](https://thenextweb.com/news/zai-zcode-open-source-commit-history-security-assessment)，The Next Web，2026-09-22
- [OpenAI halves Pro 200 usage and launches a $500 ChatGPT plan at DevDay](https://daily.dev/posts/openai-halves-pro-200-usage-and-launches-a-500-chatgpt-plan-at-devday-vbxlojybv)，daily.dev，2026-09-29
- [OpenAI releases GPT-6.1 Sol at a fifth of GPT-6 Astra's token prices](https://thenextweb.com/news/openai-gpt-6-1-sol-price-astra-devday)，The Next Web，2026-09-29
- [GPT-6 Astra API 价格](https://openrouter.ai/openai/gpt-6-astra)，OpenRouter
- [Claude 模型价格](https://platform.claude.com/docs/en/about-claude/pricing)
- [智谱 API 定价](https://docs.bigmodel.cn/cn/guide/start/pricing)
- [DeepSeek V4.1 Flash 速度与价格](https://artificialanalysis.ai/models/deepseek-v4-1-flash)，Artificial Analysis
- [Cursor 模型与计费](https://cursor.com/docs/models-and-pricing)
- [Introducing Grok 4.5](https://cursor.com/blog/grok-4-5)，Cursor，2026-07-08
- [Cursor Auto Pricing: What the August 24 Change Actually Costs](https://cellcog.ai/blog/cursor-auto-pricing/)，CellCog
- [Pelican riding a bicycle](https://simonwillison.net/tags/pelican-riding-a-bicycle/)，Simon Willison
- [Gemini 应用各版本发布时间](https://keywordseverywhere.com/news/gemini-updates/gemini-3/)
