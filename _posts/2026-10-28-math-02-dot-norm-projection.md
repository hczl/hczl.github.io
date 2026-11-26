---
title: "大模型的数学基础（二）：点积、范数与投影"
description: "从勾股定理和余弦定理出发，用具体二维向量推一遍点积、三种常用范数、余弦相似度、正交矩阵与外积投影矩阵，再看注意力分数为什么要除以 √d 以及 RMSNorm 做了什么几何变换。"
date: 2026-10-28 09:55:00 +0800
tags: [数学, 线性代数]
math: true
series: math
series_order: 2
---

第一篇讲了向量怎样做线性组合、矩阵怎样把整个空间做平行等距的线性变换，但那张空间里还没有放进尺子和量角器：单看一根向量，它的长度怎么算；对比两根向量，它们之间夹多少度、方向有多接近；给定空间里的一条直线或一张平面，往上面作垂线找最近的点，垂足落在哪里。

在高维空间里，这三件事全都建立在同一个最简单的运算上，就是两个向量的点积。这一篇围绕几个可手算的二维向量（$$\mathbf{u} = [3, -4]^\top$$、$$\mathbf{a} = [1, 3]^\top$$ 和 $$\mathbf{b} = [4, 2]^\top$$），顺着勾股定理和余弦定理一步步推完长度、夹角、正交矩阵和外积投影矩阵，最后看它们在大模型注意力分数、语义检索与 RMSNorm 里的具体形态。文中的验证代码在 Python 3.9.6 和 NumPy 2.0.2 下运行。

## 点积与向量的长度

两个同维度的列向量 $$\mathbf{x}, \mathbf{y} \in \mathbb{R}^n$$，点积（也叫标准内积）定义为对应位置的分量相乘再相加：

