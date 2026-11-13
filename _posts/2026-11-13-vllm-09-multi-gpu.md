---
title: "vLLM 入门（九）：多卡并行下的 KV"
description: "把 Qwen3-8B 用 TP=2 放到两张没有 NVLink 的 RTX 4090 上：每张卡的 KV 头和每 token 字节怎么变，block 数为什么涨到单卡的 4.7 倍，一步前向里多出的 73 次 all-reduce 花了多少时间，再和 PP=2、DP=2 对比。"
date: 2026-11-13 00:00:00 +0800
tags: [vLLM, 推理, KV Cache, GPU]
math: true
series: vllm
series_order: 9
---

前八篇都在一张 RTX 4090 上。第二、三篇看过，Qwen3-8B 的权重占了 15.27 GiB，留给 KV Cache 的只有 5.48 GiB，不到 4 万个 token；第七篇里 4 个会话就把它用满了。这一篇换成两张卡，用张量并行（TP=2）把同一个模型切开放，看每张卡上的 KV 怎么变、能多放多少、一步前向多付出了什么；最后和流水线并行（PP=2）、两份独立副本（DP=2）对比一下。

行为以 vLLM 0.32.0 为准。这次是另一台机器：2 张 RTX 4090 24 GB，PCIe Gen4 x16，两张卡在同一个 NUMA 节点下，没有 NVLink，`nvidia-smi topo -p2p r` 显示两卡之间不支持 P2P；驱动 595.71.05，torch 2.13.0（CUDA 13.0），模型还是 Qwen3-8B（bf16）。服务参数和前几篇一样：`--max-model-len 32768`，开前缀缓存，`--gpu-memory-utilization` 用默认的 0.92。单卡的数字在这台机器上重测了，单条请求 decode 每秒 58.0 个 token，和前几篇那台差不多。

## 先看一个缩小的例子

先把显存画成每张卡 24 格。单卡时权重占 16 格，其他用途占 2 格，一个 block 占 2 格；换成两张卡，看每张卡的格子怎么分。规则和 vLLM 0.32.0 一样，格数大致按实测比例取整，可以按“下一步”一步步看。

{% include kv-demo.html id="tp-split" caption="图 1：单卡和 TP=2 时每张卡的显存。灰色是权重，灰紫色是其他用途，彩色是请求占的 block，格内是 block 编号，两张卡上编号相同的格子合起来是一个完整的 block" %}

这个例子里 block 变多有两个原因。一是每张卡只放一半权重，空出来的显存都给了 KV；二是每张卡只存一半的 KV 头，一个 block 在每张卡上只有一半大。两个因素乘起来，block 数从 3 个涨到 14 个，是 4.7 倍，涨得比卡数快。代价是每一步两张卡要多次交换结果。下面看实测。

## 启动：每张卡上的显存

启动命令只多一个参数：

```bash
vllm serve Qwen/Qwen3-8B --max-model-len 32768 --enable-prefix-caching \
  --tensor-parallel-size 2
```

服务起来后有两个 worker 进程，日志前缀是 `Worker_TP0` 和 `Worker_TP1`，各管一张卡。调度器还是只有一个，在引擎进程里，每一步把同一份调度结果发给两个 worker。和单卡的启动日志对比：

| | 单卡 | TP=2 |
| --- | ---: | ---: |
| 每张卡的模型权重（`Model loading took`） | 15.27 GiB | 7.64 GiB |
| 每张卡的 KV Cache（`Available KV cache memory`） | 5.48 GiB | 12.97 GiB |
| KV Cache 容量（`GPU KV cache size`） | 39,920 token | 188,912 token |
| block 数（`/metrics` 里 `vllm:cache_config_info` 的 `num_gpu_blocks`） | 2,495 | 11,807 |

