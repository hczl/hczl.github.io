---
title: "vLLM 入门（一）：一条请求在 vLLM 里的完整流程"
description: "以编程智能体的一轮请求为例，按时间顺序梳理请求从进入 vLLM 到返回结果经过的进程、调度、KV Cache 分配、分块 prefill、decode 和缓存保留，作为后续各篇的索引。"
date: 2026-11-02 16:30:00 +0800
tags: [vLLM, 推理]
math: true
series: vllm
series_order: 1
---

做 KV Cache 卸载之前，得先弄清楚 vLLM 自己怎么管 KV：一条请求进来后经过哪些进程，KV Cache 什么时候分配、什么时候收回，多轮对话里哪些 token 不用重算，显存不够时谁先让出来。这个系列按时间顺序整理这些过程，全系列用同一个例子：一个编程智能体的多轮请求。

几点约定：只讨论 V1 引擎；默认单卡，多卡在第九篇单独讲；文中用启动参数、日志原文和 `/metrics` 接口的指标名标记各个步骤，方便和文档、监控对照。

实验环境如下，后面各篇不再重复，有变化时单独说明：

| 项目 | 版本 |
| --- | --- |
| GPU | NVIDIA GeForce RTX 4090，24 GB，驱动 580.142 |
| 系统 | Ubuntu 22.04，内核 5.15 |
| vLLM | 0.32.0 |
| PyTorch / CUDA | 2.13.0 / 13.0 |
| 模型 | Qwen3-8B，bf16 |

这一篇先把一条请求的全过程过一遍，每一步只说做什么，细节放到后面各篇。

## 例子：一个编程智能体

例子是一个修 bug 的编程智能体。用户报告某个模块处理全角字符时宽度算错，智能体依次读源文件、读相关代码、跑测试、改代码、再跑测试，一共 6 轮请求。每轮请求都带同一段 system prompt（工具定义和工作约定），后面跟着到目前为止的全部对话，包括上一轮工具返回的文件内容，所以每轮新增的只是末尾的工具输出。

为了每次实验内容一致，工具输出是事先准备好的固定文本，文件内容取自 Python 标准库的源码；模型每轮的回复原样拼进历史。

服务按下面的方式启动：

```bash
vllm serve Qwen/Qwen3-8B \
  --served-model-name qwen3-8b \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.92 \
  --enable-prefix-caching \
  --enable-prompt-tokens-details
```

第一次启动没有加 `--gpu-memory-utilization`，默认值就是 0.92，结果报错退出：留给 KV Cache 的显存只有 4.48 GiB，放不下一条 32768 token 的请求要的 4.5 GiB，差了 0.02 GiB。第二次显式写上 0.92 再启动就成功了，KV Cache 有 5.48 GiB。两次参数一样，差别在于第一次是冷启动，测显存时顺带做了 torch.compile 编译，多占了约 1 GiB；第二次直接用了编译缓存。下一篇讲启动时再细说。`--enable-prompt-tokens-details` 让返回结果里带上命中缓存的 token 数，下表的“命中缓存”一列就是这个值。

智能体每轮用流式接口请求，关闭 Qwen3 的思考模式，一轮请求的写法如下（消息内容从略）：

```bash
curl -N localhost:8000/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "qwen3-8b",
  "messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}],
  "max_tokens": 256, "temperature": 0, "stream": true,
  "stream_options": {"include_usage": true},
  "chat_template_kwargs": {"enable_thinking": false}
}'
```

6 轮请求的实测结果：

| 轮次 | 新增内容 | prompt token | 命中缓存 | 输出 token | 首 token 时间 | 总时长 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 用户描述问题 | 307 | 0 | 32 | 0.08 s | 0.61 s |
| 2 | 读源文件的结果 | 7,219 | 288 | 45 | 0.83 s | 1.61 s |
| 3 | 读相关代码的结果 | 15,421 | 7,200 | 55 | 1.28 s | 2.32 s |
| 4 | 测试失败的输出 | 15,536 | 15,408 | 49 | 0.14 s | 1.06 s |
| 5 | 修改成功的回执 | 15,607 | 15,520 | 41 | 0.14 s | 0.90 s |
| 6 | 测试通过的输出 | 15,680 | 15,600 | 29 | 0.13 s | 0.67 s |

