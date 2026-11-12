---
title: "vLLM 入门（二）：启动：从 vllm serve 到能接请求"
description: "按日志时间戳跟一次 vllm serve 的启动：解析配置、起引擎进程、加载权重、torch.compile、测显存、算 KV Cache、捕获 CUDA Graph，并解释冷启动为什么会比热启动少 1 GiB KV Cache。"
date: 2026-11-05 11:30:00 +0800
tags: [vLLM, 推理]
math: true
series: vllm
series_order: 2
---

上一篇的服务第一次启动就失败了：留给 KV Cache 的显存是 4.48 GiB，比一条 32768 token 的请求要的 4.5 GiB 少了 0.02 GiB；参数不变再启动一次，KV Cache 变成了 5.48 GiB，启动成功。同样的命令、同一张卡，两次差了 1 GiB。这一篇按日志时间戳把一次启动从头跟一遍，顺便把这 1 GiB 的去向查清楚。

这一篇的实验换了一台机器，GPU 型号和软件版本与上一篇相同：

| 项目 | 版本 |
| --- | --- |
| GPU | NVIDIA GeForce RTX 4090，24 GB，驱动 580.105.08 |
| 内存 | 117 GiB |
| 模型所在盘 | XFS 数据盘 |
| vLLM | 0.32.0 |
| PyTorch / CUDA | 2.13.0 / 13.0 |
| 模型 | Qwen3-8B，bf16 |

## 例子：五次启动

启动命令和上一篇一样，只是为了看清每一步，打开了 DEBUG 日志：

```bash
VLLM_LOGGING_LEVEL=DEBUG vllm serve Qwen/Qwen3-8B \
  --served-model-name qwen3-8b \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.9 \
  --enable-prefix-caching \
  --enable-prompt-tokens-details
```

这里写的是 0.9，因为我在上一篇里以为 0.9 是默认值，这一篇的前四次启动都按 0.9 做。后来翻 v0.32.0 的源码才发现默认值是 0.92，于是补了第五次。上一篇的这处说法已经改正。

vLLM 启动时会用到三个缓存目录：`~/.cache/vllm` 里是 torch.compile 的编译结果，`~/.cache/flashinfer` 里是 FlashInfer 即时编译出的算子，`~/.triton` 是 Triton 的算子缓存。“冷启动”指的是先把这三个目录都删掉：

```bash
rm -rf ~/.cache/vllm ~/.cache/flashinfer ~/.triton
```

五次启动依次进行，用时从执行命令算起，到 `/health` 返回 200 或者进程退出为止：

| 次序 | 条件 | 用时 | torch.compile | KV Cache | 结果 |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | 冷启动，0.9 | 78.7 s | 35.3 s | 4.01 GiB | 失败 |
| 2 | 紧接着再启动，0.9 | 121.0 s | 0.9 s | 5.01 GiB | 成功 |
| 3 | 再启动一次，0.9 | 40.4 s | 0.4 s | 5.01 GiB | 成功 |
| 4 | 加 `--enforce-eager`，0.9 | 28.3 s | 不编译 | 5.43 GiB | 成功 |
| 5 | 冷启动，0.92 | 78.8 s | 35.2 s | 4.48 GiB | 失败 |

第 5 次就是上一篇第一次启动的情况，4.48 GiB 原样复现了。第 2 次比第 3 次多用了 80 秒，原因放到后面说。下面以第 3 次为准走一遍，遇到和冷启动不同的地方再对照第 1 次。

## 一次启动的全过程

第 3 次启动的日志从 11:47:37 开始，11:48:09 打出“Starting vLLM server”，一共 32 秒；剩下的 8 秒左右在第一行日志之前，是 Python 导入 vLLM 的时间。

{% include figure.html src="/assets/images/vllm-02-startup/01-startup-timeline.jpg" alt="一次热启动的时间线：解析配置、起引擎进程、加载权重、加载编译结果、测显存、分配 KV Cache、捕获 CUDA Graph、开始服务；冷启动时加载编译结果一段换成 35 秒的编译" caption="图 1：第 3 次启动的时间线。冷启动时“加载编译结果”一段换成 35 秒的编译，并且这段编译落在测显存的范围里" %}

### 第一步：API 服务进程解析配置（0 s）

`vllm serve` 先启动的是 API 服务进程。它读模型目录里的 config.json，认出架构是 `Qwen3ForCausalLM`，确定最大长度 32768，然后补齐没有显式设置的参数。DEBUG 日志里能看到上一篇提到的几个默认值：