权重减半，是因为每一层的矩阵都按 TP 切成两半，embedding 和 lm_head 也按词表切开，每张卡各放一半。省下的 7.63 GiB 几乎全给了 KV，每张卡的 KV 从 5.48 GiB 涨到 12.97 GiB，多了 7.49 GiB，是原来的 2.37 倍。剩下的 1.3 到 1.5 GiB 是第二篇说过的激活、CUDA Graph 这些，两种启动差不多。

### 每个 token 在每张卡上多大

第三篇算过单卡时每个 token 的 KV：

$$
2 \times 36 \times 8 \times 128 \times 2 = 147456 \text{ 字节} = 144 \text{ KiB}
$$

8 是 KV 头数。TP=2 时每一层的 8 个 KV 头分到两张卡上，每张卡存 4 个：

$$
2 \times 36 \times 4 \times 128 \times 2 = 73728 \text{ 字节} = 72 \text{ KiB}
$$

层数不变，36 层每张卡都有，只是每层只有一半的头。一个 block 还是 16 个 token，每张卡上是 1.125 MiB，单卡是 2.25 MiB。12.97 GiB 除以 1.125 MiB 约是 11,806，和指标里的 11,807 对得上（12.97 是四舍五入过的）。

block 数是单卡的 4.7 倍：KV 显存是 2.37 倍，每个 block 又只有一半大。按两张卡加起来算，一个 token 还是 144 KiB，只是分在两张卡上存。

block 编号只有一套。调度器给请求分 block 时只分编号，两个 worker 拿到同一份 block 表，各自用这个编号去自己那张卡的 KV 里找位置，里面存的是本卡那 4 个头。第五篇讲的 block table、第六篇的前缀缓存、第七篇的抢占都还是一份，和单卡时一样，只是每个 block 的内容分在两张卡上。

### 两张卡的 block 数怎么统一

既然编号只有一套，两张卡的 block 数必须一样。启动时每个 worker 先按自己那张卡的可用显存算出能放多少个 block，再取两张卡里最小的那个，两边都按这个数分配。

日志里这两步各有一行，意思不一样。`Available KV cache memory: 12.97 GiB` 只由本机的第一个 worker（这里是 `Worker_TP0`）打印，是它那张卡在取最小值之前的数；`GPU KV cache size: 188,912 tokens` 是取最小值之后的容量，等于 11,807 个 block 乘 16。TP=2 时两张卡的显存用法一样，两个数对得上；后面 PP=2 那一节两个数就差了一点。

### 冷启动

这台机器上第一次启动单卡时，服务没起来：

```text
ValueError: To serve at least one request with the model's max seq len (32768), (4.5 GiB KV cache is needed, which is larger than the available KV cache memory (4.48 GiB).
```

第三篇提过，没有编译缓存的冷启动，启动时测出来的显存峰值更高，留给 KV 的更少。这一次少到放不下一条 32768 个 token 的请求，第二次启动有了编译缓存，才是 5.48 GiB。DP=2 第一次启动也一样起不来。TP=2 则第一次和第二次都是 12.97 GiB。

把编译缓存挪走，打开 `VLLM_LOGGING_LEVEL=DEBUG` 再各启动一次，日志里每个 worker 会多打一行启动时测显存的明细：

| | 测显存用时 | PyTorch 显存峰值的增量 | KV 以外的显存 | KV |
| --- | ---: | ---: | ---: | ---: |
| 单卡，热启动 | 2.1 s | 0.20 GiB | 15.72 GiB | 5.48 GiB |
| 单卡，冷启动 | 42.6 s | 1.19 GiB | 16.72 GiB | 4.49 GiB |
| TP=2，热启动（每张卡） | 2.8 s | 0.22 GiB | 8.04 GiB | 12.97 GiB |
| TP=2，冷启动（每张卡） | 45.5 s | 0.22 GiB | 8.04 GiB | 12.97 GiB |

两种配置的冷启动都在这一步里编译了 40 多秒。单卡编译时的显存峰值多了约 1 GiB，KV 就少了约 1 GiB；TP=2 编译时这个峰值和热启动一样，KV 也就一样。为什么切成两半之后编译时没有多出这 1 GiB，原因未查清。

