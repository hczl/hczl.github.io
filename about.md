---
layout: page
title: 关于
eyebrow: 关于
permalink: /about/
---
hczl，从事大模型推理系统中的存储与 KV Cache 卸载方向。

## 研究背景

在长上下文与高并发推理场景下，KV Cache 占用随序列长度和并发数线性增长，往往成为 GPU / NPU 显存的主要瓶颈。我的工作集中于 KV Cache 的分层存储：将其卸载至主机内存与 SSD，并在不显著增加推理延迟的前提下按需取回。相关实验同时在 NVIDIA GPU 与昇腾 NPU 平台上进行。

## 内容范围

- vLLM 等推理框架中 KV Cache 管理机制的源码分析
- 存储 I/O 的带宽、延迟测试方法与结果
- CUDA 与昇腾平台上的工程问题及排查过程

## 说明

每篇文章均注明所用软件版本与硬件环境，结论仅在所述环境下验证。如发现错误，将在原文中更正并注明修改内容。

联系方式：[GitHub](https://github.com/hczl) · 订阅：[RSS](/feed.xml)
