---
title: "大模型的数学基础（一）：训练一步里用到的数学"
description: "以一个极小的 Transformer 做一次前向、算损失、反向传播、更新参数为线索，标出每一步用到的数学和所属学科，作为本系列的索引；附符号约定和参考书单。"
date: 2026-10-05 01:00:00 +0800
tags: [数学, 大模型]
math: true
series: math
series_order: 1
---

读大模型的论文和代码，很快会碰到一串具体问题：注意力分数为什么要除以 $$\sqrt{d_k}$$；损失函数里的 $$\log$$ 是从哪里来的；`loss.backward()` 到底算了什么；Adam 里的 $$\beta_1$$、$$\beta_2$$、$$\epsilon$$ 各管什么；训练为什么偏向 BF16 而不是 FP16；RLHF 里为什么要加一项 KL 散度。每个问题背后都是一段大学数学，只是课本上讲的时候没有和这些场景联系起来。

这个系列从头整理这些数学，每个概念都对应到它在大模型里出现的位置。目标是看懂公式和代码在做什么，推导写到能理解为止，不追求证明的完整性。每篇配少量 NumPy 代码，用来直观看一下数值，不涉及训练框架。

文中代码在 Python 3.11、NumPy 2.4 下运行过。

这一篇先用一个极小的模型走完训练的一步，标出每一步用到哪一块数学，后面各篇再分别展开。

## 一个极小的例子

设词表只有 $$V = 8$$ 个词，每个词用 $$d = 4$$ 维向量表示，输入一段长度 $$T = 5$$ 的序列。模型的任务是在每个位置预测下一个词：输入第 1 到第 $$t$$ 个词，输出第 $$t+1$$ 个词在整个词表上的概率分布。

模型只保留一个注意力头和一个输出层，省去多头、前馈层和多层堆叠。真实的大模型结构更复杂，但训练的一步同样由下面几个环节组成：

1. 把词变成向量
2. 注意力：每个位置汇总前面位置的信息
3. 输出层：得到下一个词的概率分布
4. 计算损失
5. 反向传播：求损失对每个参数的梯度
6. 更新参数

下面逐个看每一步用到什么。

## 第一步：把词变成向量

输入是一串整数编号（token id），模型先用一个 $$V \times d$$ 的矩阵 $$E$$ 把每个编号换成一行向量，称为 embedding。代码里这一步是查表 `E[tokens]`，数学上等价于用 one-hot 向量乘矩阵：编号为 $$i$$ 的词对应第 $$i$$ 位为 1、其余为 0 的向量 $$\mathbf{e}_i$$，$$\mathbf{e}_i^\top E$$ 恰好取出 $$E$$ 的第 $$i$$ 行。

整段序列查完表得到一个 $$T \times d$$ 的矩阵 $$X$$，每行是一个位置的向量。此后模型里几乎所有计算都是矩阵乘法，读代码时最常做的事就是推演每个张量的形状。

用到的数学：向量、矩阵、矩阵乘法（第 2 篇）。

## 第二步：注意力

注意力先用三个 $$d \times d$$ 的矩阵把 $$X$$ 分别投影成查询、键和值：

$$
Q = X W_Q,\quad K = X W_K,\quad V = X W_V
$$

然后计算每两个位置之间的相关程度，并归一化成权重：

$$
\mathrm{Attention}(Q, K, V) = \mathrm{softmax}\!\left(\frac{Q K^\top}{\sqrt{d_k}}\right) V
$$

这一个式子里有几处数学：

- $$QK^\top$$ 是一个 $$T \times T$$ 的矩阵，第 $$i$$ 行第 $$j$$ 列是第 $$i$$ 个位置的查询向量和第 $$j$$ 个位置的键向量的点积。点积越大，两个向量方向越接近（第 3 篇）。
- 除以 $$\sqrt{d_k}$$ 是为了控制点积的数值范围。如果查询和键的各分量相互独立、均值为 0、方差为 1，那么它们的点积方差是 $$d_k$$，维度越高数值越大，softmax 的输出越接近 one-hot，梯度越小。这一点在原论文 Attention Is All You Need 的脚注里有说明（第 3 篇、第 8 篇）。
- softmax 把一行任意实数变成一组非负、和为 1 的权重，可以看成一个概率分布（第 9 篇）。
- 语言模型预测下一个词时不能看到后面的词，所以要把 $$QK^\top$$ 上三角部分（$$j > i$$）置为 $$-\infty$$，softmax 之后这些位置的权重为 0，这就是 causal mask。

注意力的输出再加回输入 $$X$$，这一步叫残差连接，它对深层网络能否训练起来影响很大（第 14 篇）。

用到的数学：点积与相似度、softmax、方差分析。

## 第三步：输出层

