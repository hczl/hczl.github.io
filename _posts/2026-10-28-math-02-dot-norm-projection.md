---
title: "大模型的数学基础（二）：点积、范数与投影"
description: "点积的代数定义和几何含义、L1/L2/L∞ 范数、余弦相似度、正交与投影；以及注意力分数为什么要除以 √d、RMSNorm 做的是什么。"
date: 2026-10-28 09:55:00 +0800
tags: [数学, 线性代数]
math: true
series: math
series_order: 2
---

上一篇讲矩阵乘法时，按行的看法用到了点积：$$A\mathbf{x}$$ 的每个分量是 $$A$$ 的一行和 $$\mathbf{x}$$ 的点积。这一篇单独看点积。它是一个很简单的运算，对应位置相乘再相加，但从它能引出长度、夹角、正交和投影，大模型里的注意力分数、余弦相似度和 RMSNorm 也都直接建立在它上面。

## 点积

两个 $$n$$ 维向量 $$\mathbf{x}$$、$$\mathbf{y}$$ 的点积（也叫内积）定义为对应分量相乘再相加：

$$
\mathbf{x}^\top \mathbf{y} = \sum_{i=1}^{n} x_i y_i
$$

结果是一个数。按上一篇的形状规则，$$\mathbf{x}^\top$$ 是 $$1 \times n$$，$$\mathbf{y}$$ 是 $$n \times 1$$，相乘得到 $$1 \times 1$$，所以点积常写成 $$\mathbf{x}^\top \mathbf{y}$$，也写成 $$\langle \mathbf{x}, \mathbf{y} \rangle$$ 或 $$\mathbf{x} \cdot \mathbf{y}$$。

以 $$\mathbf{x} = [3, 4]$$、$$\mathbf{y} = [4, 3]$$ 为例，$$\mathbf{x}^\top \mathbf{y} = 3 \times 4 + 4 \times 3 = 24$$。

点积有几条直接从定义得到的性质：

- 交换：$$\mathbf{x}^\top \mathbf{y} = \mathbf{y}^\top \mathbf{x}$$。
- 对每个参数都是线性的：$$\mathbf{x}^\top (a\mathbf{y} + b\mathbf{z}) = a\,\mathbf{x}^\top \mathbf{y} + b\,\mathbf{x}^\top \mathbf{z}$$。
- 向量和自己的点积是各分量的平方和，$$\mathbf{x}^\top \mathbf{x} = \sum_i x_i^2 \ge 0$$，只有零向量等于 0。

最后一条引出了长度。

## 范数

$$\mathbf{x}^\top \mathbf{x}$$ 开平方，就是向量的长度：

$$
\lVert \mathbf{x} \rVert_2 = \sqrt{\mathbf{x}^\top \mathbf{x}} = \sqrt{x_1^2 + x_2^2 + \cdots + x_n^2}
$$

二维时这就是勾股定理，$$[3, 4]$$ 的长度是 $$\sqrt{9 + 16} = 5$$。维度更高时没法画，但公式照样适用。这种长度叫 L2 范数，也叫欧几里得范数。

度量向量大小的方法不止一种，统称范数。常用的还有两个：

| 范数 | 定义 | $$[1, -2, 2]$$ 的值 |
| --- | --- | --- |
| L1 | $$\lVert \mathbf{x} \rVert_1 = \sum_i \lvert x_i \rvert$$ | 5 |
| L2 | $$\lVert \mathbf{x} \rVert_2 = \sqrt{\sum_i x_i^2}$$ | 3 |
| L∞ | $$\lVert \mathbf{x} \rVert_\infty = \max_i \lvert x_i \rvert$$ | 2 |

三者都满足范数的要求：只有零向量的范数为 0；$$\lVert c\,\mathbf{x} \rVert = \lvert c \rvert \, \lVert \mathbf{x} \rVert$$；三角不等式 $$\lVert \mathbf{x} + \mathbf{y} \rVert \le \lVert \mathbf{x} \rVert + \lVert \mathbf{y} \rVert$$。区别在于对大分量的敏感程度：L1 把所有分量的绝对值同等相加，L2 先平方，大分量的权重更高，L∞ 只看最大的那一个。不加下标时，$$\lVert \mathbf{x} \rVert$$ 一般指 L2 范数，本系列也是这样。

范数为 1 的向量叫单位向量。任何非零向量除以自己的 L2 范数，得到同方向的单位向量，这一步叫归一化：$$\hat{\mathbf{x}} = \mathbf{x} / \lVert \mathbf{x} \rVert$$。

