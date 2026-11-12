---
title: "vLLM 入门（八）：一次前向的完整过程"
description: "用 torch profiler 抓一条请求，看 GPU 上的一次 prefill 和七次 decode：每一层由哪几个矩阵乘组成，decode 为什么一步要 16 毫秒，prefill 怎样用差不多的时间结构算完 1,798 个 token，CUDA Graph 省下的又是哪一部分。"
date: 2026-11-12 14:00:00 +0800
tags: [vLLM, 推理, GPU]
series: vllm
series_order: 8
---

第一篇说，引擎每一步先调度、再做一次前向；第四篇看了调度器怎么把一步的 token 预算分给各个请求。这一篇看前向本身：一步里的 token 进了模型之后，GPU 上依次跑了什么，各花多少时间。第一篇用带宽估算过 decode 一步大约 16 毫秒，这次用 vLLM 自带的 profiler 把它量出来。

行为以 vLLM 0.32.0 为准。机器和模型还是第一篇那台 RTX 4090 和 Qwen3-8B（bf16，36 层）。

## 先看一个缩小的例子

真实模型有 36 层，一步要跑四百多个 GPU 内核，先放到一个只有 2 层的模型里走一遍。prompt 是 t0 到 t3 四个 token，先做 prefill，再做一步 decode。每层的权重分 attention 和 MLP 两份，加上最后的 lm_head 一共 5 份。顺序和 vLLM 0.32.0 一样，数字只是示意，可以按“下一步”一步步看。

{% include forward-demo.html id="forward" caption="图 1：一步前向的示意。左边是这一步正在执行的阶段，右边是这一步喂进模型的 token、每层 KV Cache 的写入和读出，以及这一步已经读过几份权重" %}

这个例子要说明一件事：不管这一步喂进去多少个 token，每一层的权重都要从显存里读出来。prefill 读一遍算 4 个 token，decode 读一遍只算 1 个。KV Cache 的作用也在这里：decode 时前面 4 个 token 的 K、V 已经存着，直接读出来用，不用重算。

下面看真实的一次请求。

## 怎么抓的

vLLM 带了一个 profiler 开关。启动时加上

```bash
vllm serve Qwen/Qwen3-8B ... \
  --profiler-config '{"profiler": "torch", "torch_profiler_dir": "/root/profile"}'
```

服务会多出 `/start_profile` 和 `/stop_profile` 两个接口，调用前者之后开始记录，调用后者时把记录写成文件。文件里有 CPU 上每个操作的起止时间，也有 GPU 上每个内核的起止时间。vLLM 还给每一步打了标记，写明这一步有几个请求在 prefill、算了多少 token，几个请求在 decode，所以能把 GPU 上的内核按步分开。

测的请求是一段 Python 标准库源码加一句“总结下面这段代码的作用”，prompt 一共 1,798 个 token，`temperature` 为 0，`max_tokens` 和 `min_tokens` 都是 8，保证正好输出 8 个 token。开始记录之前先发一条短请求预热。同样的步骤跑了两次，一次是默认启动，一次加了 `--enforce-eager`，下面的数字除特别说明外都来自默认启动的那次。

profiler 会拖慢 CPU 这一侧，GPU 内核本身的耗时基本不受影响：下面量出的 decode 速度是每秒 57.9 个 token，第二篇不开 profiler 测的是 52 到 58 个。

## 整条请求的时间线

{% include figure.html src="/assets/images/vllm-08-forward-pass/01-request-timeline.png" alt="两行横条。下面一行是 GPU：先是一段 184.5 毫秒的 prefill，之后是 7 段等长的 decode，每两段之间夹着一小段 lm_head 和采样，中间没有空隙。上面一行是 CPU：prefill 那一步的 CPU 区间在 GPU 开始之前就开始了，长 70.6 毫秒；之后每个 decode 步的 CPU 区间只有 2 到 6.5 毫秒" caption="图 2：一条请求在 CPU 和 GPU 上的时间线，横轴从 CPU 开始准备第一步算起" %}

请求从发出到收到结果用了 0.387 秒。GPU 上的部分是这样的：

| 阶段 | GPU 耗时 | 内核数 |
| --- | ---: | ---: |
| prefill 一步（1,798 token） | 184.5 ms | 452 |
| lm_head 和采样，得到第 1 个 token | 1.35 ms | 13 |
| 每个 decode 步（1 token） | 15.9 ms | 约 445 |
| 每个 decode 步之后的 lm_head 和采样 | 1.35 ms | 13 |

