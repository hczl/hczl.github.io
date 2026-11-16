---
title: "vLLM 入门（十一）：工具调用"
description: "用 OpenAI 接口的 tools 字段让 Qwen3-8B 调工具：工具定义怎样进 prompt，模型写出的 <tool_call> 文本怎样变成 tool_calls，tool_choice 的几种取值各约束了什么，截断和格式写错时客户端收到什么，工具定义的顺序又怎样决定前缀缓存能命中多少。"
date: 2026-11-16 10:00:00 +0800
tags: [vLLM, 推理, 工具调用]
series: vllm
series_order: 11
---

前十篇的主实验里，编程智能体调工具用的是最简单的办法：system prompt 里写明有哪些工具，要求模型回一行 `CALL 工具名 JSON 参数`，客户端自己从文本里把这一行找出来。实际的智能体框架大多走 OpenAI 接口的 `tools` 字段，请求里给工具定义，响应里拿回结构化的 `tool_calls`。这一篇看 vLLM 在中间做了什么：工具定义怎么进 prompt，模型写出来的文本怎么变成 `tool_calls`，`tool_choice` 的几种取值各约束了什么，输出被截断、格式写错时客户端会收到什么，最后看工具定义对前缀缓存和首 token 时间的影响。

行为以 vLLM 0.32.0 为准。机器是第九篇那台，这次只用一张 RTX 4090 24 GB；驱动 595.71.05，torch 2.13.0（CUDA 13.0），模型 Qwen3-8B（bf16）。服务参数和前几篇一样：`--max-model-len 32768`，开前缀缓存，`--gpu-memory-utilization` 用默认的 0.92，KV Cache 5.48 GiB、39,920 个 token；另外加了 `--enable-prompt-tokens-details`，让响应里带上命中前缀缓存的 token 数。请求一律关掉思考模式，temperature 0。工具还是第一篇那个智能体的 4 个：`read_file`、`search`、`edit_file`、`run`。

## 先看一次调用的来回

服务启动时要多加两个参数，打开自动工具选择，并指定按哪种格式解析模型的输出：

```bash
vllm serve Qwen/Qwen3-8B --max-model-len 32768 --enable-prefix-caching \
  --enable-prompt-tokens-details \
  --enable-auto-tool-choice --tool-call-parser hermes
```

hermes 是一种调用格式：模型把每个调用写成一段 JSON，前后用 `<tool_call>` 和 `</tool_call>` 包起来。Qwen3 的 chat template 要求模型按这种格式写，所以解析器选它。启动日志里会多一行 `"auto" tool choice has been enabled.`。

请求就是普通的 chat completions，多一个 `tools` 字段：

```json
{
  "model": "qwen3-8b",
  "messages": [
    {"role": "system", "content": "你是一个在用户仓库里工作的编程智能体。……"},
    {"role": "user", "content": "读一下 README.md。"}
  ],
  "tools": [
    {"type": "function", "function": {
      "name": "read_file",
      "description": "读取仓库中的文件，返回带行号的内容",
      "parameters": {"type": "object",
                     "properties": {"path": {"type": "string"}},
                     "required": ["path"]}}}
  ],
  "temperature": 0,
  "chat_template_kwargs": {"enable_thinking": false}
}
```

实际请求里 `tools` 有 4 个工具，这里只列了一个。这条请求在 vLLM 里经过下面几步。

1. 渲染 prompt。vLLM 不给工具列表排序，也不去重，按请求里的顺序原样交给 chat template。Qwen3 的模板把工具放在 system 消息里、系统提示之后：先是一段 `# Tools` 说明，`<tools>` 里每行一个工具的 JSON，再是一段要求用 `<tool_call></tool_call>` 包住调用的格式说明。用户消息在后面。关掉思考模式时，assistant 开头是一对空的 `<think>` 标签，第六篇说过它的来历。

    ```text
    <|im_start|>system
    你是一个在用户仓库里工作的编程智能体。……

    # Tools

    You may call one or more functions to assist with the user query.

    You are provided with function signatures within <tools></tools> XML tags:
    <tools>
    {"type": "function", "function": {"name": "read_file", "description": "读取仓库中的文件，返回带行号的内容", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}}
    ……另外 3 个工具，每行一个……
    </tools>

    For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
    <tool_call>
    {"name": <function-name>, "arguments": <args-json-object>}
    </tool_call><|im_end|>
    <|im_start|>user
    读一下 README.md。<|im_end|>
    <|im_start|>assistant
    <think>

    </think>
    ```

    这一条 prompt 是 432 个 token。同样格式的用户消息，不带工具时 prompt 是 90 个 token，带这 4 个工具是 451 个，工具定义连同前后两段说明一共 361 个。

