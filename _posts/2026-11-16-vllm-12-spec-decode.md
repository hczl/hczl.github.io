---
title: "vLLM 入门（十二）：投机解码与 MTP"
description: "在一张 RTX 4090 上给 Qwen3-8B 开 ngram、EAGLE-3 和 Qwen3-0.6B 草稿三种投机解码，再在 Qwen3.5-4B 上开 MTP：一步验证怎么走，草稿的 KV 为什么让 32768 的服务起不来，接受率在照抄代码、中文、英文三种输出上差多少，哪些情况比不开还慢。"
date: 2026-11-16 15:00:00 +0800
tags: [vLLM, 推理, 投机解码, GPU]
series: vllm
series_order: 12
---

第八篇看过，decode 一步里每条请求只出一个 token，时间的大头是把 15.1 GB 权重从显存读一遍，算得并不多。投机解码利用的就是这一点：先用便宜的办法猜出后面几个 token，再让目标模型在一步里把这几个位置一起验证，猜对几个就前进几个。投机解码是这套“先猜、再验证”的框架，猜的办法有好几种。MTP（multi-token prediction）是其中一种，用模型训练时自带的一层来出草稿，专门预测再往后的 token；它和从上下文里抄的 ngram、单独训练的 EAGLE-3 小网络、另找一个小模型当草稿是并列的，不是投机解码的别名。这一篇看 vLLM 里一步验证怎么走，四种猜法各要多少显存、能猜对多少、实际快了多少。

行为以 vLLM 0.32.0 为准。机器是第九篇那台，这次只用一张 RTX 4090 24 GB；驱动 595.71.05，torch 2.13.0（CUDA 13.0）。目标模型还是 Qwen3-8B（bf16）。服务参数和前几篇一样：`--max-model-len 32768`，开前缀缓存，`--gpu-memory-utilization` 用默认的 0.92。请求一律关掉思考模式，temperature 0。Qwen3-8B 没有 MTP 层，MTP 换在 Qwen3.5-4B 上测，只和 Qwen3.5-4B 自己不开投机时比。

## 一步验证怎么走

投机解码在启动时用 `--speculative-config` 打开，参数是一段 JSON，`method` 选猜法，`num_speculative_tokens` 是每步猜几个，下文记作 k。例如用一个小模型当草稿，每步猜 4 个：

```bash
vllm serve Qwen/Qwen3-8B --max-model-len 32768 --enable-prefix-caching \
  --speculative-config '{"method": "draft_model", "model": "Qwen/Qwen3-0.6B", "num_speculative_tokens": 4}'
```

打开以后，每条请求的一步 decode 变成下面这样，可以按“下一步”看：

{% include kv-demo.html id="spec-verify" caption="图 1：一步投机解码，k = 4。上面是这条请求的输出，下面是目标模型这一步在 5 个位置上各自选的 token，和正上方的草稿比较" %}

1. 起草。用便宜的办法猜出接下来的 k 个 token，叫草稿。
2. 验证。调度器给这条请求排 k + 1 个 token：上一步最后输出的那个，加 k 个草稿。目标模型一次前向把这 k + 1 个位置都算出来，每个位置给出它自己会选的下一个 token。
3. 比较。从第一个草稿往后比，相同就接受，遇到第一个不同的就停，后面的草稿不管对不对都丢掉。
4. 输出。接受的草稿加上目标模型在断开处自己选的那个 token。一个都没猜对也前进 1 个，全猜对是 k + 1 个。

所以投机解码多出两部分时间：起草本身的时间，和验证时目标模型这一步多算的 k 个位置。并发 16、k = 4 时，验证这一步是 80 个 token，不开投机是 16 个，两者走的是不同尺寸的 CUDA Graph。按默认设置，vLLM 0.32.0 里投机一旦打开就一直开着，不会因为批次变大或者接受率低自动关掉。

这次测了四种猜法：

