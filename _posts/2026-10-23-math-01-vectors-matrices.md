---
title: "大模型的数学基础（一）：向量与矩阵"
description: "向量和矩阵的定义、矩阵乘法的三种看法和形状规则；附本系列的篇目安排、符号约定和参考书单。"
date: 2026-10-23 17:40:00 +0800
tags: [数学, 线性代数]
math: true
series: math
series_order: 1
---

打开任何一个模型实现，最先看到的往往是一串形状注释：`(batch, seq, hidden)`、`(hidden, 4 * hidden)`。读代码时常要回答这样的问题：两个张量能不能相乘，乘完是什么形状；`x @ W` 和 `W @ x` 有什么区别；一个 $$4096 \times 4096$$ 的矩阵乘上一个向量，到底算了什么。这些问题都属于线性代数里最基础的部分：向量、矩阵和矩阵乘法。

这一篇是「大模型数学基础」系列的第一篇，全系列篇目见下表。

## 系列篇目

| 篇号 | 内容 | 学科 |
| --- | --- | --- |
| 1 | 向量与矩阵 | 线性代数 |
| 2 | 点积、范数与投影 | 线性代数 |
| 3 | 特征值与 SVD | 线性代数 |
| 4 | 导数、偏导与梯度 | 微积分 |
| 5 | 链式法则与矩阵求导 | 微积分 |
| 6 | 概率基础 | 概率论 |
| 7 | 常见分布 | 概率论 |
| 8 | 期望、方差与估计 | 概率论与数理统计 |
| 9 | 最大似然估计 | 数理统计 |
| 10 | 熵、交叉熵与 KL 散度 | 信息论 |
| 11 | 梯度下降 | 最优化 |
| 12 | 浮点数与数值误差 | 数值计算 |
| 13 | 训练一步里用到的数学 | 应用 |
| 14 | 把注意力完整推一遍 | 应用 |
| 15 | 推理中的数学 | 应用 |
| 16 | 后训练中的数学 | 应用 |

## 向量

向量是一列有序的数。一个 $$n$$ 维向量写作

$$
\mathbf{x} = \begin{bmatrix} x_1 \\ x_2 \\ \vdots \\ x_n \end{bmatrix} \in \mathbb{R}^n
$$

$$\mathbb{R}^n$$ 表示所有 $$n$$ 维实向量构成的集合。向量有两种常用的理解方式：一是一组数值特征，比如一个词用 4096 个数表示；二是空间里的一个点，或者从原点指向这个点的箭头。二维、三维时可以画出来，维度再高就画不出来了，但加法、长度、夹角这些几何概念照样成立。

向量有两种基本运算。加法是对应分量相加，数乘是每个分量乘同一个数：

$$
\mathbf{x} + \mathbf{y} = \begin{bmatrix} x_1 + y_1 \\ \vdots \\ x_n + y_n \end{bmatrix},\qquad
c\,\mathbf{x} = \begin{bmatrix} c\,x_1 \\ \vdots \\ c\,x_n \end{bmatrix}
$$

把两者组合起来，$$c_1 \mathbf{v}_1 + c_2 \mathbf{v}_2 + \cdots + c_k \mathbf{v}_k$$ 叫作向量 $$\mathbf{v}_1, \dots, \mathbf{v}_k$$ 的线性组合，$$c_i$$ 是组合系数。线性组合是线性代数里最核心的操作，后面矩阵乘法的几种看法都建立在它上面。

## 矩阵

矩阵是按行和列排列的一张数表。$$m$$ 行 $$n$$ 列的实矩阵记为 $$A \in \mathbb{R}^{m \times n}$$，第 $$i$$ 行第 $$j$$ 列的元素记为 $$A_{ij}$$。一个矩阵既可以看成 $$m$$ 个行向量叠在一起，也可以看成 $$n$$ 个列向量并排放在一起，两种看法在不同场合各有用处。

几个常用的概念：

- 转置 $$A^\top$$：行列互换，$$(A^\top)_{ij} = A_{ji}$$，形状从 $$m \times n$$ 变为 $$n \times m$$。
- 方阵：行数等于列数的矩阵。
- 单位矩阵 $$I$$：对角线上是 1、其余为 0 的方阵，任何矩阵乘以它都不变。
- 对角矩阵：只有对角线上有非零元素的方阵。用对角矩阵乘一个矩阵，相当于把每一行（左乘）或每一列（右乘）分别放大或缩小。