2. 生成。对调度器和前向来说，这就是一条普通请求，`tool_choice` 不填时也不加任何约束，模型自己决定写什么。请求带上 `logprobs: true`，把返回的每个 token 拼起来，就能看到解析之前模型写了什么。这一条一共 21 个 token：

    ```text
    <tool_call>
    {"name": "read_file", "arguments": {"path": "README.md"}}
    </tool_call><|im_end|>
    ```

3. 解析。生成结束后，hermes 解析器在输出里找 `<tool_call>` 和 `</tool_call>` 之间的每一段，把它当 JSON 读，取出 `name` 和 `arguments`，组成 `tool_calls`。只要解析出至少一个调用，`finish_reason` 就从引擎给的 `stop` 改成 `tool_calls`。

4. 返回。客户端收到的 `message` 里 `content` 是 `null`，`<tool_call>` 这些标签不出现，`arguments` 是一个 JSON 字符串：

    ```json
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "chatcmpl-tool-…",
        "type": "function",
        "function": {"name": "read_file", "arguments": "{\"path\": \"README.md\"}"}
      }]
    }
    ```

所以工具调用在 vLLM 里分成两半：前一半是模板把 JSON 形式的工具定义写成 prompt 里的文本，后一半是解析器把模型写出的文本再读回 JSON。中间的生成和别的请求没有区别。

### 不加那两个参数

不开解析器启动，请求照样带 `tools`，`tool_choice` 不填就按 `auto` 处理，在渲染 prompt 之前就返回 400：

```text
"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set
```

`required` 和指定工具名也是 400，提示 `requires --tool-call-parser to be set`。只有 `none` 返回 200。`none` 并没有把工具定义从 prompt 里拿掉，模型照样写出了 `<tool_call>…</tool_call>`，只是没有解析器，这段文本原样放在 `content` 里。

## `tool_choice`：约束的是什么

开着 hermes 解析器，用三条用户消息各试了 5 种 `tool_choice`。表里是解析出的调用和 `finish_reason`：

| 用户消息 | 不填 / `auto` | `required` | 指定 `read_file` | `none` |
| --- | --- | --- | --- | --- |
| 读一下 README.md。 | 1 个调用，`tool_calls` | 1 个，`tool_calls` | 1 个，`stop` | 无，原文在 `content`，`stop` |
| 同时读一下 README.md 和 setup.py | 2 个，`tool_calls` | 1 个，`tool_calls` | 1 个，`stop` | 无，两段原文在 `content`，`stop` |
| 你好，介绍一下你自己 | 无，正常回答，`stop` | 1 个 `read_file(README.md)`，`tool_calls` | 同左，`stop` | 无，正常回答，`stop` |

不填和 `auto` 每一格都一样：请求带了 `tools` 却不填 `tool_choice`，vLLM 在校验请求时就把它设成 `auto`。

`auto` 不约束生成，模型可以先写普通文本，也可以不调用。`required` 和指定工具名不一样，vLLM 会给这条请求挂上结构化输出，用 xgrammar 的 structural tag 按 hermes 的文本格式约束生成：`<tool_call>` 加换行、`{"name": "`、函数名、`", "arguments": ` 这一串是固定的，模型只能照写，后面的参数部分只要求是合法的 JSON，不按 `parameters` 里的 schema 约束，结尾是 `}` 加 `</tool_call>`。约束的是 hermes 这段文本，不是直接生成 OpenAI 格式的 JSON 数组，生成完以后 `tool_calls` 照样由解析器从文本里读出来。三种取值下的原始输出因此是同一种格式。