## 一步前向里多了什么

TP=2 时每一层的计算也分到两张卡上：QKV 投影和 gate、up 投影按输出切开，每张卡算自己那一半的头和中间维；输出投影和 down 投影按输入切开，每张卡算出的是一份部分和，两份加起来才是这一层的输出。所以每层的 attention 和 MLP 各要做一次 all-reduce，把两张卡的部分和加起来，两张卡都拿到完整的结果，再进入下一部分。embedding 按词表切开后，每张卡只查得到一半的词，查完也要 all-reduce 一次。

一步前向就是 1 + 36 × 2 = 73 次 all-reduce。lm_head 之后还有一次 all-gather，把两张卡各自那一半词表的分数拼起来，再做采样。profile 里看到的正是这些：这条请求 8 步（1 次 prefill、7 次 decode），每张卡的 trace 里有 584 次 NCCL 的 all-reduce 内核，正好 8 × 73，all-gather 是 8 次。默认启动时，这 73 次 all-reduce 和前向一起被捕获进 CUDA Graph，decode 一步还是一次图回放。

### 两张卡之间怎么传

这台机器没有 NVLink，也不支持 P2P。启动日志里两个 worker 各打了一行：

```text
Custom allreduce is disabled because your platform lacks GPU P2P capability or P2P test failed.
```

vLLM 自己的 all-reduce 实现要求两张卡能直接读写对方的显存，不满足就关掉。还有一种 FlashInfer 的 all-reduce，日志说 `world_size=2` 不支持；实际原因是它只支持更新一代的卡，RTX 4090 不在其中。剩下的就是 NCCL。NCCL 自己发现两卡之间不能 P2P，选了经过主机内存中转的方式，打开 `NCCL_DEBUG=INFO` 能看到 `via SHM/direct/direct`。

用一个两进程的小程序单独测了 NCCL 的 all-reduce（bf16，1 MB 及以下 200 次、更大的 50 次取平均，CPU 计时，带宽是消息大小除以用时）：

| 消息大小 | 8 KB | 256 KB | 1 MB | 4 MB | 16 MB | 64 MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 每次用时 | 50.6 µs | 50.8 µs | 93.2 µs | 306 µs | 1,154 µs | 4,480 µs |
| 带宽 | 0.16 GB/s | 5.2 GB/s | 11.3 GB/s | 13.7 GB/s | 14.5 GB/s | 15.0 GB/s |

小消息每次 50 µs 左右，和大小无关；大消息最多每秒 15 GB 左右。

### decode：通信只占 7%

用和第八篇一样的方法抓了一条请求：prompt 1,798 个 token，输出 8 个。单卡也在这台机器上重抓了一次。

{% include figure.html src="/assets/images/vllm-09-multi-gpu/02-step-time.png" alt="两组横条。左边是 decode 一步：单卡 15.9 毫秒；TP=2 的卡 0 是 9.2 毫秒，其中末尾一小段橙色的 all-reduce 是 0.6 毫秒。右边是 1,798 个 token 的 prefill 一步：单卡 186.3 毫秒；TP=2 的卡 0 是 179.7 毫秒，其中橙色的 all-reduce 占了 84.0 毫秒，差不多一半" caption="图 2：一步里 GPU 内核的耗时，TP=2 时橙色是 NCCL 的 all-reduce。decode 是各步的平均，都不含 lm_head 和采样" %}

decode 一步从 15.9 ms 降到 9.2 ms。其中 all-reduce 一共 0.64 ms，73 次，每次约 8.7 µs，只占这一步的 7%。剩下的 8.6 ms 里大头还是读权重：第八篇算过一步要读 15.1 GB 权重，现在每张卡只读一半，7.55 GB，按 1,008 GB/s 算下限是 7.5 ms。

graph 里每次 all-reduce 的内核只有 8.7 µs，比上面小程序测的 50 µs 短得多。又写了一个小程序，把同一个 8 KB 的 all-reduce 换几种方式量，跑了两次：