```text
Enabling chunked prefill by default
Defaulting max_num_batched_tokens to 2048 for OPENAI_API_SERVER usage context.
Defaulting max_num_seqs to 256 for OPENAI_API_SERVER usage context.
```

接着加载分词器和对话模板，到 11:47:39 结束。

### 第二步：起引擎进程（2～9 s）

API 服务进程随后拉起引擎进程 `VLLM::EngineCore`。之后 7 秒没有日志，这段时间应该主要是新进程导入 PyTorch 等库，我没有逐项计时。11:47:46 两边通过 ZeroMQ 的本地套接字握手，引擎进程打出完整的引擎配置。

### 第三步：记下初始显存（10 s）

引擎进程初始化 CUDA 之后，先记一次显存：

```text
worker init memory snapshot: ... free_memory=23.13GiB, total_memory=23.52GiB, ...
worker requested memory: 21.16GiB
```

整张卡 23.52 GiB，这时空闲 23.13 GiB。`--gpu-memory-utilization` 是按整卡算的比例，0.9 对应 21.16 GiB，引擎后面所有的显存都要从这 21.16 GiB 里出：权重、前向的临时张量、CUDA Graph，剩下的才给 KV Cache。

### 第四步：加载权重（10～16 s）

```text
Filesystem type for checkpoints: XFS. Checkpoint size: 15.26 GiB. Available RAM: 117.16 GiB.
Loading weights took 2.98 seconds
Model loading took 15.27 GiB memory and 5.624345 seconds
```

权重读进显存用了 3 秒，连同建模型结构一共 5.6 秒，权重占 15.27 GiB。15.26 GiB 的文件 3 秒读完，这台机器的权重文件多半已经在系统的页缓存里。我想清掉页缓存测一次真正从盘上读的速度，容器里没有权限写 `/proc/sys/vm/drop_caches`，没测成。

### 第五步：torch.compile（17 s）

热启动时这一步只是从 `~/.cache/vllm/torch_compile_cache` 里加载上次的编译结果，0.41 秒：

```text
[backbone] Directly load AOT compilation from path /root/.cache/vllm/torch_compile_cache/torch_aot_compile/...
[backbone] torch.compile took 0.41 s in total
```

冷启动时没有缓存，要现编译。第 1 次启动的日志：

```text
[backbone] Dynamo bytecode transform time: 6.62 s
[backbone] Compiling a graph for compile range (1, 2048) takes 24.24 s
[backbone] torch.compile took 35.34 s in total
```

先用 Dynamo 把模型的 Python 代码转成计算图，再交给 Inductor 生成算子。编译的 token 数范围是 1 到 2048，正好是一步的 token 预算。

编译结果按配置区分缓存。后来做别的实验时发现，只把 `--max-model-len` 改成 16384，或者加上投机解码的配置，缓存目录名就变了，启动时又编译了 23 秒左右。所以“热启动”只对参数完全相同的那一次成立。

### 第六步：测显存（17～23 s）

权重加载后，引擎要知道前向时临时张量最多占多少显存。它按一步 2048 个 token 用假数据跑一次前向，记下 PyTorch 显存的峰值；然后把 CUDA Graph 先捕获一遍，估算图要占多少显存。日志里的汇总是：

```text
Memory profiling takes 1.98 seconds. Total non KV cache memory: 15.72GiB; torch peak memory increase: 0.2GiB; total consumed (from mem_get_info): 15.54GiB; weights memory: 15.27GiB.
```

逐项看：

- 15.54 GiB 是这时实际用掉的显存，其中 15.27 GiB 是权重，另外 0.27 GiB 不归 PyTorch 管，主要是 CUDA 上下文和各种库的工作区。
- 0.2 GiB 是假数据前向时 PyTorch 显存峰值的增量，也就是临时张量的上限。
- 两项合起来，非 KV 显存是 15.72 GiB。日志里各项都四舍五入到 0.01 GiB，加起来对不上的 0.02 GiB 是舍入。

CUDA Graph 的估计值在另一行里，是 0.43 GiB（见第九步）。

### 第七步：算出 KV Cache 的大小（23 s）

KV Cache 拿到的是剩下的部分：

$$
21.16 - 15.72 - 0.43 = 5.01 \text{ GiB}
$$

```text
Available KV cache memory: 5.01 GiB
GPU KV cache size: 36,480 tokens, Maximum concurrency for 32,768 tokens per request: 1.11x
```