| 标签 | 目标模型 | `--speculative-config` |
| --- | --- | --- |
| ngram | Qwen3-8B | `{"method": "ngram", "num_speculative_tokens": 4, "prompt_lookup_max": 4, "prompt_lookup_min": 2}` |
| EAGLE-3 | Qwen3-8B | `{"method": "eagle3", "model": "<EAGLE-3 检查点>", "num_speculative_tokens": 3}` |
| 0.6B 草稿 | Qwen3-8B | `{"method": "draft_model", "model": "Qwen/Qwen3-0.6B", "num_speculative_tokens": 4}` |
| MTP | Qwen3.5-4B | `{"method": "mtp", "num_speculative_tokens": 1}`，另测了 3 |

- ngram 不用任何模型，从这条请求自己的上下文里抄。它拿最后几个 token 去前文里找相同的一段，长度在 `prompt_lookup_min` 到 `prompt_lookup_max` 之间，取最长的；同样长的有几处，取最靠前的那一处，把它后面的最多 k 个 token 当草稿。找的范围是 prompt 加上已经生成的输出，不只是 prompt。
- EAGLE-3 是一个单独训练的小网络，用的检查点是 ModelScope 上的 AngelSlim/Qwen3-8B_eagle3：1 层，hidden 4096，8 个 KV 头，763 MB。它不只看 token，还读目标模型中间层的输出，启动日志里有一行 `Using Eagle3 auxiliary layers from model: (2, 18, 33)`，取的是第 2、18、33 层。
- 0.6B 草稿是同一系列的小模型 Qwen3-0.6B，28 层，8 个 KV 头，自己往后生成 k 个 token。
- MTP 用模型自带的那一层。Qwen3.5-4B 是多模态模型，加 `--language-model-only` 只起语言部分。它的 MTP 只有一层，k = 3 时同一层要连着跑 3 次，启动日志里有一行警告：`Enabling num_speculative_tokens > 1 will run multiple times of forward on same MTP layer,which may result in lower acceptance rate`。

## 启动：草稿的 KV 也占显存

先看能不能起来。EAGLE-3 和 0.6B 草稿按 `--max-model-len 32768` 启动，都失败了：

```text
ValueError: To serve at least one request with the model's max seq len (32768), (4.62 GiB KV cache is needed, which is larger than the available KV cache memory (4.27 GiB). Based on the available memory, the estimated maximum model length is 30224.
```

0.6B 草稿那次要 8.0 GiB，只有 4.21 GiB，估计最多 17,232 个 token。不开投机时一条 32768 个 token 的请求只要 4.5 GiB，这里多出来的是草稿模型的 KV。这两种只好改成 `--max-model-len 16384` 起，后面的速度也是在 16384 下测的；不开投机的 Qwen3-8B 在 16384 和 32768 下各测了一遍，速度几乎一样，可以直接比。

各配置的启动日志对比如下。第三篇说过，没有编译缓存的冷启动留给 KV 的显存更少，编译缓存又按配置区分，改 `--max-model-len` 也算新配置，所以表里都用有缓存时再启动一次的数：

| 配置 | 权重（`Model loading took`） | 可用 KV | KV 容量 | 每 token 的 KV |
| --- | ---: | ---: | ---: | ---: |
| Qwen3-8B，不开投机 | 15.27 GiB | 5.48 GiB | 39,920 token | 144 KiB |
| ngram | 15.27 GiB | 5.34 GiB | 38,896 token | 144 KiB |
| EAGLE-3 | 16.01 GiB | 4.27 GiB | 起不来 | 148 KiB |
| 0.6B 草稿 | 16.38 GiB | 4.21 GiB | 17,248 token（16384 下） | 256 KiB |

ngram 没有额外的权重，可用 KV 只少了 0.14 GiB。EAGLE-3 的权重多 0.74 GiB，可用 KV 少 1.21 GiB；0.6B 草稿的权重多 1.11 GiB，可用 KV 少 1.27 GiB。

每 token 的 KV 是用容量反推的。EAGLE-3 在 16384 下那次是 3.12 GiB、22,080 个 token，合 148 KiB；0.6B 草稿是 4.21 GiB、17,248 个 token，合 256 KiB。第三篇算过，Qwen3-8B 一层是 8 个 KV 头 × 128 × K 和 V × 2 字节 = 4 KiB，36 层 144 KiB。EAGLE-3 多 1 层，148 KiB；Qwen3-0.6B 每层也是 4 KiB，28 层再加 112 KiB，正好 256 KiB。