把注意力层的输出 $$H$$（$$T \times d$$）乘上输出矩阵 $$W_{\text{out}}$$（$$d \times V$$），每个位置得到 $$V$$ 个实数，称为 logits，再过一次 softmax：

$$
P(x_{t+1} = i \mid x_{\le t}) = \frac{e^{z_i}}{\sum_{j=1}^{V} e^{z_j}}
$$

这里的 $$P$$ 就是模型给出的条件概率：已知前 $$t$$ 个词，第 $$t+1$$ 个词是 $$i$$ 的概率。整段序列的概率按链式法则分解为每个位置条件概率的乘积：

$$
P(x_1, \dots, x_T) = \prod_{t=1}^{T} P(x_t \mid x_{<t})
$$

自回归语言模型做的就是估计这些条件概率（第 7 篇）。推理时从这个分布里选下一个词，选法不同就是 greedy、温度、top-k、top-p 等采样策略的区别（第 9 篇）。

用到的数学：条件概率、链式分解、softmax。

## 第四步：计算损失

训练数据给出了每个位置真正的下一个词。如果模型给正确答案的概率是 $$p$$，这个位置的损失就是 $$-\log p$$；整段序列取平均：

$$
\mathcal{L} = -\frac{1}{T} \sum_{t=1}^{T} \log P(x_{t+1} \mid x_{\le t})
$$

这就是交叉熵损失。它有两种解释：从统计的角度看，最小化它等于最大化训练数据在模型下的似然，也就是最大似然估计（第 10 篇）；从信息论的角度看，它是数据分布和模型分布之间的交叉熵，和 KL 散度只差一个常数（第 12 篇）。

常见的困惑度（perplexity）就是 $$e^{\mathcal{L}}$$。如果模型对每个词都均匀猜测，损失是 $$\ln V$$，困惑度恰好等于词表大小 $$V$$，可以理解为模型平均在多少个词之间犹豫。

用到的数学：对数、最大似然估计、交叉熵、KL 散度。

## 第五步：反向传播

训练要调整所有参数（$$E$$、$$W_Q$$、$$W_K$$、$$W_V$$、$$W_{\text{out}}$$）让损失变小，所以需要知道损失对每个参数的偏导数，合起来就是梯度。损失是参数经过一长串运算得到的，求导要用链式法则从损失一层层往回推，这个过程叫反向传播。

以输出层为例，softmax 加交叉熵对 logits 的梯度有一个很简单的结果：

$$
\frac{\partial \mathcal{L}}{\partial \mathbf{z}} = \mathbf{p} - \mathbf{y}
$$

其中 $$\mathbf{p}$$ 是模型输出的概率向量，$$\mathbf{y}$$ 是正确答案的 one-hot 向量。再往回一层，由 $$Z = H W_{\text{out}}$$ 得到 $$\partial \mathcal{L} / \partial W_{\text{out}} = H^\top (P - Y)$$（按位置取平均时再除以 $$T$$）。PyTorch 的 `loss.backward()` 就是自动完成这些计算（第 5 篇、第 6 篇）。

用到的数学：偏导、梯度、链式法则、矩阵求导。

## 第六步：更新参数

最简单的更新方法是沿负梯度方向走一小步：

$$
\theta \leftarrow \theta - \eta \, \nabla_\theta \mathcal{L}
$$

$$\eta$$ 是学习率。大模型训练实际用的是 AdamW：它为每个参数维护梯度的滑动平均（一阶矩）和梯度平方的滑动平均（二阶矩），用二者的比值决定每个参数的步长，再单独加上权重衰减。$$\beta_1$$、$$\beta_2$$ 是两个滑动平均的衰减系数，$$\epsilon$$ 防止除以零。这两份状态和参数一样大，所以优化器状态本身就要占用可观的显存（第 13 篇）。

用到的数学：梯度下降、指数滑动平均、最优化。

## 贯穿全程：数值精度

上面每一步都在有限精度的浮点数上计算。FP16 有 5 位指数、10 位尾数，能表示的最大值约为 65504，训练中梯度很容易上溢或下溢；BF16 有 8 位指数、7 位尾数，指数范围和 FP32 相同，精度更低但不容易溢出，这是训练偏向 BF16 的主要原因。前面 softmax 的实现里先减去最大值再求指数，也是为了避免溢出（第 9 篇、第 14 篇）。

## 训练之外

推理和后训练还会用到另外几块数学：

- 推理：采样策略（第 9 篇）；权重和 KV Cache 的量化（第 15 篇）；一次前向的计算量、KV Cache 的大小、prefill 和 decode 的性能瓶颈分析（第 16 篇）。
- 后训练：RLHF、DPO 等方法把语言模型看成一个策略，用强化学习的方法优化它，需要策略梯度、重要性采样和带 KL 约束的优化（第 17 篇、第 18 篇）。
- 评测：两个模型在评测集上差一两个点是否有意义，属于统计里的估计和置信区间（第 11 篇）。