## 夹角与余弦相似度

点积和长度、夹角的关系是

$$
\mathbf{x}^\top \mathbf{y} = \lVert \mathbf{x} \rVert \, \lVert \mathbf{y} \rVert \cos\theta
$$

$$\theta$$ 是两个非零向量的夹角（零向量没有方向，夹角无定义）。二维时可以用余弦定理验证：以 $$\mathbf{x}$$、$$\mathbf{y}$$ 为两边的三角形，第三边是 $$\mathbf{x} - \mathbf{y}$$，展开 $$\lVert \mathbf{x} - \mathbf{y} \rVert^2 = (\mathbf{x} - \mathbf{y})^\top (\mathbf{x} - \mathbf{y}) = \lVert \mathbf{x} \rVert^2 + \lVert \mathbf{y} \rVert^2 - 2\,\mathbf{x}^\top \mathbf{y}$$，和余弦定理 $$c^2 = a^2 + b^2 - 2ab\cos\theta$$ 逐项对照，就得到上面的式子。高维时反过来用它定义夹角：

$$
\cos\theta = \frac{\mathbf{x}^\top \mathbf{y}}{\lVert \mathbf{x} \rVert \, \lVert \mathbf{y} \rVert}
$$

这个值叫余弦相似度，范围在 $$-1$$ 到 $$1$$ 之间：方向相同为 1，垂直为 0，相反为 $$-1$$。它保证落在这个范围内，依据的是柯西-施瓦茨不等式 $$\lvert \mathbf{x}^\top \mathbf{y} \rvert \le \lVert \mathbf{x} \rVert \, \lVert \mathbf{y} \rVert$$。

还是 $$[3, 4]$$ 和 $$[4, 3]$$：两者长度都是 5，点积 24，余弦相似度 $$24 / 25 = 0.96$$，夹角约 16.3°。

余弦相似度只看方向，不看长度：把 $$\mathbf{x}$$ 放大 10 倍，点积放大 10 倍，余弦相似度不变。点积则同时受方向和长度影响。两个向量点积大，可能是方向接近，也可能只是其中一个很长。用点积比较相似程度时，要想清楚长度是不是也应该算进去。

## 正交

点积为 0 的两个向量叫正交，几何上就是垂直。$$[3, 4]$$ 和 $$[-4, 3]$$ 的点积是 $$-12 + 12 = 0$$，二者正交。

一组向量两两正交、并且每个长度都是 1，叫标准正交（orthonormal）向量组。上一篇的标准基向量 $$\mathbf{e}_1, \dots, \mathbf{e}_n$$ 就是一组。把一组标准正交向量按列排成矩阵 $$Q$$，由按元素的看法，$$Q^\top Q$$ 的 $$(i, j)$$ 元素是第 $$i$$ 列和第 $$j$$ 列的点积，于是

$$
Q^\top Q = I
$$

列数等于行数的这种方阵叫正交矩阵，它的逆就是它的转置。正交矩阵乘一个向量不改变长度：$$\lVert Q\mathbf{x} \rVert^2 = \mathbf{x}^\top Q^\top Q \mathbf{x} = \mathbf{x}^\top \mathbf{x}$$。几何上它只做旋转或镜像，第三篇讲 SVD 时会用到这一点。

## 投影

把向量 $$\mathbf{a}$$ 投影到非零向量 $$\mathbf{b}$$ 所在的直线上，是在这条直线上找离 $$\mathbf{a}$$ 最近的点。

以 $$\mathbf{a} = [2, 1]$$、$$\mathbf{b} = [3, 0]$$ 为例。$$\mathbf{b}$$ 在横轴上，直线上离 $$[2, 1]$$ 最近的点显然是 $$[2, 0]$$，从 $$\mathbf{a}$$ 往横轴作垂线就得到它。

一般情况的推导按下面几步：

1. 投影点在 $$\mathbf{b}$$ 的直线上，可以写成 $$\mathbf{p} = c\,\mathbf{b}$$，只需要求系数 $$c$$。
2. 最近的点满足：从 $$\mathbf{p}$$ 指向 $$\mathbf{a}$$ 的误差向量 $$\mathbf{a} - \mathbf{p}$$ 和直线垂直，即 $$\mathbf{b}^\top (\mathbf{a} - c\,\mathbf{b}) = 0$$。
3. 展开得 $$\mathbf{b}^\top \mathbf{a} - c\,\mathbf{b}^\top \mathbf{b} = 0$$，所以 $$c = \dfrac{\mathbf{b}^\top \mathbf{a}}{\mathbf{b}^\top \mathbf{b}}$$。
4. 代回去：

