---
title: "vLLM 入门（五）：PagedAttention 与 block table"
description: "跟着编程智能体第 2 轮请求的 prefill 和 decode，看 vLLM 怎样用 block table 把请求里每个 token 对应到 2494 个物理 block 中的某一格，写 KV、读 KV、在请求之间共享 block，并用 4 个会话的 KV 占用读数和一次 profiler 结果核对。"
date: 2026-11-11 11:00:00 +0800
tags: [vLLM, 推理, KV Cache]
math: true
series: vllm
series_order: 5
---

第三篇算出了 block 有多大：16 个 token，36 层一共 2.25 MiB，0.92 热启动时一共 2494 个。第四篇看了调度器每一步给请求分多少 token。这两篇都没有说一条请求分到的 block 在显存里怎么摆、attention 算的时候怎么找到它们。这一篇讲 vLLM 里负责这件事的结构 block table，以及它背后的分页管理方式，也就是 PagedAttention 论文里提出的做法。

行为以 vLLM 0.32.0 为准。数据来自三次实验：单会话 6 轮和 4 个会话同时跑的那两次是第一篇的实验，`--gpu-memory-utilization` 0.92，2494 个 block；逐步调度日志和 profiler 是在第二篇那台机器上做的，配置相同，KV Cache 也是 2494 个 block。

## 为什么不给每条请求一段连续显存

最直接的做法是请求一到，就按它可能用到的最大长度切一段连续显存。服务的 `--max-model-len` 是 32768，一条请求最多要

$$
32768 \times 144 \text{ KiB} = 4.5 \text{ GiB}
$$

5.48 GiB 的 KV Cache 只够切一段，启动日志里的“Maximum concurrency ... 1.22x”就是这个比值。而智能体第 1 轮请求加上输出一共 339 个 token，只用得到这段的 1%；最长的第 6 轮 15,709 个 token，也不到一半。

按实际长度切也不行：请求开始时只知道 prompt 多长，不知道模型会输出多少个 token。就算预先知道，长短不一的请求陆续结束，空出来的是一段段大小不同的空洞，新请求要的连续长度不一定有空洞放得下。

vLLM 的做法是把 KV Cache 切成固定大小的 block，请求用到哪里就分配到哪里，每次分配的单位是 1 个 block。任何一个空闲 block 都能分给任何请求，同一条请求的 block 在显存里不必相邻。每条请求另有一张表，按顺序记下它用到的每个 block 的编号，这张表就是 block table。和操作系统的页表类似：请求看到的是从 0 开始连续编号的逻辑 block，表里存的是对应的物理 block 号。

{% include figure.html src="/assets/images/vllm-05-paged-attention/01-block-table.jpg" alt="左边是两张 block table：会话 0 第 2 轮的表依次是 7、3、12，会话 1 第 1 轮的表依次是 7、3、18；右边是 6 列 4 行的物理 block 阵列，编号 7、3、12、18 的格子分散在不同位置，7 和 3 涂成浅蓝并标为 shared，下方写 2494 blocks in total" caption="图 1：block table 里存的是物理 block 号。两条请求的表开头都是 7 和 3，指向同一组物理 block。编号是示意；实际上第 2 轮 prefill 结束时表有 452 项，会话 1 第 1 轮有 20 项，共用的是前 17 项" %}

## 例子：第 2 轮请求的 block table

下面跟着单会话实验里的第 2 轮请求走。它的 prompt 有 7,219 个 token，命中前缀缓存 288 个，输出 45 个 token。第一篇和第四篇已经确认，它的 prefill 分 4 块算：2048、2048、2048、787。

逻辑 block 和 token 位置的关系是固定的：位置为 $$i$$ 的 token（从 0 数）落在第 $$\lfloor i / 16 \rfloor$$ 个逻辑 block 的第 $$i \bmod 16$$ 格。物理 block 号是分配时从空闲 block 里取的，实验没有记录具体编号，下文和配图里的编号都只是示意。

### 第一步：命中缓存的 block 直接填进表