## 用 NumPy 走一遍

下面的代码按上面的步骤走完一次训练：查表、单头注意力、输出层、交叉熵，然后只对输出层求梯度并更新一步，看损失是否下降。

```python
import numpy as np

rng = np.random.default_rng(0)
V, d, T = 8, 4, 5                     # 词表大小、向量维度、序列长度
tokens  = np.array([1, 5, 2, 7, 3])   # 输入序列
targets = np.array([5, 2, 7, 3, 0])   # 每个位置要预测的下一个词

E = rng.normal(0, 0.5, (V, d))        # embedding 矩阵
W_q, W_k, W_v = (rng.normal(0, 0.5, (d, d)) for _ in range(3))
W_out = rng.normal(0, 0.5, (d, V))    # 输出层

def softmax(z):
    z = z - z.max(axis=-1, keepdims=True)   # 减去最大值，避免 exp 溢出
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)

def forward(W_out):
    X = E[tokens]                                  # 查表：(T, d)
    Q, K, Vv = X @ W_q, X @ W_k, X @ W_v
    S = Q @ K.T / np.sqrt(d)                       # 注意力分数：(T, T)
    S = S + np.triu(np.full((T, T), -np.inf), 1)   # causal mask：不能看后面的词
    H = X + softmax(S) @ Vv                        # 注意力输出加残差
    P = softmax(H @ W_out)                         # 每个位置在词表上的概率：(T, V)
    loss = -np.log(P[np.arange(T), targets]).mean()  # 交叉熵
    return H, P, loss

H, P, loss = forward(W_out)
print(f"更新前 loss = {loss:.4f}，均匀猜测时为 ln V = {np.log(V):.4f}")

# 反向：只对输出层求梯度。softmax + 交叉熵对 logits 的梯度是 P - onehot
G = P.copy()
G[np.arange(T), targets] -= 1
grad_W_out = H.T @ G / T                           # 链式法则：(d, V)

W_out = W_out - 0.5 * grad_W_out                   # 梯度下降一步，学习率 0.5
_, _, loss = forward(W_out)
print(f"更新后 loss = {loss:.4f}")
```

输出：

```text
更新前 loss = 2.1034，均匀猜测时为 ln V = 2.0794
更新后 loss = 2.0015
```

随机初始化的模型和均匀猜测差不多，更新一步之后损失下降。上面的梯度公式也可以用数值差分检验：把 $$W_{\text{out}}$$ 的每个元素分别加减 $$10^{-6}$$，用损失之差除以 $$2 \times 10^{-6}$$，和公式算出的梯度最大相差约 $$3 \times 10^{-10}$$。

## 各步骤与本系列的对应

| 环节 | 用到的数学 | 学科 | 篇目 |
| --- | --- | --- | --- |
| 词变向量、线性层 | 矩阵乘法、形状 | 线性代数 | 2 |
| 注意力分数 | 点积、范数、缩放 | 线性代数、概率 | 3 |
| LoRA、低秩 KV 压缩 | 特征值、SVD、秩 | 线性代数 | 4 |
| 求梯度 | 偏导、梯度 | 微积分 | 5 |
| 反向传播 | 链式法则、矩阵求导 | 微积分 | 6 |
| 语言模型的定义 | 条件概率、链式分解 | 概率论 | 7 |
| 初始化、方差分析 | 高斯分布、方差 | 概率论 | 8 |
| 输出分布与采样 | softmax、温度 | 概率论 | 9 |
| 损失函数 | 最大似然、交叉熵 | 数理统计 | 10 |
| 评测结果是否可信 | 估计、置信区间 | 数理统计 | 11 |
| 蒸馏、KL 惩罚 | 熵、KL 散度 | 信息论 | 12 |
| 参数更新 | 梯度下降、AdamW | 最优化 | 13 |
| 数值精度 | 浮点格式、归一化 | 数值计算 | 14 |
| 量化 | 缩放、舍入误差 | 数值计算 | 15 |
| 性能估算 | FLOPs、访存、roofline | 系统估算 | 16 |
| RLHF | 策略梯度 | 强化学习 | 17 |
| PPO、DPO | 重要性采样、KL 约束 | 强化学习 | 18 |
| 注意力完整推导 | 以上全部 | 综合 | 19 |

## 符号约定

本系列统一使用下面的记号，和多数论文、PyTorch 代码保持一致。