$$
\mathbf{p} = \frac{\mathbf{b}^\top \mathbf{a}}{\mathbf{b}^\top \mathbf{b}}\,\mathbf{b}
$$

代入例子，$$\mathbf{b}^\top \mathbf{a} = 6$$，$$\mathbf{b}^\top \mathbf{b} = 9$$，$$\mathbf{p} = \tfrac{6}{9}[3, 0] = [2, 0]$$，误差向量 $$[0, 1]$$ 和 $$\mathbf{b}$$ 的点积为 0，和直观一致。

```python
import numpy as np

x = np.array([3.0, 4.0])
y = np.array([4.0, 3.0])

dot = x @ y
cos = dot / (np.linalg.norm(x) * np.linalg.norm(y))
print(dot, np.linalg.norm(x), cos, np.degrees(np.arccos(cos)))

a = np.array([2.0, 1.0])
b = np.array([3.0, 0.0])
p = (a @ b) / (b @ b) * b
print(p, a - p, (a - p) @ b)
```

```text
24.0 5.0 0.96 16.260204708311967
[2. 0.] [0. 1.] 0.0
```

如果 $$\mathbf{b}$$ 是单位向量，分母 $$\mathbf{b}^\top \mathbf{b} = 1$$，投影简化为 $$(\mathbf{b}^\top \mathbf{a})\,\mathbf{b}$$：点积 $$\mathbf{b}^\top \mathbf{a}$$ 就是 $$\mathbf{a}$$ 在 $$\mathbf{b}$$ 方向上的坐标。这给了点积另一层含义：一个向量和单位向量的点积，是它在这个方向上有多少分量。

投影是一个线性变换，所以能写成矩阵。把 $$\mathbf{p}$$ 的式子改写成 $$\mathbf{p} = \dfrac{\mathbf{b}\mathbf{b}^\top}{\mathbf{b}^\top \mathbf{b}}\,\mathbf{a}$$，投影矩阵就是

$$
P = \frac{\mathbf{b}\mathbf{b}^\top}{\mathbf{b}^\top \mathbf{b}}
$$

分子是上一篇的外积。例子里 $$P = \begin{bmatrix} 1 & 0 \\ 0 & 0 \end{bmatrix}$$，保留横坐标、清掉纵坐标。投影两次和投影一次结果相同，$$P^2 = P$$。

投影到多个方向张成的子空间也是同样的思路。如果这些方向是一组标准正交向量，排成矩阵 $$Q$$，投影矩阵是 $$P = QQ^\top$$，等于分别投影到每个方向再相加。方向不正交时，把这些方向按列排成矩阵 $$A$$，误差向量要和每一个方向都垂直，在 $$A$$ 的各列线性无关（列满秩，$$A^\top A$$ 可逆）时推出来的结果是 $$A(A^\top A)^{-1}A^\top$$，这就是最小二乘法的来源，这里不展开。

## 在大模型里

### 注意力分数和 √d

注意力里，每个 query 向量 $$\mathbf{q}$$ 和每个 key 向量 $$\mathbf{k}$$ 做点积，得到分数，分数经过 softmax 变成权重。Transformer 论文里的公式是

$$
\mathrm{Attention}(Q, K, V) = \mathrm{softmax}\!\left(\frac{QK^\top}{\sqrt{d}}\right) V
$$

$$QK^\top$$ 的 $$(i, j)$$ 元素是第 $$i$$ 个 query 和第 $$j$$ 个 key 的点积，$$d$$ 是向量维度。除以 $$\sqrt{d}$$ 的原因可以从点积的定义看出来：假设 $$\mathbf{q}$$、$$\mathbf{k}$$ 的每个分量都是独立的、均值 0 方差 1 的随机数，那么每一项 $$q_i k_i$$ 的方差是 1，$$d$$ 项相加，方差是 $$d$$，标准差是 $$\sqrt{d}$$。维度越高，点积的数值越大。用随机数验证：

```python
import numpy as np

rng = np.random.default_rng(0)
for d in [16, 128, 1024]:
    q = rng.standard_normal((10000, d))
    k = rng.standard_normal((10000, d))
    s = (q * k).sum(axis=1)          # 10000 个点积
    print(d, s.std().round(2), (s / np.sqrt(d)).std().round(2))
```

```text
16 4.04 1.01
128 11.37 1.01
1024 31.85 1.0
```