请求进入调度时，调度器先查前缀缓存，前 18 个 block（288 个 token）和第 1 轮留下的 block 内容相同。这 18 个 block 不用重新分配，也不用重新算，调度器把它们的物理 block 号依次填进 block table 的第 0～17 项。block table 里同一个物理 block 被第 1 轮和第 2 轮先后引用，KV 只存了一份。

### 第二步：每一块 prefill 只为这一块分配

第一块 prefill 要算位置 288～2335 的 2048 个 token，它们落在逻辑 block 18～145。调度器这一步从空闲 block 里取 128 个，填进表的第 18～145 项。第二、三块各再取 128 个。

第四篇的逐步调度日志每行末尾有 KV 占用，第 33、34 步分别是 11.0% 和 16.1%，合 274 和 402 个 block 左右（只保留一位小数，误差在 2 个 block 以内），相差 128 个。274 是命中的 18 个加上前两块的 256 个，比第 33 步这一行算的 token 多出一块。原因是 vLLM 默认开启异步调度：引擎先把下一批排好、分配好 block，再给上一批打这行日志，所以日志里的占用已经包含了下一块的 block。

第四块 787 个 token，位置 6432～7218，落在逻辑 block 402～451，新取 50 个。最后一个 token 在位置 7218，是第 451 个逻辑 block 的第 2 格，所以 prefill 结束时这条请求有 452 个 block，前 451 个写满，最后一个只有 3 个 token。这和第三篇里 KV 占用读数换算出的 452 个 block 一致。

### 第三步：前向时把新 token 的 KV 写进去

调度器每一步除了把 token 交给模型，还要告诉模型每条请求的 block table，以及这一步每个新 token 的 KV 写到哪一格。格的编号由物理 block 号和块内位置算出来：

$$
\text{格号} = \text{物理 block 号} \times 16 + (i \bmod 16)
$$

KV Cache 在启动时一次分配好，按层、block、格、KV 头、内容的顺序排开，启动日志里的“Using LBNHC KV cache layout.”说的就是这个顺序：L 是层，B 是 block，N 是 block 里的格，H 是 KV 头，C 是一个头在一格里的内容，K 的 128 维和 V 的 128 维挨着放，bf16 下一共 512 字节。一格存一个 token 在这一层的 8 个头，4 KiB；一个 block 在一层里是 64 KiB，一层是 $$2494 \times 64 \text{ KiB} \approx 155.9 \text{ MiB}$$，36 层加起来就是 5.48 GiB。第三篇讲过，同一个 block 号在 36 层里指的是同一批 token，所以一条请求只需要一张 block table，36 层共用，格号也一样。

每一层算出这一步新 token 的 K、V 之后，先按格号写进这一层的那一段，再做 attention。

### 第四步：attention 按 block table 读

attention 要读这条请求前面所有 token 的 KV。它拿到的不是一段连续的 KV，而是 block table 和这条请求当前的长度：从表的第 0 项开始，依次找到每个物理 block，读出 16 格的 K 和 V；最后一个 block 只读有效的那几格。以第四块 prefill 为例，787 个新 token 的 query 要和 452 个 block 里 7,219 个 token 的 KV 做 attention，这 452 个 block 在显存里分散在哪里，对计算结果没有影响。

这台机器上 attention 用的是 FlashAttention 2，启动日志里有这两行（去掉了行首的进程和文件前缀）：

```text
Using FLASH_ATTN attention backend out of potential backends: ['FLASH_ATTN', 'FLASHINFER', 'TRITON_ATTN', 'FLEX_ATTENTION'].
Using FlashAttention version 2
```

PagedAttention 论文里，vLLM 自己写了一个按 block 读 KV 的 attention 算子。这台机器上按 block table 读 KV 的是 vLLM 自己维护的 FlashAttention 分支里的算子，后面 profiler 结果里的 attention 一项就是它。分支里同时有 FlashAttention 2 和 3，vLLM 按 GPU 的计算能力（compute capability）选用哪一个。计算能力是 NVIDIA 给每代 GPU 架构编的版本号，表示这张卡支持哪些硬件特性和指令，主版本号对应架构：4090 是 Ada 架构，8.9；H100 是 Hopper 架构，9.0。软件按它决定能用哪些 kernel。4090 用的是 FlashAttention 2，计算能力 9.x 的卡才会用 FlashAttention 3。本机的计算能力可以这样查，这台机器输出的是 8.9：