向量也可以看成只有一列的矩阵，$$\mathbf{x} \in \mathbb{R}^n$$ 就是 $$n \times 1$$ 的矩阵，它的转置 $$\mathbf{x}^\top$$ 是 $$1 \times n$$ 的行向量。

## 矩阵乘向量

先看一个具体的例子，一个 3 行 2 列的矩阵乘一个 2 维向量：

$$
\begin{bmatrix} 1 & 2 \\ 3 & 4 \\ 5 & 6 \end{bmatrix}
\begin{bmatrix} 10 \\ 1 \end{bmatrix}
=
\begin{bmatrix} 1 \times 10 + 2 \times 1 \\ 3 \times 10 + 4 \times 1 \\ 5 \times 10 + 6 \times 1 \end{bmatrix}
=
\begin{bmatrix} 12 \\ 34 \\ 56 \end{bmatrix}
$$

结果是一个 3 维向量，有几行就得到几个数。第一个数 12 只用到矩阵的第一行 $$[1, 2]$$：把它和向量 $$[10, 1]$$ 对应位置相乘再相加，$$1 \times 10 + 2 \times 1 = 12$$。第二、三个数分别用第二、三行，算法相同。所以矩阵的列数必须等于向量的长度，否则对应位置配不上。

一般地，$$A \in \mathbb{R}^{m \times n}$$ 乘以 $$\mathbf{x} \in \mathbb{R}^n$$ 得到 $$\mathbf{y} = A\mathbf{x} \in \mathbb{R}^m$$，第 $$i$$ 个分量是

$$
y_i = \sum_{j=1}^{n} A_{ij} x_j
$$

上面的算法是按行读：$$y_i$$ 是 $$A$$ 的第 $$i$$ 行和 $$\mathbf{x}$$ 逐项相乘再求和，这种运算叫两个向量的点积。$$A\mathbf{x}$$ 等于拿 $$A$$ 的每一行分别和 $$\mathbf{x}$$ 做点积。

同一个例子还可以换一种算法，按列读：把矩阵拆成两列，用向量的两个分量 10 和 1 分别去乘这两列，再相加：

$$
10 \begin{bmatrix} 1 \\ 3 \\ 5 \end{bmatrix} + 1 \begin{bmatrix} 2 \\ 4 \\ 6 \end{bmatrix}
=
\begin{bmatrix} 10 \\ 30 \\ 50 \end{bmatrix} + \begin{bmatrix} 2 \\ 4 \\ 6 \end{bmatrix}
=
\begin{bmatrix} 12 \\ 34 \\ 56 \end{bmatrix}
$$

结果相同。向量的第 1 个分量决定第 1 列用多少份，第 2 个分量决定第 2 列用多少份。一般地，把 $$A$$ 的列记为 $$\mathbf{a}_1, \dots, \mathbf{a}_n$$，

$$
A\mathbf{x} = x_1 \mathbf{a}_1 + x_2 \mathbf{a}_2 + \cdots + x_n \mathbf{a}_n
$$

即 $$A\mathbf{x}$$ 是 $$A$$ 各列的线性组合，组合系数就是 $$\mathbf{x}$$ 的各个分量。按行读适合手算，按列读更便于理解结果：不管 $$\mathbf{x}$$ 取什么值，$$A\mathbf{x}$$ 都只能是 $$A$$ 各列按某种比例混合出来的向量。

```python
import numpy as np

A = np.array([[1, 2],
              [3, 4],
              [5, 6]])          # 3×2
x = np.array([10, 1])           # 长度 2

# 看法一：每一行和 x 做点积
by_rows = np.array([A[i] @ x for i in range(3)])
# 看法二：A 的各列按 x 的分量加权求和
by_cols = x[0] * A[:, 0] + x[1] * A[:, 1]

print(A @ x, by_rows, by_cols)
```

```text
[12 34 56] [12 34 56] [12 34 56]
```

一个特例很常用：如果 $$\mathbf{x}$$ 是第 $$j$$ 个分量为 1、其余为 0 的向量 $$\mathbf{e}_j$$（称为 one-hot 向量或标准基向量），按列的看法，$$A\mathbf{e}_j$$ 恰好取出 $$A$$ 的第 $$j$$ 列；同理，$$\mathbf{e}_i^\top A$$ 取出第 $$i$$ 行。

## 矩阵乘矩阵

$$A \in \mathbb{R}^{m \times k}$$ 乘以 $$B \in \mathbb{R}^{k \times n}$$ 得到 $$C = AB \in \mathbb{R}^{m \times n}$$：