| 量法 | 第一次 | 第二次 |
| --- | ---: | ---: |
| 每次调用完等 GPU 做完，CPU 计时（上面小程序的量法） | 80.6 µs | 44.8 µs |
| 连着发、中间不等，平均每次 | 38.6 µs | 38.6 µs |
| 其中 CPU 发一次调用本身 | 39.2 µs | 33.4 µs |
| 73 次捕获进一个 CUDA Graph 再回放，平均每次 | 17.8 µs | 17.8 µs |
| 回放时 NCCL 内核本身 | 7.5 µs | 9.3 µs |

连着发时，平均每次的时间和 CPU 发一次调用的时间差不多，GPU 是在等 CPU。放进 CUDA Graph 后这部分没有了，内核本身 7.5 到 9.3 µs，和 vLLM 里的 8.7 µs 量的是同一样东西。所以 50 µs 里大部分是不用 graph 时一次调用在 CPU 上的开销，内核本身不到 10 µs。小程序的 graph 里平均每次 17.8 µs、内核只占一半，73 次 all-reduce 紧挨着排，相邻两个之间还有约 9 µs 的空隙，这段空隙由什么组成，原因未查清。vLLM 的 decode 图不是这样排的：all-reduce 和每层的计算录在同一张图里，两次 all-reduce 之间隔着的是下一部分的计算；上面的 0.64 ms 是 73 个内核各自的时长相加，不含内核之间的空隙。第一行两次差了近一倍，这种量法只能看量级。

客户端看到的 decode 速度从每秒 58.0 个 token 涨到 100.3 个，是 1.73 倍，不到 2 倍：每张卡的计算从 15.9 ms 降到 8.6 ms，不是正好一半，再加上 0.64 ms 的通信。

### prefill：通信占了一半

prefill 那一步几乎没快：单卡 186.3 ms，TP=2 是 179.7 ms，其中 all-reduce 占了 84.0 ms。每次 all-reduce 约 1.1 ms，传的是这一步全部 1,798 个 token 的 hidden state，每个 token 4096 维、bf16，一次 14.7 MB，和小程序里 16 MB 用 1.15 ms 对得上。计算部分确实减半了，从 186 ms 降到 96 ms，省下的时间又被通信花掉了。

更长的 prompt 也一样。一条 16,087 个 token 的请求，只输出 1 个 token，3 次的首 token 时间平均，单卡是 2.21 秒，TP=2 是 1.89 秒，只快了 15%。

压测时用 `nvidia-smi dmon` 看了 PCIe 流量：TP=2 时每张卡平均收发各 4 到 5 GB/s，最高 7 GB/s；单卡时只有 10 MB/s 左右。

### eager 时两张卡在互相等

加 `--enforce-eager` 又抓了一次（这次关掉了 Python 调用栈的记录）。decode 一步从开始到结束是 38 到 45 毫秒，GPU 上真正在算的时间和默认启动差不多。两张卡的 all-reduce 内核时间差得很远：卡 1 上每次约 600 µs，卡 0 上约 7 µs。

all-reduce 要两张卡都到了才能完成，先到的那张卡会在内核里等。两张卡的 trace 用的是同一个时钟，把 decode 里的 511 次 all-reduce 按顺序一一对上：卡 1 的内核比卡 0 早开始，中位数早 594 µs；两边的内核却在同一时刻结束，相差不到 1 µs。所以卡 1 的 600 µs 里约 594 µs 是在等卡 0 进来，两张卡都到齐以后，这次 all-reduce 只用了 7 µs 左右，就是卡 0 看到的那个数。