第 4 轮以后 prompt 有一万五千多个 token，几乎全部命中缓存，首 token 时间 0.14 秒左右；第 2、3 轮各读进一个大文件，新增的几千个 token 要现算，首 token 时间是 0.83 秒和 1.28 秒。下面跟着第 2 轮请求走一遍。

## 参与者

服务启动后，机器上有两个主要进程：

| 进程 | 日志前缀 | 主要职责 |
| --- | --- | --- |
| API 服务进程 | `(APIServer pid=...)` | 接收 HTTP 请求，套对话模板、分词，把请求交给引擎；把引擎返回的 token 转回文字，流式发给客户端 |
| 引擎进程 | `(EngineCore pid=...)`，进程名 `VLLM::EngineCore` | 循环执行调度和模型前向；管理 KV Cache；单卡时模型就在这个进程里运行 |

{% include figure.html src="/assets/images/vllm-01-overview/01-request-path.jpg" alt="请求从客户端经 API 服务进程、引擎进程到 GPU，GPU 上方是一排 KV Cache block，其中几格已缓存；生成的 token 沿虚线流式返回客户端" caption="图 1：一条请求经过的进程" %}

两个进程之间通过本机的 ZeroMQ 套接字传递请求和结果。用 `nvidia-smi` 看，22,456 MiB 显存全部算在引擎进程名下，API 服务进程不占显存。

引擎进程启动时划分显存。按 0.92 的比例，可用的是 21.64 GiB，其中：

- 模型权重占 15.27 GiB，CUDA 上下文等不归 PyTorch 管的显存占 0.27 GiB。
- 前向的峰值临时张量约 0.2 GiB；为 CUDA Graph 预留 0.43 GiB，实际只用了 0.23 GiB。
- 剩下的 5.48 GiB 全部预先分配给 KV Cache，切成固定大小的 block。每个 block 存 16 个 token 的 KV。Qwen3-8B 有 36 层、8 个 KV 头、每个头 128 维，bf16 下每个 token 的 K 和 V 一共 $$2 \times 36 \times 8 \times 128 \times 2 = 147456$$ 字节，即 144 KiB，一个 block 是 2.25 MiB。

启动日志里的这一行给出了总容量：

```text
GPU KV cache size: 39,904 tokens, Maximum concurrency for 32,768 tokens per request: 1.22x
```

也就是 2494 个 block。服务运行期间 KV Cache 不再申请或释放显存，所有请求共用这 2494 个 block，调度器按需分给各个请求，请求结束后收回。

## 全流程

### 第一步：客户端发出请求

智能体把 system prompt、第 1 轮的问题和模型回复、以及刚读到的源文件内容拼成一个消息列表，以 `stream: true` 发到 `/v1/chat/completions`。

### 第二步：API 服务进程套模板、分词

API 服务进程先检查参数，再用模型自带的对话模板把消息列表渲染成一段文本：每条消息前后加上角色标记，末尾加上让模型开始回复的标记。关闭思考模式时，Qwen3 的模板还会在末尾补一段空的思考标签。然后用分词器把这段文本转成 token 序列，这一轮是 7,219 个 token。

请求连同 token 序列、采样参数（`max_tokens`、`temperature` 等）一起交给引擎进程。

### 第三步：进入等待队列

引擎进程收到请求后，把它放进等待队列。引擎维护两个队列：等待队列里是还没开始算的请求，运行队列里是已经分到 KV Cache、正在 prefill 或 decode 的请求。

引擎进程在一个循环里一步一步地执行，每一步先调度、再前向。新请求要等到下一步调度时才会被处理。

### 第四步：调度：查前缀缓存，分配 block

