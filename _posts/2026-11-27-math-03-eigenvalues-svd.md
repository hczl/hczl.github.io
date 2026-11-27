---
title: "大模型的数学基础（三）：特征值与 SVD"
description: "从矩阵变换的不变方向出发，用两个手算小矩阵推一遍特征值、对角化、实对称矩阵的谱分解和一般矩阵的 SVD，再看奇异值怎样决定秩与低秩近似，以及截断 SVD、LoRA 和 KV 低秩压缩的区别。"
date: 2026-11-27 13:07:00 +0800
tags: [数学, 线性代数]
math: true
series: math
series_order: 3
---

一个普通向量经过矩阵变换后，长度和方向通常都会改变，各个坐标分量混在一起。想看清一个矩阵对空间做了什么，或者连续计算它的高次幂，最有效的办法是找出一组彼此独立的基准方向，把复杂的线性变换拆成沿每条方向的单纯缩放。

全文围绕两个可手算的小矩阵展开。实对称方阵取

$$
A = \begin{bmatrix} 2 & 1 \\ 1 & 2 \end{bmatrix}
$$

2 行 3 列的矩形矩阵取

$$
M = \begin{bmatrix} 3 & 2 & 2 \\ 2 & 3 & -2 \end{bmatrix}
$$

讨论对角化失效情形时会再引入两个 2×2 上三角矩阵和一个旋转矩阵做对照。文中的验证代码在 Python 3.9.6 和 NumPy 2.0.2 下运行。

## 特征方向与特征值

把方阵 $$A = \begin{bmatrix} 2 & 1 \\ 1 & 2 \end{bmatrix}$$ 作用在标准基向量 $$[1, 0]^\top$$ 上，得到 $$A[1, 0]^\top = [2, 1]^\top$$。展开成分量就是 $$y_1 = 2x_1 + x_2$$、$$y_2 = x_1 + 2x_2$$：横轴方向发生了偏转，两个坐标分量互相耦合。如果要继续算 $$A^{100}[1, 0]^\top$$，直接连乘一百次矩阵既繁琐也看不出趋势。

换两条对角线方向代入，结果完全不同：

- 代入 $$[1, 1]^\top$$，算出 $$A[1, 1]^\top = [3, 3]^\top = 3\,[1, 1]^\top$$，方向没有偏转，只沿原直线拉长了 3 倍。
- 代入 $$[1, -1]^\top$$，算出 $$A[1, -1]^\top = [1, -1]^\top = 1\,[1, -1]^\top$$，方向和长度都保持 1 倍不变。

有了这两条不偏转的直线，前面耦合的计算就可以拆开。把 $$[1, 0]^\top$$ 写成这两条方向的线性组合：

$$
\begin{bmatrix} 1 \\ 0 \end{bmatrix} = \frac{1}{2}\begin{bmatrix} 1 \\ 1 \end{bmatrix} + \frac{1}{2}\begin{bmatrix} 1 \\ -1 \end{bmatrix}
$$

利用线性变换保持加法和数乘的性质，算 $$A[1, 0]^\top$$ 只需把两段各自乘上对应的伸缩倍数 3 和 1，得到 $$\tfrac{3}{2}[1, 1]^\top + \tfrac{1}{2}[1, -1]^\top = [2, 1]^\top$$；算 $$A^{100}[1, 0]^\top$$ 也只需要把两段各自乘上 $$3^{100}$$ 和 $$1^{100}$$，不需要连乘矩阵。

这种在变换下留在原直线上的方向称为矩阵的特征向量，对应的伸缩倍数称为特征值。这里的“特征”和机器学习里的特征（`feature`，如身高、像素、词向量等数据属性）不是同一个词；它对应英文 `eigenvector` 和 `eigenvalue`，德语词根 `eigen-` 的意思是“自身固有的”（早年教材也译作“本征值”或“固有值”），指矩阵变换自身固有的不变方向。

一般地，对 $$n$$ 阶方阵 $$A$$，如果存在非零向量 $$\mathbf{x}$$ 和标量 $$\lambda$$ 满足