再往前看是谁慢。卡 0 上，CPU 发出一个 all-reduce 之后 9 µs，GPU 就开始执行，GPU 一直在等 CPU 发下一个内核；卡 1 上，CPU 发出的内核要过 24 ms 左右 GPU 才轮到它，CPU 跑在 GPU 前面很远。同一次 all-reduce，卡 0 的 CPU 比卡 1 晚发约 24.6 ms（中位数）。也就是卡 0 那一侧 CPU 发内核跟不上，卡 1 每次都先到、先等。两个 worker 每步拿到的是同一份广播的输入，前向里调用 all-reduce 的代码也一样；不对称的地方是每步结束时只有卡 0 要把采样结果拷回来、交还给引擎，卡 1 跑完就去取下一步。这一处能不能解释 24.6 ms 的差，原因未查清。所以 eager 的 profile 里，all-reduce 内核的时间不能直接当成通信用的时间。

## 多条请求：KV 多了，抢占没了

单条请求只快了一点，TP=2 的好处主要在 KV 多了。用同一组请求压测：同时发 N 条请求，prompt 都是 1,816 个 token 左右，每条开头加了编号，前缀缓存命中不了；每条输出 256 个 token。

{% include figure.html src="/assets/images/vllm-09-multi-gpu/03-concurrency.png" alt="两张折线图，横轴是同时发出的请求数 1、4、16、32、64。左图是总吞吐：单卡在 16 条之后停在每秒 460 个 token 左右，32 和 64 条时分别标着 2 次和 6 次抢占；TP=2 一直往上涨到 917；PP=2 涨到 1,104；DP=2 在 32 条时是 919，64 条时 899，标着 4 次抢占。右图是首 token 时间的中位数：单卡 64 条时跳到 12.6 秒，TP=2 是 5.9 秒，PP=2 和 DP=2 是 3.4 到 3.6 秒" caption="图 3：并发压测的总吞吐和首 token 时间中位数，点下方的数字是这组请求里的抢占次数" %}

| 同时的请求数 | 1 | 4 | 16 | 32 | 64 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 单卡：总吞吐 | 55.6 | 183.6 | 469.9 | 460.9 | 460.2 |
| 单卡：KV 占用峰值 | 5% | 21% | 82% | 100% | 100% |
| TP=2：总吞吐 | 92.8 | 285.3 | 630.3 | 786.0 | 917.1 |
| TP=2：KV 占用峰值 | 1% | 4% | 17% | 35% | 69% |

吞吐的单位是每秒 token 数。单卡到 16 条请求时 KV 已经用了 82%，32 条时用满，同时在跑的最多只有 21 条，其余的在等待队列里，还抢占了 2 次；64 条时抢占 6 次，首 token 时间的中位数到了 12.6 秒，吞吐停在每秒 460 个。TP=2 时 64 条全都在跑，KV 只用到 69%，没有抢占。

再看第一篇那种编程智能体：8 个会话每隔 3 秒启动一个，每个 6 轮，每轮最多输出 256 个 token。8 个会话最后一轮的 prompt 加起来是 10 万 4 千多个 token，单卡的 39,920 个放不下。单卡跑完用了 66.2 秒，KV 占用最高 99.4%，那时 4 条在跑、4 条在等，最慢的一轮 14.8 秒；这次没有抢占，和第七篇一样，放不下的请求在等待队列里等。TP=2 用了 32.1 秒，KV 最高 29.5%，最慢的一轮 2.7 秒。

## 换成 PP=2 和 DP=2

两张卡还有另外两种用法，用同一组压测对比。

### PP=2：每张卡 18 层

`--pipeline-parallel-size 2` 把 36 层分成两段，卡 0 算前 18 层，卡 1 算后 18 层，卡 0 算完把这一段的 hidden state 发给卡 1，KV 不在卡之间传。embedding 在卡 0，lm_head 在卡 1。每张卡的权重也是 7.64 GiB。

每张卡只为自己那 18 层存 KV，KV 头不切，每层还是 8 个：

$$
2 \times 18 \times 8 \times 128 \times 2 = 73728 \text{ 字节} = 72 \text{ KiB}
$$