8 个输出 token，第 1 个来自 prefill，后 7 个各来自一个 decode 步。decode 步一个接一个，从一步开始到下一步开始正好是 17.27 毫秒，中间 GPU 没有空着：上一步的采样一结束，下一步的第一个内核就开始了。

CPU 那一行比 GPU 早。prefill 那一步，CPU 在 GPU 开始之前就开始往 GPU 上排内核，排了 70.6 毫秒，GPU 要算 184.5 毫秒。第 1 个 decode 步的 CPU 区间在 73 毫秒处，那时 GPU 的 prefill 还要再算 130 多毫秒；第 2 个 decode 步的 CPU 区间，在第 1 个 decode 步刚开始在 GPU 上执行时就开始了。

这是默认的异步调度。GPU 在算第 N 步时，CPU 已经把第 N+1 步调度好，把它的内核排在第 N 步后面。第 N+1 步要喂的 token 是第 N 步采样出来的，采样结果写在 GPU 上，第 N+1 步直接从那里取，不用等它拷回 CPU；拷回 CPU、交给 API 服务的那份另外进行。所以 GPU 一步接一步，中间不用等 CPU。每一步 CPU 只用 2 到 6.5 毫秒，GPU 用 17.27 毫秒，这条请求的速度由 GPU 决定。

最后两段灰色的 CPU 区间，是调度了 0 个 token 的步：第 8 个 token 还在 GPU 上算，算完这条请求就够 8 个 token 了，调度器不再给它安排新的 token。

## 一层里有什么

decode 一步的 445 个内核里，开头几个在 GPU 上准备这一步的输入：每个 token 的位置、要喂的 token 编号、请求的 block 表，以及新 token 的 K、V 要写进 KV Cache 的哪个位置。然后是 embedding，之后 36 层，每层十来个内核，顺序和耗时（36 层、7 个 decode 步的平均）是：

| 顺序 | 做什么 | 耗时 |
| ---: | --- | ---: |
| 1 | QKV 投影：一个矩阵乘同时算出 Q、K、V | 54.6 µs |
| 2 | 对 q、k 做 RMSNorm，加旋转位置编码 | 1.4 µs |
| 3 | 把这个 token 的 K、V 写进 KV Cache | 1.6 µs |
| 4 | attention：读出全部 1,799 个位置的 K、V | 18.3 µs |
| 5 | 输出投影 | 38.3 µs |
| 6 | 加上残差，RMSNorm | 1.6 µs |
| 7 | gate、up 投影：一个矩阵乘同时算两个 | 212.0 µs |
| 8 | SiLU 后两者相乘 | 1.1 µs |
| 9 | down 投影 | 109.6 µs |
| 10 | 加上残差，RMSNorm | 1.8 µs |

第 2 行的 RMSNorm 是 Qwen3 的结构：Q、K 算出来之后，每个 head 先各做一次 RMSNorm，再加位置编码。第 6、10 行才是每层前后的那两次 norm，和残差相加合在一个内核里。第 3、4 行的顺序是先写后读，这个 token 的 K、V 写进 KV Cache 之后，attention 读出的就包括它自己。第五篇讲过的按 block 表读 KV，就发生在第 4 行。decode 时这一行是两个内核：FlashAttention 把 1,799 个位置分成几段并行算，再把几段的结果合起来。分不分段由 FlashAttention 自己决定，prefill 那一步就没有分。

一层合计约 441 µs，36 层约 15.9 毫秒。4 个矩阵乘占了 94%，attention 占 5%，其余的 norm、位置编码、激活函数加起来不到 2%。

## decode：每一步读一遍权重

decode 时每个矩阵乘都只乘 1 个 token，计算量很小，耗时几乎全花在把权重从显存读出来上。按每个矩阵的大小（bf16，每个参数 2 字节）和耗时算一下读取速度：

| 矩阵 | 形状 | 大小 | 耗时 | 读取速度 |
| --- | --- | ---: | ---: | ---: |
| QKV 投影 | 6144 × 4096 | 50.3 MB | 54.6 µs | 921 GB/s |
| 输出投影 | 4096 × 4096 | 33.6 MB | 38.3 µs | 876 GB/s |
| gate、up 投影 | 24576 × 4096 | 201.3 MB | 212.0 µs | 950 GB/s |
| down 投影 | 4096 × 12288 | 100.7 MB | 109.6 µs | 918 GB/s |
| lm_head | 151936 × 4096 | 1,245 MB | 1,298 µs | 959 GB/s |