每个 token 144 KiB，5.01 GiB 放得下 36,480 个 token，也就是 2280 个 block。引擎接着检查一条最长的请求放不放得下：32768 个 token 要 $$32768 \times 144\ \text{KiB} = 4.5\ \text{GiB}$$，5.01 GiB 够用，启动继续。

日志在这里还有一行提示：

```text
CUDA graph memory profiling is enabled (default since v0.21.0). The current --gpu-memory-utilization=0.9000 is equivalent to --gpu-memory-utilization=0.8816 without CUDA graph memory profiling. To maintain the same effective KV cache size as before, increase --gpu-memory-utilization to 0.9184.
```

v0.21.0 以前，CUDA Graph 的显存不从这份预算里扣；现在要扣，0.43 GiB 相当于整卡的 1.84%。从旧版本升级上来、想保持 KV Cache 大小不变的话，比例要相应调高。

第 1 次冷启动走到这里就失败了。对照两次的同一行日志：

| 项目 | 第 1 次（冷） | 第 3 次（热） |
| --- | ---: | ---: |
| 测显存用时 | 37.42 s | 1.98 s |
| PyTorch 峰值增量 | 1.19 GiB | 0.2 GiB |
| 非 KV 显存 | 16.72 GiB | 15.72 GiB |
| KV Cache | 4.01 GiB | 5.01 GiB |

两次实际用掉的都是 15.54 GiB，权重都是 15.27 GiB，差别全在峰值增量上。冷启动时测显存用了 37 秒，其中 35 秒是编译：编译是在第一次前向时触发的，而这次前向就是测显存用的那次，编译过程中临时占用的显存也被记进了峰值。所以冷启动多扣的这 1 GiB 不是前向真正需要的。

4.01 GiB 小于 4.5 GiB，引擎报错退出：

```text
ValueError: To serve at least one request with the model's max seq len (32768), (4.5 GiB KV cache is needed, which is larger than the available KV cache memory (4.01 GiB). Based on the available memory, the estimated maximum model length is 29216. ...
```

但编译结果在报错之前已经存进了缓存，所以原样再启动一次就能成功。上一篇“参数不变再启动就好了”就是这样。0.92 时冷启动的 KV Cache 是 $$21.64 - 16.72 - 0.43 = 4.49$$ GiB，日志里是 4.48 GiB，差 0.02 GiB 失败；热启动是 5.48 GiB。

### 第八步：FlashInfer 即时编译（只在第 2 次）

KV Cache 分配好之后，引擎用假数据预热一遍各个算子。采样用的是 FlashInfer 的 top-p / top-k 算子，这台机器上没有装预编译好的版本（日志里有一行“flashinfer-cubin package was not found”），第一次用时要现编译：

```text
2026-11-04 11:45:54,706 - INFO - core.py:564 - flashinfer.jit: Building JIT module sampling; this can take several minutes on first use.
```

第 2 次启动卡在这一步，下一行日志出现在 11:47:12，编译用了 77 秒。我一开始以为这段空白是 Triton 在编译，看日志才知道是 FlashInfer。第 1 次启动也清了 FlashInfer 的缓存，但它在第七步就退出了，没走到这一步，所以这次编译落到了第 2 次启动；第 3 次缓存都在，这一步不到 1 秒。装上 flashinfer-cubin 这个包能不能省掉这次编译，我没有试。

### 第九步：正式捕获 CUDA Graph（23～29 s）

然后正式捕获 CUDA Graph，6 秒捕获了两类图：

- PIECEWISE 图 51 个，token 数从 1 到 512：1、2、4、8，之后到 256 每隔 8 个一档，再到 512 每隔 16 个一档。这类图不包含 attention，attention 在图与图之间照常执行，所以不管批次里是 prefill 还是 decode 都能用。
- FULL 图 35 个，只用于批次里全是 decode、每个请求 1 个 token 的情况，请求数从 1 到 256。这类图把 attention 也包含在内。

运行时一步的 token 数凑到最近的一档，回放对应的图；超过 512 个 token 的步不用图，直接执行编译后的代码。

```text
CUDA graph pool memory: 0.23 GiB (actual), 0.43 GiB (estimated), difference: 0.2 GiB (87.3%).
```

图实际占了 0.23 GiB，比第六步的估计少 0.2 GiB。估计值已经从 KV Cache 的预算里扣掉了，多扣的 0.2 GiB 就空着。

### 第十步：开始服务（29～32 s）

11:48:07 引擎报告初始化完成，“init engine (profile, create kv cache, warmup model) took 14.58 s”。API 服务进程预热对话模板（0.37 秒），注册路由，11:48:09 开始监听 8000 端口。