和 TP=2 一样是每张卡 72 KiB，只是切法不同：TP 切头，PP 切层。block 编号同样只有一套，两张卡的 block 数取最小的那个。热启动时 `Available KV cache memory` 是 13.46 GiB，按 72 KiB 一个 token 能放 196,000 个左右，`GPU KV cache size` 却是 193,648 个，即 12,103 个 block。前一个数是卡 0 取最小值之前的，后一个是取最小值之后的，差了 2,400 个 token 左右，约 148 个 block。

打开 DEBUG 日志后，两张卡各打了自己的显存明细。每张卡按 0.92 能用 21.64 GiB；KV 以外的显存卡 0 是 7.87 GiB，卡 1 是 8.05 GiB。另一行日志说，把 CUDA Graph 的显存算进去以后，0.92 相当于不算时的 0.9067（卡 1 是 0.9075），按 23.52 GiB 的总显存折算，卡 0 是 0.31 GiB，卡 1 是 0.29 GiB。用 21.64 减去这两项，卡 0 得 13.46 GiB，正是日志打印的那个数；卡 1 得 13.30 GiB，除以 1.125 MiB 是 12,103 个 block，正是取最小值之后的数。TP=2 两张卡用同样的算法都得 12.97 GiB，所以两行对得上。

148 个 block 就是卡 1 少的这 0.16 GiB：KV 以外的显存多了 0.18 GiB，CUDA Graph 那部分少了 0.02 GiB。卡 1 是最后一段，启动测显存时比卡 0 多跑了 lm_head 和采样。但这 0.18 GiB 不在 PyTorch 显存峰值里（两张卡都是 0.2 GiB），也不在权重里（两张卡都是 7.64 GiB），是测完、回收以后仍然占着的一块。具体是哪一块分配留下的，原因未查清。

PP 下引擎同时维持几个还没算完的批次，默认是 3 个，两张卡各算一个，再多一个用来和 CPU 的调度重叠。一条长 prompt 的 prefill 本来就按每步 2048 个 token 分块，前一块在卡 1 上算时，后一块已经可以在卡 0 上算。

测出来的数：

| | 单卡 | TP=2 | PP=2 | DP=2 |
| --- | ---: | ---: | ---: | ---: |
| KV Cache 容量 | 39,920 | 188,912 | 193,648 | 39,920 × 2 |
| 单条请求的 decode 速度 | 58.0 | 100.3 | 57.9 | 57.8 |
| 64 条并发的总吞吐 | 460.2 | 917.1 | 1,104.3 | 899.1 |
| 64 条并发的首 token 中位数 | 12.56 s | 5.92 s | 3.55 s | 3.38 s |
| 16,087 token 的 prefill | 2.21 s | 1.89 s | 1.32 s | 2.19～2.34 s |

PP=2 的单条 decode 和单卡一样快，64 条并发时吞吐最高，16k 的 prefill 也最快。为了看两张卡各忙了多久，又给单卡、TP=2、PP=2 各抓了 profile。开着 profiler 时内核会变慢，下面的毫秒数只用来比例，不和上表直接比。

16,085 个 token 的 prefill，只算计算的内核，不算 NCCL：

| | 单卡 | TP=2 | PP=2 |
| --- | ---: | ---: | ---: |
| 卡 0 在算 | 2,086 ms | 1,069 ms | 1,028 ms |
| 卡 1 在算 | — | 1,138 ms | 1,103 ms |
| 两张卡同时在算 | — | 1,027 ms | 923 ms |
| 每张卡的 NCCL 内核 | — | 650～719 ms | 38～102 ms |
| 整段 | 2,093 ms | 1,795 ms | 1,225 ms |

两种切法每张卡算的量都是单卡的一半左右，差在剩下的时间。TP=2 的 all-reduce 和计算一个接一个地排着，每张卡还有约 0.7 秒在 all-reduce，这段时间不算东西。PP=2 的时间线是这样的：开头约 100 ms 只有卡 0 在算第一个 2048 token 的块；之后两张卡同时忙，卡 1 算第 k 块的后 18 层，卡 0 同时算第 k+1 块的前 18 层；最后约 150 ms 只剩卡 1 算最后一块。两段之间每块只传一次 hidden state，NCCL 只占几十毫秒。