表里有三处和直觉不同。

1. 两个文件的请求，`required` 只给了 1 个调用，`auto` 给了 2 个。`required` 的约束允许连着写多个 `<tool_call>`，并不在第一个结束后强制停止；`parallel_tool_calls` 默认是 `true`，设成 `false` 才只允许一个。这次是模型自己在第一个调用之后停了。指定工具名时约束只允许一个调用。
2. “你好，介绍一下你自己”不需要工具，`required` 和指定名字都硬生成了一个 `read_file(README.md)`。约束要求至少一个调用，模型只能编一个出来。
3. 指定工具名时 `finish_reason` 是 `stop`，不是 `tool_calls`。vLLM 只在 `auto` 和 `required` 时把它改成 `tool_calls`，指定名字时保留引擎原来的结束原因。客户端判断有没有调用，要看 `tool_calls` 字段，不能只看 `finish_reason`。

另外，`content` 在 `auto` 时是 `null`，在 `required` 和指定名字时是空字符串。

### 第一次 `required` 慢了 0.7 秒

第一条 `required` 请求用了 1.105 秒，同样输出 21 个 token 的 `auto` 请求是 0.38 秒左右，之后的 `required` 也回到 0.38 秒。后来补测时重启过一次服务，那次第一条 `required`（输出被截在 12 个 token）用了 0.82 秒，同样设置的 `auto` 是 0.22 秒。

这和约束的编译对得上。`auto` 默认不挂约束；`required` 第一次出现时，要按这一组工具把 hermes 格式的语法编译一遍。编译结果缓存在服务进程里，按语法内容查找，同一组工具、同一种 `tool_choice` 第二次就能直接用；换一组工具，或者从 `required` 换成指定名字，就是另一份语法。这 0.7 秒里多少是编译，这次没有单独量。

## 流式：工具调用怎么分块

把两个文件的请求改成流式（`auto`），一共收到 18 个 chunk：

1. 第 1 个只有 `role: assistant`。
2. 第 2 个是第一个调用的开头，带 `id`、`type`、`index: 0` 和 `function.name: read_file`，还没有参数。
3. 接下来 7 个 chunk 是参数，依次是 `{"`、`path`、`":`、` "`、`README`、`.md`、`"}`，拼起来是 `{"path": "README.md"}`。
4. 第二个调用（`index: 1`）重复第 2、3 步：一个带名字的 chunk，再是 7 片参数。
5. 最后一个 chunk 的 `delta` 是空的，`finish_reason: tool_calls`。

原始输出里的 `<tool_call>`、`"name"` 这些文字都不出现在 delta 里。解析器每收到新的 token，就把到目前为止的全部输出重新切一遍：一看到 `<tool_call>`，后面的文字就不再当 `content` 发；`"name": "…"` 的右引号到了，确定了函数名，才发出带 `id` 和名字的那个 chunk；之后每次把已经解析出的参数文本和已经发出去的比较，只发多出来的那一截。这次参数的 7 片正好和 token 一一对应，是因为每个新 token 都正好接在参数这段 JSON 的末尾。已经发出去的片段不会收回，后面写坏了也不会发更正。

所以调用工具时，客户端收到第一个有内容的 chunk，比模型生成第一个 token 晚好几步。下一节截断实验里，`max_tokens` 设成 6 时模型正好写到 `<tool_call>`、换行和 `{"name": "`，函数名和右引号至少还要 2 个 token，名字 chunk 最早也要等到第 8 个 token。后面前缀缓存那一节的实验里，同样格式的用户消息，不带工具时模型直接回答，第一个 chunk 在 0.031 秒到达；带 4 个工具时模型调用 `read_file`，第一个 chunk 要 0.168 秒。两种 prompt 没命中缓存、要算的 token 都只有三十个左右（26 个和 35 个），prefill 差不多，多出来的 0.14 秒基本是名字之前那几步 decode：不带工具那组 decode 一步约 17 毫秒，0.14 秒是 8 步左右。

## 出错的时候