$$
A\mathbf{x} = \lambda \mathbf{x}
$$
{: #eq-eigen-def }

就称 $$\mathbf{x}$$ 为 $$A$$ 的特征向量，$$\lambda$$ 为对应的特征值。当 $$\lambda > 0$$ 时方向不变，$$\lambda < 0$$ 时方向反转，$$\lambda = 0$$ 时向量被压成零向量，三种情形都没有偏离原直线。定义要求 $$\mathbf{x} \ne \mathbf{0}$$，是因为零向量乘任何矩阵都是零向量，对任意 $$\lambda$$ 都成立，无法确定方向；而任何特征向量的非零倍数依然满足 [式](#eq-eigen-def)，因此通常归一化成单位向量，正负号任选。

刚才 $$A$$ 的两条方向是靠观察试出来的；给一个一般方阵，按下面四步求解特征值和特征向量：

1. 把 [式](#eq-eigen-def) 移项，改写成齐次方程 $$(A - \lambda I)\mathbf{x} = \mathbf{0}$$。
2. 要让该方程存在非零解 $$\mathbf{x}$$，方阵 $$A - \lambda I$$ 不能可逆（若可逆，两边左乘逆矩阵会得出 $$\mathbf{x} = \mathbf{0}$$）。不可逆意味着它把空间压到更低的维度、成为奇异矩阵，面积（高维时是体积）缩放倍率为 0，即行列式为 0。对 2×2 矩阵 $$\begin{bmatrix} a & b \\ c & d \end{bmatrix}$$，[行列式](/notes/math-01-vectors-matrices/#eq-det2)等于 $$ad - bc$$，代入 $$A$$ 得到特征方程：

   $$
   \det(A - \lambda I) = \det\begin{bmatrix} 2 - \lambda & 1 \\ 1 & 2 - \lambda \end{bmatrix} = (2 - \lambda)^2 - 1 = 0
   $$
   {: #eq-char-poly }

3. 解出特征值 $$\lambda_1 = 3$$、$$\lambda_2 = 1$$。对于一般的 $$n$$ 阶方阵，特征方程是 $$n$$ 次多项式，在复数范围内共有 $$n$$ 个根（重根按重数计算）。
4. 把每个特征值代回齐次方程 $$(A - \lambda I)\mathbf{x} = \mathbf{0}$$ 求方向。$$\lambda_1 = 3$$ 时 $$A - 3I = \begin{bmatrix} -1 & 1 \\ 1 & -1 \end{bmatrix}$$，解得 $$x_1 = x_2$$，归一化得到 $$\mathbf{q}_1 = \tfrac{1}{\sqrt{2}}[1, 1]^\top$$；$$\lambda_2 = 1$$ 时 $$A - I = \begin{bmatrix} 1 & 1 \\ 1 & 1 \end{bmatrix}$$，解得 $$x_1 = -x_2$$，归一化得到 $$\mathbf{q}_2 = \tfrac{1}{\sqrt{2}}[1, -1]^\top$$。

算出的特征值可以用两条对任意方阵都成立的恒等式验算：所有特征值之和等于主对角线元素之和（迹），这里 $$3 + 1 = 2 + 2 = 4$$；所有特征值之积等于矩阵行列式，这里 $$3 \times 1 = 2 \times 2 - 1 \times 1 = 3$$。

## 对角化与失效情形

把前面“拆到特征方向、各自乘特征值、再拼回原坐标”的过程写成矩阵，就是特征分解。设 $$n$$ 阶方阵 $$A$$ 有 $$n$$ 个线性无关的特征向量 $$\mathbf{s}_1, \dots, \mathbf{s}_n$$，把它们按列排成矩阵 $$S$$，把对应特征值排进对角矩阵 $$\Lambda = \mathrm{diag}(\lambda_1, \dots, \lambda_n)$$。按[第一篇按列看矩阵乘法的规则](/notes/math-01-vectors-matrices/#eq-matvec-cols)，$$AS$$ 的第 $$i$$ 列是 $$A\mathbf{s}_i = \lambda_i \mathbf{s}_i$$，而 $$S\Lambda$$ 的第 $$i$$ 列同样是 $$\lambda_i \mathbf{s}_i$$，所以 $$AS = S\Lambda$$。因为各列线性无关，$$S$$ 可逆，两边右乘 $$S^{-1}$$ 得到

$$
A = S \Lambda S^{-1}
$$
{: #eq-diag }

从几何上看，[式](#eq-diag) 把矩阵变换分成三步：先用 $$S^{-1}$$ 把输入从标准坐标换算到特征基坐标，再用对角矩阵 $$\Lambda$$ 在每条特征轴上独立缩放 $$\lambda_i$$ 倍，最后用 $$S$$ 换回标准坐标。计算高次幂时，中间相邻的 $$S^{-1}S = I$$ 两两抵消：$$A^2 = (S\Lambda S^{-1})(S\Lambda S^{-1}) = S\Lambda(S^{-1}S)\Lambda S^{-1} = S\Lambda^2 S^{-1}$$，以此类推得到 $$A^k = S \Lambda^k S^{-1}$$，只需对对角线上的每个特征值单独求幂。如果绝对值最大的特征值是唯一的，且初始向量在该方向上的分量不为 0，反复乘以 $$A$$ 后这一方向会占主导；若该特征值为负，每乘一次方向还会正负交替翻转。

能写成 [式](#eq-diag) 的方阵称为可对角化，充要条件是存在 $$n$$ 个线性无关的特征向量（若 $$n$$ 个特征值互不相同，对应特征向量自动线性无关，一定可对角化）。但并非所有方阵都能这么规整地拆解。拿下面两个左下角为 0 的 2×2 上三角矩阵和一个 90° 旋转矩阵对照（上三角矩阵的特征值就是主对角线元素），会出现三种不同的限制：

$$
B = \begin{bmatrix} 2 & 1 \\ 0 & 3 \end{bmatrix}, \qquad J = \begin{bmatrix} 1 & 1 \\ 0 & 1 \end{bmatrix}, \qquad R = \begin{bmatrix} 0 & -1 \\ 1 & 0 \end{bmatrix}
$$

1. 特征方向不垂直。矩阵 $$B$$ 的特征值是 2 和 3，互不相同，解出的特征向量是 $$\mathbf{s}_1 = [1, 0]^\top$$ 和 $$\mathbf{s}_2 = [1, 1]^\top$$。两列线性无关，$$B$$ 可以对角化，但 $$\mathbf{s}_1^\top \mathbf{s}_2 = 1 \ne 0$$，两条轴夹角为 45°。斜坐标系下求逆 $$S^{-1}$$ 和算分量投影都不够简洁。
2. 凑不够线性无关的特征向量。水平剪切矩阵 $$J$$ 的特征方程是 $$(1 - \lambda)^2 = 0$$，只有二重根 $$\lambda = 1$$。代回 $$J - I = \begin{bmatrix} 0 & 1 \\ 0 & 0 \end{bmatrix}$$ 只能解出 $$x_2 = 0$$，所有特征向量全落在横轴 $$[1, 0]^\top$$ 这一条直线上，凑不出第二条不变直线，$$S$$ 不可逆，因此 $$J$$ 不可对角化（重根并不必然导致不可对角化，例如单位矩阵 $$I$$ 的特征值全是 1，但它本身已经是对角矩阵）。
3. 实数范围内不存在特征方向。逆时针旋转 90° 的矩阵 $$R$$ 会把平面上每根非零实向量都转离原来的直线，特征方程 $$\lambda^2 + 1 = 0$$ 没有实根（特征值为虚数 $$\pm i$$）。

下面把 $$A$$、$$B$$、$$J$$、$$R$$ 四类 2×2 矩阵的连续网格变形放在一起对比（最后一步回到剪切矩阵 $$J$$，展示它在单位圆上对应的正交长短轴）：

{% include linalg-demo.html id="math03-eigen" caption="二维线性变换连续网格演示：对比实对称矩阵 A、非对称矩阵 B、剪切矩阵 J 与 90° 旋转的特征方向，以及末尾 J 在单位圆上对应的正交长短轴" %}

## 实对称矩阵与谱分解

对照前面的 $$A = \begin{bmatrix} 2 & 1 \\ 1 & 2 \end{bmatrix}$$ 和 $$B = \begin{bmatrix} 2 & 1 \\ 0 & 3 \end{bmatrix}$$：两者都可以对角化，但 $$B$$ 的两条特征轴夹角为 45°，而 $$A$$ 的两条特征轴满足 $$\mathbf{q}_1^\top \mathbf{q}_2 = \tfrac{1}{2}(1 - 1) = 0$$，恰好互相垂直。

差别在于 $$A$$ 满足对称性 $$A^\top = A$$，而 $$B$$ 不对称。实对称矩阵的谱定理（数学里把矩阵的全部特征值集合称为它的“谱”）保证了两条强性质：任意实对称矩阵的特征值全是实数，且总能选出一组 $$n$$ 个两两正交的单位特征向量。

对称性为何能保证不同特征值对应的特征向量正交，用[第二篇的点积](/notes/math-02-dot-norm-projection/#eq-dot)一行就能验算。设 $$A\mathbf{x} = \lambda \mathbf{x}$$、$$A\mathbf{y} = \mu \mathbf{y}$$ 且 $$\lambda \ne \mu$$，把 $$A$$ 通过转置移到右边，再代入 $$A^\top = A$$：

$$
\lambda\,\mathbf{x}^\top \mathbf{y} = (A\mathbf{x})^\top \mathbf{y} = \mathbf{x}^\top A^\top \mathbf{y} = \mathbf{x}^\top A \mathbf{y} = \mu\,\mathbf{x}^\top \mathbf{y}
$$
{: #eq-sym-ortho }

移项得 $$(\lambda - \mu)\,\mathbf{x}^\top \mathbf{y} = 0$$。因为 $$\lambda \ne \mu$$，必然有 $$\mathbf{x}^\top \mathbf{y} = 0$$，两根特征向量严格垂直。换成不对称的 $$B$$ 时，$$B^\top \ne B$$，中间的替换不成立，特征向量也就不再保证正交。

把实对称矩阵的标准正交特征向量按列排成正交矩阵 $$Q = [\mathbf{q}_1, \dots, \mathbf{q}_n]$$，利用正交矩阵性质 [$$Q^{-1} = Q^\top$$](/notes/math-02-dot-norm-projection/#eq-ortho-mat)，特征分解 [式](#eq-diag) 里的求逆退化为转置 $$A = Q\Lambda Q^\top$$。其中 $$Q\Lambda$$ 的第 $$i$$ 列是 $$\lambda_i \mathbf{q}_i$$、$$Q^\top$$ 的第 $$i$$ 行是 $$\mathbf{q}_i^\top$$，按[第一篇的外积之和读法](/notes/math-01-vectors-matrices/#eq-matmul-outer)把 $$(Q\Lambda)Q^\top$$ 展开，就得到实对称矩阵的谱分解：

$$
A = Q \Lambda Q^\top = \lambda_1 \mathbf{q}_1 \mathbf{q}_1^\top + \cdots + \lambda_n \mathbf{q}_n \mathbf{q}_n^\top
$$
{: #eq-spectral }

结合[第二篇的外积投影矩阵](/notes/math-02-dot-norm-projection/#eq-proj-mat)，每一项 $$\mathbf{q}_i \mathbf{q}_i^\top$$ 都是向第 $$i$$ 条特征轴做正交投影的矩阵。因此 [式](#eq-spectral) 的几何含义很明确：先把输入向量分别投影到 $$n$$ 条互相垂直的轴上，各自乘上对应的特征值 $$\lambda_i$$，再把各轴结果相加。代入 $$A$$ 验算：

$$
A = 3 \cdot \frac{1}{2}\begin{bmatrix} 1 & 1 \\ 1 & 1 \end{bmatrix} + 1 \cdot \frac{1}{2}\begin{bmatrix} 1 & -1 \\ -1 & 1 \end{bmatrix} = \begin{bmatrix} 2 & 1 \\ 1 & 2 \end{bmatrix}
$$

一般的矩形矩阵并不对称，但拿任意实矩阵 $$X$$ 与自身转置相乘，得到的 $$X^\top X$$ 和 $$XX^\top$$ 一定是实对称方阵，因为 $$(X^\top X)^\top = X^\top (X^\top)^\top = X^\top X$$。不仅如此，对任意向量 $$\mathbf{x}$$，都有 $$\mathbf{x}^\top (X^\top X)\mathbf{x} = (X\mathbf{x})^\top (X\mathbf{x}) = \lVert X\mathbf{x} \rVert_2^2 \ge 0$$；把满足 $$(X^\top X)\mathbf{x} = \lambda \mathbf{x}$$ 的非零特征向量代进去，左边变成 $$\mathbf{x}^\top(\lambda \mathbf{x}) = \lambda(\mathbf{x}^\top \mathbf{x}) = \lambda \lVert \mathbf{x} \rVert_2^2 \ge 0$$，由于 $$\lVert \mathbf{x} \rVert_2^2 > 0$$，必然有 $$\lambda \ge 0$$。所有特征值都非负的实对称矩阵称为半正定矩阵，下一节构造奇异值分解会用到这一性质。
{: #ref-psd }

在 NumPy 里，对称矩阵应当优先调用专用的 `eigh`，它保证返回升序的实特征值和标准正交特征向量；一般方阵则用 `eig`，返回值可能含复数，特征向量也不保证正交。下面用代码核验 $$A$$ 和 $$B$$（特征向量的整体正负号由底层数值库选定，与手算相反不影响正确性）：

```python
import numpy as np

A = np.array([[2.0, 1.0],
              [1.0, 2.0]])
lam, Q = np.linalg.eigh(A)
print("A eigenvalues:", lam)
print("Q.T @ Q == I:", np.allclose(Q.T @ Q, np.eye(2)))
print("Q @ diag(lam) @ Q.T == A:", np.allclose(Q @ np.diag(lam) @ Q.T, A))

B = np.array([[2.0, 1.0],
              [0.0, 3.0]])
lam_b, S = np.linalg.eig(B)
print("B eigenvalues:", lam_b)
print("B s1·s2:", round(float(S[:, 0] @ S[:, 1]), 4))
print("S @ diag(lam_b) @ inv(S) == B:", np.allclose(S @ np.diag(lam_b) @ np.linalg.inv(S), B))
```

```text
A eigenvalues: [1. 3.]
Q.T @ Q == I: True
Q @ diag(lam) @ Q.T == A: True
B eigenvalues: [2. 3.]
B s1·s2: 0.7071
S @ diag(lam_b) @ inv(S) == B: True
```

## 矩形矩阵与奇异值分解

特征值只对方阵有定义，但大模型里的线性层权重、词表嵌入和注意力投影矩阵绝大多数都是矩形。比如开头那张 2×3 矩阵 $$M$$，它把三维空间里的向量映射到二维平面，输入和输出不在同一个维度里，无法讨论变换前后“方向不变”。

看前面动画的第 7 步：不可对角化的剪切矩阵 $$J = \begin{bmatrix} 1 & 1 \\ 0 & 1 \end{bmatrix}$$ 虽然凑不齐两个特征向量，但它把单位圆映射出去依然是一个椭圆；输出椭圆的长短半轴互相垂直，它们在输入单位圆上也正好对应一对互相垂直的方向 $$\mathbf{v}_1 \perp \mathbf{v}_2$$。

前面在方阵里受限，原因在于特征分解要求输入和输出共用同一套坐标轴（输入沿 $$\mathbf{q}_i$$，输出仍须留在 $$\mathbf{q}_i$$ 上）。如果放宽这一要求，允许输入空间选一套标准正交基 $$\mathbf{v}_i$$、输出空间另选一套标准正交基 $$\mathbf{u}_i$$，只要求 $$M$$ 把输入的第 $$i$$ 条正交轴送到输出的第 $$i$$ 条正交轴，并按非负倍数 $$\sigma_i \ge 0$$ 伸缩：

$$
M\mathbf{v}_i = \sigma_i \mathbf{u}_i, \qquad \sigma_i \ge 0
$$
{: #eq-svd-vec }

这种把任意矩阵拆成“输入正交基 + 非负轴向伸缩 + 输出正交基”的方法，就是奇异值分解（Singular Value Decomposition，简称 SVD）。和只对部分方阵成立的特征分解不同，任意 $$m \times n$$ 实矩阵都必然存在奇异值分解，不要求方阵、对称或满秩（后面会看到，这是因为任意矩阵 $$M$$ 构造出的 $$MM^\top$$ 一定是实对称半正定方阵，必然可以进行谱分解）。各主方向上的非负伸缩倍数 $$\sigma_i$$ 称为奇异值；当某个 $$\sigma_i = 0$$ 时，空间沿该方向被压成零向量，对应维度信息丢失且变换不可逆，这正是矩阵“奇异（singular）”的几何含义。

要从 $$M$$ 求出未知的正交矩阵 $$U, V$$ 和对角拉伸矩阵 $$\Sigma$$，先假设分解 $$M = U\Sigma V^\top$$ 成立，把 $$M$$ 与转置 $$M^\top = V\Sigma^\top U^\top$$ 相乘，利用 [$$V^\top V = I$$](/notes/math-02-dot-norm-projection/#eq-ortho-mat) 消去右边的 $$V$$：

$$
MM^\top = (U \Sigma V^\top)(V \Sigma^\top U^\top) = U (\Sigma \Sigma^\top) U^\top
$$
{: #eq-mmt }

[式](#eq-mmt) 右边正是[实对称半正定矩阵](#ref-psd) $$MM^\top$$ 的[谱分解](#eq-spectral)：原本跨维度的矩形矩阵经由 $$MM^\top$$ 变成了一个作用在输出空间内的对称方阵。两边逐项对照，$$U$$ 的各列就是 $$MM^\top$$ 的标准正交特征向量 $$\mathbf{u}_i$$，对角阵 $$\Sigma \Sigma^\top$$ 的对角元素是 $$\sigma_i^2$$，因此 $$MM^\top$$ 的特征值 $$\lambda_i$$ 等于 $$\sigma_i^2$$，把正特征值开平方就能反推出奇异值 $$\sigma_i = \sqrt{\lambda_i}$$。

下面按这一关系在 $$M = \begin{bmatrix} 3 & 2 & 2 \\ 2 & 3 & -2 \end{bmatrix}$$ 上逐步求解：

1. 构造 2×2 的实对称半正定矩阵 $$MM^\top$$ 并做[谱分解](#eq-spectral)：

   $$
   MM^\top = \begin{bmatrix} 3 & 2 & 2 \\ 2 & 3 & -2 \end{bmatrix}\begin{bmatrix} 3 & 2 \\ 2 & 3 \\ 2 & -2 \end{bmatrix} = \begin{bmatrix} 17 & 8 \\ 8 & 17 \end{bmatrix}
   $$

   它的第 $$(i, j)$$ 个元素是 $$M$$ 第 $$i$$ 行与第 $$j$$ 行的点积（两行长度平方同为 17，两行点积为 8）。特征方程 $$(17 - \lambda)^2 - 64 = 0$$ 解出特征值 $$\lambda_1 = 25$$、$$\lambda_2 = 9$$。由于主对角线元素相等且非对角线元素也相等，它的标准正交特征向量和 $$A$$ 完全一样：$$\mathbf{u}_1 = \tfrac{1}{\sqrt{2}}[1, 1]^\top$$，$$\mathbf{u}_2 = \tfrac{1}{\sqrt{2}}[1, -1]^\top$$。由 [式](#eq-mmt) 可知 $$\lambda_i = \sigma_i^2$$，对正特征值开平方得到奇异值 $$\sigma_1 = 5$$、$$\sigma_2 = 3$$。

2. 反求对应的输入正交轴 $$\mathbf{v}_i$$。把目标式 $$M = U \Sigma V^\top$$ 两边取转置得 $$M^\top = V \Sigma^\top U^\top$$，右乘第 $$i$$ 根左奇异向量 $$\mathbf{u}_i$$（因 $$U$$ 各列标准正交，$$U^\top \mathbf{u}_i$$ 只在第 $$i$$ 位为 1、其余为 0），得到 $$M^\top \mathbf{u}_i = \sigma_i \mathbf{v}_i$$。对每个正奇异值 $$\sigma_i > 0$$，两边除以 $$\sigma_i$$ 解出 $$\mathbf{v}_i = M^\top \mathbf{u}_i / \sigma_i$$：

   $$
   \mathbf{v}_1 = \frac{1}{5\sqrt{2}}\begin{bmatrix} 5 \\ 5 \\ 0 \end{bmatrix} = \frac{1}{\sqrt{2}}\begin{bmatrix} 1 \\ 1 \\ 0 \end{bmatrix},\qquad
   \mathbf{v}_2 = \frac{1}{3\sqrt{2}}\begin{bmatrix} 1 \\ -1 \\ 4 \end{bmatrix}
   $$

   代回验算可以确认它同时满足 [式](#eq-svd-vec) 与标准正交性：一方面 $$M\mathbf{v}_i = (MM^\top \mathbf{u}_i)/\sigma_i = (\sigma_i^2 \mathbf{u}_i)/\sigma_i = \sigma_i \mathbf{u}_i$$；另一方面把 $$MM^\top \mathbf{u}_j = \sigma_j^2 \mathbf{u}_j$$ 代入内积，得 $$\mathbf{v}_i^\top \mathbf{v}_j = (\mathbf{u}_i^\top MM^\top \mathbf{u}_j)/(\sigma_i \sigma_j) = (\mathbf{u}_i^\top (\sigma_j^2 \mathbf{u}_j))/(\sigma_i \sigma_j) = (\sigma_j / \sigma_i)\,\mathbf{u}_i^\top \mathbf{u}_j$$，当 $$i \ne j$$ 时为 0，$$i = j$$ 时为 1。

3. 补齐输入空间里被压成 0 的方向。输入空间是三维的，$$\mathbf{v}_1$$、$$\mathbf{v}_2$$ 只撑起一张二维平面。找出与两者都垂直的单位向量 $$\mathbf{v}_3 = \tfrac{1}{3}[2, -2, -1]^\top$$，代入可得 $$M\mathbf{v}_3 = \mathbf{0}$$。它对应 3×3 矩阵 $$M^\top M$$ 多出来的零特征值（$$M^\top M$$ 的特征值为 25、9、0），补上它才能让 $$V$$ 凑成完整的 3×3 正交方阵。

4. 把结果按列拼成 2×2 正交矩阵 $$U = [\mathbf{u}_1, \mathbf{u}_2]$$、3×3 正交矩阵 $$V = [\mathbf{v}_1, \mathbf{v}_2, \mathbf{v}_3]$$，在 2×3 矩阵 $$\Sigma$$ 的主对角线依次填入 5 和 3、其余补 0。前面三条方程 $$M\mathbf{v}_1 = 5\mathbf{u}_1$$、$$M\mathbf{v}_2 = 3\mathbf{u}_2$$、$$M\mathbf{v}_3 = \mathbf{0}$$ 按列拼在一起就是 $$MV = U\Sigma$$，两边右乘 $$V^\top$$ 并利用正交方阵性质 [$$V^{-1} = V^\top$$](/notes/math-02-dot-norm-projection/#eq-ortho-mat)（即 $$VV^\top = I$$），再按外积之和展开，就得到奇异值分解：

   $$
   M = U \Sigma V^\top = \sigma_1 \mathbf{u}_1 \mathbf{v}_1^\top + \sigma_2 \mathbf{u}_2 \mathbf{v}_2^\top
   $$
   {: #eq-svd }

在几何上，[式](#eq-svd) 把任意矩阵变换拆成了三步：先由 $$V^\top$$ 在输入空间做一次刚体旋转或镜像，把输入主轴 $$\mathbf{v}_i$$ 对齐到标准坐标轴；再由 $$\Sigma$$ 沿各轴按奇异值 $$\sigma_i$$ 独立拉伸，并把多余的零空间维度压成 0；最后由 $$U$$ 在输出空间做一次旋转或镜像，把主轴转到 $$\mathbf{u}_i$$ 的方向。因为[正交矩阵不改变向量长度](/notes/math-02-dot-norm-projection/#eq-ortho-dot)，整个矩阵在尺度上的拉伸与压缩全部由奇异值决定：

{% include linalg-demo.html id="math03-svd" caption="2×3 矩阵 M = U Σ Vᵀ 的三维连续几何变换与秩 1 截断坍缩演示" %}

再区分一下奇异值与特征值：对实对称半正定矩阵（例如开头的 $$A$$），SVD 与谱分解重合，奇异值就是特征值 3 和 1；对一般方阵两者通常不同，例如不可对角化的剪切矩阵 $$J = \begin{bmatrix} 1 & 1 \\ 0 & 1 \end{bmatrix}$$，两个特征值都是 1，而奇异值（输出椭圆的长短半轴）约为 1.618 和 0.618。

用 NumPy 对 $$M$$ 做 SVD，并核验只留第一项时的秩 1 近似（`full_matrices=False` 只返回前 $$\min(m, n)$$ 组奇异向量，做低秩截断时更省内存；`svd` 返回转置后的 `Vt`，且成对左、右奇异向量同时变号不影响外积 $$\mathbf{u}_i \mathbf{v}_i^\top$$）：

```python
import numpy as np

M = np.array([[3.0, 2.0,  2.0],
              [2.0, 3.0, -2.0]])
U, s, Vt = np.linalg.svd(M, full_matrices=False)
M1 = (U[:, :1] * s[:1]) @ Vt[:1]
E = M - M1
print("singular values:", s)
print("M1:\n", M1.round(4))
print("spectral err:", round(float(np.linalg.norm(E, 2)), 6),
      "frobenius err:", round(float(np.linalg.norm(E, 'fro')), 6))
print("||M||_F^2:", round(float(np.linalg.norm(M, 'fro') ** 2), 6),
      "sum(s^2):", round(float((s ** 2).sum()), 6))
```

```text
singular values: [5. 3.]
M1:
 [[2.5 2.5 0. ]
 [2.5 2.5 0. ]]
spectral err: 3.0 frobenius err: 3.0
||M||_F^2: 34.0 sum(s^2): 34.0
```

## 秩与低秩近似

把 [式](#eq-svd) 作用到任意输入向量 $$\mathbf{x}$$ 上，展开成逐项叠加的形式：

$$
M\mathbf{x} = \sigma_1 (\mathbf{v}_1^\top \mathbf{x})\,\mathbf{u}_1 + \sigma_2 (\mathbf{v}_2^\top \mathbf{x})\,\mathbf{u}_2 + \cdots + \sigma_r (\mathbf{v}_r^\top \mathbf{x})\,\mathbf{u}_r
$$

从这行展开可以看出两条常用结论：

1. 矩阵的秩等于非零奇异值的个数。只有 $$\sigma_i > 0$$ 的项对输出有贡献，$$\sigma_i = 0$$ 对应的方向（如上面的 $$\mathbf{v}_3$$）会被映射为零向量，因此矩阵的秩恰好等于非零奇异值的个数 $$r \le \min(m, n)$$。每一项 $$\mathbf{u}_i \mathbf{v}_i^\top$$ 都是[秩 1 矩阵](/notes/math-01-vectors-matrices/#ref-outer-def)，秩为 $$r$$ 的 $$m \times n$$ 矩阵不需要存满 $$mn$$ 个数，只需存成 $$m \times r$$ 和 $$r \times n$$ 两张窄矩阵，元素总数降为 $$r(m + n)$$。在浮点计算中，理论上为 0 的奇异值常因舍入变成 $$10^{-15}$$ 量级的小数，NumPy 的 `matrix_rank` 内部也是先算奇异值再按阈值计数，因此分析实际矩阵时，观察奇异值从大到小的衰减曲线比只看一个整数秩更有参考价值。

2. 按奇异值大小只保留前 $$k$$ 项，就得到矩阵的低秩近似（截断 SVD）。把奇异值从大到小排列，靠前的 $$\sigma_i$$ 对应振幅最大的主方向，靠后极小的 $$\sigma_i$$ 对应次要细节或噪声。舍弃第 $$k$$ 项之后的部分，得到

   $$
   M_k = \sum_{i=1}^{k} \sigma_i \mathbf{u}_i \mathbf{v}_i^\top
   $$
   {: #eq-trunc-svd }

对照上面 3D 动画的最后一步：对 $$M$$ 只保留第一项 $$M_1 = 5\,\mathbf{u}_1 \mathbf{v}_1^\top = \begin{bmatrix} 2.5 & 2.5 & 0 \\ 2.5 & 2.5 & 0 \end{bmatrix}$$，残差恰好是丢掉的第二项 $$E = M - M_1 = 3\,\mathbf{u}_2 \mathbf{v}_2^\top$$。几何上，二维输出椭圆沿着短轴压成一条直线，原椭圆上任意点到这条直线的最大偏离等于被舍弃的短半轴长度 $$\sigma_2 = 3$$。

要量化一般矩阵截断后的误差，最常用的度量是 Frobenius 范数 $$\lVert E \rVert_F = \sqrt{\sum_{i,j} E_{ij}^2}$$，即把残差矩阵里所有元素的平方相加再开方（相当于把矩阵拉成长向量算 [L2 范数](/notes/math-02-dot-norm-projection/#eq-l2)，也等于所有列向量长度平方之和再开方）。由于左乘正交矩阵 $$U^\top$$ 不改变每一列的长度、右乘正交矩阵 $$V$$ 不改变每一行的长度（[第二篇正交保长性质](/notes/math-02-dot-norm-projection/#eq-ortho-dot)），矩阵的元素平方和恰好等于全部奇异值的平方和：$$\lVert M \rVert_F = \lVert U\Sigma V^\top \rVert_F = \lVert \Sigma \rVert_F = \sqrt{\sum_i \sigma_i^2}$$（在 $$M$$ 上，元素平方和 $$9 + 4 + 4 + 4 + 9 + 4 = 34$$ 正好等于 $$5^2 + 3^2$$）。

因此只保留前 $$k$$ 项时，丢掉的 Frobenius 误差等于被舍弃奇异值的平方和开方；若看任意单位输入向量上的最大单向偏差（谱范数 $$\lVert E \rVert_2$$），误差等于被舍弃的最大那个奇异值 $$\sigma_{k+1}$$：

$$
\min_{\mathrm{rank}(X) \le k} \lVert M - X \rVert_2 = \lVert M - M_k \rVert_2 = \sigma_{k+1}, \qquad
\min_{\mathrm{rank}(X) \le k} \lVert M - X \rVert_F = \lVert M - M_k \rVert_F = \sqrt{\sigma_{k+1}^2 + \cdots + \sigma_r^2}
$$
{: #eq-eckart-young }

这就是 Eckart-Young 定理给出的最优性保证：在所有秩不超过 $$k$$ 的矩阵中，[式](#eq-trunc-svd) 在这两种范数下误差最小。套回 $$M$$ 的秩 1 截断，舍弃的只有 $$\sigma_2 = 3$$，代入 [式](#eq-eckart-young) 两种误差都是 3，与前面代码输出一致。

不过最优性只代表不存在误差更小的秩 $$k$$ 近似，绝对误差有多小仍取决于原矩阵奇异值的衰减速度。拿两个 256×256 矩阵实测对比：一个是纯标准高斯随机矩阵，另一个由秩 16 的低秩主结构叠加 5% 随机噪声构成，分别计算截断到 $$k = 16, 32, 64$$ 时的相对误差 $$\lVert W - W_k \rVert_F / \lVert W \rVert_F$$：

```python
import numpy as np

rng = np.random.default_rng(0)
n = 256
W_rand = rng.standard_normal((n, n))
W_low = (rng.standard_normal((n, 16)) @ rng.standard_normal((16, n))) / np.sqrt(16) + 0.05 * rng.standard_normal((n, n))

for name, W in [("随机高斯矩阵", W_rand), ("低秩主结构 + 小噪声", W_low)]:
    s = np.linalg.svd(W, compute_uv=False)
    total = np.linalg.norm(s)
    errs = [round(float(np.linalg.norm(s[k:]) / total), 4) for k in (16, 32, 64)]
    print(f"{name}: k=16 -> {errs[0]}, k=32 -> {errs[1]}, k=64 -> {errs[2]}")
```

```text
随机高斯矩阵: k=16 -> 0.8879, k=32 -> 0.7887, k=64 -> 0.6123
低秩主结构 + 小噪声: k=16 -> 0.0463, k=32 -> 0.0409, k=64 -> 0.0316
```

在 $$k = 16$$ 时，用两张 256×16 的窄矩阵替代 256×256 原矩阵，参数缩减到 12.5%。面对有低秩结构的矩阵，相对误差为 4.6%，主体几乎完整保留；面对奇异值平缓的随机满秩矩阵，即便留到 $$k = 64$$（参数占一半），相对误差仍达 61.2%。此外在实际压缩神经网络时，权重自身的数值重构误差小并不自动等价于模型输出精度不变，因为不同输入维度的激活幅度差异很大。

## 在大模型里

以常见的 4096×4096 线性层权重 $$W$$ 为例，完整存储需要 16,777,216 个参数；写成秩 $$r = 64$$ 的两张窄矩阵乘积，只需要 $$64 \times (4096 + 4096) = 524{,}288$$ 个参数，缩减到原来的 1/32。大模型工程和机制分析里常见到四类低秩形式，外观相似但来源不同：

1. 对已训练权重做截断 SVD 压缩。把训练好的 $$W$$ 分解成 $$(U_k \Sigma_k)$$ 和 $$V_k^\top$$ 两张窄矩阵替代原层，省下显存和一部分乘加计算。它属于对已知矩阵 $$W$$ 的近似，精度上限受制于 $$W$$ 自身奇异值的衰减速度；工程上常结合一批校准样本的输入分布对 SVD 加权，优先压低每一层输出结果的误差，而不是只看权重矩阵本身的数值误差。
2. LoRA（Low-Rank Adaptation，低秩适配）微调。把一个已经训练好的大模型调整到特定任务上时，如果直接更新所有原始权重矩阵，显存开销很大，而且每个任务都要单独保存一整份几十亿参数的模型副本。LoRA 的做法是保持原始权重 $$W \in \mathbb{R}^{d \times k}$$ 固定不变，只在旁边并联一条由两张很窄的小矩阵相乘构成的增量支路 $$\Delta W = BA$$（其中 $$B \in \mathbb{R}^{d \times r}$$、$$A \in \mathbb{R}^{r \times k}$$，秩 $$r$$ 往往只取 8 到 64，远小于 $$d$$ 和 $$k$$）。计算时把主路和旁路相加，输出变为 $$(W + BA)\mathbf{x} = W\mathbf{x} + B(A\mathbf{x})$$；训练阶段只更新 $$B$$ 和 $$A$$ 这两张小矩阵，需要保存的微调参数缩小几十到上百倍，推理部署时还可以把 $$BA$$ 直接加回 $$W$$，不增加额外计算延迟。虽然 $$\Delta W = BA$$ 的形状和截断 SVD 因子一样（秩不超过 $$r$$），但它不是把原权重 $$W$$ 截断压缩出来的，也不要求 $$W$$ 本身低秩，而是基于“适配新任务只需要在少数主方向上微调权重”的假设，直接通过训练学出这两张小矩阵。
3. 推理期的 KV 低秩压缩。大模型逐字生成文本时，为了避免重复计算前面所有词的注意力，会把历史每个词算出的键（Key）和值（Value）向量缓存在显存里，称为 KV Cache，上下文越长显存占用越大。无论是直接对缓存下来的历史 KV 矩阵做低秩投影，还是像多头潜在注意力（MLA，Multi-head Latent Attention）那样在模型结构里就把每个词的键值联合压缩进一个低维潜在向量、算注意力时再按需还原，利用的都是注意力状态或投影权重集中在少数主方向上的特性。具体结构留到后面推理篇再展开。
4. 多头注意力里的天然低秩子空间。单个注意力头先把 $$4096$$ 维隐藏向量压进 $$128$$ 维头空间，算完再映射回 $$4096$$ 维。把值投影和输出投影合写成一张 $$4096 \times 4096$$ 矩阵 $$W_{OV} = W_O W_V$$ 时，由于中间经过 $$128$$ 维瓶颈，它的秩最多只有 $$128$$。这意味着每个注意力头只从贯穿各层的主隐藏状态通道里挑选一个很小的低维子空间做读写，不同头之间得以在同一条通道里并行传递信息而减少互相覆盖。

下表汇总这一篇涉及的几种矩阵分解与低秩形式，方便对照它们的适用范围和区别：

| 形式 | 适用矩阵 | 表达式 | 因子是否正交 | 主要用途 |
| --- | --- | --- | --- | --- |
| 一般特征分解 | 可对角化方阵 | $$A = S \Lambda S^{-1}$$ | $$S$$ 不保证正交 | 分析矩阵幂次与动态迭代 |
| 实对称谱分解 | 实对称方阵 | $$A = Q \Lambda Q^\top$$ | $$Q$$ 标准正交 | 正交投影展开、半正定矩阵分析 |
| 奇异值分解（SVD） | 任意 $$m \times n$$ 实矩阵 | $$M = U \Sigma V^\top$$ | $$U, V$$ 均标准正交 | 几何分解、数值秩与主方向分析 |
| 截断 SVD | 任意 $$m \times n$$ 实矩阵 | $$M_k = U_k \Sigma_k V_k^\top$$ | 截断后列仍标准正交 | 给定矩阵的最优低秩近似 |
| LoRA 增量 | 冻结权重旁路 | $$\Delta W = B A$$ | 无正交约束，梯度学出 | 参数高效微调低秩权重增量 |

## 参考资料

- Gilbert Strang，Introduction to Linear Algebra，第 6 版，第 6.1 节 Introduction to Eigenvalues、6.2 节 Diagonalizing a Matrix、6.3 节 Symmetric Positive Definite Matrices、7.1 节 Singular Values and Singular Vectors（章节名据作者公开 [目录](https://math.mit.edu/~gs/linearalgebra/ila6/ila6outline.pdf)）。
- Marc Peter Deisenroth 等，[Mathematics for Machine Learning](https://mml-book.github.io/)，第 4 章 Matrix Decompositions：4.2 Eigenvalues and Eigenvectors、4.4 Eigendecomposition and Diagonalization、4.5 Singular Value Decomposition、4.6 Matrix Approximation。
- Ian Goodfellow 等，[Deep Learning](https://www.deeplearningbook.org/)，第 2.7 节 Eigendecomposition、第 2.8 节 Singular Value Decomposition。
- Carl Eckart、Gale Young，[The approximation of one matrix by another of lower rank](https://doi.org/10.1007/BF02288367)，Psychometrika，1936。
- Leon Mirsky，[Symmetric gauge functions and unitarily invariant norms](https://doi.org/10.1093/qmath/11.1.50)，The Quarterly Journal of Mathematics，1960。
- Edward J. Hu 等，[LoRA: Low-Rank Adaptation of Large Language Models](https://arxiv.org/abs/2106.09685)，ICLR 2022。
- NumPy 文档：[numpy.linalg.eigh](https://numpy.org/doc/stable/reference/generated/numpy.linalg.eigh.html)、[numpy.linalg.eig](https://numpy.org/doc/stable/reference/generated/numpy.linalg.eig.html)、[numpy.linalg.svd](https://numpy.org/doc/stable/reference/generated/numpy.linalg.svd.html)、[numpy.linalg.matrix_rank](https://numpy.org/doc/stable/reference/generated/numpy.linalg.matrix_rank.html)。