草稿的 KV 和目标模型的 KV 放在同一个 block 池里，用同一套 block 编号：一个 block 里同时存着这 16 个 token 在目标模型 36 层和草稿各层的 KV，block 的字节数是各层相加。所以 EAGLE-3 的一个 block 比不开投机大 1/36，0.6B 草稿大 7/9。启动时那条“至少放下一条最长请求”的检查也按相加以后的字节算：32768 × 148 KiB = 4.625 GiB，32768 × 256 KiB = 8 GiB，就是报错里的 4.62 和 8.0。前缀缓存命中时复用的是整块，草稿层的 KV 在同一块里，一起被复用。

折合下来，32768 下 EAGLE-3 的容量按 4.27 GiB 算约 30,250 个 token，比不开投机少 24%；0.6B 草稿只剩 17,248 个，少 57%。第七篇里 4 个会话就能把 39,920 个 token 用满，换成 0.6B 草稿，一条 16k 的请求就几乎占满。

### Qwen3.5-4B：k 从 1 改到 3，容量又少了一截

| 配置 | 权重 | 可用 KV | 日志里的 KV 容量 | 32768 的请求最多同时放几条 |
| --- | ---: | ---: | ---: | ---: |
| 不开投机 | 7.94 GiB | 12.66 GiB | 372,795 token | 11.38 |
| MTP，k = 1 | 8.17 GiB | 12.19 GiB | 305,834 token | 9.33 |
| MTP，k = 3 | 8.17 GiB | 12.03 GiB | 277,665 token | 8.47 |

MTP 那一层的权重是 0.23 GiB，k = 1 和 k = 3 一样，没有按 k 复制。可用显存只差 0.16 GiB，容量却从 305,834 降到 277,665，每 GiB 能放的 token 从 25,090 降到 23,080。

原因在 Qwen3.5 的结构。它是混合注意力，一部分层是线性注意力（启动日志里能数出 24 层），其余是普通的全注意力。全注意力层还是每个 token 占一份 KV；线性注意力层不存每个 token 的 KV，每条请求只占固定大小的状态，和序列多长无关。这样一来，显存就没法直接除以一个“每 token 字节数”。日志里的 KV 容量是这么来的：先算一条 32768 个 token 的请求在全注意力层和线性注意力层一共要几个 block，用总 block 数去除，得到最多能同时放几条，再乘 32768。372,795 正好是 11.38 × 32768。

开着前缀缓存时，启动日志里有一行 `Mamba cache mode is set to 'align' for Qwen3_5ForConditionalGeneration by default when prefix caching is enabled`。这个模式下，每条请求在每个线性注意力层上要预留几份状态，份数随 k 增加，k 每加 1 就多 1 份；不开投机时这部分是 0。k 从 1 变成 3，每条请求多预留 2 份，一条请求占的 block 多了，能同时放的条数就少了，乘 32768 之后的容量也跟着降。

## 猜对了多少

压测用三种 prompt，都基于 Python 标准库 textwrap 模块的源码：

- copy：给出其中 120 行带行号的代码，要求把 `len(` 都改成 `_width(`，输出修改后的完整代码。输出大部分是照抄 prompt。
- free：给出整个文件，要求用中文分条解释模块设计、各个函数的职责、处理全角字符时哪里可能出错。
- free_en：同样的要求，用英文写。

每种 prompt 依次同时发 1 条、16 条，每条固定输出 512 个 token。并发 16 时发的是 16 条完全相同的请求，temperature 0，输出也相同，前缀缓存全部命中，这一点和真实负载不同。

接受率来自 `/metrics` 里四个计数器在整轮压测前后的增量：草稿次数、草稿 token 数、接受的 token 数、每个位置接受的次数。一次草稿是一条请求的一步，并发 16 时一步算 16 次。