$$
\mathbf{x}^\top \mathbf{y} = \sum_{i=1}^{n} x_i y_i
$$
{: #eq-dot }

结果是一个标量，常见记号还有 $$\langle \mathbf{x}, \mathbf{y} \rangle$$ 和 $$\mathbf{x} \cdot \mathbf{y}$$。按[第一篇的矩阵乘法规则](/notes/math-01-vectors-matrices/#eq-matvec-rows)，$$\mathbf{x}^\top$$ 是 $$1 \times n$$ 的行矩阵，$$\mathbf{y}$$ 是 $$n \times 1$$ 的列向量，行乘列恰好得到 $$1 \times 1$$ 的数；换用空间变换的眼光看，固定行矩阵 $$\mathbf{x}^\top$$ 本身就是一个把 $$n$$ 维空间映射到一维数轴的线性变换。<span id="ref-dot-laws">从定义可以直接核对两条基本运算律：一是交换顺序结果不变，$$\mathbf{x}^\top \mathbf{y} = \mathbf{y}^\top \mathbf{x}$$；二是对加减和数乘满足线性分配，$$\mathbf{x}^\top (c_1 \mathbf{y} + c_2 \mathbf{z}) = c_1 \mathbf{x}^\top \mathbf{y} + c_2 \mathbf{x}^\top \mathbf{z}$$。</span>

先拿点积做第一件度量工作：量出一根向量自身的长度。取二维平面上的 $$\mathbf{u} = [3, -4]^\top$$，让它和自己做点积：

$$
\mathbf{u}^\top \mathbf{u} = 3^2 + (-4)^2 = 9 + 16 = 25
$$

在平面直角坐标系里，横坐标绝对值 $$3$$ 和纵坐标绝对值 $$4$$ 正好是直角三角形的两条直角边，由勾股定理，从原点到 $$(3, -4)$$ 的斜边长度就是 $$\sqrt{25} = 5$$。到三维空间再套一次勾股定理是 $$\sqrt{x_1^2 + x_2^2 + x_3^2}$$，推广到任意 $$n$$ 维空间，向量和自身点积的算术平方根就定义了欧几里得长度，称为 L2 范数：

$$
\lVert \mathbf{x} \rVert_2 = \sqrt{\mathbf{x}^\top \mathbf{x}} = \sqrt{x_1^2 + x_2^2 + \cdots + x_n^2}
$$
{: #eq-l2 }

由于实数的平方非负，只要 $$\mathbf{x}$$ 不全为 0，$$\lVert \mathbf{x} \rVert_2$$ 就严格大于 0。后续不标下标写 $$\lVert \mathbf{x} \rVert$$ 时，默认都指 L2 范数。

工程里衡量一个向量“有多大”并不只有直线距离这一把尺子，统称为范数（norm）。任意合法的范数都要满足三条常识性的几何要求：只有零向量的大小为 0；把向量拉长 $$c$$ 倍时大小跟着乘 $$\lvert c \rvert$$，即 $$\lVert c\,\mathbf{x} \rVert = \lvert c \rvert \lVert \mathbf{x} \rVert$$；走折线不比走直线近，即三角不等式 $$\lVert \mathbf{x} + \mathbf{y} \rVert \le \lVert \mathbf{x} \rVert + \lVert \mathbf{y} \rVert$$。除了 L2 范数，最常遇到的还有 L1 范数和 L∞ 范数，拿同一个 $$\mathbf{u} = [3, -4]^\top$$ 对照最清楚：

- L1 范数 $$\lVert \mathbf{x} \rVert_1 = \sum_{i=1}^n \lvert x_i \rvert$$：把各分量的绝对值直接相加，在 $$\mathbf{u}$$ 上等于 $$\lvert 3 \rvert + \lvert -4 \rvert = 7$$。几何上好比在棋盘格街道里只能沿着横竖坐标轴走步数（曼哈顿距离）；二维平面上所有满足 $$\lVert \mathbf{x} \rVert_1 = r$$ 的等距点围成一个斜放的菱形。
- L2 范数 $$\lVert \mathbf{x} \rVert_2 = \sqrt{\sum_{i=1}^n x_i^2}$$：先平方再开方，在 $$\mathbf{u}$$ 上等于 $$5$$。平方项会让绝对值较大的分量占更高比重；平面上 $$\lVert \mathbf{x} \rVert_2 = r$$ 的等距点围成一个正圆。
- L∞ 范数 $$\lVert \mathbf{x} \rVert_\infty = \max_i \lvert x_i \rvert$$：只取绝对值最大的那一个分量，在 $$\mathbf{u}$$ 上等于 $$\max(3, 4) = 4$$。模型量化时检查张量里有没有极端离群值（outlier），看的就是它的 L∞ 范数；平面上 $$\lVert \mathbf{x} \rVert_\infty = r$$ 的等距点围成一个与坐标轴平行的正方形。

L2 范数等于 1 的向量称为单位向量。把任意非零向量除以它自身的 L2 范数，就得到方向完全一致、长度缩放到 1 的单位向量，这一步称为归一化：

$$
\hat{\mathbf{x}} = \frac{\mathbf{x}}{\lVert \mathbf{x} \rVert_2}
$$
{: #eq-norm-unit }

例如 $$\mathbf{u} = [3, -4]^\top$$ 除以长度 $$5$$，得到 $$\hat{\mathbf{u}} = [0.6, -0.8]^\top$$，终点恰好落在半径为 1 的单位圆上（$$0.6^2 + (-0.8)^2 = 1$$）。

## 夹角与余弦相似度

量完单根向量的长度，再看两根不同非零向量 $$\mathbf{a}$$ 和 $$\mathbf{b}$$ 做点积为什么能量出夹角。取 $$\mathbf{a} = [1, 3]^\top$$ 和 $$\mathbf{b} = [4, 2]^\top$$，先算出它们的长度和点积：$$\lVert \mathbf{a} \rVert_2 = \sqrt{1 + 9} = \sqrt{10}$$，$$\lVert \mathbf{b} \rVert_2 = \sqrt{16 + 4} = \sqrt{20}$$，点积 $$\mathbf{a}^\top \mathbf{b} = 1 \times 4 + 3 \times 2 = 10$$。

要找出点积 $$10$$ 与两向量夹角 $$\theta$$ 的关系，直接看原点、$$\mathbf{a}$$ 的终点和 $$\mathbf{b}$$ 的终点围成的三角形，按四步推出来：

1. 两边分别是 $$\mathbf{a}$$ 和 $$\mathbf{b}$$，连接两个箭头尖端的第三条边正好是差向量 $$\mathbf{a} - \mathbf{b}$$，长度为 $$\lVert \mathbf{a} - \mathbf{b} \rVert_2$$。

2. 根据平面几何的余弦定理，第三边长度的平方等于

   $$
   \lVert \mathbf{a} - \mathbf{b} \rVert_2^2 = \lVert \mathbf{a} \rVert_2^2 + \lVert \mathbf{b} \rVert_2^2 - 2\,\lVert \mathbf{a} \rVert_2 \lVert \mathbf{b} \rVert_2 \cos\theta
   $$
   {: #eq-cos-law }

3. 同时用[点积的线性分配律](#ref-dot-laws)把左边的平方展开：

   $$
   \lVert \mathbf{a} - \mathbf{b} \rVert_2^2 = (\mathbf{a} - \mathbf{b})^\top (\mathbf{a} - \mathbf{b}) = \mathbf{a}^\top \mathbf{a} - 2\,\mathbf{a}^\top \mathbf{b} + \mathbf{b}^\top \mathbf{b} = \lVert \mathbf{a} \rVert_2^2 + \lVert \mathbf{b} \rVert_2^2 - 2\,\mathbf{a}^\top \mathbf{b}
   $$
   {: #eq-diff-expand }

4. 把 [式](#eq-cos-law) 和 [式](#eq-diff-expand) 的右边相等，消去两头相同的长度平方项再除以 $$-2$$，就得到点积的几何表达式：

   $$
   \mathbf{a}^\top \mathbf{b} = \lVert \mathbf{a} \rVert_2 \, \lVert \mathbf{b} \rVert_2 \cos\theta
   $$
   {: #eq-dot-geo }

高维空间里任意两根非零向量同样撑起一张二维平面，上面的三角形推导原封不动成立。因为 $$\lvert \cos\theta \rvert \le 1$$，点积的绝对值永远不会超过两向量长度的乘积，即柯西-施瓦茨不等式 $$\lvert \mathbf{a}^\top \mathbf{b} \rvert \le \lVert \mathbf{a} \rVert_2 \, \lVert \mathbf{b} \rVert_2$$（等号只在两向量共线时成立）。反过来用点积除以两向量的长度，就定义了任意高维空间里的夹角余弦，在机器学习里称为余弦相似度：

$$
\cos\theta = \frac{\mathbf{a}^\top \mathbf{b}}{\lVert \mathbf{a} \rVert_2 \, \lVert \mathbf{b} \rVert_2} = \hat{\mathbf{a}}^\top \hat{\mathbf{b}}
$$
{: #eq-cos-sim }

最右边这个改写很实用：先把两个向量各自归一化成单位向量 $$\hat{\mathbf{a}}$$ 和 $$\hat{\mathbf{b}}$$，再算它们的点积，结果直接就是余弦相似度。代入 $$\mathbf{a} = [1, 3]^\top$$ 与 $$\mathbf{b} = [4, 2]^\top$$：

$$
\cos\theta = \frac{10}{\sqrt{10}\times\sqrt{20}} = \frac{10}{10\sqrt{2}} = \frac{1}{\sqrt{2}} \approx 0.7071
$$

对应夹角恰好是 $$45^\circ$$。余弦相似度的取值严格落在 $$[-1, 1]$$ 区间：两向量同向时为 $$1$$（$$\theta = 0^\circ$$），互相垂直时为 $$0$$（$$\theta = 90^\circ$$），方向完全相反时为 $$-1$$（$$\theta = 180^\circ$$）。

在实际工程里用点积还是用余弦相似度，差别在于“要不要把向量长度算进去”。余弦相似度完全剥离了模长：把 $$\mathbf{a} = [1, 3]^\top$$ 拉长 10 倍变成 $$[10, 30]^\top$$，它与 $$\mathbf{b}$$ 的余弦相似度依然是 $$0.7071$$。<span id="ref-long-vec-example">而原始点积同时受方向和长度两者支配：另取一根竖直向上的长向量 $$\mathbf{c} = [0, 10]^\top$$，它与 $$\mathbf{b} = [4, 2]^\top$$ 的余弦相似度只有 $$20 / (10 \times \sqrt{20}) \approx 0.4472$$（夹角约 $$63.4^\circ$$，方向比 $$\mathbf{a}$$ 偏得多），但因为 $$\mathbf{c}$$ 足够长，原始点积 $$\mathbf{c}^\top \mathbf{b} = 20$$ 反而是 $$\mathbf{a}^\top \mathbf{b} = 10$$ 的两倍。</span>

## 正交与正交矩阵

顺着 $$\cos\theta$$ 的正负号看，固定参考向量 $$\mathbf{b}$$ 后，整个空间被过原点且与 $$\mathbf{b}$$ 垂直的超平面一分为二：夹角小于 $$90^\circ$$ 的一侧点积大于 $$0$$，夹角大于 $$90^\circ$$ 的一侧点积小于 $$0$$；<span id="ref-ortho-cond">恰好落在分界超平面上、满足 $$\mathbf{a}^\top \mathbf{b} = 0$$ 时，两向量互相垂直，称为正交（orthogonal）。</span>例如取 $$\mathbf{a} = [-1, 2]^\top$$，它与 $$\mathbf{b} = [4, 2]^\top$$ 的点积是 $$(-1) \times 4 + 2 \times 2 = 0$$，两者严格成 $$90^\circ$$ 直角。

如果 $$n$$ 维空间里有一组向量 $$\mathbf{q}_1, \dots, \mathbf{q}_n$$，不同向量之间两两正交（$$i \ne j$$ 时 $$\mathbf{q}_i^\top \mathbf{q}_j = 0$$），而且每根向量自身的长度都是 $$1$$（$$\mathbf{q}_i^\top \mathbf{q}_i = 1$$），这组向量就构成一组标准正交基（orthonormal basis）。第一篇用的标准坐标轴 $$\mathbf{e}_1, \dots, \mathbf{e}_n$$ 是最简单的一组；把二维十字坐标架逆时针旋转 $$45^\circ$$ 得到的 $$\mathbf{q}_1 = \tfrac{1}{\sqrt{2}}[1, 1]^\top$$、$$\mathbf{q}_2 = \tfrac{1}{\sqrt{2}}[-1, 1]^\top$$ 也是标准正交基。

把 $$n$$ 个标准正交基向量按列排成 $$n \times n$$ 方阵 $$Q = [\mathbf{q}_1, \dots, \mathbf{q}_n]$$，这样的方阵称为正交矩阵（需要注意术语习惯：中文和英文教材都叫 orthogonal matrix，但定义要求各列不仅是正交的，还必须是长度为 1 的标准正交向量）。拿 $$Q^\top$$ 左乘 $$Q$$，按[第一篇“左行乘右列”的规则](/notes/math-01-vectors-matrices/#eq-matmul-elem)，乘积第 $$(i, j)$$ 个元素就是 $$\mathbf{q}_i^\top \mathbf{q}_j$$，于是对角线上全是 1、其余位置全是 0：

$$
Q^\top Q = I, \qquad Q^{-1} = Q^\top
$$
{: #eq-ortho-mat }

正交矩阵求逆不需要做任何消元计算，直接转置就能把变换还原。放到空间变换里看，任意两个向量 $$\mathbf{x}, \mathbf{y}$$ 左乘正交矩阵 $$Q$$ 后，新的点积是

$$
(Q\mathbf{x})^\top (Q\mathbf{y}) = \mathbf{x}^\top Q^\top Q \mathbf{y} = \mathbf{x}^\top I \mathbf{y} = \mathbf{x}^\top \mathbf{y}
$$
{: #eq-ortho-dot }

点积不变意味着两件事同时不变：令 $$\mathbf{y} = \mathbf{x}$$ 可得 $$\lVert Q\mathbf{x} \rVert_2 = \lVert \mathbf{x} \rVert_2$$，所有向量的长度不变；任意两向量之间的夹角也丝毫不变。因此正交矩阵不对空间做任何拉伸、压缩或剪切，几何上只做绕原点的刚体旋转（$$\det Q = 1$$）或镜面翻转（$$\det Q = -1$$），相当于保持空间形状不动、换了一套互相垂直的单位坐标轴。下一篇的实对称矩阵谱分解与奇异值分解，核心就是用正交矩阵来对齐主方向。

## 正交投影与外积投影矩阵

现在解决开头提出的第三个几何问题：空间里有一条穿过原点、沿非零向量 $$\mathbf{b}$$ 延伸的直线，直线外有一个向量 $$\mathbf{a}$$，直线上哪个点 $$\mathbf{p}$$ 离 $$\mathbf{a}$$ 最近？这个最近点就是 $$\mathbf{a}$$ 在直线 $$\mathbf{b}$$ 上的正交投影。

继续拿 $$\mathbf{a} = [1, 3]^\top$$ 和 $$\mathbf{b} = [4, 2]^\top$$ 按下面四步完整算出垂足 $$\mathbf{p}$$：

1. 因为投影点 $$\mathbf{p}$$ 必须落在 $$\mathbf{b}$$ 所在的直线上，它一定是 $$\mathbf{b}$$ 的某个实数倍，设 $$\mathbf{p} = c\,\mathbf{b}$$，待求的只有标量系数 $$c$$。

2. 连接 $$\mathbf{p}$$ 到 $$\mathbf{a}$$，得到偏离直线的误差向量 $$\mathbf{r} = \mathbf{a} - \mathbf{p} = \mathbf{a} - c\,\mathbf{b}$$。由直角三角形斜边大于直角边可知，要让距离 $$\lVert \mathbf{r} \rVert_2$$ 最短，误差向量 $$\mathbf{r}$$ 必须与直线方向 $$\mathbf{b}$$ 严格垂直。套用[上一节的正交条件](#ref-ortho-cond)列出方程：

   $$
   \mathbf{b}^\top (\mathbf{a} - c\,\mathbf{b}) = 0
   $$
   {: #eq-proj-ortho }

3. 用[点积分配律](#ref-dot-laws)把 [式](#eq-proj-ortho) 展开成 $$\mathbf{b}^\top \mathbf{a} - c\,\mathbf{b}^\top \mathbf{b} = 0$$，直接解出比例系数

   $$
   c = \frac{\mathbf{b}^\top \mathbf{a}}{\mathbf{b}^\top \mathbf{b}}
   $$
   {: #eq-proj-c }

4. 把 [式](#eq-proj-c) 代回 $$\mathbf{p} = c\,\mathbf{b}$$，得到直线上的正交投影公式：

   $$
   \mathbf{p} = \frac{\mathbf{b}^\top \mathbf{a}}{\mathbf{b}^\top \mathbf{b}}\,\mathbf{b}
   $$
   {: #eq-proj-b }

代入具体数字验算：$$\mathbf{b}^\top \mathbf{a} = 10$$，$$\mathbf{b}^\top \mathbf{b} = 20$$，算出 $$c = 10 / 20 = 0.5$$，于是垂足落在 $$\mathbf{p} = 0.5 \times [4, 2]^\top = [2, 1]^\top$$。剩下的误差向量是 $$\mathbf{r} = \mathbf{a} - \mathbf{p} = [-1, 2]^\top$$，核对 $$\mathbf{b}^\top \mathbf{r} = 4 \times (-1) + 2 \times 2 = 0$$，确实严格垂直；同时原向量被拆成两段互相垂直的分量之和 $$\mathbf{a} = [2, 1]^\top + [-1, 2]^\top$$，长度平方满足勾股定理 $$5 + 5 = 10$$。

如果事先把直线方向归一化成单位向量 $$\mathbf{q} = \mathbf{b} / \lVert \mathbf{b} \rVert_2$$（本例中 $$\mathbf{q} = \tfrac{1}{\sqrt{5}}[2, 1]^\top$$），分母 $$\mathbf{q}^\top \mathbf{q} = 1$$ 直接省去，[式](#eq-proj-b) 简化成

$$
\mathbf{p} = (\mathbf{q}^\top \mathbf{a})\,\mathbf{q}
$$
{: #eq-proj-q }

[式](#eq-proj-q) 给出了点积在几何上的第二层直观解释：任意向量 $$\mathbf{a}$$ 与单位向量 $$\mathbf{q}$$ 的点积 $$\mathbf{q}^\top \mathbf{a}$$，恰好是把 $$\mathbf{a}$$ 往 $$\mathbf{q}$$ 轴上作垂线所读出来的有向坐标分量。

固定直线方向 $$\mathbf{q}$$，把“对输入向量 $$\mathbf{a}$$ 做正交投影”写成函数 $$f(\mathbf{a}) = (\mathbf{q}^\top \mathbf{a})\,\mathbf{q}$$。套用[前面点积对加法和数乘的线性分配律](#ref-dot-laws)，可以直接验算它满足[第一篇对线性变换的两条定义](/notes/math-01-vectors-matrices/#eq-linear-def)：

$$
f(\mathbf{a}_1 + \mathbf{a}_2) = \bigl(\mathbf{q}^\top(\mathbf{a}_1 + \mathbf{a}_2)\bigr)\,\mathbf{q} = (\mathbf{q}^\top \mathbf{a}_1)\,\mathbf{q} + (\mathbf{q}^\top \mathbf{a}_2)\,\mathbf{q} = f(\mathbf{a}_1) + f(\mathbf{a}_2)
$$
{: #eq-proj-add }

$$
f(c\,\mathbf{a}) = \bigl(\mathbf{q}^\top(c\,\mathbf{a})\bigr)\,\mathbf{q} = c\,(\mathbf{q}^\top \mathbf{a})\,\mathbf{q} = c\,f(\mathbf{a})
$$
{: #eq-proj-scale }

放到几何上看，沿垂直方向把向量投到过原点的直线上时，向量缩放 $$c$$ 倍，投影也同步缩放 $$c$$ 倍；两根向量首尾相加后的投影等于各自投影相加（前提是直线穿过原点，否则零向量投影后不再留在原点，数乘不变就会失效）。既然 $$f$$ 满足加法和数乘不变，按[第一篇的结论](/notes/math-01-vectors-matrices/#ref-basis-columns)，它本身就是一个线性变换，结果完全由各标准基向量的投影落点决定，一定能写成某个固定矩阵 $$P$$ 乘以 $$\mathbf{a}$$。把标量 $$\mathbf{q}^\top \mathbf{a}$$ 挪到列向量 $$\mathbf{q}$$ 右边，再用[第一篇的矩阵乘法结合律](/notes/math-01-vectors-matrices/#ref-matmul-assoc)移动括号：

$$
\mathbf{p} = \mathbf{q}(\mathbf{q}^\top \mathbf{a}) = (\mathbf{q}\mathbf{q}^\top)\mathbf{a} = P\mathbf{a}, \qquad P = \mathbf{q}\mathbf{q}^\top = \frac{\mathbf{b}\mathbf{b}^\top}{\mathbf{b}^\top \mathbf{b}}
$$
{: #eq-proj-mat }

这里的 $$P = \mathbf{q}\mathbf{q}^\top$$ 正是[第一篇讲过的列乘行外积矩阵](/notes/math-01-vectors-matrices/#ref-outer-def)。代入 $$\mathbf{b} = [4, 2]^\top$$ 算出来：

$$
P = \frac{1}{20}\begin{bmatrix} 4 \\ 2 \end{bmatrix}\begin{bmatrix} 4 & 2 \end{bmatrix} = \begin{bmatrix} 0.8 & 0.4 \\ 0.4 & 0.2 \end{bmatrix}
$$

按[第一篇“矩阵各列即标准基向量的新落点”的说法](/notes/math-01-vectors-matrices/#ref-basis-columns)核对也能印证这一点：把 $$\mathbf{e}_1 = [1, 0]^\top$$ 和 $$\mathbf{e}_2 = [0, 1]^\top$$ 分别代入 [式](#eq-proj-q)（其中 $$\mathbf{q} = \tfrac{1}{\sqrt{5}}[2, 1]^\top$$），得到的投影分别是 $$[0.8, 0.4]^\top$$ 和 $$[0.4, 0.2]^\top$$，恰好就是 $$P$$ 的两列。拿 $$P$$ 左乘 $$\mathbf{a} = [1, 3]^\top$$，得到 $$[0.8 \times 1 + 0.4 \times 3,\; 0.4 \times 1 + 0.2 \times 3]^\top = [2, 1]^\top$$，与上面逐步解出来的垂足分毫不差。作为空间变换，外积投影矩阵 $$P$$ 把整张二维平面沿着垂直于 $$\mathbf{b}$$ 的方向齐刷刷压到直线 $$\mathbf{b}$$ 上（秩为 1，$$\det P = 0.16 - 0.16 = 0$$）。任何正交投影矩阵都自带两条好认的代数性质：一是实对称，$$P^\top = (\mathbf{q}\mathbf{q}^\top)^\top = \mathbf{q}\mathbf{q}^\top = P$$；二是连乘两次等于乘一次，即幂等性 $$P^2 = (\mathbf{q}\mathbf{q}^\top)(\mathbf{q}\mathbf{q}^\top) = \mathbf{q}(\mathbf{q}^\top \mathbf{q})\mathbf{q}^\top = \mathbf{q}\mathbf{q}^\top = P$$，对应几何事实“已经在直线上的点，再往这条直线投影一次不会再动”。

把一条直线推广到由 $$k$$ 个两两正交的单位向量 $$\mathbf{q}_1, \dots, \mathbf{q}_k \in \mathbb{R}^n$$ 张成的 $$k$$ 维子空间，按列排成瘦高矩阵 $$Q \in \mathbb{R}^{n \times k}$$。由于这 $$k$$ 个方向互相垂直、彼此不抢分量，往整个子空间做投影就等于分别往每条轴做投影再相加：

$$
P = \mathbf{q}_1 \mathbf{q}_1^\top + \cdots + \mathbf{q}_k \mathbf{q}_k^\top = Q Q^\top
$$
{: #eq-proj-subspace }

读推导时要格外留心 $$Q^\top Q$$ 和 $$QQ^\top$$ 的区别。拿三维空间里张成 $$xy$$ 水平面的两根标准正交单位向量举例（$$n = 3,\; k = 2$$），把它们按列排成 $$3 \times 2$$ 矩阵 $$Q = \begin{bmatrix} 1 & 0 \\ 0 & 1 \\ 0 & 0 \end{bmatrix}$$，把两种乘法各算一遍：

$$
Q^\top Q = \begin{bmatrix} 1 & 0 & 0 \\ 0 & 1 & 0 \end{bmatrix}\begin{bmatrix} 1 & 0 \\ 0 & 1 \\ 0 & 0 \end{bmatrix} = \begin{bmatrix} 1 & 0 \\ 0 & 1 \end{bmatrix} = I_2, \qquad
QQ^\top = \begin{bmatrix} 1 & 0 \\ 0 & 1 \\ 0 & 0 \end{bmatrix}\begin{bmatrix} 1 & 0 & 0 \\ 0 & 1 & 0 \end{bmatrix} = \begin{bmatrix} 1 & 0 & 0 \\ 0 & 1 & 0 \\ 0 & 0 & 0 \end{bmatrix}
$$

当 $$k < n$$ 时，$$Q^\top Q = I_k$$ 算的是各列两两之间的点积，结果永远是 $$k \times k$$ 的单位矩阵；反过来的 $$QQ^\top$$ 则是 $$n \times n$$ 的秩 $$k$$ 投影矩阵（上例里拿 $$QQ^\top$$ 乘任意三维向量 $$[3, 4, 5]^\top$$ 会得到 $$[3, 4, 0]^\top$$，把 $$z$$ 分量压成了 $$0$$），推导中绝不能把 $$QQ^\top$$ 当成单位矩阵消掉。只有当 $$k = n$$、把缺失的垂直轴全部补齐让 $$Q$$ 成为方阵时，每个方向的信息都完整保留，才有 $$QQ^\top = I_n$$。

如果张成 $$k$$ 维子空间的各列向量 $$\mathbf{a}_1, \dots, \mathbf{a}_k \in \mathbb{R}^n$$ 彼此线性无关，但既不互相垂直也不一定是单位向量，把它们按列拼成矩阵 $$A = [\mathbf{a}_1, \dots, \mathbf{a}_k] \in \mathbb{R}^{n \times k}$$，此时不能直接用 [式](#eq-proj-subspace) 分别投影再相加，但求解思路与一维直线完全相同：

1. 子空间里的任意一点都可以写成各列的线性组合 $$\mathbf{p} = c_1 \mathbf{a}_1 + \cdots + c_k \mathbf{a}_k = A\mathbf{c}$$，其中 $$\mathbf{c} = [c_1, \dots, c_k]^\top$$ 是待求的系数向量（对应一维直线里的单个系数 $$c$$）。

2. 从投影点 $$A\mathbf{c}$$ 指回原向量 $$\mathbf{a}$$ 的误差向量为 $$\mathbf{r} = \mathbf{a} - A\mathbf{c}$$。要让距离 $$\lVert \mathbf{r} \rVert_2$$ 最短，$$\mathbf{r}$$ 必须垂直于整个子空间，也就等价于与张成该子空间的每一列 $$\mathbf{a}_1, \dots, \mathbf{a}_k$$ 都满足[正交条件](#ref-ortho-cond) $$\mathbf{a}_j^\top (\mathbf{a} - A\mathbf{c}) = 0$$。把这 $$k$$ 条等式竖着叠在一起，利用转置后 $$A^\top$$ 的各行恰好是 $$\mathbf{a}_1^\top, \dots, \mathbf{a}_k^\top$$，就合成了一条矩阵方程：

   $$
   A^\top (\mathbf{a} - A\mathbf{c}) = \mathbf{0}
   $$
   {: #eq-normal-eq }

3. 展开 [式](#eq-normal-eq) 并移项得 $$A^\top A \mathbf{c} = A^\top \mathbf{a}$$。由于 $$A$$ 的各列线性无关，$$k \times k$$ 方阵 $$A^\top A$$ 可逆，两边左乘 $$(A^\top A)^{-1}$$ 解出 $$\mathbf{c} = (A^\top A)^{-1}A^\top \mathbf{a}$$，代回 $$\mathbf{p} = A\mathbf{c}$$ 就得到一般子空间的正交投影矩阵（也是线性回归最小二乘法的核心公式）：

   $$
   \mathbf{p} = A(A^\top A)^{-1}A^\top \mathbf{a}, \qquad P = A(A^\top A)^{-1}A^\top
   $$
   {: #eq-proj-ols }

当各列恰好构成标准正交向量（即把 $$A$$ 换成 $$Q$$）时，$$Q^\top Q = I_k$$，[式](#eq-proj-ols) 中间的逆矩阵直接消失，公式随即退回为 [式](#eq-proj-subspace) 的 $$P = QQ^\top$$。

下面的交互动画把三种范数等距圈、点积与夹角余弦、正交分界线，以及二维压到直线的 $$P = \mathbf{q}\mathbf{q}^\top$$ 和三维压到 $$xy$$ 平面的 $$P = QQ^\top$$ 放在同一张画布里，可拖动金色圆点、滑块或旋转三维视角观察各量变化：

{% include linalg-demo.html id="math02-dotproj" caption="度量与正交投影交互演示：三种范数等距圈、点积夹角、正交半平面、二维压到直线（P = qqᵀ）与三维压到平面（P = QQᵀ）" %}

用 NumPy 一次核验上面手算的三种范数、$$45^\circ$$ 夹角、投影垂足 $$[2, 1]^\top$$ 与 $$P^2 = P$$：

```python
import numpy as np

u = np.array([3.0, -4.0])
print("norms (L1, L2, Linf):",
      np.linalg.norm(u, 1), np.linalg.norm(u, 2), np.linalg.norm(u, np.inf))

a = np.array([1.0, 3.0])
b = np.array([4.0, 2.0])
cos_ab = (a @ b) / (np.linalg.norm(a) * np.linalg.norm(b))
print("dot:", a @ b, "cos:", round(float(cos_ab), 4),
      "deg:", round(float(np.degrees(np.arccos(cos_ab))), 2))

p = (b @ a) / (b @ b) * b
r = a - p
P = np.outer(b, b) / (b @ b)
print("proj p:", p, "residual r:", r, "b·r:", b @ r)
print("P @ a == p:", np.allclose(P @ a, p), "P @ P == P:", np.allclose(P @ P, P))
```

```text
norms (L1, L2, Linf): 7.0 5.0 4.0
dot: 10.0 cos: 0.7071 deg: 45.0
proj p: [2. 1.] residual r: [-1.  2.] b·r: 0.0
P @ a == p: True P @ P == P: True
```

## 在大模型里

### 注意力分数为什么要除以 √d

自注意力机制里，每个位置的查询向量 $$\mathbf{q} \in \mathbb{R}^d$$ 要和序列中所有位置的键向量 $$\mathbf{k} \in \mathbb{R}^d$$ 逐一算匹配分数，再经 softmax 归一化成加权系数。按[第一篇的行向量批次排法](/notes/math-01-vectors-matrices/#ref-row-batch)，$$T$$ 个查询排成 $$Q \in \mathbb{R}^{T \times d}$$、$$T$$ 个键排成 $$K \in \mathbb{R}^{T \times d}$$，矩阵乘积 $$QK^\top \in \mathbb{R}^{T \times T}$$ 的第 $$(i, j)$$ 个元素恰好是第 $$i$$ 个查询与第 $$j$$ 个键的点积 $$\mathbf{q}_i^\top \mathbf{k}_j$$（这里用原始点积而非余弦相似度，既衡量方向是否对齐，也保留了向量模长来调节关注强度）。Transformer 的缩放点积注意力公式在点积后专门除以了 $$\sqrt{d}$$：

$$
\mathrm{Attention}(Q, K, V) = \mathrm{softmax}\!\left(\frac{QK^\top}{\sqrt{d}}\right) V
$$
{: #eq-attn }

为什么要除以 $$\sqrt{d}$$，直接拆开 [式](#eq-dot) 的求和项 $$\sum_{i=1}^d q_i k_i$$ 就能算出来。假设初始化或归一化后，$$\mathbf{q}$$ 和 $$\mathbf{k}$$ 的每个分量近似相互独立，均值为 $$0$$、方差为 $$1$$。那么单项乘积 $$q_i k_i$$ 的均值仍为 $$0$$，方差为 $$1$$；把 $$d$$ 个独立同分布的项加起来，总和 $$\mathbf{q}^\top \mathbf{k}$$ 的均值还是 $$0$$，但方差累加到了 $$d$$，标准差随之放大为 $$\sqrt{d}$$。当头维度 $$d = 128$$ 时，点积的标准差涨到 $$\sqrt{128} \approx 11.3$$，很容易出现绝对值二三十的分数。用随机数验证不同维度下的标准差：

```python
import numpy as np

rng = np.random.default_rng(0)
for d in (16, 128, 1024):
    q = rng.standard_normal((10000, d))
    k = rng.standard_normal((10000, d))
    s = (q * k).sum(axis=1)
    print(f"d={d:4d}: std={s.std():.2f}, scaled_std={(s / np.sqrt(d)).std():.2f}")
```

```text
d=  16: std=4.04, scaled_std=1.01
d= 128: std=11.37, scaled_std=1.01
d=1024: std=31.85, scaled_std=1.00
```

实测标准差与 $$\sqrt{16} = 4$$、$$\sqrt{128} \approx 11.31$$、$$\sqrt{1024} = 32$$ 吻合，除以 $$\sqrt{d}$$ 后全部拉回 $$1$$ 附近。如果不做这一步缩放，分数之间的绝对差距会被指数函数 $$\exp(s_j)$$ 急剧放大，导致 softmax 输出几乎全部集中到最大的那一两项上。看一个 $$d = 128$$、共 8 个键向量的例子：

```python
import numpy as np

def softmax(s):
    e = np.exp(s - s.max())
    return e / e.sum()

rng = np.random.default_rng(1)
d = 128
q = rng.standard_normal(d)
K = rng.standard_normal((8, d))
scores = (K * q).sum(axis=1)
print("unscaled:", softmax(scores).round(3))
print("scaled:  ", softmax(scores / np.sqrt(d)).round(3))
```

```text
unscaled: [0.    0.7   0.    0.    0.    0.    0.001 0.3  ]
scaled:   [0.047 0.278 0.124 0.051 0.065 0.026 0.152 0.258]
```

不除 $$\sqrt{d}$$ 时，第 2 个和第 8 个位置拿走了约 $$99.9\%$$ 的权重，其余位置四舍五入到三位小数后全成了 `0.`；一旦 softmax 落进这种接近 0 或 1 的极端区域，它对输入分数的导数就会趋近于 0（第五篇推链式法则时会算出具体导数式），反向传播信号变弱，模型很难训练得动。另外在自回归生成阶段，KV Cache 里存的就是历史所有 token 的键和值，每解码一个新 token 都要拿当前 $$\mathbf{q}$$ 与缓存里成千上万个历史 $$\mathbf{k}$$ 逐一算点积，上下文越长，读取历史键值做点积的访存开销越大。

### 归一化向量与语义检索

在检索增强生成（RAG）、文本去重和聚类里，需要比较查询句子与成百上千段候选文本的语义接近程度。如果直接拿未经处理的隐藏向量算点积，长度偏大的向量会像[前面长向量 $$\mathbf{c}$$ 的例子](#ref-long-vec-example)那样凭模长占优。因此专用文本 embedding 模型通常在输出层显式做一次 L2 归一化（[式](#eq-norm-unit)），把所有文本向量都约束到单位超球面上。归一化一旦提前算好存进向量库，检索时只需做一次矩阵乘法 $$\hat{\mathbf{q}}^\top \hat{D}^\top$$，算出来的每个内积直接就是纯粹比较方向的余弦相似度（[式](#eq-cos-sim)）。

### RMSNorm 的几何动作

LLaMA、Qwen 等主流架构在每个注意力层和前馈层入口都用 RMSNorm（均方根归一化）稳定激活尺度。对 $$d$$ 维隐藏向量 $$\mathbf{h}$$，定义为

$$
\mathrm{RMSNorm}(\mathbf{h}) = \frac{\mathbf{h}}{\sqrt{\frac{1}{d}\sum_{i=1}^{d} h_i^2 + \epsilon}} \odot \mathbf{g}, \qquad
\mathrm{RMS}(\mathbf{h}) = \sqrt{\frac{1}{d}\sum_{i=1}^{d} h_i^2} = \frac{\lVert \mathbf{h} \rVert_2}{\sqrt{d}}
$$
{: #eq-rmsnorm }

其中 $$\epsilon$$（如 $$10^{-6}$$）是防止零向量除零的极小常数，$$\mathbf{g} \in \mathbb{R}^d$$ 是可学习的逐维缩放参数。忽略极小的 $$\epsilon$$ 时，分母恰好等于 L2 范数除以 $$\sqrt{d}$$，把式子拆成前后两步看几何动作非常清楚：

1. 第一步算 $$\mathbf{h} / \mathrm{RMS}(\mathbf{h}) = \sqrt{d} \cdot (\mathbf{h} / \lVert \mathbf{h} \rVert_2) = \sqrt{d}\,\hat{\mathbf{h}}$$。它保持 $$\mathbf{h}$$ 的方向丝毫不变，不管输入向量原本有多长或多短，统一把终点拉回到半径为 $$\sqrt{d}$$ 的球面上（使每个分量的均方值恢复到 $$1$$ 左右），防止经过几十层矩阵乘法后向量模长失控放大或衰减归零。以 $$d = 4$$ 的 $$\mathbf{h} = [1, -2, 2, 4]^\top$$ 为例，$$\lVert \mathbf{h} \rVert_2 = 5$$，$$\mathrm{RMS}(\mathbf{h}) = 5 / \sqrt{4} = 2.5$$，除完得到 $$[0.4, -0.8, 0.8, 1.6]^\top$$，核对它的 L2 范数正好等于 $$\sqrt{4} = 2$$。
2. 第二步逐元素乘以 $$\mathbf{g}$$，完全等价于左乘[第一篇讲过的对角矩阵](/notes/math-01-vectors-matrices/#ref-diag-matrix) $$\mathrm{diag}(g_1, \dots, g_d)$$，沿着各个坐标轴方向单独调节拉伸比例（乘完 $$\mathbf{g}$$ 后终点一般离开半径为 $$\sqrt{d}$$ 的球面）。

下表把本篇出现的几组度量与投影概念放在一起做汇总对比：

| 概念 | 公式（列向量） | 结果类型 | 几何含义与典型用途 |
| --- | --- | --- | --- |
| 点积 | $$\mathbf{x}^\top \mathbf{y} = \sum_i x_i y_i$$ | 标量 | $$\lVert \mathbf{x} \rVert_2 \lVert \mathbf{y} \rVert_2 \cos\theta$$，同时计入方向与长度；注意力原始打分 |
| L1 / L2 / L∞ 范数 | $$\sum \lvert x_i \rvert$$、$$\sqrt{\sum x_i^2}$$、$$\max \lvert x_i \rvert$$ | 非负标量 | 等距圈依次为菱形、正圆、正方形；度量向量幅值、正则化与离群值分析 |
| 余弦相似度 | $$\hat{\mathbf{x}}^\top \hat{\mathbf{y}} = \dfrac{\mathbf{x}^\top \mathbf{y}}{\lVert \mathbf{x} \rVert_2 \lVert \mathbf{y} \rVert_2}$$ | $$[-1, 1]$$ 标量 | 剥离长度只看夹角方向；embedding 语义检索与聚类 |
| 正交矩阵 | $$Q^\top Q = I$$（方阵时 $$Q^{-1} = Q^\top$$） | $$n \times n$$ 矩阵 | 保持长度与夹角不变，对空间做刚体旋转或镜像翻转 |
| 直线正交投影矩阵 | $$P = \mathbf{q}\mathbf{q}^\top = \dfrac{\mathbf{b}\mathbf{b}^\top}{\mathbf{b}^\top \mathbf{b}}$$ | $$n \times n$$ 秩 1 矩阵 | 满足 $$P^\top = P$$、$$P^2 = P$$，把整个空间垂直压到直线 $$\mathbf{b}$$ 上找最近点 |

## 参考资料

- Gilbert Strang，Introduction to Linear Algebra，第 6 版，第 1.2 节 Lengths and Angles from Dot Products、第 4.2 节 Projections、第 4.4 节 Orthogonal Bases and Gram-Schmidt。
- Marc Peter Deisenroth 等，[Mathematics for Machine Learning](https://mml-book.github.io/)，第 3 章 Analytic Geometry：3.1 Norms、3.2 Inner Products、3.4 Angles and Orthogonality、3.7 Rotations、3.8 Orthogonal Projections。
- Ian Goodfellow 等，[Deep Learning](https://www.deeplearningbook.org/)，第 2.5 节 Norms、第 2.6 节 Special Kinds of Matrices and Vectors。
- 3Blue1Brown，[Essence of linear algebra](https://www.3blue1brown.com/topics/linear-algebra) 第 9 集：Dot products and duality。
- Ashish Vaswani 等，[Attention Is All You Need](https://arxiv.org/abs/1706.03762)，NeurIPS 2017，第 3.2.1 节 Scaled Dot-Product Attention。
- Biao Zhang、Rico Sennrich，[Root Mean Square Layer Normalization](https://arxiv.org/abs/1910.07467)，NeurIPS 2019。
- NumPy 文档：[numpy.linalg.norm](https://numpy.org/doc/stable/reference/generated/numpy.linalg.norm.html)。