每一步调度有一个 token 预算，由 `--max-num-batched-tokens` 控制。没有显式设置时，vLLM 按显卡显存选默认值：`vllm serve` 在显存 160 GiB 以上的卡上默认是 16384，70 GiB 以上的卡（A100 除外）上是 8192，其他卡上是 2048，这台 4090 属于最后一种。这一步里所有请求要计算的 token 加起来不能超过这个数。同一步里最多同时运行的请求数由 `--max-num-seqs` 控制，这里是默认的 256。

调度器先照顾运行队列里的请求，再从等待队列里按到达顺序取新请求。轮到第 2 轮请求时：

1. 查前缀缓存。调度器把 token 序列按 16 个一组切开，从头开始逐个 block 计算哈希，到缓存里找内容完全相同的 block。这一轮命中了 18 个 block，也就是前 288 个 token：system prompt 和第 1 轮的问题。这些 token 的 KV 已经在显存里，直接复用，不用再算。
2. 决定这一步算多少。剩下 6,931 个 token 要算，超过了 2048 的预算，这一步只算前 2048 个，其余的留到后面几步。V1 引擎默认开启分块 prefill（chunked prefill），长 prompt 都这样拆开算。
3. 分配 block。调度器只为这一步要算的 token 分配 block，不是一次给整条请求分够。如果空闲 block 不够，这条请求就留在等待队列里，下一步再试。

分配成功后，请求移到运行队列。

### 第五步：分块 prefill

按默认预算算，第 2 轮请求的 prefill 分 4 步：前三步各 2048 个 token，第四步 787 个。这个步数是推算的，实验里没有逐步记录。每一步的前向读取前面所有 token 的 KV，算出这一步新 token 的 KV，写进刚分配的 block 里。

{% include figure.html src="/assets/images/vllm-01-overview/02-turn2-timeline.jpg" alt="第 2 轮请求先命中 288 个缓存 token，再分 2048、2048、2048、787 四段 prefill，第四段之后得到第一个 token，之后每步 decode 一个 token" caption="图 2：第 2 轮请求的执行顺序。方框宽度示意 token 数，不代表耗时；命中缓存的部分不需要计算" %}

同一步里如果还有别的请求在 decode，它们和这 2048 个 token 拼在一起算，每步照样前进一个 token。

### 第六步：一次前向，采样出第一个 token

每一步的前向大致是：把这一步所有请求的 token 拼成一个批次，连同每个请求的 block 位置一起送进模型；模型逐层计算，attention 层按 block 位置去读写 KV Cache；最后一层输出每个请求最后一个位置上的词表概率，采样器按 `temperature` 等参数选出下一个 token。

prefill 的前三步也跑了完整的前向，但 prompt 还没读完，采样结果直接丢弃；第四步结束时才采样出第一个输出 token。客户端看到的首 token 时间是 0.83 秒，包括套模板、分词和 4 步 prefill。

这台机器上 attention 用的是 FlashAttention 后端；attention 以外的部分经过 torch.compile 编译，一步的 token 数在 512 以内时回放启动时捕获的 CUDA Graph，decode 一般都在这个范围内。

### 第七步：decode

拿到第一个 token 后，请求进入 decode：之后每一步只算 1 个 token，读前面全部 token 的 KV，写入 1 个 token 的 KV，采样出下一个 token。

prompt 的 7,219 个 token 占满 451 个 block，第 452 个 block 里有 3 个 token；decode 时先填满这个 block，再分配新的。这一轮输出 45 个 token，decode 期间新分配了 2 个 block。

首 token 之后的 44 个 token 用了 0.78 秒，每步约 18 毫秒，和 4 步 prefill 的时间差不多，而 prefill 算了 6,931 个 token。decode 每一步都要把 15.27 GiB 的权重从显存读一遍，4090 的显存带宽约 1 TB/s，光读权重就要 16 毫秒左右。同一步里 decode 的请求越多，这次读取就由越多的 token 分摊。

### 第八步：流式返回

引擎进程每一步都把新生成的 token 发回 API 服务进程。API 服务进程把 token 转回文字，以 SSE 事件流的形式发给客户端。