QKV 是 6144 行，因为 Q 有 32 个 head，K、V 各只有 8 个，每个 head 128 维：4096 加 2 × 1024。RTX 4090 公开的显存带宽是 1,008 GB/s，这几个矩阵乘都读到了它的 87% 到 95%。

一步要读的权重是 36 层的 13.9 GB 加上 lm_head 的 1.25 GB，一共 15.1 GB。embedding 那张表和 lm_head 一样大，但每步只按 token 编号取一行，不用整张读。第一篇按全部 15.27 GiB 权重估算是 16 毫秒左右；按 15.1 GB 和 1,008 GB/s 算，下限是 15.0 毫秒，实测一步 17.27 毫秒。

KV Cache 也要读。这一步要读 1,799 个位置的 K、V，每层每个位置 8 个 head × 128 维 × 2（K 和 V）× 2 字节，36 层一共约 265 MB，不到权重的 2%。所以上下文从几百涨到一万多 token，decode 也只是慢一点：第二篇的 6 轮请求，上下文从 307 涨到 15,680 个 token，decode 速度从每秒 58.5 个降到 53 个左右。

### 一步里有多个请求

上面只有 1 个请求。一步里有 N 个请求在 decode 时，每个矩阵乘乘的是 N 行，权重还是只读一遍，所以多出来的请求几乎不加时间。profile 只抓了单个请求，这里用另一组测试看：同时发 N 条一样的请求，每条输出 512 个 token，`temperature` 为 0，在客户端按流式输出算每条请求 decode 的速度，用了两种 prompt。

| 同时的请求数 | 1 | 4 | 8 | 16 |
| --- | ---: | ---: | ---: | ---: |
| prompt 1,714 token：每条的 decode 速度 | 58.0 | 54.6 | 53.1 | 50.3 |
| prompt 1,714 token：总吞吐 | 57.8 | 216.6 | 420.2 | 792.6 |
| prompt 6,914 token：每条的 decode 速度 | 55.5 | 50.1 | 46.2 | 39.2 |
| prompt 6,914 token：总吞吐 | 55.1 | 198.0 | 363.4 | 613.1 |

单位都是每秒 token 数。prompt 短的那组，16 条请求一起跑，每条只从每秒 58 个降到 50 个，总吞吐涨到 13.7 倍。按每条的速度换算，一步从 17 毫秒左右变成 20 毫秒左右，这一步出了 16 个 token。

prompt 长的那组降得多，16 条时每条只有每秒 39 个，一步约 25 毫秒。两组的请求数一样，读的权重也一样，差别只在上下文长度，也就是 attention：每条请求都要和自己的 6,900 多个 token 算一遍，attention 的工作量随请求数和上下文长度一起涨，16 条长请求时就不能忽略了。

这组测试的 N 条请求 prompt 完全相同，开着前缀缓存，prompt 的 KV 是共用的；N 条请求同时到达，有的请求开始 decode 时别的还在 prefill，每条的速度会略低一点。这里的“一步”是从客户端的速度换算的，和上面 profile 的 GPU 时间不是一种量法，不能直接放在一起比。

## prefill：同样的结构，算 1,798 个 token

prefill 那一步的 36 层，每层也是这些操作、同样的顺序，只是每个矩阵乘一次乘 1,798 行：

{% include figure.html src="/assets/images/vllm-08-forward-pass/02-layer-breakdown.png" alt="两条横向的百分比堆叠条。上面一条是 prefill 一步的每层，合计 4.91 毫秒：QKV 612 微秒，attention 很窄，输出投影 394 微秒，gate/up 2.29 毫秒，down 1.12 毫秒；下面一条是 decode 一步的每层，合计 0.44 毫秒：QKV 55 微秒，输出投影 38 微秒，gate/up 212 微秒，down 110 微秒。两条的各段比例几乎一样" caption="图 3：prefill 和 decode 每层的耗时构成，36 层平均" %}

prefill 每层 4.91 毫秒，是 decode 的 11 倍，算的 token 却是 1,798 倍。平均下来 prefill 每个 token 约 0.1 毫秒，decode 每个 token 要 16 毫秒。这一步每层的权重同样要读一遍，按 386 MB 和 1,008 GB/s 算只要 0.38 毫秒，剩下的时间花在计算上，所以 prefill 的耗时由 GPU 的算力决定，decode 的耗时由显存带宽决定。