```bash
nvidia-smi --query-gpu=name,compute_cap --format=csv
```

### 第五步：decode 先填满最后一个 block

prefill 结束时最后一个 block 还有 13 格空着。decode 的第一个 token 位置是 7219，写进第 451 个逻辑 block 的第 3 格，不需要新 block。之后每一步写一格，填满这个 block 后，位置 7232 的 token 落进第 452 个逻辑 block，调度器这才再取一个空闲 block，追加到表的末尾。

{% include figure.html src="/assets/images/vllm-05-paged-attention/02-decode-fill.jpg" alt="logical block 451 分成三段：offset 0-2 涂成浅蓝，是 prefill 写进的 3 个 token；position 7219 的新 token 沿箭头落进 offset 3 那一格；offset 4-15 空着。右边虚线框是 logical block 452，下方写 allocated when 451 is full；最下方写 slot = physical block x 16 + offset" caption="图 2：decode 的第一个 token 写进第 451 个逻辑 block 的第 3 格（从 0 数），这个 block 写满之后才分配第 452 个" %}

这一轮输出 45 个 token，7,219 加 45 是 7,264，正好 454 个 block，decode 期间一共新分配了 2 个，和第一篇的说法一致。一条请求的最后一个 block 最多空 15 格，也就是 2.1 MiB 左右，分页之后每条请求空占的显存不超过这个数。

### 第六步：请求结束，block 回到空闲池

请求结束时，block table 里的 454 个 block 都不再被这条请求引用，KV 占用指标随之回落（第三篇）。写满的 block 里的内容和哈希保留着，没有被别的请求征用之前，下一轮还能命中；第 3 轮请求到达时，block table 的前 450 项直接用的就是第 2 轮留下的物理 block。为什么是 450 个而不是 453 个，第一篇讲过是对话模板的原因，第六篇讲前缀缓存时再展开。

## 两条请求共用 block

block table 只记编号，所以几条请求的表里可以出现同一个物理 block。第四篇的第 36 步里，会话 0 的第 2 轮在算最后 787 个 token，会话 1 的第 1 轮同时开始：它的 307 个 token 里前 272 个命中缓存，是 system prompt 所在的 17 个 block。这两条请求的 block table 第 0～16 项是同一组物理 block；第 17 项起不同，因为会话 1 的第一句话是“会话 1：……”，从这里起两边的 token 不一样了。会话 1 的第 1 轮只需要为位置 272～306 新分配 3 个 block。

共享的只有写满 16 个 token 的 block：请求的 KV 登记进前缀缓存时只登记整块，没写满的最后一块不登记，别的请求也就命中不了它。新 token 总是写进新分配给这条请求自己的 block，共享的 block 不会被改写，所以这套配置下用不到论文里的写时复制。

把第一步到第六步和共用 block 放到一个缩小的例子里，可以按“下一步”看 block table 怎样一项项长出来，数字是示意：

{% include kv-demo.html id="block-table" caption="图 3：block table 的增长和两条请求共用 block 的示意。虚线框是空闲的 block，里面还写着编号的是挂着哈希、仍能被命中的" %}

一个物理 block 被几条请求引用，在 KV 占用里只算一次。下面用 4 个会话的实验核对这一点。

## 4 个会话时的 block 占用

第一篇里 4 个会话每隔 3 秒启动一个，回放脚本每 0.5 秒读一次 `vllm:kv_cache_usage_perc` 和运行中的请求数。其中两次读数：

| 读数 | KV 占用 | 换算成 block | 运行中 | 等待中 |
| --- | ---: | ---: | ---: | ---: |
| 4 条请求同时运行时 | 77.2% | 1,926 | 4 | 0 |
| 整个实验的峰值 | 98.5% | 2,456 | 3 | 0 |

