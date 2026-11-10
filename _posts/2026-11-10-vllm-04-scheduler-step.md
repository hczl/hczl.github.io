---
title: "vLLM 入门（四）：调度器的一步"
description: "打开 vLLM 的逐步调度日志，跟着 4 个编程智能体会话的前几秒，看每一步怎么在 decode 和分块 prefill 之间分配 2048 个 token 的预算，以及 prefill 怎样拖慢同批请求的 decode。"
date: 2026-11-10 11:00:00 +0800
tags: [vLLM, 推理]
series: vllm
series_order: 4
---

第一篇说引擎进程一步一步地执行，每一步先调度、再前向，第 2 轮请求的 prefill 分 4 步算完，这个步数当时是按预算推算的。vLLM 有一个启动参数 `--enable-logging-iteration-details`，打开后每一步都会打一行日志，写明这一步有几个请求在 prefill、几个在 decode、各算了多少 token。这一篇用它看调度器在多个请求之间怎么分配一步的算力。

环境和第二篇相同，`--gpu-memory-utilization` 用默认的 0.92，KV Cache 是 2494 个 block。启动命令在第一篇的基础上加了这个参数：

```bash
vllm serve Qwen/Qwen3-8B \
  --served-model-name qwen3-8b \
  --max-model-len 32768 \
  --enable-prefix-caching \
  --enable-prompt-tokens-details \
  --enable-logging-iteration-details
```

一步的日志是这样的：

```text
Engine 000: Iteration(94): 1 context requests, 2047 context tokens, 1 generation requests, 1 generation tokens, iteration elapsed time: 160.97 ms, GPU KV cache usage: 11.1%
```

context 指这一步在做 prefill 的请求和它们这一步算的 token 数，generation 指在做 decode 的请求和 token 数。prefill 的 token 数不含命中前缀缓存的部分，只算真正要计算的。

## 例子：4 个会话同时开始

还是第一篇的编程智能体，这次 4 个会话每隔 2 秒启动一个，每个会话 6 轮，一共 24 个请求，日志里一共 474 步。下面跟着前 6 秒走，这段时间里到达的请求是：

| 请求 | prompt token | 命中缓存 | 要计算 |
| --- | ---: | ---: | ---: |
| 会话 0 第 1 轮 | 307 | 0 | 307 |
| 会话 0 第 2 轮 | 7,219 | 288 | 6,931 |
| 会话 1 第 1 轮 | 307 | 272 | 35 |
| 会话 2 第 1 轮 | 307 | 272 | 35 |
| 会话 1 第 2 轮 | 4,809 | 288 | 4,521 |
| 会话 0 第 3 轮 | 15,432 | 7,200 | 8,232 |
| 会话 3 第 1 轮 | 306 | 272 | 34 |

会话 0 的第 1 轮最先到达，第 0 步一次算完 307 个 token，第 1～32 步逐个 decode，输出 32 个 token 后结束，前后 0.6 秒，这时别的会话还没有开始。下面从会话 0 的第 2 轮讲起，第一篇推算过它的 prefill 要分 4 步。

后 3 个会话的第 1 轮和会话 0 的 system prompt 相同，前 272 个 token 直接命中会话 0 留下的缓存。日志里的步和请求是按 token 数对上的，下面每一步的对应关系都可以用表里的数核对。

### 第一步：一个请求独占预算（第 33～35 步）

会话 0 的第 2 轮到达时，引擎里没有别的请求。它要算 6,931 个 token，超过一步 2048 的预算，于是前三步各算 2048 个：

| 步 | prefill | decode | 耗时 |
| --- | --- | --- | ---: |
| 33 | 1 个请求，2048 token | 无 | 149.96 ms |
| 34 | 1 个请求，2048 token | 无 | 178.47 ms |
| 35 | 1 个请求，2048 token | 无 | 196.99 ms |

三步算的 token 数一样，耗时却一步比一步长：每一块都要和前面所有 token 的 KV 做 attention，第 33 步前面只有 288 个 token，第 35 步前面已经有 4,384 个。

### 第二步：两个请求合用一步（第 36 步）

这时会话 1 的第 1 轮到了。第 36 步的日志是“2 context requests, 822 context tokens”：会话 0 剩下的 787 个 token，加上会话 1 要算的 35 个。会话 0 的 prefill 是先开始的，调度器先满足它；剩下的预算还有 1,261 个 token，足够把会话 1 的 35 个 token 一起算完。两个请求在这一步都算完了 prefill，各自采样出第一个 token。

第一篇推算的“2048、2048、2048、787”四步，日志里就是第 33～36 步。

### 第三步：只有 decode 的步（第 37～92 步）

之后两个请求都在 decode，每一步各算 1 个 token，日志是“0 context requests, 0 context tokens, 2 generation requests, 2 generation tokens”。会话 1 输出 29 个 token 后先结束，之后只剩会话 0。这种步很快，整个实验里只有 decode 的步耗时的中位数是：

| 同一步里 decode 的请求数 | 步数 | 耗时中位数 |
| ---: | ---: | ---: |
| 1 | 111 | 13.54 ms |
| 2 | 144 | 15.88 ms |
| 3 | 103 | 18.65 ms |
| 4 | 48 | 18.37 ms |