| 配置 | k | 草稿次数 | 接受率 | 每次草稿接受几个 | 每步前进几个 | 各位置的接受比例 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| ngram | 4 | 18,403 | 10.4% | 0.42 | 1.42 | 0.16 / 0.11 / 0.08 / 0.06 |
| EAGLE-3 | 3 | 15,200 | 23.9% | 0.72 | 1.72 | 0.40 / 0.21 / 0.11 |
| 0.6B 草稿 | 4 | 7,498 | 62.2% | 2.49 | 3.49 | 0.78 / 0.65 / 0.56 / 0.50 |
| MTP | 1 | 14,085 | 85.3% | 0.85 | 1.85 | 0.85 |
| MTP | 3 | 8,775 | 66.1% | 1.98 | 2.98 | 0.82 / 0.65 / 0.52 |

接受率是接受的 token 数除以草稿 token 数，每步前进是 1 加每次草稿接受的个数。各位置的比例都是逐位递减的，图 1 说过原因。

草稿次数加上接受的 token 数，五种配置都在 26,100 上下，和这一轮压测生成的 token 总数基本相等（3 种 prompt × 17 条 × 512 个，再加几条预热的短请求）：几乎每条请求的每一步都提了草稿。ngram 找不到匹配时这一步不提草稿、也不计数，但这次的 prompt 里都有大段源码，最后两个 token 在前文里几乎总能找到相同的一段，草稿次数乘 4 也正好等于草稿 token 数，每次都抄满了 4 个。

按 prompt 分开看（并发 1）：

| 配置 | copy | free（中文） | free_en |
| --- | ---: | ---: | ---: |
| ngram | 33.3% | 5.3% | 6.2% |
| EAGLE-3 | 37.6% | 9.2% | 32.7% |
| 0.6B 草稿 | 91.1% | 53.9% | 44.3% |
| MTP，k = 1 | 98.8% | 74.7% | 80.9% |
| MTP，k = 3 | 94.5% | 51.0% | 63.3% |

并发 16 时各格和并发 1 相差不到 7 个百分点。分开看有几点：

1. copy 上所有方法都最高，0.6B 草稿和 MTP 在 90% 以上。照抄也不是逐字照抄：prompt 里的代码带行号，输出要求不带，`len(` 还要改成 `_width(`。ngram 在 copy 上只有 33%，具体错在哪些位置，这次没有逐个 token 看。
2. ngram 在两种自由写上只有 5% 到 6%。解释性的文字很少和源码重复，可它照样每步抄 4 个，几乎都被拒绝。
3. EAGLE-3 中文 9.2%，英文 32.7%，差了两倍多；另外三种方法中英文的差距都小得多。这份检查点的草稿词表是 32,000 个 token，Qwen3-8B 的词表是 151,936 个。草稿只在这 32,000 个里出 token，检查点里带一张映射表，把它们映射回目标模型的词表，映射不到的 token 草稿永远猜不出来。把这份检查点的映射表拿出来数了一下：32,000 个 token 里只有 8 个含汉字，是“的、中、在、是、和、使用、可以、需要”，而 Qwen3-8B 词表里含汉字的 token 有 26,060 个。拿实验的 prompt 对照，中文指令里 34 个含汉字的 token 只有 2 个在映射里，英文指令的 47 个 token 全在。这次没有保存生成的文本，没法数输出里有多少 token 落在映射里。草稿能提出的汉字这么少，和中文接受率低的方向一致；但这只是判断，映射覆盖率不等于接受率，英文和 copy 的 prompt 有九成五的 token 在映射里，接受率也只有三成多。
4. MTP 的 k = 3 在第一位是 0.82，比 k = 1 的 0.85 略低，后两位降到 0.65、0.52，和上面那条警告说的一致。

## 快了多少

单条请求的 decode 速度按“输出 token 数减 1，除以从第一个 token 到结束的时间”算，单位是每秒 token 数。先看 Qwen3-8B，并发 1：

| 配置 | copy | free（中文） | free_en |
| --- | ---: | ---: | ---: |
| 不开投机 | 57.9 | 55.3 | 55.3 |
| ngram | 105.5（1.82 倍） | 43.1（0.78 倍） | 44.8（0.81 倍） |
| EAGLE-3 | 96.8（1.67 倍） | 45.7（0.83 倍） | 71.0（1.28 倍） |
| 0.6B 草稿 | 125.3（2.16 倍） | 74.0（1.34 倍） | 64.3（1.16 倍） |