如果每条请求按 32768 个 token 预先切一段连续显存，任何时刻都只能有 1 条请求在跑。分页之后，4 条请求同时运行只占了 1,926 个 block；峰值时 3 条请求一共占了 2,494 个 block 里的 2,456 个，空闲池几乎用尽。block 大小固定，不会留下放不下东西的空洞，只要空闲 block 的个数够，就能分出去。

峰值那一刻在跑的 3 条请求都已经过了首 token：

| 请求 | prompt token | 输出 token | prompt 占的 block | 输出完时的 block |
| --- | ---: | ---: | ---: | ---: |
| 会话 0 第 6 轮 | 15,670 | 27 | 980 | 982 |
| 会话 1 第 5 轮 | 13,175 | 40 | 824 | 826 |
| 会话 2 第 4 轮 | 10,932 | 49 | 684 | 687 |
| 合计 | | | 2,488 | 2,495 |

读数那一刻每条请求输出到了第几个 token 没有记录，所以三条请求的 block 数加起来在 2,488 到 2,495 之间。三条请求的 block table 开头都是 system prompt 的那 17 个 block，按请求逐条相加时这 17 个算了 3 遍，实际只占 17 个，要减去 34，得到 2,454 到 2,461。指标读到的 2,456 落在这个范围里。如果不减，合计的下限 2,488 就比读数多出 32 个 block，对不上。

## 查表和写 KV 花多少时间

block table 让 KV 可以分散存放，代价是 attention 读 KV 时要多查一次表，每步还要在 GPU 上把表准备好：把这一步新分配的 block 号写进 GPU 上常驻的 block table（只写新增的部分），按这一批的请求取出各自的表行，再算出每个新 token 的格号。这三件事每步各做一次，36 层共用。第八篇会细讲的那次 profiler 结果里可以看到 attention 和写 KV 的开销。那次实验用一个约 1,800 token 的 prompt（这一步算了 1,798 个 token）输出 8 个 token，按 GPU 上每一步的时间统计：

| 项目 | prefill 的一步 | decode 的一步 |
| --- | ---: | ---: |
| 整步 GPU 时间 | 184.5 ms | 15.9 ms |
| attention，36 层合计 | 9.47 ms | 0.65 ms |
| 把新 token 的 KV 写进 block，36 层合计 | 0.26 ms | 0.055 ms |

decode 一行是 7 步的典型值，各步相差不到 0.1 ms。这些是开着 profiler 量的 GPU 时间。profiler 主要拖慢 CPU 一侧，decode 一步加上采样是 17.27 ms，和不开 profiler 时每秒 52 到 58 个 token 对得上。下面只看比例：attention 在 prefill 里占 5%，在 decode 里占 4%；写 KV 在两种步里都不到 0.4%。

## block 大小

block 大小默认是 16，可以用启动参数 `--block-size` 改。`/metrics` 里的 `vllm:cache_config_info` 把这次的配置作为标签列了出来，其中有 `block_size="16"` 和 `user_specified_block_size="False"`。没有指定时，vLLM 先取 16，再看 attention 后端要不要更大的 block；FlashAttention 在这张卡上不改，所以就是 16。

从前面几步能看出 block 大小影响三件事：一条请求最后一个 block 最多空多少格；前缀缓存按整个 block 命中，相同的前缀只有凑满整个 block 的部分能复用，命中数总是 16 的倍数，比如会话 1 第 1 轮的 272 个；block table 有多长，第 6 轮的表有 982 项。block 越大，表越短，但浪费的格和对不齐的前缀都更多。

## 参考资料

- [vLLM](https://github.com/vllm-project/vllm)：本文行为以 v0.32.0 为准，block table 的分配时机和共享方式以这个版本的源码和实测为准。
- vLLM 文档：[Paged Attention](https://docs.vllm.ai/en/latest/design/paged_attention.html)、[Metrics](https://docs.vllm.ai/en/latest/design/metrics.html)。
- Woosuk Kwon 等，[Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180)，SOSP 2023。
- NVIDIA，[CUDA GPU Compute Capability](https://developer.nvidia.com/cuda/gpus)：各型号 GPU 的计算能力列表。
- [vLLM 的 FlashAttention 分支](https://github.com/vllm-project/flash-attention)：按 block table 读 KV 的 attention 算子。