最后一行日志汇总了各项显存：

```text
Free memory on device (23.13/23.52 GiB) on startup. Desired GPU memory utilization is (0.9, 21.16 GiB). Actual usage is 15.54 GiB for consumed memory (weights + non-torch), 0.62 GiB for peak activation, and 0.23 GiB for CUDAGraph memory. Replace gpu_memory_utilization config with `--kv-cache-memory=4975264666` (4.63 GiB) to fit into requested memory, or `--kv-cache-memory=7086991872` (6.6 GiB) to fully utilize gpu memory. Current kv cache memory in use is 5.01 GiB.
```

这里的“peak activation”0.62 GiB 是第六步的 0.2 GiB 加上 CUDA Graph 的估计值 0.43 GiB，不是单独的临时张量。

## 不用编译和 CUDA Graph：--enforce-eager

第 4 次启动加了 `--enforce-eager`，日志开头就说明了它关掉什么：

```text
Enforce eager set, disabling torch.compile, CUDAGraphs, and JIT kernel warmup.
```

第五步、第九步都没有了，第六步也不用估算 CUDA Graph，启动用了 28.3 秒，比第 3 次少 12 秒。KV Cache 是 $$21.16 - 15.74 = 5.42$$ GiB（日志 5.43 GiB），比第 3 次多出那 0.43 GiB，能多放 3,024 个 token。

代价在 decode 上。两次启动后各跑了一遍上一篇的 6 轮智能体请求：

| 轮次 | prompt token | 首 token 时间（图） | 首 token 时间（eager） | decode 速度（图） | decode 速度（eager） |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 307 | 0.08 s | 0.95 s | 58.5 tok/s | 48.0 tok/s |
| 2 | 7,219 | 0.83 s | 0.82 s | 55.9 tok/s | 49.2 tok/s |
| 3 | 15,421 | 1.28 s | 1.29 s | 52.5 tok/s | 50.9 tok/s |
| 4 | 15,536 | 0.14 s | 0.16 s | 52.2 tok/s | 51.4 tok/s |
| 5 | 15,607 | 0.14 s | 0.17 s | 52.7 tok/s | 50.4 tok/s |
| 6 | 15,680 | 0.14 s | 0.15 s | 53.2 tok/s | 51.0 tok/s |

prefill 的部分两者几乎一样，第 2、3 轮的首 token 时间相差不到 0.01 秒，因为一步 2048 个 token 超过了 512，本来就不用图。decode 每步只有 1 个 token，CPU 逐个发射算子的开销占比大，用图时快 2% 到 22%，上下文越短差得越多。

## 各次启动的显存划分

第三步到第九步的扣减按时间顺序放在一起，第 1 次和第 3 次对照，可以按“下一步”一步步看：

{% include bar-demo.html id="startup-memory" caption="图 2：显存按启动步骤一项项分出去。条的长度按比例，太窄的段放不下文字，数字见条下方" %}

各次启动的结果汇总如下：

| 项目 | 0.9 冷启动 | 0.9 热启动 | 0.9 eager | 0.92 冷启动 | 0.92 热启动 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 按比例可用 | 21.16 | 21.16 | 21.16 | 21.64 | 21.64 |
| 已用（权重 15.27 + 其他 0.27） | 15.54 | 15.54 | 15.54 | 15.54 | 15.54 |
| PyTorch 峰值增量 | 1.19 | 0.2 | 0.21 | 1.19 | 约 0.2 |
| CUDA Graph 估计 | 0.43 | 0.43 | 0 | 0.43 | 0.43 |
| KV Cache | 4.01 | 5.01 | 5.43 | 4.48 | 5.48 |
| 能否放下 32768 token（4.5 GiB） | 否 | 是 | 是 | 否 | 是 |

单位都是 GiB。0.92 热启动是上一篇的那次。

## 参考资料

- [vLLM](https://github.com/vllm-project/vllm)：本文行为以 v0.32.0 为准，`--gpu-memory-utilization` 的默认值、显存预算的计算方式和 CUDA Graph 的捕获档位均出自这个版本的源码和日志。
- vLLM 文档：[Conserving Memory](https://docs.vllm.ai/en/latest/configuration/conserving_memory/)、[torch.compile integration](https://docs.vllm.ai/en/latest/design/torch_compile.html)、[CUDA Graphs](https://docs.vllm.ai/en/latest/design/cuda_graphs.html)。
- [FlashInfer](https://github.com/flashinfer-ai/flashinfer)：采样算子的即时编译。