请求在两种情况下结束：模型输出了结束符，或者输出数达到 `max_tokens`。第 2 轮是前一种，模型输出 45 个 token 后发出了一次工具调用并结束。最后一个事件里带有用量统计：

```json
{"prompt_tokens": 7219, "completion_tokens": 45, "prompt_tokens_details": {"cached_tokens": 288}}
```

### 第九步：请求结束，KV 留在缓存里

请求结束后，它占用的 block 都还给空闲池，但已经写满 16 个 token 的 block 不清空，哈希和内容都保留着，下一次有相同前缀的请求可以直接复用。空闲 block 不够时，这些缓存 block 按最久未使用的顺序被征用。

第 3 轮请求到来时，第 2 轮的前 450 个 block 还在显存里，于是命中了 7,200 个 token。

第 2 轮的 prompt 有 451 个满 block，命中的却只有 450 个，每一轮都比上一轮的 prompt 少命中一个 block 左右。一开始以为是 block 对齐的问题，用分词器把两轮的 prompt 都渲染出来对比，才发现是对话模板：关闭思考模式时，生成那一轮的 prompt 末尾有一段空的思考标签，而下一轮把这条回复当作历史重新渲染时，模板去掉了这段标签。两次的 token 序列从助手回复的开头就不一样了，所以第 451 个 block 对不上，模型上一轮的回复本身也一直没有命中。

## 多个会话同时运行

单个会话时，第 6 轮 15,680 个 token 也只占 2494 个 block 的不到 40%。接着试了几个会话同时跑的情况，本来想看抢占，结果前两次都没看到。

第一次用 4 个会话，每隔 3 秒启动一个。4 个会话最后一轮的 prompt 加起来是 52,069 个 token，超过了 39,904 的容量，原以为会抢占，实际上 KV 占用最高到 98.5%，抢占计数 `vllm:num_preemptions_total` 一直是 0。每个智能体要等一轮结束才发下一轮，4 个会话的长 prompt 并不总是同时在跑，在跑的请求加起来放得下；被挤掉的是已经结束的请求留下的缓存 block，部分轮次的命中率从 99% 掉到 80% 左右。

第二次加到 8 个会话，每隔 0.5 秒启动一个，还是没有抢占，但缓存几乎全被冲掉了：从第 4 轮开始，每个请求只命中 system prompt 的 272 个 token，首 token 时间多在 10 秒上下，最长 14 秒。45 万个 prompt token 里有 40 万个（89%）是现算的，单个会话时这个比例是 23%。空闲 block 不够时，新请求留在等待队列里，最多时有 6 个在等，已经在跑的请求不受影响。

抢占发生在运行中的请求 decode 时分不到新 block 的时候：调度器打断一个运行中的请求，收回它的全部 block，把它放回等待队列，以后从头再算。智能体每轮只输出四五十个 token，decode 阶段几乎不增长，所以碰不到这种情况。第三次让每轮强制输出 2000 个 token，4 个会话就出现了一次抢占，两次运行里被抢占的都是同一个会话的第 4 轮，它的 decode 用了 66 到 69 秒，同批的其他请求是 44 到 49 秒。哪个请求被抢占是从时间线推断的，日志里没有记录。

## 参考资料

- [vLLM](https://github.com/vllm-project/vllm)：本文所有行为以 v0.32.0 为准，`--max-num-batched-tokens` 的默认值按显卡显存选择的规则也出自这个版本的源码。
- vLLM 文档：[OpenAI-Compatible Server](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html)、[Metrics](https://docs.vllm.ai/en/latest/design/metrics.html)、[Automatic Prefix Caching](https://docs.vllm.ai/en/latest/design/prefix_caching.html)。
- Woosuk Kwon 等，[Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180)，SOSP 2023。vLLM 按 block 管理 KV Cache 的做法出自这篇论文。
- [Qwen3-8B 模型卡](https://huggingface.co/Qwen/Qwen3-8B)：层数、KV 头数等结构参数以模型目录里的 config.json 为准。
