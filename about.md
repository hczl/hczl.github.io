---
layout: page
title: 关于
eyebrow: 关于
permalink: /about/
---
我是 hczl，在做大模型推理里的存储和 KV Cache 卸载。

长上下文、多并发的时候，KV Cache 很快就会把 GPU / NPU 的显存占满。我主要在研究怎么把它卸载到内存和 SSD 上，需要时再读回来，同时让推理别因此慢太多。手上的实验同时跑在 NVIDIA GPU 和昇腾 NPU 上。

这个博客主要是写给自己的：读 vLLM 源码的笔记、测带宽和延迟的实验记录、配环境时踩的坑。

每篇都会写清楚用的软件版本和硬件，因为这类内容过半年可能就不适用了。以前写错的地方，会直接在原文里改，并注明改了什么。

有问题可以在 [GitHub](https://github.com/hczl) 上找我，也可以用 [RSS](/feed.xml) 订阅。