4 个请求一起 decode 只比 1 个请求慢 5 毫秒左右。第一篇讲过，decode 每一步都要把权重从显存读一遍，多几个请求只是多几行计算，读权重的时间大家分摊。4 个请求时的中位数比 3 个请求时还低一点，是因为各步的上下文长度不同，这里没有按长度分开统计。

### 第四步：decode 优先，prefill 用剩下的预算（第 93～96 步）

第 93 步，会话 2 的第 1 轮到达，算完 35 个 token 后开始 decode。紧接着会话 1 的第 2 轮到了，要算 4,521 个 token：

| 步 | prefill | decode | 耗时 |
| --- | --- | --- | ---: |
| 94 | 1 个请求，2047 token | 1 个请求，1 token | 160.97 ms |
| 95 | 1 个请求，2047 token | 1 个请求，1 token | 193.29 ms |
| 96 | 1 个请求，427 token | 1 个请求，1 token | 50.11 ms |

这次 prefill 每步只算 2047 个 token，因为会话 2 在 decode，占了 1 个。调度器每一步先处理已经在运行的请求，decode 的请求各给 1 个 token，剩下的预算才给 prefill。2047 加 2047 再加 427，正好是 4,521。整个实验里有 50 步的 prefill 和 decode 加起来正好是 2048，预算每次都用满了。

{% include figure.html src="/assets/images/vllm-04-scheduler-step/01-step-budget.jpg" alt="5 根等高的长条代表 5 步，顶端虚线是 2048 的预算：第一根全是 prefill 2048；第二根底部 decode 1，上面 prefill 2047；第三根底部 decode 2，上面 prefill 2046；第四根底部 decode 2，上面只有 48 个 prefill token；第五根只有 decode 2" caption="图 1：几种步的预算分配，依次对应第 33、94、101、105 步和之后只有 decode 的步。decode 一段的高度放大了，不按比例" %}

### 第五步：长 prefill 拖慢 decode（第 101～105 步）

会话 0 的第 3 轮到达时，会话 1 和会话 2 都在 decode。会话 0 这一轮要算 8,232 个 token，前面已经有 7,200 个 token 的 KV：

| 步 | prefill | decode | 耗时 |
| --- | --- | --- | ---: |
| 101 | 1 个请求，2046 token | 2 个请求，2 token | 224.35 ms |
| 102 | 1 个请求，2046 token | 2 个请求，2 token | 244.60 ms |
| 103 | 1 个请求，2046 token | 2 个请求，2 token | 261.45 ms |
| 104 | 1 个请求，2046 token | 2 个请求，2 token | 296.08 ms |
| 105 | 1 个请求，48 token | 2 个请求，2 token | 29.37 ms |

4 次 2046 加 48 是 8,232。这一轮的上下文更长，每块 prefill 的耗时到了 224～296 毫秒。

和它同批的两个 decode 请求每一步只前进 1 个 token，所以这 5 步里它们每出一个 token 要等 200 多毫秒，而只有 decode 的步是 15 毫秒左右。会话 2 的第 1 轮正好赶上了第 94～96 步和第 101～105 步两段 prefill，输出 34 个 token 用了 2.24 秒；会话 3 的第 1 轮几秒后到达（第 119 步，算 34 个 token），没有碰上长 prefill，输出 33 个 token 只用了 0.74 秒。两条请求的 prompt 几乎一样，差别全在同批的 prefill 上。

分块 prefill 的作用也在这里：如果不分块，会话 0 的 8,232 个 token 要在一步里算完，这一步会更长，期间所有 decode 请求都要等这一整步。分成每块 2048 个 token，decode 请求在块与块之间照样能前进。

## 预算用完时

后面会话越来越长，有一段时间 KV Cache 还有一半空着，却有请求在等。回放脚本每 0.5 秒读一次指标，其中两次的读数是：

| 时刻 | KV 占用 | 运行中 | 等待中 |
| --- | ---: | ---: | ---: |
| 第 1 次 | 49.0% | 2 | 1 |
| 第 2 次 | 59.3% | 2 | 2 |

对应的几步日志都是“1 context requests, 2047 context tokens, 1 generation requests, 1 generation tokens”：一个请求在 prefill，一个在 decode，2048 的预算已经分完，等待中的请求这一步一个 token 也分不到，只能留到下一步。等前面的 prefill 只剩最后一块、预算有了余量，新请求才在同一步里开始，日志里出现了“2 context requests, 2047 context tokens”这样的步。

所以请求留在等待队列里不一定是 KV Cache 不够，也可能只是这一步的预算已经分完了。KV Cache 不够的情况在这次实验里也出现了：之后 KV 占用到过 97.9%，有几轮请求的前缀缓存被挤掉，会话 0 的第 6 轮只命中了 4,768 个 token，首 token 时间是 4.2 秒。整个实验没有发生抢占。KV Cache 被占满时调度器怎么做，放到第七篇。

## 参考资料

- [vLLM](https://github.com/vllm-project/vllm)：本文行为以 v0.32.0 为准，逐步调度日志的格式和调度顺序以这个版本的实测为准。
- vLLM 文档：[Optimization and Tuning](https://docs.vllm.ai/en/latest/configuration/optimization.html)（分块 prefill 与 `--max-num-batched-tokens`）。
- Amey Agrawal 等，[Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve](https://arxiv.org/abs/2403.02310)，OSDI 2024。分块 prefill 和把 prefill 与 decode 放进同一批的做法出自这篇论文。