$$
C_{ij} = \sum_{l=1}^{k} A_{il} B_{lj}
$$

要求 $$A$$ 的列数等于 $$B$$ 的行数，结果的形状取 $$A$$ 的行数和 $$B$$ 的列数，可以记成 $$(m \times k)(k \times n) = (m \times n)$$，中间的 $$k$$ 被“消掉”。和矩阵乘向量一样，同一个乘积有几种读法：

1.  按元素：$$C_{ij}$$ 是 $$A$$ 的第 $$i$$ 行和 $$B$$ 的第 $$j$$ 列的点积。这是定义本身，适合手算单个元素。
2.  按列：$$C$$ 的第 $$j$$ 列等于 $$A$$ 乘以 $$B$$ 的第 $$j$$ 列，即 $$A\mathbf{b}_j$$。所以 $$C$$ 的每一列都是 $$A$$ 各列的线性组合。按行也有对称的说法：$$C$$ 的第 $$i$$ 行是 $$B$$ 各行的线性组合，系数来自 $$A$$ 的第 $$i$$ 行。
3.  按外积之和。这种读法需要先认识外积。

外积是一个列向量乘一个行向量。$$m$$ 维列向量 $$\mathbf{u}$$ 是 $$m \times 1$$ 的矩阵，$$n$$ 维行向量 $$\mathbf{v}^\top$$ 是 $$1 \times n$$ 的矩阵，按形状规则相乘得到 $$m \times n$$ 的矩阵，第 $$i$$ 行第 $$j$$ 列就是 $$u_i v_j$$。例如

$$
\begin{bmatrix} 1 \\ 2 \end{bmatrix}
\begin{bmatrix} 3 & 4 & 5 \end{bmatrix}
=
\begin{bmatrix} 3 & 4 & 5 \\ 6 & 8 & 10 \end{bmatrix}
$$

相当于用列向量的每个分量去乘整个行向量，一个分量产生一行。点积是行向量乘列向量，结果是一个数；外积顺序反过来，结果是一张表。

有了外积，矩阵乘法可以这样算：取 $$A$$ 的第 1 列和 $$B$$ 的第 1 行做外积，再取 $$A$$ 的第 2 列和 $$B$$ 的第 2 行做外积，依此类推，最后把这 $$k$$ 个矩阵加起来。以两个 2×2 矩阵为例：

$$
\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}
\begin{bmatrix} 5 & 6 \\ 7 & 8 \end{bmatrix}
=
\begin{bmatrix} 1 \\ 3 \end{bmatrix} \begin{bmatrix} 5 & 6 \end{bmatrix}
+
\begin{bmatrix} 2 \\ 4 \end{bmatrix} \begin{bmatrix} 7 & 8 \end{bmatrix}
=
\begin{bmatrix} 5 & 6 \\ 15 & 18 \end{bmatrix}
+
\begin{bmatrix} 14 & 16 \\ 28 & 32 \end{bmatrix}
=
\begin{bmatrix} 19 & 22 \\ 43 & 50 \end{bmatrix}
$$

按元素的定义算，左上角是 $$1 \times 5 + 2 \times 7 = 19$$，和这里一致。原因在于定义 $$C_{ij} = \sum_l A_{il} B_{lj}$$ 的求和号里有 $$k$$ 项，第 $$l$$ 项 $$A_{il} B_{lj}$$ 恰好是第 $$l$$ 个外积在 $$(i, j)$$ 位置上的元素；按元素算是对每个位置分别把 $$k$$ 项加起来，按外积算是先把第 $$l$$ 项在所有位置上一次算完，再把 $$k$$ 张表相加。把 $$A$$ 的第 $$l$$ 列记为 $$\mathbf{a}_l$$、$$B$$ 的第 $$l$$ 行记为 $$\mathbf{b}_l^\top$$，写成公式就是

$$
AB = \sum_{l=1}^{k} \mathbf{a}_l \mathbf{b}_l^\top
$$

```python
import numpy as np

rng = np.random.default_rng(0)
A = rng.integers(-3, 4, (3, 4))
B = rng.integers(-3, 4, (4, 2))

C1 = A @ B
C2 = np.column_stack([A @ B[:, j] for j in range(2)])        # 按列
C3 = sum(np.outer(A[:, k], B[k, :]) for k in range(4))        # 外积之和
print(np.array_equal(C1, C2), np.array_equal(C1, C3))
```

```text
True True
```