ngram 和 EAGLE-3 在中文上比不开投机还慢两成左右。这些加速比都比“每步前进几个”小得多：0.6B 草稿在 copy 上每步前进 4.64 个，速度只到 2.16 倍。因为每一步本身变长了。

几乎每一步都提了草稿，每步前进的 token 数就可以按 1 + 接受率 × k 算，用速度去除，折出一步的时间：

| 配置 | copy：每步前进 ｜ 一步 | free：每步前进 ｜ 一步 | free_en：每步前进 ｜ 一步 |
| --- | --- | --- | --- |
| 不开投机 | 1 ｜ 17.3 ms | 1 ｜ 18.1 ms | 1 ｜ 18.1 ms |
| ngram | 2.33 ｜ 22.1 ms | 1.21 ｜ 28.1 ms | 1.25 ｜ 27.9 ms |
| EAGLE-3 | 2.13 ｜ 22.0 ms | 1.28 ｜ 27.9 ms | 1.98 ｜ 27.9 ms |
| 0.6B 草稿 | 4.64 ｜ 37.1 ms | 3.16 ｜ 42.6 ms | 2.77 ｜ 43.1 ms |

速度等于每步前进的个数除以一步的时间，两头一比就知道快慢。ngram 和 EAGLE-3 一步要 22 到 28 ms，是不开投机的 1.3 到 1.6 倍，每步至少要多前进 0.3 到 0.6 个 token 才能和不开投机持平；中文上只多了 0.2 到 0.3 个，于是变慢。0.6B 草稿一步要 37 到 43 ms，是不开投机的两倍多，但它每步能多前进 1.8 到 3.6 个，三种 prompt 上都比不开投机快。

有两处没查清。ngram 不跑任何模型，一步也比不开投机多了 5 到 10 ms，这次没有抓 profile，多出的时间花在哪没有拆。另外 ngram 和 EAGLE-3 在 copy 上的一步都比自由写短 6 ms 左右，两种 prompt 长度不同（copy 只给了 120 行，自由写给了整个文件），但不开投机时两者只差 0.8 ms，原因未查清。

### 并发 16

| 配置 | copy | free（中文） | free_en |
| --- | ---: | ---: | ---: |
| 不开投机 | 50.0 ｜ 789.6 | 38.7 ｜ 605.1 | 38.8 ｜ 607.8 |
| ngram | 70.5 ｜ 1,108.8 | 21.8 ｜ 344.1 | 20.9 ｜ 323.5 |
| EAGLE-3 | 68.3 ｜ 1,066.6 | 23.5 ｜ 369.2 | 37.4 ｜ 563.0 |
| 0.6B 草稿 | 94.5 ｜ 1,456.0 | 34.4 ｜ 532.0 | 32.3 ｜ 495.8 |

竖线左边是单条请求的 decode 速度，右边是总吞吐，单位都是每秒 token 数。并发 16 时投机解码的收益普遍变小：0.6B 草稿在并发 1 时三种 prompt 都更快，到并发 16 时两种自由写都比不开投机慢；EAGLE-3 在英文上从 1.28 倍掉到 0.96 倍；ngram 和 EAGLE-3 在中文上只剩不开投机的六成左右。copy 上三种方法仍然更快。

接受率没变，变的是一步的时间。照上面的方法折算，不开投机时并发 16 的一步是 20.0 到 25.8 ms，比并发 1 只多几毫秒，16 条请求共用一次权重读取；两种自由写上，0.6B 草稿一步要 94 ms，ngram 和 EAGLE-3 要 54 到 56 ms，都差不多是并发 1 时的两倍。验证这一步是 80 个 token（EAGLE-3 是 64 个），不开投机是 16 个；一步里的时间具体花在哪，这次没有抓 profile。vLLM 不会因此自动关掉投机，要不要开得按自己的负载测。

### Qwen3.5-4B 的 MTP