两条的比例很像，是因为不管 prefill 还是 decode，大头都在这 4 个矩阵乘上，它们的大小之比是固定的。不同的是 attention：1,798 个 token 时它只占 5.5%，但每个 token 都要和前面所有 token 算一遍，整段 prompt 的 attention 计算量和长度的平方成正比，prompt 越长占比越大。第五篇引用过这次的 attention 时间，36 层合计 prefill 9.47 毫秒、decode 0.65 毫秒。

## lm_head 和采样

36 层算完之后，lm_head 把最后一层的输出乘上一个 151936 × 4096 的矩阵，得到词表里每个词的分数。prefill 之后的 lm_head 用了 1,298 µs，和 decode 之后的一样。乘 1,798 行和乘 1 行，耗时会差很多，一样说明这一步只对最后一个位置算了分数：前面的位置不需要预测下一个 token，它们的输出算完就不用了。分块 prefill 时，还没算完 prompt 的那几块也会对最后一个位置算一次 lm_head，只是采样结果被丢掉。

采样在 lm_head 之后，十来个小内核加上把结果拷回 CPU，一共约 0.05 毫秒。这条请求的 `temperature` 是 0，也就是每次取分数最高的词，vLLM 0.32.0 走的还是和随机采样同一条路径，只是温度为 0 时不加随机噪声，结果和直接取最大值一样。`min_tokens` 是 8，所以前 7 个 token 采样之前，结束符的分数会被压到最低，保证不会提前结束。

## CUDA Graph 省掉了什么

第二篇说过，默认启动时 vLLM 会捕获 CUDA Graph，加 `--enforce-eager` 就不用，decode 速度慢 2% 到 22%。这次两种启动都抓了 profile，对比 decode 的一步：

| | 默认 | `--enforce-eager` |
| --- | ---: | ---: |
| 每步内核数 | 444 | 516 |
| 每步 GPU 实际在算的时间 | 15.9 ms | 16.0 ms |
| 整条请求 CPU 逐个发射内核的次数 | 519 | 3,890 |
| 整条请求回放 CUDA Graph 的次数 | 7 | 0 |

GPU 上算的时间几乎一样，矩阵乘是同样的内核。eager 多出来的 72 个内核，是 norm、旋转位置编码、激活函数这些小操作：默认模式下 torch.compile 把相邻的几个合成了一个内核，eager 时各跑各的。它们本来就只占一层的 2%，合并后省下的 GPU 时间不到 0.1 毫秒。

差别在 CPU 那一侧。eager 时 CPU 要把每一步的五百多个内核一个个发给 GPU，整条请求发了 3,890 次，和 GPU 上跑的内核数一样。默认模式下，decode 的一步只有 1 个请求、1 个 token，正好用上第二篇说的 FULL 图，36 层连同 attention 是一次图回放，7 个 decode 步就是那 7 次。1,798 个 token 的 prefill 超过了 512，不用图，它的 452 个内核还是一个个发射；lm_head 和采样不在图里，每步之后也要单独发射。加起来是 519 次。

eager 的这次 profile，每个 decode 步从开始到结束是 38 到 40 毫秒，GPU 有 23 毫秒在等 CPU。这个数不能当真：只写 `"profiler": "torch"` 时，profiler 默认会记录 Python 调用栈，eager 的 trace 里有 9 万多条 Python 调用，CPU 这一侧被拖慢了多少说不清（可以用 `--profiler-config.torch_profiler_with_stack=false` 关掉）。不开 profiler 时的差距看第二篇的实测：上下文 307 个 token 时每秒 58.5 个对 48.0 个，上下文一万五千多时只差 2% 到 4%。

prefill 两种启动差不多，184.5 毫秒对 186.9 毫秒。这一步本来就不用图，时间花在 GPU 计算上，CPU 早早地把内核排好了。

## 参考资料

- [vLLM](https://github.com/vllm-project/vllm)：本文行为以 v0.32.0 为准，profiler 的用法、一步前向的顺序和 CUDA Graph 的使用方式以这个版本的源码为准。
- vLLM 文档：[Profiling vLLM](https://docs.vllm.ai/en/latest/contributing/profiling.html)。
- Qwen 团队，[Qwen3 Technical Report](https://arxiv.org/abs/2505.09388)：模型结构，包括 attention 里对 q、k 的 RMSNorm。
- NVIDIA，[GeForce RTX 4090 规格](https://www.nvidia.com/en-us/geforce/graphics-cards/40-series/rtx-4090/)：显存带宽 1,008 GB/s。