标准差和 $$\sqrt{16} = 4$$、$$\sqrt{128} \approx 11.3$$、$$\sqrt{1024} = 32$$ 基本一致，除以 $$\sqrt{d}$$ 后都回到 1 左右。分数的数值太大时，softmax 的输出几乎全部集中到最大的那一项上。$$d = 128$$ 时 8 个 key 的例子：

```python
import numpy as np

def softmax(s):
    e = np.exp(s - s.max())
    return e / e.sum()

rng = np.random.default_rng(1)
d = 128
q = rng.standard_normal(d)
K = rng.standard_normal((8, d))      # 8 个 key
s = K @ q
print(softmax(s).round(3))
print(softmax(s / np.sqrt(d)).round(3))
```

```text
[0.    0.7   0.    0.    0.    0.    0.001 0.3  ]
[0.047 0.278 0.124 0.051 0.065 0.026 0.152 0.258]
```

不缩放时，权重几乎只落在两个 key 上，其余权重很小，多数在保留三位小数后显示为 0（本例中这些值仍是正数）；缩放后分布平缓得多。权重接近 0 或 1 时，softmax 对输入分数的梯度很小，反传回去的信号变弱，训练会变困难，这是论文给出的理由。softmax 的梯度放到第五篇，这里只看到数值上的现象。

推理时，KV Cache 里存的就是之前每个位置的 key 和 value。生成一个新 token，要拿它的 query 和缓存里所有 key 各做一次点积，序列越长，点积越多，这也是长上下文推理要读大量 KV 的原因。

### 余弦相似度

检索、去重、聚类时比较两段文本是否相似，常用的做法是把文本编码成向量，再算余弦相似度。很多 embedding 模型输出的向量已经归一化成单位向量，这时余弦相似度就等于点积，可以直接用矩阵乘法一次算出一个 query 和大量文档的相似度。

### RMSNorm

LLaMA 等模型在每一层用 RMSNorm 对隐藏向量做归一化：

$$
\mathrm{RMSNorm}(\mathbf{h}) = \frac{\mathbf{h}}{\mathrm{RMS}(\mathbf{h})} \odot \mathbf{g},\qquad
\mathrm{RMS}(\mathbf{h}) = \sqrt{\frac{1}{d}\sum_{i=1}^{d} h_i^2} = \frac{\lVert \mathbf{h} \rVert}{\sqrt{d}}
$$

$$\mathbf{g}$$ 是可学习的逐维缩放系数，$$\odot$$ 是逐元素相乘。分母就是 L2 范数除以 $$\sqrt{d}$$，所以不计下面说的 $$\epsilon$$ 时，RMSNorm 先把非零向量的长度固定到 $$\sqrt{d}$$、方向不变，再逐维乘 $$\mathbf{g}$$（乘完之后长度一般不再是 $$\sqrt{d}$$）。例如 $$\mathbf{h} = [1, -2, 2, 4]$$，$$\lVert \mathbf{h} \rVert = 5$$，$$d = 4$$，$$\mathrm{RMS} = 2.5$$，归一化后是 $$[0.4, -0.8, 0.8, 1.6]$$，长度为 2。实际实现通常在根号里的均方上加一个很小的 $$\epsilon$$，分母写成 $$\sqrt{\frac{1}{d}\sum_i h_i^2 + \epsilon}$$，避免除以 0；这时归一化后的长度小于 $$\sqrt{d}$$，均方远大于 $$\epsilon$$ 时才近似 $$\sqrt{d}$$。

## 参考资料

- Gilbert Strang，Introduction to Linear Algebra，第 6 版，第 1.2 节 Lengths and Angles from Dot Products、第 4.2 节 Projections。
- Deisenroth 等，[Mathematics for Machine Learning](https://mml-book.github.io/)，第 3 章 Analytic Geometry：3.1 Norms、3.2 Inner Products、3.4 Angles and Orthogonality、3.8 Orthogonal Projections。
- Goodfellow 等，[Deep Learning](https://www.deeplearningbook.org/) 第 2.5 节 Norms、第 2.6 节 Special Kinds of Matrices and Vectors。
- Ashish Vaswani 等，[Attention Is All You Need](https://arxiv.org/abs/1706.03762)，NeurIPS 2017。第 3.2.1 节 Scaled Dot-Product Attention 给出除以 $$\sqrt{d_k}$$ 的理由。
- Biao Zhang、Rico Sennrich，[Root Mean Square Layer Normalization](https://arxiv.org/abs/1910.07467)，NeurIPS 2019。
- [NumPy 文档：numpy.linalg.norm](https://numpy.org/doc/stable/reference/generated/numpy.linalg.norm.html)。