矩阵乘法有几条和普通数乘法不同的性质，读推导时容易出错：

- 一般 $$AB \neq BA$$。形状不对时 $$BA$$ 甚至没有定义，比如 $$3 \times 2$$ 乘 $$2 \times 4$$ 可以算，反过来 $$2 \times 4$$ 乘 $$3 \times 2$$ 就不行。就算都是方阵，结果一般也不同：

$$
\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}
\begin{bmatrix} 0 & 1 \\ 1 & 0 \end{bmatrix}
=
\begin{bmatrix} 2 & 1 \\ 4 & 3 \end{bmatrix},
\qquad
\begin{bmatrix} 0 & 1 \\ 1 & 0 \end{bmatrix}
\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}
=
\begin{bmatrix} 3 & 4 \\ 1 & 2 \end{bmatrix}
$$

同一个矩阵 $$\begin{bmatrix} 0 & 1 \\ 1 & 0 \end{bmatrix}$$，放在右边交换的是两列，放在左边交换的是两行。

- 满足结合律：$$(AB)C = A(BC)$$。结果相同，但计算量可能差很多。例如 $$A$$、$$B$$ 都是 $$1000 \times 1000$$，$$\mathbf{x}$$ 是 1000 维向量。先算 $$AB$$，结果有 $$10^6$$ 个元素，每个要做 1000 次乘法，共 $$10^9$$ 次；再乘 $$\mathbf{x}$$ 还要 $$10^6$$ 次。先算 $$B\mathbf{x}$$ 只要 $$10^6$$ 次，得到的还是向量，再乘 $$A$$ 又是 $$10^6$$ 次，合计 $$2 \times 10^6$$ 次，相差约 500 倍。
- 转置要反序：$$(AB)^\top = B^\top A^\top$$。用形状就能看出为什么不能写成 $$A^\top B^\top$$：设 $$A$$ 是 $$3 \times 2$$、$$B$$ 是 $$2 \times 4$$，$$AB$$ 是 $$3 \times 4$$，转置后是 $$4 \times 3$$。$$B^\top A^\top$$ 是 $$(4 \times 2)(2 \times 3) = 4 \times 3$$，形状对得上；$$A^\top B^\top$$ 是 $$(2 \times 3)(4 \times 2)$$，中间的 3 和 4 不相等，根本乘不了。

## 矩阵是一个线性变换

矩阵乘向量还有一层意思：$$A \in \mathbb{R}^{m \times n}$$ 定义了一个从 $$\mathbb{R}^n$$ 到 $$\mathbb{R}^m$$ 的函数 $$f(\mathbf{x}) = A\mathbf{x}$$。这个函数满足

$$
f(\mathbf{x} + \mathbf{y}) = f(\mathbf{x}) + f(\mathbf{y}),\qquad f(c\,\mathbf{x}) = c\,f(\mathbf{x})
$$

满足这两条的函数叫线性变换。反过来，任何从 $$\mathbb{R}^n$$ 到 $$\mathbb{R}^m$$ 的线性变换都能写成某个矩阵乘向量。由按列的看法，$$A$$ 的第 $$j$$ 列就是 $$f(\mathbf{e}_j)$$，即第 $$j$$ 个坐标轴方向的单位向量被变换到了哪里，知道了这 $$n$$ 个去向，整个变换就确定了。

在这个意义下，矩阵乘法 $$AB$$ 对应两个变换的复合：先做 $$B$$，再做 $$A$$。这也解释了为什么 $$AB \neq BA$$，先旋转再拉伸和先拉伸再旋转，结果一般不同。

## 形状与张量

实际代码里的数据很少只有一个向量。几种常见的排法：

