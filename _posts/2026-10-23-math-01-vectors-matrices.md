---
title: "大模型的数学基础（一）：向量与矩阵"
description: "从空间变换与基向量落点出发，用一个二维算例推一遍线性组合、矩阵乘向量、行列式与逆矩阵、外积降维以及矩阵乘法的三种读法，再对齐代码里的行向量批次与高维张量；附全系列篇目、符号约定和参考书单。"
date: 2026-10-23 17:40:00 +0800
tags: [数学, 线性代数]
math: true
series: math
series_order: 1
---

打开任何一个大模型实现，最先看到的往往是一串形状注释：`(batch, seq, hidden)`、`(hidden, 4 * hidden)`。顺着代码往下读，马上会碰到几个具体问题：两个张量什么时候能相乘，乘完剩哪几维；为什么数学书上总写矩阵在左、向量在右的 $$A\mathbf{x}$$，而 PyTorch 代码里清一色写成输入在左、权重在右的 `X @ W`；一个 $$4096 \times 4096$$ 的权重矩阵乘上一个向量，在几何上究竟对空间做了什么。

如果只把矩阵乘法背成“横行乘竖列再相加”的填表口诀，算单个数字够用，但遇到转置、求逆、低秩分解和多层复合时很容易迷失在下标里。换一个视角，把向量的坐标看成沿着基准方向的步数指令，把矩阵看成对整个原空间做的一次线性变换，上面这些问题就会连成同一幅几何画面。

这一篇是「大模型数学基础」系列的第一篇，先在最后附上全系列篇目、符号约定和参考书单。正文的推导围绕二维向量 $$\mathbf{x} = [2, 1]^\top$$ 和几个可手算的 2×2 矩阵逐步展开，文中的验证代码在 Python 3.9.6 和 NumPy 2.0.2 下运行。

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

## 向量与线性组合

代数上，$$n$$ 维实向量是一列按顺序排好的 $$n$$ 个实数，默认写成列向量：

$$
\mathbf{x} = \begin{bmatrix} x_1 \\ x_2 \\ \vdots \\ x_n \end{bmatrix} \in \mathbb{R}^n
$$

$$\mathbb{R}^n$$ 表示全体 $$n$$ 维实向量构成的空间。在模型里，一个词经过嵌入层后常表示成 4096 个浮点数排成的向量；放到二维平面或三维空间里，同一个向量可以画成从坐标原点 $$(0, 0)$$ 出发、终点指在 $$(x_1, x_2)$$ 的一根箭头。高维空间虽然画不出来，但下面在二维平面上看到的几何规律可以原样搬过去。

向量之间只定义两种最基础的运算：向量加法把对应位置的分量相加（几何上把两根箭头首尾相接，或拼成平行四边形的对角线），标量数乘把每个分量同乘一个实数 $$c$$（几何上沿着原直线拉长、缩短，$$c < 0$$ 时调转箭头方向）：

$$
\mathbf{x} + \mathbf{y} = \begin{bmatrix} x_1 + y_1 \\ \vdots \\ x_n + y_n \end{bmatrix}, \qquad
c\,\mathbf{x} = \begin{bmatrix} c\,x_1 \\ \vdots \\ c\,x_n \end{bmatrix}
$$

有了加法和数乘，回头再看一个具体的二维向量 $$\mathbf{x} = \begin{bmatrix} 2 \\ 1 \end{bmatrix}$$，就能把它的两个坐标拆开来读。在横轴和纵轴上各取一根长度为 1 的标准基向量 $$\mathbf{e}_1 = \begin{bmatrix} 1 \\ 0 \end{bmatrix}$$ 和 $$\mathbf{e}_2 = \begin{bmatrix} 0 \\ 1 \end{bmatrix}$$，那么 $$\mathbf{x}$$ 恰好写成

$$
\mathbf{x} = \begin{bmatrix} 2 \\ 1 \end{bmatrix} = 2\begin{bmatrix} 1 \\ 0 \end{bmatrix} + 1\begin{bmatrix} 0 \\ 1 \end{bmatrix} = 2\mathbf{e}_1 + 1\mathbf{e}_2
$$

也就是说，向量里的数字 $$2$$ 和 $$1$$ 本身是一套合成指令：从原点出发，沿着第一根基向量 $$\mathbf{e}_1$$ 走 2 步，再沿着第二根基向量 $$\mathbf{e}_2$$ 走 1 步。

一般地，给定一组同维度的向量 $$\mathbf{v}_1, \dots, \mathbf{v}_k$$ 和一组实系数 $$c_1, \dots, c_k$$，加权和

$$
c_1 \mathbf{v}_1 + c_2 \mathbf{v}_2 + \cdots + c_k \mathbf{v}_k
$$

称为这组向量的线性组合。让系数 $$c_1, \dots, c_k$$ 取遍所有实数，所能到达的全部终点构成了这组向量张成的空间（span）。在二维平面里拿两根向量做线性组合，会出现三种情形：

1. 两根向量不共线，例如 $$\mathbf{a}_1 = [2, 1]^\top$$ 和 $$\mathbf{a}_2 = [-1, 1]^\top$$。调节两个系数 $$c_1, c_2$$，组出来的箭头终点能铺满整个二维平面。此时谁也没法由另一根单独倍乘出来，称为线性无关。
2. 两根向量落在同一条直线上，例如 $$[1, 1]^\top$$ 和 $$[-1, -1]^\top$$。因为第二根只是第一根乘以 $$-1$$，无论怎么调系数，$$c_1[1, 1]^\top + c_2[-1, -1]^\top = (c_1 - c_2)[1, 1]^\top$$ 永远被困在 $$45^\circ$$ 这一条直线上，多出来的第二根向量没有提供新的方向，称为线性相关。
3. 两根都是零向量 $$[0, 0]^\top$$，怎么组合都留在原点。