工具调用全靠模型写出合法的文本，写不对、写不完的时候，解析器怎么处理，决定了客户端收到什么。下面按实验的顺序看几种情况，都开着 hermes 解析器。

1. 截断在第二个调用末尾。两个文件的请求加 `max_tokens: 40`，模型写完第一个调用，第二个写到 `{"path": "setup.py"}}` 和一个换行就到了 40 个 token，没有 `</tool_call>`。返回的 `tool_calls` 却是完整的 2 个，`finish_reason` 是 `tool_calls`，不是 `length`。解析器允许最后一段缺结束标签，只要这一段已经是完整的 JSON，就算一个调用；而只要解析出了调用，`finish_reason` 就改成 `tool_calls`，引擎原来的 `length` 在响应里不再出现。想知道是不是截断了，只能自己比较 `usage.completion_tokens` 和 `max_tokens`，这次两者都是 40。
2. 截断在第一个调用中间。`max_tokens` 设成 6，原始输出是 `<tool_call>` 加换行和 `{"name": "`；设成 12，写到 `"arguments":`。这两种都不是完整的 JSON，解析失败，`tool_calls` 是 `null`，这段半截原文整个放进 `content`，`finish_reason` 保持 `length`。`required` 也一样，约束只限定格式，不会让模型在 `max_tokens` 用完之前把调用写完。
3. 要模型写单引号。系统提示里要求 `<tool_call>` 里写成单引号的 Python 字典，或者在对话历史里放两次单引号写法的 assistant 回复，让它照着写。两种办法模型都没照做，仍然写出合法的 JSON，解析正常。vLLM 把历史里 assistant 的 `content` 原样交给模板，不会把其中的 `<tool_call>` 文本改写成结构化的调用；模板有没有改写这段历史，这次没有查。
4. 用 `logit_bias` 逼它写单引号。词表里含双引号的 token 一共 1,344 个，`logit_bias` 一条请求最多只能列 1,024 个（见下一条），这次禁掉其中最短的 1,024 个，每个减 100。
    - `auto`，非流式：模型写出了完整的 `<tool_call>` 加换行和 `{'name': 'read_file', 'arguments': {'path': 'README.md'}}` 再加 `</tool_call>`，21 个 token，格式一样，只是全换成了单引号。这不是合法 JSON，解析失败，`tool_calls` 是 `null`，整段原文进了 `content`，`finish_reason` 是 `stop`，HTTP 200。
    - `auto`，流式：只收到 2 个 chunk，一个 `role`，一个空的 `delta` 加 `finish_reason: stop`。没有 `content`，也没有 `tool_calls`，模型写的那段文字客户端一个字都收不到。流式时解析器看到 `<tool_call>` 就开始扣住后面的文字，等能解析出调用再发；整段最后都解析不出来，结束时也不会把扣住的文字补发成 `content`。这次流式请求没有开 `logprobs`，它的原始输出是按 temperature 0 推定和非流式那条相同。
    - `required`：约束又把双引号写了回来，原始输出是 `<tool_call>` 加换行、`{"name": "search", "arguments": 1}`、换行和 `</tool_call>`。返回的是一个合法的调用 `search`，`arguments` 是字符串 `"1"`。工具选错了，参数也不是对象。约束先把不符合格式的 token 屏蔽掉，`logit_bias` 再给名单上的 token 减分，名单外还剩 320 个含双引号的 token，约束要求的双引号可以从这些 token 里拼出来；参数部分只要求是合法 JSON，数字 `1` 也算。模型为什么在这种情况下选了 `search`，说不清。
5. `logit_bias` 超过 1,024 个。第一次实验把 1,344 个全列进去，服务直接停了：

    ```text
    ValueError: Too many logit bias tokens: 1344. The max size is 1024.
    ```

    这个检查不在接收请求的地方，而在 GPU worker 把请求加进这一步的批次时。worker 抛出异常，引擎把这一步当成失败，打出 `EngineCore encountered a fatal error.` 后退出。这条请求和之后的请求都返回 500 `EngineCore encountered an issue`，要重启服务。一条请求的参数超限，结果是整个服务不可用。1,024 是写死的常量，没有参数可以改大。