- 一批向量按行叠成矩阵。$$T$$ 个 $$d$$ 维向量写成 $$X \in \mathbb{R}^{T \times d}$$，每行一个。这时对每个向量做同一个线性变换，写成 $$XW$$，其中 $$W \in \mathbb{R}^{d \times d'}$$，结果是 $$T \times d'$$。这和单个列向量的写法 $$W^\top \mathbf{x}$$ 差一个转置，本系列统一采用按行的写法，和 PyTorch、NumPy 一致。
- 维数更多的数组叫张量。比如形状为 $$(B, T, d)$$ 的张量可以看成 $$B$$ 个 $$T \times d$$ 的矩阵。NumPy 和 PyTorch 的 `@` 把最后两维当作矩阵相乘，前面的维度当作批次，逐个配对计算。

```python
import numpy as np

X = np.ones((2, 5, 4))     # 2 个 5×4 的矩阵
W = np.ones((4, 3))
print((X @ W).shape)

W_bad = np.ones((3, 4))
try:
    X @ W_bad
except ValueError as e:
    print(e)
```

```text
(2, 5, 3)
matmul: Input operand 1 has a mismatch in its core dimension 0, with gufunc signature (n?,k),(k,m?)->(n?,m?) (size 3 is different from 4)
```

报错里的 `(n?,k),(k,m?)->(n?,m?)` 就是上一节的形状规则：第一个操作数最后一维的 $$k$$ 必须等于第二个操作数倒数第二维的 $$k$$。读代码时遇到形状问题，先把每个张量的形状写出来，再按这条规则逐个核对，通常就能找到原因。

## 在大模型里

模型里的线性层就是 $$XW$$ 形式的矩阵乘法，大模型的大部分计算量都花在这上面。把词编号转换成向量的 embedding 查表，在数学上等于用 one-hot 向量乘 embedding 矩阵，取出其中一行。

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
| $$\mathcal{N}(\mu, \sigma^2)$$ | 均值 $$\mu$$、方差 $$\sigma^2$$ 的高斯分布 |
| $$\log$$ | 自然对数，和 $$\ln$$ 相同 |

形状约定：一批数据按行排列，记为 $$X \in \mathbb{R}^{T \times d}$$，线性层写作 $$XW$$。有些教材把向量写成列、线性层写成 $$W\mathbf{x}$$，两种写法差一个转置，遇到时会说明。

## 参考书单

不必通读，按需查阅。

- Gilbert Strang，Introduction to Linear Algebra，第 6 版，Wellesley-Cambridge Press，2023。配套的 [MIT 18.06 课程](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/) 有完整录像。对应第 1 到 3 篇。
- Marc Peter Deisenroth、A. Aldo Faisal、Cheng Soon Ong，[Mathematics for Machine Learning](https://mml-book.github.io/)，Cambridge University Press，2020，作者网站提供免费 PDF。第 2 到 4 章线性代数对应第 1 到 3 篇，第 5 章向量微积分对应第 4、5 篇，第 6 章概率对应第 6 到 9 篇，第 7 章连续优化对应第 11 篇。
- Ian Goodfellow、Yoshua Bengio、Aaron Courville，[Deep Learning](https://www.deeplearningbook.org/)，MIT Press，2016，网站可免费阅读。第 2 章线性代数、第 3 章概率与信息论、第 4 章数值计算适合速查。
- 3Blue1Brown，[Essence of linear algebra](https://www.3blue1brown.com/topics/linear-algebra) 和 [Essence of calculus](https://www.3blue1brown.com/topics/calculus) 视频系列。用动画讲几何直观，适合在看书之前先建立印象。
- Larry Wasserman，All of Statistics，Springer，2004。概率和数理统计的简明教材，对应第 6 到 9 篇。
- Thomas M. Cover、Joy A. Thomas，Elements of Information Theory，第 2 版，Wiley，2006。第 2 章对应第 10 篇。
- David Goldberg，[What Every Computer Scientist Should Know About Floating-Point Arithmetic](https://docs.oracle.com/cd/E19957-01/806-3568/ncg_goldberg.html)，ACM Computing Surveys，1991。对应第 12 篇。
- Richard S. Sutton、Andrew G. Barto，[Reinforcement Learning: An Introduction](http://incompleteideas.net/book/the-book-2nd.html)，第 2 版，MIT Press，2018，作者网站提供免费 PDF。对应第 16 篇。

## 参考资料

本篇内容对应的章节：

- Gilbert Strang，Introduction to Linear Algebra，第 6 版，第 1 章 Vectors and Matrices。
- Deisenroth 等，[Mathematics for Machine Learning](https://mml-book.github.io/)，第 2.2 节 Matrices、第 2.7 节 Linear Mappings。
- Goodfellow 等，[Deep Learning](https://www.deeplearningbook.org/) 第 2.1 节 Scalars, Vectors, Matrices and Tensors、第 2.2 节 Multiplying Matrices and Vectors。
- 3Blue1Brown，Essence of linear algebra 第 1 到 4 集：向量、线性组合、线性变换与矩阵、矩阵乘法与复合。
- [NumPy 文档：numpy.matmul](https://numpy.org/doc/stable/reference/generated/numpy.matmul.html)，`@` 运算符的广播和批次规则。