## 矩阵与空间线性变换

理解了“坐标是沿着基向量的步数”，矩阵的作用就顺理成章了：矩阵是对整个输入空间做一次线性变换。

设函数 $$f$$ 把空间里的每个向量 $$\mathbf{x}$$ 映射到新位置 $$f(\mathbf{x})$$。只要它同时保持加法和数乘不变，即对任意向量 $$\mathbf{x}, \mathbf{y}$$ 和任意实数 $$c$$ 满足

$$
f(\mathbf{x} + \mathbf{y}) = f(\mathbf{x}) + f(\mathbf{y}), \qquad f(c\,\mathbf{x}) = c\,f(\mathbf{x})
$$
{: #eq-linear-def }

就称 $$f$$ 为线性变换。把这两条代数式翻译成二维网格上的视觉画面，就是三条直观特征：坐标原点固定不动（$$f(\mathbf{0}) = \mathbf{0}$$），直线变过去仍然是直线，原本平行且等距的网格线变过去依然保持平行且等距。像绕原点旋转、沿某方向拉伸、镜像翻转、水平剪切都是线性变换；而把整张网格平移一段距离（原点动了），或者把直线掰弯（如平方、正弦），就不再是线性变换。

网格保持平行等距带来了一个极省事的推论。刚才的 $$\mathbf{x} = [2, 1]^\top = 2\mathbf{e}_1 + 1\mathbf{e}_2$$ 经过线性变换 $$f$$ 后，把两条性质直接代进去：

$$
f(\mathbf{x}) = f(2\mathbf{e}_1 + 1\mathbf{e}_2) = 2\,f(\mathbf{e}_1) + 1\,f(\mathbf{e}_2)
$$
{: #eq-basis-decomp }

变换前 $$\mathbf{x}$$ 是 $$\mathbf{e}_1$$ 的 2 倍加 $$\mathbf{e}_2$$ 的 1 倍；变换后 $$f(\mathbf{x})$$ 依然是新基向量 $$f(\mathbf{e}_1)$$ 的 2 倍加 $$f(\mathbf{e}_2)$$ 的 1 倍。这意味着要确定整个平面上无穷多个向量的去向，完全不需要逐点记录，只需要记下原来的两根标准基向量 $$\mathbf{e}_1$$ 和 $$\mathbf{e}_2$$ 各自落到了什么坐标。
{: #ref-basis-columns }

具体算一遍：假设某个二维线性变换把横轴单位向量 $$\mathbf{e}_1 = [1, 0]^\top$$ 送到 $$\mathbf{a}_1 = [2, 1]^\top$$，把纵轴单位向量 $$\mathbf{e}_2 = [0, 1]^\top$$ 送到 $$\mathbf{a}_2 = [-1, 1]^\top$$。把这两个新落点作为第一列和第二列并排写进方括号，就得到了 2 行 2 列的矩阵

$$
A = \begin{bmatrix} 2 & -1 \\ 1 & 1 \end{bmatrix}
$$

现在求 $$\mathbf{x} = [2, 1]^\top$$ 经过 $$A$$ 变换后的终点 $$A\mathbf{x}$$，直接拿 $$\mathbf{x}$$ 的两个坐标去组合 $$A$$ 的两列即可：

$$
A\mathbf{x} = \begin{bmatrix} 2 & -1 \\ 1 & 1 \end{bmatrix}\begin{bmatrix} 2 \\ 1 \end{bmatrix}
= 2\begin{bmatrix} 2 \\ 1 \end{bmatrix} + 1\begin{bmatrix} -1 \\ 1 \end{bmatrix}
= \begin{bmatrix} 4 - 1 \\ 2 + 1 \end{bmatrix}
= \begin{bmatrix} 3 \\ 3 \end{bmatrix}
$$

推广到任意维度，一个 $$m$$ 行 $$n$$ 列的实矩阵记为 $$A \in \mathbb{R}^{m \times n}$$，第 $$i$$ 行第 $$j$$ 列的元素记为 $$A_{ij}$$。它的 $$n$$ 个列向量 $$\mathbf{a}_1, \dots, \mathbf{a}_n \in \mathbb{R}^m$$ 依次记录了 $$n$$ 维输入空间的 $$n$$ 根标准基向量 $$\mathbf{e}_1, \dots, \mathbf{e}_n$$ 被送到 $$m$$ 维输出空间里的坐标。对任意输入 $$\mathbf{x} \in \mathbb{R}^n$$，矩阵乘向量定义为各列的线性组合：

$$
\mathbf{y} = A\mathbf{x} = x_1 \mathbf{a}_1 + x_2 \mathbf{a}_2 + \cdots + x_n \mathbf{a}_n \in \mathbb{R}^m
$$
{: #eq-matvec-cols }

从 [式](#eq-matvec-cols) 不用死记也能看清形状规则：输入 $$\mathbf{x}$$ 有 $$n$$ 个坐标分量，矩阵就必须有 $$n$$ 列来和它们一一配对；每根列向量长 $$m$$，加出来的输出自然就是 $$m$$ 维向量。例如一个 $$3 \times 2$$ 矩阵乘二维向量：

$$
\begin{bmatrix} 1 & 2 \\ 3 & 4 \\ 5 & 6 \end{bmatrix}\begin{bmatrix} 10 \\ 1 \end{bmatrix}
= 10\begin{bmatrix} 1 \\ 3 \\ 5 \end{bmatrix} + 1\begin{bmatrix} 2 \\ 4 \\ 6 \end{bmatrix}
= \begin{bmatrix} 12 \\ 34 \\ 56 \end{bmatrix}
$$

它在几何上把二维平面的两根基向量送到了三维空间里的 $$[1, 3, 5]^\top$$ 和 $$[2, 4, 6]^\top$$，整个二维输入平面在三维空间里铺成了一张倾斜平面。特别地，如果输入取第 $$j$$ 个分量为 1、其余全为 0 的标准基向量 $$\mathbf{e}_j$$（工程里常叫 one-hot 向量），$$A\mathbf{e}_j$$ 就会把其余列全乘 0 消掉，单独取出 $$A$$ 的第 $$j$$ 列。

把上面的线性组合逐行拆开看第 $$i$$ 个输出分量，就是教科书里最熟悉的行乘列公式：

$$
y_i = \sum_{j=1}^{n} A_{ij} x_j
$$
{: #eq-matvec-rows }

例如上面 $$[12, 34, 56]^\top$$ 的第一个数 $$12$$，等于矩阵第 1 行 $$[1, 2]$$ 与向量 $$[10, 1]^\top$$ 对应相乘再相加（$$1 \times 10 + 2 \times 1 = 12$$），这种运算叫两向量的点积，下一篇会单独展开。按行读方便手算某一个分量；按列读则一眼看穿全局：不管输入 $$\mathbf{x}$$ 怎么变，输出 $$A\mathbf{x}$$ 永远逃不出 $$A$$ 的各列张成的空间。

顺着基向量落点的看法，几种高频出现的特殊矩阵一眼就能认出几何动作：

- 方阵：行数与列数相等（$$n \times n$$），输入和输出留在同一个 $$n$$ 维空间里。
- 单位矩阵 $$I$$：主对角线上全是 1、其余位置全是 0 的方阵。它的第 $$j$$ 列就是原来的标准基向量 $$\mathbf{e}_j$$，空间纹丝不动，$$I\mathbf{x} = \mathbf{x}$$。
- <span id="ref-diag-matrix">对角矩阵 $$\mathrm{diag}(d_1, \dots, d_n)$$：只有主对角线有非零元素。基向量都不偏转方向，只把第 $$j$$ 条坐标轴单独伸缩 $$d_j$$ 倍。</span>
- 转置 $$A^\top$$：把 $$A$$ 的行和列对调，$$(A^\top)_{ij} = A_{ji}$$，形状从 $$m \times n$$ 变成 $$n \times m$$。列向量 $$\mathbf{x} \in \mathbb{R}^{n \times 1}$$ 转置后就写成行向量 $$\mathbf{x}^\top \in \mathbb{R}^{1 \times n}$$。

## 行列式、逆矩阵与外积降维

回到刚才的方阵 $$A = \begin{bmatrix} 2 & -1 \\ 1 & 1 \end{bmatrix}$$，再看一眼空间变形时的面积变化。变换前，$$\mathbf{e}_1$$ 和 $$\mathbf{e}_2$$ 围出一个边长为 1、面积为 1 的单位正方形；经过 $$A$$ 变换后，两列 $$\mathbf{a}_1 = [2, 1]^\top$$ 与 $$\mathbf{a}_2 = [-1, 1]^\top$$ 围成了一个斜向平行四边形，算一下它的面积正好等于 3。由于整张网格均匀变形，平面上任意图形经过 $$A$$ 变换后，面积都会放大同样的 3 倍。

这个“单位面积（三维时是单位体积）被方阵缩放的有向倍率”就是矩阵的行列式，记作 $$\det A$$。对任意 2×2 方阵 $$\begin{bmatrix} a & b \\ c & d \end{bmatrix}$$，几何拼割可以算出

$$
\det\begin{bmatrix} a & b \\ c & d \end{bmatrix} = ad - bc
$$
{: #eq-det2 }

在 $$A$$ 上，$$\det A = 2 \times 1 - (-1) \times 1 = 3$$。之所以叫“有向”倍率，是因为如果变换把 $$\mathbf{a}_1$$ 和 $$\mathbf{a}_2$$ 的左右相对朝向翻了过来（好比把透明胶片翻了个面，比如交换两列的矩阵 $$\begin{bmatrix} 0 & 1 \\ 1 & 0 \end{bmatrix}$$），行列式就会带上负号 $$\det = -1$$，绝对值依然代表面积缩放倍数。

只要 $$\det A \ne 0$$，各列就没有塌缩到更低的维度上，整个空间里的输入点和输出点一一对应。既然没有丢失信息，就一定能再做一次反向的线性变换把变形的空间原样退回去，对应的矩阵称为 $$A$$ 的逆矩阵 $$A^{-1}$$，满足

$$
A^{-1}A = AA^{-1} = I
$$
{: #eq-inv }

2×2 方阵当 $$ad - bc \ne 0$$ 时，逆矩阵可以直接写出显式公式 $$\frac{1}{ad - bc}\begin{bmatrix} d & -b \\ -c & a \end{bmatrix}$$。代入上面的 $$A$$ 得到

$$
A^{-1} = \frac{1}{3}\begin{bmatrix} 1 & 1 \\ -1 & 2 \end{bmatrix}
$$

拿它左乘刚才算出来的输出 $$A\mathbf{x} = [3, 3]^\top$$，得到 $$\frac{1}{3}[3 + 3,\; -3 + 6]^\top = [2, 1]^\top$$，精准退回初始输入 $$\mathbf{x}$$。

反过来，一旦两列落在同一条直线上（三维时三列落在同一张平面甚至同一条直线上），平行四边形瞬间被压扁成一条没有面积的线段，$$\det = 0$$。此时整个高维空间发生了降维，输出空间的实际维数称为矩阵的秩（rank）。降维后无穷多个不同的输入点会被压到同一个输出点上，信息已经合并丢失，也就不再存在逆矩阵。

在线性代数和大模型里，最基本、最重要的一类降维矩阵是两个向量的外积（outer product）。设列向量 $$\mathbf{u} \in \mathbb{R}^m$$（形状 $$m \times 1$$）和列向量 $$\mathbf{v} \in \mathbb{R}^n$$，把 $$\mathbf{v}$$ 转置成行向量 $$\mathbf{v}^\top$$（形状 $$1 \times n$$）。如果算行乘列 $$\mathbf{u}^\top \mathbf{v}$$（当 $$m = n$$ 时），得到的是一个标量点积；把顺序反过来算列乘行 $$\mathbf{u}\mathbf{v}^\top$$，根据形状规则 $$(m \times 1)(1 \times n) = m \times n$$，结果会撑开成一张 $$m \times n$$ 的矩阵，第 $$i$$ 行第 $$j$$ 列的元素就是 $$u_i v_j$$。
{: #ref-outer-def }

取 $$\mathbf{u} = [1, 1]^\top$$、$$\mathbf{v} = [1, -1]^\top$$ 具体算一张 2×2 的外积矩阵：

$$
M = \mathbf{u}\mathbf{v}^\top = \begin{bmatrix} 1 \\ 1 \end{bmatrix}\begin{bmatrix} 1 & -1 \end{bmatrix} = \begin{bmatrix} 1 & -1 \\ 1 & -1 \end{bmatrix}
$$
{: #eq-outer }

观察这张矩阵的内部结构：第 1 列是 $$1\mathbf{u}$$，第 2 列是 $$-1\mathbf{u}$$，所有列都是 $$\mathbf{u}$$ 的倍数；同时每一行也都是 $$\mathbf{v}^\top$$ 的倍数，行列式 $$\det M = 1 \times (-1) - (-1) \times 1 = 0$$。要看清外积矩阵对空间做了什么，拿它去乘任意输入向量 $$\mathbf{x} = [x_1, x_2]^\top$$，把乘法括号往右挪一下：

$$
M\mathbf{x} = (\mathbf{u}\mathbf{v}^\top)\mathbf{x} = \mathbf{u}(\mathbf{v}^\top \mathbf{x}) = (x_1 - x_2)\begin{bmatrix} 1 \\ 1 \end{bmatrix}
$$

括号里的 $$\mathbf{v}^\top \mathbf{x} = x_1 - x_2$$ 只是一个标量，用来读取输入向量沿 $$\mathbf{v}$$ 方向的数值；随后再拿这个标量去伸缩固定向量 $$\mathbf{u}$$。因此，任何非零外积矩阵 $$\mathbf{u}\mathbf{v}^\top$$ 做的都是一条秩为 1 的单通道变换：先把整个输入空间压缩成一维读数，再全部投放到输出空间的同一条直线 $$\mathbf{u}$$ 上。代入 $$\mathbf{x} = [2, 1]^\top$$ 得到 $$M\mathbf{x} = [1, 1]^\top$$；若把输入换成 $$[3, 2]^\top$$ 或 $$[1, 0]^\top$$，只要满足 $$x_1 - x_2 = 1$$，输出全都会重叠在 $$[1, 1]^\top$$ 同一个点上。

下面的交互动画把线性组合、基向量落点、逆矩阵还原、外积秩 1 降维以及下一节要讲的矩阵复合放在同一张画布里，可以逐步播放或拖动金色圆点测试不同输入位置：

{% include linalg-demo.html id="math01-transform" caption="二维空间线性变换交互演示：基向量线性组合、面积倍率 det、逆矩阵还原、外积秩 1 压扁与矩阵相乘顺序对比" %}

## 矩阵乘矩阵：连续变换与三种读法

弄清了单个矩阵怎样变换空间，两个矩阵相乘 $$C = AB$$ 的含义就不用硬背了：它代表对空间连续施加两次线性变换，先做右边的 $$B$$，再做左边的 $$A$$。

设输入向量 $$\mathbf{x} \in \mathbb{R}^n$$ 先经过 $$B \in \mathbb{R}^{k \times n}$$ 映射到中间空间 $$\mathbb{R}^k$$ 里的向量 $$B\mathbf{x}$$，再经过 $$A \in \mathbb{R}^{m \times k}$$ 映射到最终空间 $$\mathbb{R}^m$$ 里的 $$A(B\mathbf{x})$$。两次线性变换叠在一起仍然是线性变换，对应的单一复合矩阵记作 $$C = AB \in \mathbb{R}^{m \times n}$$。形状规则 $$(m \times k)(k \times n) = (m \times n)$$ 可以直接从这层接力关系看出来：右矩阵 $$B$$ 输出的维数 $$k$$，必须恰好等于左矩阵 $$A$$ 接收的输入维数 $$k$$，两步变换才能首尾衔接。

复合矩阵 $$C = AB$$ 的每一列该怎么算？依然只追问第 $$j$$ 根标准基向量 $$\mathbf{e}_j$$ 经过两步接力后的最终落点：

1. 第一步经过 $$B$$，$$\mathbf{e}_j$$ 落到 $$B$$ 的第 $$j$$ 列 $$\mathbf{b}_j$$；
2. 第二步经过 $$A$$，向量 $$\mathbf{b}_j$$ 被送到 $$A\mathbf{b}_j$$。

于是 $$C = AB$$ 的第 $$j$$ 列必然等于 $$A\mathbf{b}_j$$。把 $$A\mathbf{b}_j$$ 的第 $$i$$ 个分量按行展开，就推导出矩阵乘法的元素通项公式：

$$
C_{ij} = \sum_{l=1}^{k} A_{il} B_{lj}
$$
{: #eq-matmul-elem }

同一个矩阵乘积 $$C = AB$$，在手算、推导和写代码时有三种完全等价的拆解读法。下面拿两个 2×2 矩阵 $$P = \begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}$$ 和 $$Q = \begin{bmatrix} 5 & 6 \\ 7 & 8 \end{bmatrix}$$ 算 $$C = PQ$$ 对照一遍：

1. 按列（或按行）读：$$C$$ 的第 $$j$$ 列是左矩阵乘右矩阵的第 $$j$$ 列，即 $$P\mathbf{q}_j$$。第 1 列是 $$5\begin{bmatrix} 1 \\ 3 \end{bmatrix} + 7\begin{bmatrix} 2 \\ 4 \end{bmatrix} = \begin{bmatrix} 19 \\ 43 \end{bmatrix}$$，第 2 列是 $$6\begin{bmatrix} 1 \\ 3 \end{bmatrix} + 8\begin{bmatrix} 2 \\ 4 \end{bmatrix} = \begin{bmatrix} 22 \\ 50 \end{bmatrix}$$，拼起来得到 $$C = \begin{bmatrix} 19 & 22 \\ 43 & 50 \end{bmatrix}$$。对称地按行看，$$C$$ 的第 $$i$$ 行是右矩阵各行的线性组合，组合系数来自左矩阵的第 $$i$$ 行。

2. 按单个元素读：$$C_{ij}$$ 是左矩阵第 $$i$$ 行与右矩阵第 $$j$$ 列对应相乘再求和。例如左上角 $$C_{11} = 1 \times 5 + 2 \times 7 = 19$$，右下角 $$C_{22} = 3 \times 6 + 4 \times 8 = 50$$。

3. 按外积之和（$$k$$ 条秩 1 通道叠加）读：对照上面的 [式](#eq-matmul-elem)，如果不等单个位置把 $$k$$ 项加完，而是先固定下标 $$l$$，把 $$A_{il} B_{lj}$$ 在整张表所有 $$(i, j)$$ 位置上一次铺开，得到的恰好是 $$A$$ 的第 $$l$$ 列 $$\mathbf{a}_l$$ 与 $$B$$ 的第 $$l$$ 行 $$\mathbf{b}_l^\top$$ 的外积矩阵 $$\mathbf{a}_l \mathbf{b}_l^\top$$。去掉元素下标 $$(i, j)$$，把这 $$k$$ 张秩 1 矩阵加起来就是整张结果矩阵 $$C$$：

   $$
   C = \sum_{l=1}^{k} \mathbf{a}_l \mathbf{b}_l^\top
   $$
   {: #eq-matmul-outer }

   代入 $$PQ$$ 验算：

   $$
   \begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}\begin{bmatrix} 5 & 6 \\ 7 & 8 \end{bmatrix}
   = \begin{bmatrix} 1 \\ 3 \end{bmatrix}\begin{bmatrix} 5 & 6 \end{bmatrix}
   + \begin{bmatrix} 2 \\ 4 \end{bmatrix}\begin{bmatrix} 7 & 8 \end{bmatrix}
   = \begin{bmatrix} 5 & 6 \\ 15 & 18 \end{bmatrix}
   + \begin{bmatrix} 14 & 16 \\ 28 & 32 \end{bmatrix}
   = \begin{bmatrix} 19 & 22 \\ 43 & 50 \end{bmatrix}
   $$

   第三篇讲 SVD 和低秩压缩时会反复用到这种读法：把大矩阵写成若干个外积之和，每一项都是一条独立的秩 1 通道，删掉权重微弱的通道就能用窄矩阵近似原矩阵。

用 NumPy 对照验证矩阵乘向量的两种读法与矩阵乘矩阵的三种读法：

```python
import numpy as np

A = np.array([[2, -1],
              [1,  1]])
x = np.array([2, 1])
by_cols = x[0] * A[:, 0] + x[1] * A[:, 1]
by_rows = np.array([A[i] @ x for i in range(2)])
print("Ax:", A @ x, "by_cols:", by_cols, "by_rows:", by_rows)

P = np.array([[1, 2],
              [3, 4]])
Q = np.array([[5, 6],
              [7, 8]])
c_cols = np.column_stack([P @ Q[:, j] for j in range(2)])
c_outer = sum(np.outer(P[:, l], Q[l, :]) for l in range(2))
print("PQ == by_cols:", np.array_equal(P @ Q, c_cols),
      "PQ == sum_outer:", np.array_equal(P @ Q, c_outer))
```

```text
Ax: [3 3] by_cols: [3 3] by_rows: [3 3]
PQ == by_cols: True PQ == sum_outer: True
```

借助“连续空间变换”的直观，矩阵乘法里三条和普通数字乘法不同的性质就很容易核对：

1. 一般不满足交换律，$$AB \ne BA$$，而且作用顺序是从右往左。拿上面动画第 5、6 步里的水平剪切矩阵 $$B = \begin{bmatrix} 1 & 1 \\ 0 & 1 \end{bmatrix}$$ 和逆时针旋转 90° 矩阵 $$R = \begin{bmatrix} 0 & -1 \\ 1 & 0 \end{bmatrix}$$ 对比：

   $$
   RB = \begin{bmatrix} 0 & -1 \\ 1 & 0 \end{bmatrix}\begin{bmatrix} 1 & 1 \\ 0 & 1 \end{bmatrix} = \begin{bmatrix} 0 & -1 \\ 1 & 1 \end{bmatrix}, \qquad
   BR = \begin{bmatrix} 1 & 1 \\ 0 & 1 \end{bmatrix}\begin{bmatrix} 0 & -1 \\ 1 & 0 \end{bmatrix} = \begin{bmatrix} 1 & -1 \\ 1 & 0 \end{bmatrix}
   $$

   写 $$RB\mathbf{x} = R(B\mathbf{x})$$ 时，离向量 $$\mathbf{x}$$ 更近的 $$B$$ 先作用：先把 $$[2, 1]^\top$$ 水平推到 $$[3, 1]^\top$$，再转 90° 停在 $$[-1, 3]^\top$$；反过来 $$BR\mathbf{x}$$ 先转到 $$[-1, 2]^\top$$，再水平推到 $$[1, 2]^\top$$，终点完全不同。

2. <span id="ref-matmul-assoc">满足结合律 $$(AB)C = A(BC)$$，但加括号的顺序会显著改变计算开销。</span>设 $$A, B$$ 都是 $$4096 \times 4096$$ 方阵，$$\mathbf{x}$$ 是 $$4096$$ 维向量。如果按 $$(AB)\mathbf{x}$$ 先把两个方阵乘出来，结果有 $$4096^2$$ 个元素、每个元素做 $$4096$$ 次乘法，光这一步就要 $$4096^3 \approx 6.87 \times 10^{10}$$ 次乘法；如果按 $$A(B\mathbf{x})$$ 先算右边的矩阵乘向量，每次只做 $$4096^2$$ 次乘法、中间结果始终是向量，两步合起来只需 $$2 \times 4096^2 \approx 3.36 \times 10^7$$ 次乘法，计算量相差 2048 倍。LoRA 旁路推理在未合并权重时先乘降维窄矩阵再乘升维窄矩阵，省算力的原理正是这一条结合律。

3. 乘积的转置与求逆都要把顺序倒过来：

   $$
   (AB)^\top = B^\top A^\top, \qquad (AB)^{-1} = B^{-1}A^{-1}
   $$
   {: #eq-transpose-inv }

   转置顺序用形状就能核对：设 $$A$$ 是 $$3 \times 2$$、$$B$$ 是 $$2 \times 4$$，乘积 $$AB$$ 是 $$3 \times 4$$，转置后应当是 $$4 \times 3$$；只有 $$(4 \times 2)(2 \times 3)$$ 也就是 $$B^\top A^\top$$ 中间的 $$2$$ 才配得上。求逆顺序则对应动作回退：先做 $$B$$ 再做 $$A$$，撤销时必须先用 $$A^{-1}$$ 撤掉最后一步 $$A$$，再用 $$B^{-1}$$ 撤掉第一步 $$B$$，代数上 $$(B^{-1}A^{-1})(AB) = B^{-1}(A^{-1}A)B = I$$。

## 代码里的行向量批次与高维张量

回到文章开头的第二个问题：为什么数学推导习惯写 $$A\mathbf{x}$$，而深度学习代码里全写成 `X @ W`？

原因只是样本在内存里的排布方向不同。数学推导处理单个向量时默认写成列向量 $$\mathbf{x} \in \mathbb{R}^{d \times 1}$$，从 $$d$$ 维映射到 $$d'$$ 维写作 $$\mathbf{y} = A\mathbf{x}$$，其中 $$A \in \mathbb{R}^{d' \times d}$$。但在代码里，一个序列往往包含 $$T$$ 个 token，工程惯例把第 $$t$$ 个 token 的向量横过来当成第 $$t$$ 行 $$\mathbf{x}_t^\top \in \mathbb{R}^{1 \times d}$$，上下叠成一张 $$T \times d$$ 的输入矩阵 $$X$$。
{: #ref-row-batch }

把单个列向量的等式 $$\mathbf{y}_t = A\mathbf{x}_t$$ 两边同时取转置，套用上一节的反序规则（[式](#eq-transpose-inv)）：

$$
\mathbf{y}_t^\top = (A\mathbf{x}_t)^\top = \mathbf{x}_t^\top A^\top
$$

记权重矩阵 $$W = A^\top \in \mathbb{R}^{d \times d'}$$，再把 $$T$$ 个行向量上下拼回整张表，就得到了代码里的标准写法

$$
Y = XW \in \mathbb{R}^{T \times d'}
$$
{: #eq-batch-xw }

两套写法只差一个转置，几何含义完全一致：在 $$A\mathbf{x}$$ 里，$$A$$ 的每一列是输入基向量在输出空间里的落点；转置成 $$W = A^\top$$ 后，$$W$$ 的每一行就是原来的一列，因此 $$XW$$ 的每一行依然是拿输入向量的各个坐标去线性组合 $$W$$ 的各行。本系列后续推导在讲单个向量几何时用列向量 $$A\mathbf{x}$$，讲整批 token 前向计算时与 PyTorch 保持一致用 $$XW$$。

实际训练和推理还会再多出一维批次大小 $$B$$（batch size），数据存成形状为 $$(B, T, d)$$ 的三维数组，这类高于二维的数组统称张量。NumPy 和 PyTorch 的矩阵乘法运算符 `@` 约定把最后两维当作矩阵相乘，前面的维度当作批次逐一配对：$$(B, T, d)$$ 乘以 $$(d, d')$$ 时，同一个权重矩阵 $$W$$ 会分别右乘批次里的每一个 $$T \times d$$ 矩阵，输出形状为 $$(B, T, d')$$。

下面把前文的 $$A = \begin{bmatrix} 2 & -1 \\ 1 & 1 \end{bmatrix}$$ 转置成 $$W = A^\top$$，先看三个二维行向量组成的 $$X$$（分别取 $$[2, 1]$$、$$[1, 0]$$、$$[0, 1]$$），再看三维批次张量相乘与维度不匹配时的报错原文：

```python
import numpy as np

A = np.array([[2.0, -1.0],
              [1.0,  1.0]])
X = np.array([[2.0, 1.0],
              [1.0, 0.0],
              [0.0, 1.0]])          # T=3 个二维行向量
W = A.T                             # W = Aᵀ，形状 (2, 2)
print("XW:\n", X @ W)

batch_X = np.ones((2, 5, 4))        # (B=2, T=5, d=4)
W_proj = np.ones((4, 3))            # (d=4, d'=3)
print("batch shape:", (batch_X @ W_proj).shape)

try:
    batch_X @ np.ones((3, 4))
except ValueError as e:
    print(e)
```

```text
XW:
 [[ 3.  3.]
 [ 2.  1.]
 [-1.  1.]]
batch shape: (2, 5, 3)
matmul: Input operand 1 has a mismatch in its core dimension 0, with gufunc signature (n?,k),(k,m?)->(n?,m?) (size 3 is different from 4)
```

输出里的第一行 $$[3., 3.]$$ 和前面列向量算的 $$A[2, 1]^\top$$ 完全相同；第二行 $$[1, 0]$$ 和第三行 $$[0, 1]$$ 作为 one-hot 行向量，直接取出了 $$W$$ 的第 1 行和第 2 行。最后那条 `gufunc signature (n?,k),(k,m?)->(n?,m?)` 报错说的正是核心维度对齐规则：左操作数最后一维的长度 `4` 必须等于右操作数倒数第二维的长度，传成 `(3, 4)` 时中间是 `4` 对 `3`，直接报错。排查模型里的形状错误时，把每个张量的最后两维单独拎出来核对中间维是否相等，最快能定位问题。

## 在大模型里

Transformer 里绝大多数浮点运算都花在 $$XW$$ 形式的矩阵乘法上，按功能主要分三处：

1. 词表嵌入（Embedding）与输出词表头（LM Head）。设词表大小为 $$V$$、隐藏维数为 $$d$$，嵌入层维护一张 $$E \in \mathbb{R}^{V \times d}$$ 的矩阵。把编号为 $$i$$ 的词写成长度为 $$V$$ 的 one-hot 行向量 $$\mathbf{e}_i^\top$$，数学上做一次行乘矩阵 $$\mathbf{e}_i^\top E$$ 就取出了 $$E$$ 的第 $$i$$ 行（代码实现直接按整数下标索引该行，省掉乘零运算）。到模型最后一层，再把隐藏状态 $$H \in \mathbb{R}^{T \times d}$$ 乘上输出矩阵 $$W_{\mathrm{out}} \in \mathbb{R}^{d \times V}$$，一次算出每个位置在全部 $$V$$ 个词上的得分。
2. 注意力层的线性投影。同一批输入隐藏状态 $$X \in \mathbb{R}^{T \times d}$$ 分别右乘三个权重矩阵 $$W_Q, W_K, W_V$$，相当于把同一组 token 向量各自做三次不同的空间线性变换，分别送进查询、键和值子空间；多头注意力做完加权汇聚后，还要再右乘一次 $$W_O$$ 映射回原来的隐藏空间。
3. 前馈网络（FFN）与非线性激活的必要性。FFN 先用一个矩阵 $$W_1 \in \mathbb{R}^{d \times d_{\mathrm{ff}}}$$ 把向量映射到更高维空间，经过逐元素非线性激活函数（如 ReLU、GELU 或 SwiGLU 门控）把空间网格“折弯”，再用 $$W_2 \in \mathbb{R}^{d_{\mathrm{ff}} \times d}$$ 映射回 $$d$$ 维。这里也能立刻看出为什么要夹非线性激活：假如去掉中间的激活函数，连续两层变成 $$(XW_1)W_2$$，根据[矩阵结合律](#ref-matmul-assoc)它完全等价于 $$X(W_1 W_2) = XW_{\mathrm{merged}}$$，哪怕堆叠一百层线性层，表达能力也和单独乘一个 $$d \times d$$ 矩阵没有任何区别。

下表汇总了这一篇涉及的几种基本矩阵运算、形状要求和空间几何含义：

| 运算 | 记号与形状 | 代数读法 | 空间变换含义 |
| --- | --- | --- | --- |
| 矩阵乘列向量 | $$A\mathbf{x}$$，$$(m \times n)(n \times 1) \to m \times 1$$ | 各列按 $$x_j$$ 线性组合；或各行与 $$\mathbf{x}$$ 点积 | 把标准基 $$\mathbf{e}_j$$ 送到第 $$j$$ 列 $$\mathbf{a}_j$$，网格平行等距变形 |
| 向量外积 | $$\mathbf{u}\mathbf{v}^\top$$，$$(m \times 1)(1 \times n) \to m \times n$$ | 第 $$(i, j)$$ 元素为 $$u_i v_j$$，各列均与 $$\mathbf{u}$$ 共线 | 沿 $$\mathbf{v}$$ 读取标量再投到直线 $$\mathbf{u}$$ 上，秩恒为 1 |
| 矩阵乘矩阵 | $$AB$$，$$(m \times k)(k \times n) \to m \times n$$ | 按列 $$A\mathbf{b}_j$$；按元素行乘列；按 $$k$$ 项外积之和 | 先施加变换 $$B$$，再施加变换 $$A$$（从右往左复合） |
| 方阵求逆 | $$A^{-1}$$，$$n \times n$$（需 $$\det A \ne 0$$） | $$A^{-1}A = AA^{-1} = I$$ | 空间未发生降维时，把 $$A$$ 造成的网格变形原路退回 |
| 行向量批次投影 | $$XW$$，$$(T \times d)(d \times d') \to T \times d'$$ | $$W = A^\top$$，每行对 $$W$$ 的各行做线性组合 | 对批次内 $$T$$ 个向量并行施加同一个线性变换 |

## 符号约定

本系列统一使用下面的记号，与多数机器学习论文和 PyTorch 代码保持一致。

| 记号 | 含义 |
| --- | --- |
| $$x$$、$$a$$ | 标量，小写斜体 |
| $$\mathbf{x}$$ | 向量，小写粗体，默认是列向量 |
| $$X$$、$$W$$ | 矩阵，大写斜体 |
| $$x_i$$、$$X_{ij}$$ | 向量的第 $$i$$ 个分量、矩阵第 $$i$$ 行第 $$j$$ 列的元素 |
| $$I$$、$$A^{-1}$$、$$\det A$$ | 单位矩阵、方阵的逆矩阵、方阵的行列式 |
| $$X^\top$$ | 转置 |
| $$\mathbf{x}^\top \mathbf{y}$$、$$\langle \mathbf{x}, \mathbf{y} \rangle$$ | 点积（内积） |
| $$\mathbf{u}\mathbf{v}^\top$$ | 外积（列向量乘行向量，结果为秩 1 矩阵） |
| $$\lVert \mathbf{x} \rVert_2$$ | L2 范数 |
| $$\odot$$ | 逐元素相乘 |
| $$\mathbb{R}^{m \times n}$$ | $$m$$ 行 $$n$$ 列的实矩阵集合 |
| $$\theta$$ | 模型的全部参数 |
| $$\nabla_\theta \mathcal{L}$$ | 损失 $$\mathcal{L}$$ 对参数 $$\theta$$ 的梯度 |
| $$P(A \mid B)$$ | 条件概率 |
| $$\mathbb{E}[X]$$、$$\mathrm{Var}(X)$$ | 期望、方差 |
| $$\mathcal{N}(\mu, \sigma^2)$$ | 均值 $$\mu$$、方差 $$\sigma^2$$ 的高斯分布 |
| $$\log$$ | 自然对数，和 $$\ln$$ 相同 |

## 参考书单

全系列共用的参考书单，不必从头通读，按各篇末尾标出的章节按需查阅即可：

- Gilbert Strang，Introduction to Linear Algebra，第 6 版，Wellesley-Cambridge Press，2023。配套的 [MIT 18.06 课程](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/) 有完整录像。对应第 1 到 3 篇。
- Marc Peter Deisenroth、A. Aldo Faisal、Cheng Soon Ong，[Mathematics for Machine Learning](https://mml-book.github.io/)，Cambridge University Press，2020，作者网站提供免费 PDF。第 2 到 4 章线性代数对应第 1 到 3 篇，第 5 章向量微积分对应第 4、5 篇，第 6 章概率对应第 6 到 9 篇，第 7 章连续优化对应第 11 篇。
- Ian Goodfellow、Yoshua Bengio、Aaron Courville，[Deep Learning](https://www.deeplearningbook.org/)，MIT Press，2016，网站可免费阅读。第 2 章线性代数、第 3 章概率与信息论、第 4 章数值计算适合速查。
- 3Blue1Brown，[Essence of linear algebra](https://www.3blue1brown.com/topics/linear-algebra) 和 [Essence of calculus](https://www.3blue1brown.com/topics/calculus) 视频系列。用连续网格动画展示空间变换、行列式、点积和特征值的几何直观，适合配合前五篇一起看。
- Larry Wasserman，All of Statistics，Springer，2004。概率和数理统计的简明教材，对应第 6 到 9 篇。
- Thomas M. Cover、Joy A. Thomas，Elements of Information Theory，第 2 版，Wiley，2006。第 2 章对应第 10 篇。
- David Goldberg，[What Every Computer Scientist Should Know About Floating-Point Arithmetic](https://docs.oracle.com/cd/E19957-01/806-3568/ncg_goldberg.html)，ACM Computing Surveys，1991。对应第 12 篇。
- Richard S. Sutton、Andrew G. Barto，[Reinforcement Learning: An Introduction](http://incompleteideas.net/book/the-book-2nd.html)，第 2 版，MIT Press，2018，作者网站提供免费 PDF。对应第 16 篇。

## 参考资料

本篇内容对应的章节：

- Gilbert Strang，Introduction to Linear Algebra，第 6 版，第 1 章 Vectors and Matrices、第 2.5 节 Inverse Matrices、第 5.1 节 The Properties of Determinants。
- Marc Peter Deisenroth 等，[Mathematics for Machine Learning](https://mml-book.github.io/)，第 2.2 节 Matrices、第 2.5 节 Linear Independence、第 2.7 节 Linear Mappings、第 4.1 节 Determinant and Trace。
- Ian Goodfellow 等，[Deep Learning](https://www.deeplearningbook.org/)，第 2.1 节 Scalars, Vectors, Matrices and Tensors、第 2.2 节 Multiplying Matrices and Vectors、第 2.3 节 Identity and Inverse Matrices。
- 3Blue1Brown，[Essence of linear algebra](https://www.3blue1brown.com/topics/linear-algebra) 第 1 到 7 集：向量、线性组合与张成空间、线性变换与矩阵、矩阵乘法与复合、行列式、逆矩阵与列空间。
- NumPy 文档：[numpy.matmul](https://numpy.org/doc/stable/reference/generated/numpy.matmul.html)、[numpy.outer](https://numpy.org/doc/stable/reference/generated/numpy.outer.html)。