6. 调用不在 `tools` 里的工具。系统提示里说“你还可以调用 `delete_repo`”，用户让它删仓库，返回 200，`tool_calls` 里就是 `delete_repo`，参数 `{}`。解析器不检查函数名在不在 `tools` 里，也不按 `parameters` 检查参数。反过来，`tool_choice` 指定一个不在 `tools` 里的名字，请求校验时就挡住了，返回 400 `` The tool specified in `tool_choice` does not match any of the specified `tools` ``。

汇总一下：

| 情况 | HTTP | `finish_reason` | `tool_calls` | `content` |
| --- | --- | --- | --- | --- |
| 截断在调用末尾，JSON 已完整 | 200 | `tool_calls` | 完整 | 无 |
| 截断在调用中间 | 200 | `length` | `null` | 半截原文 |
| 格式不是合法 JSON，非流式 | 200 | `stop` | `null` | 整段原文 |
| 格式不是合法 JSON，流式 | 200 | `stop` | 无 | 无 |
| 调用了没定义的工具 | 200 | `tool_calls` | 照样返回 | 无 |
| `tool_choice` 指定了没定义的工具 | 400 | — | — | — |
| `logit_bias` 超过 1,024 个 | 500，服务退出 | — | — | — |

vLLM 只检查 `tool_choice` 里指定的名字。模型写出的函数名是不是定义过的、参数对不对、是不是被截断了，都要客户端自己查。流式那一种最难发现，客户端只看到一条正常结束、什么都没说的回复。

## 工具定义和前缀缓存

第一步说过，工具定义写在 system 消息里，每条请求都带着。工具多了，prompt 就长，第一次算的时候首 token 时间也长。好在每条请求开头这一段都一样，正好能命中前缀缓存。为了看清楚，在 4 个工具之外再加了 40 个长一些的工具，每个都有几个参数和一段描述。

{% include kv-demo.html id="tool-order" caption="图 1：工具定义怎么改会让前缀缓存失效。上面是上一条请求，下面是这一条，实测数字来自 44 个工具的实验" %}

### 顺序发 5 条

工具分三档：不带工具、4 个工具、44 个工具。每档顺序发 5 条流式请求，用户消息开头带不同的编号，内容都是让它读一个文件。不带工具时模型直接回答，19 个 token；带工具时都是一个 `read_file` 调用，24 个 token。下面几张表里的“首个 chunk”是从发出请求到收到第一个有内容的 chunk 的时间，按流式那一节说的，带工具时它还包含写到函数名之前的那几步 decode，4 个工具时约 0.14 秒：

| 工具 | prompt token | 第 1 条：命中 ｜ 首个 chunk | 第 2–5 条：命中 ｜ 首个 chunk |
| --- | ---: | --- | --- |
| 无 | 90 | 48 ｜ 0.031 s | 64 ｜ 0.031–0.032 s |
| 4 个 | 451 | 416 ｜ 0.168 s | 416 ｜ 0.169 s |
| 44 个 | 10,241 | 368 ｜ 1.365 s | 10,208 ｜ 0.221–0.226 s |

40 个长工具让 prompt 多了 9,790 个 token，平均每个工具约 245 个。按第三篇的每个 token 144 KiB，这一段 KV 是 1.34 GiB，差不多是这张卡 5.48 GiB KV 的四分之一。

44 个工具的第 1 条只命中了 368 个：前面那些实验在同一个服务上用过同样的系统提示和 4 个工具，开头这一段已经在缓存里，后面 40 个工具是新的，要从头算，近 9,900 个 token，首个 chunk 等了 1.365 秒。第 2 条起命中 10,208 个，是 638 个整块，只剩最后 33 个 token 要算；用户消息各不相同，命中最多到它前面为止。首个 chunk 降到 0.22 秒左右，比 4 个工具时只多 0.05 秒。

### 换个写法

44 个工具的列表换四种写法，各发一条：