| 记号 | 含义 |
| --- | --- |
| $$x$$、$$a$$ | 标量，小写斜体 |
| $$\mathbf{x}$$ | 向量，小写粗体，默认是列向量 |
| $$X$$、$$W$$ | 矩阵，大写斜体 |
| $$x_i$$、$$X_{ij}$$ | 向量的第 $$i$$ 个分量、矩阵第 $$i$$ 行第 $$j$$ 列的元素 |
| $$X^\top$$ | 转置 |
| $$\mathbf{x}^\top \mathbf{y}$$、$$\langle \mathbf{x}, \mathbf{y} \rangle$$ | 点积 |
| $$\lVert \mathbf{x} \rVert_2$$ | L2 范数 |
| $$\odot$$ | 逐元素相乘 |
| $$\mathbb{R}^{m \times n}$$ | $$m$$ 行 $$n$$ 列的实矩阵 |
| $$\theta$$ | 模型的全部参数 |
| $$\nabla_\theta \mathcal{L}$$ | 损失 $$\mathcal{L}$$ 对参数 $$\theta$$ 的梯度 |
| $$P(A \mid B)$$ | 条件概率 |
| $$\mathbb{E}[X]$$、$$\mathrm{Var}(X)$$ | 期望、方差 |
| $$p_\theta$$ | 参数为 $$\theta$$ 的模型给出的分布 |
| $$\mathcal{N}(\mu, \sigma^2)$$ | 均值 $$\mu$$、方差 $$\sigma^2$$ 的高斯分布 |
| $$\log$$ | 自然对数，和 $$\ln$$ 相同 |

形状约定：数据按行排列，一个 batch 里 $$T$$ 个位置、每个 $$d$$ 维，记为 $$X \in \mathbb{R}^{T \times d}$$，线性层写作 $$XW$$，和 PyTorch 的 `x @ W` 一致。有些教材把向量写成列、线性层写成 $$W\mathbf{x}$$，两种写法差一个转置，遇到时会说明。

## 参考书单

不必通读，按需查阅。

- Gilbert Strang，Introduction to Linear Algebra，第 6 版，Wellesley-Cambridge Press，2023。配套的 [MIT 18.06 课程](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/) 有完整录像。适合第 2 到 4 篇。
- Marc Peter Deisenroth、A. Aldo Faisal、Cheng Soon Ong，[Mathematics for Machine Learning](https://mml-book.github.io/)，Cambridge University Press，2020，作者网站提供免费 PDF。专为机器学习写的数学书，第 2 到 4 章线性代数、第 5 章向量微积分、第 6 章概率、第 7 章连续优化，覆盖本系列前半部分。
- Ian Goodfellow、Yoshua Bengio、Aaron Courville，[Deep Learning](https://www.deeplearningbook.org/)，MIT Press，2016，网站可免费阅读。第 2 章线性代数、第 3 章概率与信息论、第 4 章数值计算是很好的速查；第 5 章讲最大似然，第 6 章讲反向传播，第 8 章讲优化算法。
- 3Blue1Brown，[Essence of linear algebra](https://www.3blue1brown.com/topics/linear-algebra) 和 [Essence of calculus](https://www.3blue1brown.com/topics/calculus) 视频系列。用动画讲几何直观，适合在看书之前先建立印象。
- Larry Wasserman，All of Statistics，Springer，2004。概率和数理统计的简明教材，适合第 7 到 11 篇。
- Thomas M. Cover、Joy A. Thomas，Elements of Information Theory，第 2 版，Wiley，2006。信息论的标准教材，第 2 章就够第 12 篇用。
- Richard S. Sutton、Andrew G. Barto，[Reinforcement Learning: An Introduction](http://incompleteideas.net/book/the-book-2nd.html)，第 2 版，MIT Press，2018，作者网站提供免费 PDF。第 3 章马尔可夫决策过程、第 13 章策略梯度，对应第 17 篇。

各篇会再标出对应的章节。

## 参考资料

- Ashish Vaswani 等，[Attention Is All You Need](https://arxiv.org/abs/1706.03762)，NeurIPS 2017。缩放点积注意力的定义，以及除以 $$\sqrt{d_k}$$ 的理由（3.2.1 节脚注）。
- Diederik P. Kingma、Jimmy Ba，[Adam: A Method for Stochastic Optimization](https://arxiv.org/abs/1412.6980)，ICLR 2015。
- Ilya Loshchilov、Frank Hutter，[Decoupled Weight Decay Regularization](https://arxiv.org/abs/1711.05101)，ICLR 2019。AdamW。
- Ian Goodfellow 等，[Deep Learning](https://www.deeplearningbook.org/) 第 6.5 节，反向传播；第 5.5 节，最大似然估计。
- IEEE 754-2019，浮点数算术标准（FP16、FP32 的格式定义）。BF16 不在该标准中，格式见 [Google Cloud 关于 bfloat16 的说明](https://cloud.google.com/tpu/docs/bfloat16)。
- [NumPy 文档](https://numpy.org/doc/stable/)。