64 条并发时也各抓了一段：

| | TP=2：两张卡同时在算 | TP=2：all-reduce 占的时间 | PP=2：两张卡同时在算 |
| --- | ---: | ---: | ---: |
| prefill 和 decode 混在一起的 1 秒 | 51% | 46% | 78% |
| 只剩 decode 的 1 秒 | 78% | 20% | 84% |

只剩 decode 时，PP=2 的卡 0 每段算 29.5 ms，卡 1 每段 31.5 ms，两张卡错开约 15 ms 交替进行。不开 profiler 的压测里，64 条时 TP=2 和 PP=2 每条请求的 decode 速度差不多（每秒 22.2 和 23.3 个 token），差在首 token 时间，中位数 5.92 秒和 3.55 秒。所以 PP=2 吞吐高出的部分主要来自这 64 条 prompt 的 prefill，原因和上面的长 prompt 一样。只剩 decode 时两者谁更快，这次没有单独测。PP=2 压测时每张卡的 PCIe 接收平均 2.7 GB/s，比 TP=2 少。

### DP=2：两份完整的模型

`--data-parallel-size 2` 是在两张卡上各起一个完整的引擎，各有自己的调度器和 KV，API 服务按两个引擎的负载分配请求，谁的运行加等待的请求少就给谁，KV 占用过半时还会把等待的请求数加权算进去。

每个引擎都是单卡的样子：权重 15.27 GiB，KV 5.48 GiB，39,920 个 token。两张卡加起来是 79,840 个 token，不到 TP=2 的一半，因为权重存了两份。单条请求只落在一张卡上，速度和单卡一样；4 到 32 条时，首 token 时间是几种里最短的；64 条时两个引擎的 KV 都用满了，抢占 4 次。

`/metrics` 里每个指标都带 `engine` 标签，两个引擎各报各的。KV 占用要分开看，加起来不是一个整体的占用率：压测脚本把两个值加在一起，64 条时是 1.99，也就是两个都接近 100%。

DP=2 时两张卡之间几乎没有流量，PCIe 只有每秒 10 MB 左右。

## 从日志和指标看多卡

和这一篇有关的日志行和指标：

- `Model loading took ... GiB`：每个 worker 各打一行，是这张卡上的权重。
- `Available KV cache memory: ... GiB`：只由本机第一个 worker 打，是它那张卡在取最小值之前的可用显存。
- `GPU KV cache size: ... tokens`：引擎打一行，按所有卡里最小的 block 数算。
- `Memory profiling takes ... Total non KV cache memory ...`：`VLLM_LOGGING_LEVEL=DEBUG` 时每个 worker 各打一行，可以看每张卡自己的显存明细，对照上一行找出是哪张卡最少。
- `Custom allreduce is disabled ...`：没有 P2P 时出现，all-reduce 改用 NCCL。
- `vllm:kv_cache_usage_perc`、`vllm:cache_config_info` 里的 `num_gpu_blocks`：TP 和 PP 只有一个引擎，一个值；DP 每个引擎一个，按 `engine` 标签分开。

## 参考资料

- [vLLM](https://github.com/vllm-project/vllm)：本文行为以 v0.32.0 为准，KV 头的切分、block 数的统一、all-reduce 的位置和实现、PP 的分层和批次数、DP 的请求分配以这个版本的源码为准。
- vLLM 文档：[Parallelism and Scaling](https://docs.vllm.ai/en/latest/serving/parallelism_scaling/)。
- Mohammad Shoeybi 等，[Megatron-LM: Training Multi-Billion Parameter Language Models Using Model Parallelism](https://arxiv.org/abs/1909.08053)：按列、按行切矩阵乘，每层两次 all-reduce 的张量并行做法。
- NVIDIA，[NCCL 文档](https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/index.html)：`NCCL_DEBUG` 和传输方式。