| 写法 | prompt token | 命中 | 首个 chunk |
| --- | ---: | ---: | ---: |
| 和上一条完全相同 | 10,239 | 10,208 | 0.219 s |
| 工具倒过来排 | 10,239 | 96 | 1.383 s |
| 只改第一个工具的描述，加“（只读）” | 10,244 | 112 | 1.383 s |
| 末尾加一个工具 | 10,303 | 10,160 | 0.229 s |

倒序和改第一个工具的描述，都只剩开头的一百个 token 左右能命中，首个 chunk 的时间和第一次算这 40 个工具时一样；末尾加一个工具几乎不受影响。规则就是第六篇那条：前缀缓存从头往后比，第一个不同的 token 之后都不能命中。vLLM 不会替客户端把工具列表排好序，模板也按列表顺序写。客户端每次按不同的顺序拼工具列表，比如从一个无序的集合里取，或者在列表前面插入一个工具，这 1 万个 token 每条都要重算。

### 并发 16 条

每档再同时发 16 条，用户消息各不相同，最多输出 128 个 token。用户消息里要模型先说一句判断再调用工具，带工具时它没有照做，还是只写了一个调用，24 到 25 个 token；不带工具时直接回答，38 到 96 个 token：

| 工具 | 并发 | prompt token | 命中的中位数 | 首个 chunk 中位数 |
| --- | ---: | ---: | ---: | ---: |
| 无 | 1 | 102 | 64 | 0.037 s |
| 无 | 16 | 103 | 64 | 0.130 s |
| 4 个 | 1 | 463 | 416 | 0.175 s |
| 4 个 | 16 | 464 | 432 | 0.248 s |
| 44 个 | 1 | 10,253 | 10,208 | 0.219 s |
| 44 个 | 16 | 10,254 | 10,224 | 0.671 s |

16 条请求的工具定义部分都命中了同一批 block，这些 block 由它们共用，只存一份，和第七篇里共用的 system prompt 一样。每条请求没命中的只有三四十个 token，44 个工具时 16 条并发的首个 chunk 中位数仍然是 0.67 秒，最慢 0.76 秒，是 4 个工具时的 2.7 倍。这段时间里有 16 条请求各自的 prefill，也有写到函数名之前的那几步 decode，每一步的 attention 都要读一万多个 token 的 KV，各占多少，这次没有拆。

## 从响应和日志看工具调用

和这一篇有关的字段和日志：

- `finish_reason`：`auto` 和 `required` 解析出调用时是 `tool_calls`，即使其实是被 `max_tokens` 截断的；指定工具名时是 `stop`。
- `usage.completion_tokens`：和请求的 `max_tokens` 相等时，输出可能被截断了，响应里没有别的标志。
- `usage.prompt_tokens_details.cached_tokens`：命中前缀缓存的 token 数，按 16 个 token 的整块计。启动时要加 `--enable-prompt-tokens-details` 才有。
- 请求带 `logprobs: true` 时，把每个 token 拼起来就是解析之前的原始输出。
- 启动日志里的 `"auto" tool choice has been enabled.`：开了自动工具选择。
- `/metrics` 里的 `vllm:prefix_cache_queries_total` 和 `vllm:prefix_cache_hits_total`：这次每条请求前后的增量，和响应里的 prompt token 数、`cached_tokens` 都一致。

## 参考资料

- [vLLM](https://github.com/vllm-project/vllm)：本文行为以 v0.32.0 为准，`tool_choice` 的默认值和校验、工具定义交给模板的方式、`required` 和指定名字时的约束、hermes 解析器在非流式和流式下的行为、`finish_reason` 的改写、`logit_bias` 的上限以这个版本的源码为准。
- vLLM 文档：[Tool Calling](https://docs.vllm.ai/en/latest/features/tool_calling.html)、[Structured Outputs](https://docs.vllm.ai/en/latest/features/structured_outputs.html)。
- [xgrammar](https://github.com/mlc-ai/xgrammar)：`required` 和指定名字时用的约束解码后端。
- Qwen 文档：[Function Calling](https://qwen.readthedocs.io/en/latest/framework/function_call.html)：Qwen3 的工具调用格式。
- OpenAI，[Function calling](https://platform.openai.com/docs/guides/function-calling)：`tools`、`tool_choice` 和 `tool_calls` 的接口约定。