| 配置 | copy，并发 1 | free，并发 1 | free_en，并发 1 | copy，并发 16 | free，并发 16 | free_en，并发 16 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 不开投机 | 100.1 | 98.2 | 98.3 | 77.2 | 69.5 | 69.7 |
| MTP，k = 1 | 148.6 | 107.9 | 111.7 | 108.6 | 72.8 | 75.7 |
| MTP，k = 3 | 228.2 | 129.0 | 147.0 | 152.7 | 84.2 | 91.5 |

表里是单条请求的 decode 速度。MTP 在每一格都比不开投机快，k = 3 也每一格都比 k = 1 快：copy 并发 1 是 2.28 倍，中文并发 16 最少，也有 1.21 倍。并发 16 的总吞吐，k = 3 在三种 prompt 上分别是 1,893.7、1,215.9、1,278.5，不开投机是 1,143.4、1,024.7、1,022.8。

同样折算并发 1 时一步的时间：不开投机 10.0 到 10.2 ms，k = 1 是 13.4 到 16.2 ms，k = 3 是 16.8 到 19.7 ms，每步多出 3 到 10 ms。MTP 起草只用一层，接受率在几种方法里又最高，这次的每一格都比不开投机快。这组数只说明 Qwen3.5-4B 上的情况，模型不同，不和上面的 Qwen3-8B 直接比。

## 从日志和指标看投机解码

和这一篇有关的日志行和指标：

- `max_num_scheduled_tokens is set to 2048 based on the speculative decoding settings`：开了投机解码就会打这条警告。它只是把每步调度的 token 上限设成 `--max-num-batched-tokens` 的值，默认 2048，并没有从 2048 里再扣掉草稿的位置；不开投机时调度器用的也是这个 2048，prefill 分块不变。
- `SpecDecoding metrics: Mean acceptance length: ..., Per-position acceptance rate: ..., Avg Draft acceptance rate: ...`：服务每 10 秒打一行这段时间的统计。Mean acceptance length 是 1 加每次草稿接受的个数，就是上文的“每步前进几个”；Avg Draft acceptance rate 是接受率。
- `GPU KV cache size: ... tokens`：开了草稿模型或 EAGLE-3 以后，这个容量已经按目标加草稿每 token 的字节算过。它等于同一行后面的 `Maximum concurrency` 乘 `--max-model-len`；混合注意力模型的这个数不是可用显存除以每 token 字节。
- `/metrics` 里的 `vllm:spec_decode_num_drafts_total`、`vllm:spec_decode_num_draft_tokens_total`、`vllm:spec_decode_num_accepted_tokens_total`、`vllm:spec_decode_num_accepted_tokens_per_pos_total`：草稿次数、草稿 token 数、接受数、每个位置的接受次数。前后各取一次相减，就能算这段时间的接受率和每步前进的个数。

## 参考资料

- [vLLM](https://github.com/vllm-project/vllm)：本文行为以 v0.32.0 为准，草稿 KV 的分组和启动检查、混合注意力模型的容量折算、ngram 的匹配规则、EAGLE-3 的草稿词表映射、验证步的 token 数和调度上限、`/metrics` 里投机解码指标的定义以这个版本的源码为准。
- vLLM 文档：[Speculative Decoding](https://docs.vllm.ai/en/latest/features/speculative_decoding/)。
- Yaniv Leviathan 等，[Fast Inference from Transformers via Speculative Decoding](https://arxiv.org/abs/2211.17192)：起草、验证、按前缀接受的做法。
- Yuhui Li 等，[EAGLE-3: Scaling up Inference Acceleration of Large Language Models via Training-Time Test](https://arxiv.org/abs/2503.01840)。
- Fabian Gloeckle 等，[Better & Faster Large Language Models via Multi-token Prediction](https://arxiv.org/abs/2404.19737)：MTP。
- [prompt-lookup-decoding](https://github.com/apoorvumang/prompt-lookup-decoding)：从 prompt 里找 n-gram 当草稿的做法。
- 模型：[AngelSlim/Qwen3-8B_eagle3](https://modelscope.cn/models/AngelSlim/Qwen3-8B_eagle3)、[Qwen/Qwen3.5-4B](https://modelscope.cn/models/Qwen/Qwen3.5-4B)。
