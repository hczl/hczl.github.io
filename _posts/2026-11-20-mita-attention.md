---
title: "MiTA：把注意力拆成压缩摘要和动态 top-k 专家"
description: "解读北京邮电大学 Wen 等人的 MiTA（arXiv 2602.01219v6）：从快权重 MLP 视角看路由与压缩两条路线，走一遍用少量 landmark query 同时构造全局摘要与可复用动态 top-k 专家的流程，对照官方 PyTorch 实现的细节差异，并梳理 ImageNet、ADE20K 与 LRA 的实测结果。"
date: 2026-11-20 14:00:00 +0800
tags: [注意力, 稀疏注意力, 论文]
math: true
---

标准双向自注意力里，序列中的每个 query 都要和全部 $$N$$ 个 key 做一次点积打分，单层单头的计算量按 $$N^2$$ 增长。以 ViT 为例，ImageNet 上 224×224 的图像按 16×16 切块加上 1 个 class token 共 197 个 token，单层单头要做 38,809 次点积；换成 ADE20K 的 512×512 语义分割图（1,024 个 patch），打分次数就涨到 1,048,576 次。北京邮电大学 Qishuai Wen、Zhiyuan Huang、Xianghan Meng、Wei He 和 Chun-Guang Li 在 2026 年 2 月发表了 Mixture-of-Top-k Attention（MiTA，9 月 27 日更新至 arXiv 第 6 版），用少量 landmark query 一边把全序列压成全局摘要，一边按内容挑出若干组可复用的 top-k 原始 key-value，把每个 query 需要访问的 key-value 对数压到几十对（ImageNet 上 50 对，ADE20K 上 98 对）。

文中的公式、图表与实验数据均取自 arXiv 2602.01219v6，算法执行细节对照了论文公开的 PyTorch 官方实现（2026 年 11 月 5 日版本，包含 ImageNet DeiT、ViT-5 和 ADE20K 三套代码），不是我的实测。论文的全部评测都采用双向注意力，覆盖图像分类、语义分割和 Long Range Arena（LRA），吞吐数据由作者在单张 24 GB 的 RTX 4090 上测得，暂未覆盖大语言模型的自回归解码阶段。

## 快权重视角下的压缩与路由

论文先借用快权重（fast weight）的视角重新审视标准注意力。对于单个查询向量 $$\boldsymbol{q} \in \mathbb{R}^d$$ 以及按列排列的键、值矩阵 $$\boldsymbol{K}, \boldsymbol{V} \in \mathbb{R}^{d \times N}$$，标准缩放点积注意力可以等价改写为一个没有偏置项、激活函数为指数函数的两层 MLP：

$$
\operatorname{Atten}(\boldsymbol{q}, \boldsymbol{K}, \boldsymbol{V}) = \boldsymbol{V}\operatorname{softmax}\!\left(\boldsymbol{K}^\top \boldsymbol{q} / \sqrt{d}\right) = \hat{\boldsymbol{V}}\exp\!\left(\hat{\boldsymbol{K}}^\top \boldsymbol{q}\right)
$$

其中第一层权重是缩放后的键矩阵 $$\hat{\boldsymbol{K}} = \boldsymbol{K}/\sqrt{d}$$，第二层权重是归一化后的值矩阵 $$\hat{\boldsymbol{V}} = \boldsymbol{V} / \left(\exp(\hat{\boldsymbol{K}}^\top \boldsymbol{q})^\top \boldsymbol{1}_N\right)$$。普通前馈网络里的权重在训练结束后就固定下来，隐藏层宽度也是常数；而这里由当前输入临时生成的快权重 MLP 隐藏层宽度始终等于序列长度 $$N$$，每个 token 对应一个隐藏神经元。上下文拉长时，这个临时 MLP 随之变宽，单个 query 的计算量线性增长，$$N$$ 个 query 合起来就落到了 $$\mathcal{O}(N^2)$$。

{% include figure.html src="/assets/images/mita-attention/01-fast-weight-scaling.png" alt="论文图 1。左侧将全注意力画成宽度随上下文长度 N 增长的两层快权重 MLP，激活函数为 exp；右上以 MoBA 为例展示按路由扩展，将 key-value 切成连续固定块并由路由器分配；右下以 Test-time Training 为例展示按压缩扩展，把全部 key-value 压缩进一个固定大小的快权重模块" caption="出自论文图 1：上下文变长时快权重 MLP 同步变宽，右侧对比按路由扩展（MoBA）与按压缩扩展（TTT）两条路线" %}

沿着这个视角，现有的高效注意力大致落在压缩和路由两条路线上，各自都有明显的取舍：

- 压缩路线（线性注意力、Linformer、Agent Attention、Test-time Training 等）把宽度为 $$N$$ 的快权重 MLP 压成一个固定容量的共享模块，每个 query 都能看到整段序列的概览，但压缩过程不可避免地会丢失细粒度信息。
- 路由路线让每个 query 只访问一部分原始 key-value，保留下来的条目本身没有信息损失，却容易缺失全局视野。其中按块路由（MoBA、NSA 等）沿着序列位置把 token 切成连续、等长、互不重叠的固定块，访存规则、对硬件友好，但分块位置僵硬，无法跟着语义内容变化；近期的 top-k 注意力（Gemma 3n 的 Spark Attention、DeepSeek-V3.2 的 DSA）改由每个 query 用低精度或部分维度先粗扫一遍全部 key，再各挑出最相关的 $$k$$ 对原始 key-value，虽然内容自适应，但 $$N$$ 个 query 会挑出 $$N$$ 组互不复用的私密集合，专家总数仍然等于序列长度 $$N$$。

下面的交互示意用 8 对 key-value 对比了标准注意力、只压缩、按块路由、top-k 注意力和 MiTA 五种做法下同一个 query 的访问范围：

{% include kv-demo.html id="mita-four-ways" caption="五种注意力机制在 8 对 key-value 上为 query q3 构造专家和分配上下文的对比（按论文图 1、图 7 分类绘制的示意数据）" %}

大多数方法只在压缩和路由里二选一，MiTA 则把两条路拼在了一起，同时把动态专家的总数从 $$N$$ 固定到一个远小于 $$N$$ 的常数 $$m$$：用少量 landmark query 同时完成两件事，一边把全序列压成一个共享专家以补上全局视野，一边按内容挑出 $$m$$ 组可被多个 query 复用的 top-k 专家。

## MiTA 怎样算完一层注意力

为了看清具体计算，下面用一个 4×4 的图像网格做例子：整张图共 $$N = 16$$ 个双向注意力 token（`t0` 到 `t15`，分别对应天空、鸟、树枝和叶子），取 $$m = 4$$ 个 landmark query、每个专家保留 $$k = 3$$ 对原始 key-value，每个 query 路由到 $$s = 1$$ 个专家。我们全程跟踪位于鸟身上的查询 `t9`，看它如何从访问全部 16 对原始 key-value 收窄到只看 7 对。

{% include figure.html src="/assets/images/mita-attention/02-mita-overview.png" alt="论文图 2。左上全注意力中一个 query 连向圆柱里全部 key-value；右上用少量 landmark query 对全部 key-value 做压缩得到摘要；右下由相同的 landmark query 各自挑出 top-k 原始 key-value 组成路由专家；左下 MiTA 将压缩摘要与路由得到的原始 key-value 拼接给 query 访问" caption="出自论文图 2：MiTA 用同一批 landmark query 同时构造压缩摘要（右上）与 top-k 路由专家（右下），再拼接供每个 query 访问（左下）" %}

一层 MiTA 注意力按顺序分五步完成：

1. 用平均池化提取 $$m$$ 个 landmark query。先把全部 $$N$$ 个 query 排回二维图像网格，均匀划成 $$m$$ 个窗口并对窗口内向量求平均，得到 landmark query 矩阵 $$\tilde{\boldsymbol{Q}} \in \mathbb{R}^{d \times m}$$。在 4×4 小图里，这相当于切出 4 个 2×2 窗口，各取均值得到 `q̃0` 到 `q̃3`。论文在 ImageNet-1K（DeiT-T，$$m = k = 25$$）上专门对 landmark 提取方式做了消融（论文表 6）：无参数的二维平均池化拿到 71.1% 的 top-1 准确率，高于随机采样（70.6%）、一维平均池化（70.4%），也明显超过引入可学习参数（66.3%）、普通卷积（67.0%）和 depth-wise 卷积（68.8%），只有需要多轮迭代合并的 Token Merging 略高 0.2 个百分点（71.3%）。作者在附录 A 推测，landmark query 既要充当压缩后的 key 又要担任路由器，额外引入可学习参数容易产生梯度冲突。

2. 每个 landmark query 在全序列里挑 top-k，组成 $$m$$ 个动态专家。拿第 $$i$$ 个 landmark query $$\tilde{\boldsymbol{q}}_i$$ 和全部 $$N$$ 个 key 做点积，取分数最高的 $$k$$ 个下标收集对应的原始键和值，构成第 $$i$$ 个快权重专家 $$\mathcal{E}_i$$：

   $$
   \mathcal{I}_i = \operatorname{Top}_k\!\left(\boldsymbol{K}^\top \tilde{\boldsymbol{q}}_i\right) \in \{1, \ldots, N\}^k, \qquad \boldsymbol{K}^{(i)} = \boldsymbol{K}_{:,\mathcal{I}_i},\ \boldsymbol{V}^{(i)} = \boldsymbol{V}_{:,\mathcal{I}_i} \in \mathbb{R}^{d \times k}
   $$

   挑 key 面向全部 $$N$$ 个位置，不受池化窗口束缚；由于各个 landmark 独立取 top-k，不同专家允许选中同一个 token，而没有被任何专家选中的背景位置在路由分支里就会被自然滤掉。

3. 复用同一组分数压缩出全局共享专家。对第 2 步算出的 landmark-key 相似度直接做 softmax，加权汇聚全部 $$N$$ 个 value，得到 $$m$$ 个全局摘要向量 $$\tilde{\boldsymbol{v}}_i = \operatorname{Atten}(\tilde{\boldsymbol{q}}_i, \boldsymbol{K}, \boldsymbol{V})$$。把 $$\tilde{\boldsymbol{Q}}$$ 当作键、$$\tilde{\boldsymbol{V}}$$ 当作值，就构成了所有 query 共同访问的共享专家 $$\tilde{\mathcal{E}}(\boldsymbol{q}) = \operatorname{Atten}(\boldsymbol{q}, \tilde{\boldsymbol{Q}}, \tilde{\boldsymbol{V}})$$。论文强调，压缩分支和路由分支的计算高度耦合：算 top-k 和算 $$\tilde{\boldsymbol{V}}$$ 共用 $$\boldsymbol{K}^\top \tilde{\boldsymbol{Q}}$$，下一步的路由打分和共享专家注意力也共用 $$\boldsymbol{Q}^\top \tilde{\boldsymbol{Q}}$$。

4. 为每个 query 路由专家并定义拼接注意力。计算所有 query 与 landmark query 的点积 $$\boldsymbol{Q}^\top \tilde{\boldsymbol{Q}} \in \mathbb{R}^{N \times m}$$，给每个 query 挑出得分最高的 $$s$$ 个专家（编号记为 $$e_1(\boldsymbol{q}), \ldots, e_s(\boldsymbol{q})$$），把共享专家的 $$m$$ 对摘要和路由专家的 $$ks$$ 对原始 key-value 拼接在一起做一次标准注意力：

   $$
   \operatorname{MiTA}(\boldsymbol{q}) = \boldsymbol{V}^\star \operatorname{softmax}\!\left({\boldsymbol{K}^\star}^\top \boldsymbol{q} / \sqrt{d}\right)
   $$

   $$
   \boldsymbol{K}^\star = \left[\tilde{\boldsymbol{Q}},\ \boldsymbol{K}^{(e_1(\boldsymbol{q}))},\ \ldots,\ \boldsymbol{K}^{(e_s(\boldsymbol{q}))}\right], \qquad \boldsymbol{V}^\star = \left[\tilde{\boldsymbol{V}},\ \boldsymbol{V}^{(e_1(\boldsymbol{q}))},\ \ldots,\ \boldsymbol{V}^{(e_s(\boldsymbol{q}))}\right]
   $$

   与普通 MoE 先在各专家内部独立计算再对输出加权求和不同，MiTA 让共享摘要和路由专家在同一个 softmax 分母下直接竞争权重。论文所有实验均固定 $$s = 1$$（论文脚注坦言这只是初步验证，尚未发挥多选组合出 $$\binom{m}{s}$$ 种稀疏模式的表达力，但 $$s > 1$$ 需改走 MoBA 式调度并付出速度代价），路由直接取最大值，不加负载均衡损失或专家容量上限。针对 $$s = 1$$ 是否会退化成封闭的硬聚类，作者在附录 B 测量了 12 层网络中每个专家收集的 key-value 与路由给它的 query 之间的位置重叠度（mIoU），峰值在第 2 层仅约 0.3，后四层接近 0，说明信息仍能跨区域流动，并未锁死在局部簇内。另外，挑 top-k 和选专家的下标本身不可微，反向传播的梯度经由被选中 key-value 的数值以及共享专家的交叉注意力回传。

5. 拆成两次 FlashAttention 计算，再用 online softmax 合并。实际执行时不需要把共享专家和路由专家真的拼进同一张张量：先对共享专家的 $$m$$ 对摘要跑一次常规 FlashAttention；再把所有 query 按路由到的专家编号重新排序归组，对 $$m$$ 个专家跑一次变长 FlashAttention（每段 query 长度是分到该专家的 query 数量，每段 key-value 长度固定为 $$k$$）；最后取出两侧记录的局部最大值与指数和，经 online softmax 换算到同一基准后加权合并，数学结果与拼在一起算一次完全相等。

下面的交互动画把上述五步串在 4×4 小图上，展示 `t9` 如何从 16 对原始 key-value 缩减到 4 对摘要加 3 对原始 key-value；紧接着第二组动画给出 `t9` 拆分计算并用 online softmax 合并的具体数值过程：

{% include attn-demo.html id="mita-recap" caption="4×4 小图上跟踪查询 t9 走完一层 MiTA 注意力，最终只访问 4 对全局摘要与专家 1 的 3 对原始 key-value" %}

{% include attn-demo.html id="mita-combine" caption="共享专家（4 对摘要）与路由专家 1（3 对原始 KV）分两次计算，再用 online softmax 精确还原拼接结果 4.80" %}

放到真实图像上，这种全局按内容挑选专家的机制会呈现出两个现象。其一，专家收集的 key-value 和被路由给它的 query 都会跳出红框所示的池化窗口，沿物体语义跨区域聚拢（论文图 3）；其二，随着网络加深，绝大多数背景 token 不再被任何专家选中，注意力逐渐收束到前景类别相关的区域，自发产生类似 token pruning 的效果（论文图 4）。

{% include figure.html src="/assets/images/mita-attention/03-expert-heatmap.jpg" alt="论文图 3，同一张鸟的照片展示 4 个专家。红框标出池化生成 landmark query 的局部窗口；上排热力图标出该专家收集的 key-value，下排标出路由给该专家的 query，两者均大量分布在红框之外的同类语义区域" caption="出自论文图 3：4 个专家各自收集的 key-value（上排）和路由给它的 query（下排）都会跨出红框所示的局部池化窗口" %}

{% include figure.html src="/assets/images/mita-attention/04-token-pruning.jpg" alt="论文图 4，三行分别是鸟、水边象群和白色小狗，每行最左为原图，向右依次展示各层被专家选中的 token 位置，未入选位置留白。越靠后的网络层留白越多，最后几层基本只保留主体目标区域" caption="出自论文图 4：越往深层走，背景 token 越少被专家选中，注意力逐渐集中在与类别相关的目标区域" %}

按理论复用全部中间点积来算，$$s = 1$$ 时单层单头的 query-key 打分次数为 $$N(m + k) + mN$$（每个 query 访问 $$m + k$$ 对，加上 $$m$$ 个 landmark 扫一遍 $$N$$ 个 key），随 $$N$$ 线性增长。对照不同分辨率下单层单头的打分次数，序列越长压缩幅度越明显：

| 场景设置 | 序列长度 $$N$$ | 标准注意力（$$N^2$$） | MiTA 理论打分次数 | 占比 |
| --- | ---: | ---: | ---: | ---: |
| 4×4 小图示例（$$m = 4, k = 3$$） | 16 | 256 | 176 | 69% |
| ImageNet 224×224（$$m = k = 25$$，含 class token） | 197 | 38,809 | 14,775 | 38% |
| ADE20K 512×512（$$m = k = 49$$，仅计 patch） | 1,024 | 1,048,576 | 150,528 | 14% |
| ADE20K 640×640（$$m = k = 49$$，仅计 patch） | 1,600 | 2,560,000 | 235,200 | 9% |

论文在 3.2 节也明确点出，MiTA 的主要硬件瓶颈不在点积计算量，而在第 2 步按索引收集 top-k 原始 key-value 的不规则随机访存，很容易把整条流水线拖成访存受限。不过相比普通 top-k 注意力需要为 $$N$$ 个 query 分别收集 $$N$$ 组专家，MiTA 只收集 $$m$$ 组可复用专家，访存压力小得多，代价是多出一步 $$N$$ 到 $$m$$ 的路由和重排。

## 官方实现与论文写法的几处差异

对照 2026 年 11 月 5 日版本的官方 PyTorch 仓库，有四处具体实现和论文正文里的理想写法并不完全一致，读代码或复现实验时值得留意：

1. 共享专家实际按 $$d$$ 缩放而非 $$\sqrt{d}$$。论文的拼接公式里，共享专家和路由专家共用同一个 $$1/\sqrt{d}$$ 缩放因子；但官方实现把 landmark key 送进共享专家的 FlashAttention 前先手动乘了一次 $$1/\sqrt{d}$$，内核内部又照常除以 $$\sqrt{d}$$，实际相当于除以 $$d$$。代码注释说明这样做是为了让共享专家上的注意力权重更平滑，这也意味着代码算出的数值和论文的拼接公式并不严格等价。
2. 中间打分没有跨分支复用。论文指出挑 top-k 和生成 landmark value 可共享 $$\boldsymbol{K}^\top \tilde{\boldsymbol{Q}}$$，路由分数也可复用于共享专家；官方实现里，挑 top-k 先单独算一遍点积并只留下标，生成压缩 value 时再调用一次完整的缩放点积注意力重新计算，路由阶段也单独再做了一次点积，因此实际执行的点积次数高于上表的理论值。
3. 池化窗口和特殊 token 的处理细节。官方实现在拆成多头之前就对整段 query 做二维自适应平均池化，所有注意力头共用同一套 landmark 网格。在 ImageNet（197 个 token）和 ADE20K（1,025 个 token）里，代码截掉序列最后一个 patch，把开头的 class token 放进网格第一格一起池化，且 14×14 网格自适应池化成 5×5 时各方向窗口宽度为 3、4、4、4、3 格、相邻窗口重叠一格，并非论文描述的等大互不重叠矩形。到了 ViT-5 版本，代码改为把 class token 和 4 个 register token 全部排除在池化之外（注释提到曾尝试直接拿 register token 当路由器但极易出现 NaN），而且把每个专家的宽度 $$k$$ 设成了 30（ImageNet 主实验为 25）。
4. 裁剪空专家但没有定制 gather 内核。如果某个专家在这一步一个 query 都没分到，官方实现会先把它从变长 FlashAttention 的分段列表里剔除，并把同 batch 所有样本、所有头的非空专家拼成一长串一次性送进变长内核；不过收集 top-k 原始 key-value 仍采用常规张量下标索引，没有像 DeepSeek Sparse Attention 那样编写专门的融合访存核。

## 论文实验结果

三组主实验全部采用 $$s = 1$$：ImageNet-1K 图像分类取 $$m = k = 25$$（每 query 访问 50 对），ADE20K 语义分割取 $$m = k = 49$$（98 对），Long Range Arena 文本与长序列基准取 $$m = k = 128$$（256 对，官方仓库目前未公开 LRA 代码）。

### ImageNet-1K 图像分类

许多高效注意力论文在 ImageNet 上会顺带加入 depth-wise 卷积等局部结构，掩盖注意力本身与全注意力的差距。作者先在 DeiT 训练配方下从头训练，严格只替换注意力层（论文表 2），再把 MiTA 接入结构更强的 ViT-5（论文表 3），主要结果汇总如下：

| 模型配置 | 参数量 | FLOPs | Top-1 准确率 (%) | 相对全注意力基线 |
| --- | ---: | ---: | ---: | ---: |
| DeiT-T（全注意力） | 5.7M | 1.2G | 72.2 | 基线 |
| Linear / PolaFormer / MHLA-DeiT-T | 5.7M | 1.1G / 1.2G / 1.1G | 68.0 / 68.1 / 69.2 | −4.2 / −4.1 / −3.0 |
| FLatten / BRA-DeiT-T | 6.1M / 5.7M | 1.1G | 70.2 / 70.2 | −2.0 / −2.0 |
| Agent-DeiT-T（无偏置 / 加 agent bias） | 5.7M / 6.0M | 1.1G / 1.2G | 70.3 / 71.1 | −1.9 / −1.1 |
| MiTA-DeiT-T（纯注意力 / 加 DWC） | 5.7M | 1.1G | 71.1 / 73.4 | −1.1 / +1.2 |
| DeiT-S（全注意力） | 22M | 4.6G | 79.9 | 基线 |
| Agent-DeiT-S（无偏置 / 加 agent bias） | 22M / 23M | 4.4G | 78.5 / 79.1 | −1.4 / −0.8 |
| MiTA-DeiT-S（纯注意力 / 加 DWC / 加 DWC+Gate） | 22M | 4.4G / 4.4G / 4.7G | 79.8 / 80.6 / 81.2 | −0.1 / +0.7 / +1.3 |
| ViT-5-S（全注意力） | 22M | 4.7G | 82.2 | 基线 |
| MiTA-ViT-5-S（纯注意力 / 加 DWC） | 22M | 4.5G | 81.3 / 81.7 | −0.9 / −0.5 |

在不加任何额外模块的前提下，MiTA-DeiT-T 拿到 71.1%，领先其余不加组件的高效注意力 0.8 到 3.1 个百分点；可视作 MiTA 只路由特例的 BRA（70.2%）与只压缩特例的 Agent Attention（70.3%）均落后近一个百分点，论文表 6 的内部消融也得到一致趋势（只压缩 70.3%，只路由 70.8%，两者结合 71.1%）。Agent Attention 加上额外可学习偏置矩阵后在 DeiT-T 上虽能追平到 71.1%，但在 DeiT-S 上仍落后 MiTA 0.7 个百分点（79.1% 对 79.8%），且这种加性注意力偏置目前不被 FlashAttention 支持。模型放大到 DeiT-S 后，纯 MiTA 已经把与全注意力的差距缩到 0.1 个百分点；如果像其他工作那样在注意力输出端并联一条 3×3 depth-wise 卷积旁路（官方代码是在除 class token 外的 value 网格上做卷积后加回输出，与 landmark 池化无关），DeiT-T 和 DeiT-S 的准确率均反超全注意力基线。在更强的 ViT-5-S 上，MiTA-ViT-5-S（加 DWC）达到 81.7%，比全注意力 ViT-5-S 低 0.5 个百分点，FLOPs 从 4.7G 降至 4.5G。

### ADE20K 语义分割

这组实验把在 ImageNet-21K（384×384，patch 16）上用全注意力预训练好的 ViT 骨干直接替换成 MiTA，再接 CBT 分割头在 ADE20K 上训练。每个 query 访问 98 对 key-value，远低于 512×512 时的 1,024 对和 640×640 时的 1,600 对，四档模型规模的 FLOPs 与 mIoU 对比如下：

{% include bar-demo.html id="mita-ade-flops" caption="ADE20K 上将预训练 ViT 骨干直接替换为 MiTA 后的计算量与 mIoU 变化（数据取自论文表 4）" %}

四档模型总计算量下降 14% 到 42%，同时 mIoU 下降 1.2 到 2.8 个百分点。论文指出，由于骨干并非原生用 MiTA 预训练，直接替换并微调尚未完全发挥 MiTA 的精度上限。

### LRA 与长序列推理吞吐

序列拉长到 1K～4K 的 LRA 基准上，所有方法沿用同一套超参，由作者在单张 24 GB 的 RTX 4090 上与 PyTorch 内置 FlashAttention 对比准确率与端到端训练时间（论文表 5，每格为“准确率 / 训练吞吐 steps/s”，末列为“五项平均准确率 / 总训练小时数”，带 `‡` 表示去掉压缩分支并增大 $$k$$ 保持单 query 访问条数不变的纯路由变体）：

| 方法 | ListOps (2K) | Text (4K) | Retrieval (4K) | Image (1K) | Pathfinder (1K) | 平均准确率 / 总耗时 (h) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Standard Attention | 37.35 / 12.7 | 63.63 / 3.8 | 79.90 / 1.9 | 40.38 / 5.7 | 69.68 / 5.7 | 58.19 / 10.6 |
| Reformer | 18.55 / 34.1 | 65.08 / 16.8 | 78.77 / 8.5 | 44.04 / 8.3 | 69.04 / 8.5 | 55.10 / 4.5 |
| Linformer | 38.05 / 35.0 | 56.69 / 24.6 | 78.41 / 13.7 | 39.56 / 11.9 | 67.13 / 11.9 | 55.97 / 3.1 |
| Performer | 17.84 / 28.0 | 65.13 / 16.5 | 77.18 / 8.9 | 36.64 / 8.1 | 70.20 / 8.0 | 53.40 / 4.7 |
| Nyströmformer | 29.69 / 22.0 | 65.84 / 16.7 | 79.68 / 8.8 | 36.83 / 4.5 | 72.50 / 4.5 | 56.91 / 7.3 |
| Agent Attention | 36.59 / 40.1 | 63.86 / 38.9 | 79.98 / 24.3 | 38.92 / 19.5 | 71.77 / 19.1 | 58.22 / 1.9 |
| MoBA‡（纯路由） | 37.10 / 30.4 | 62.35 / 15.8 | 76.64 / 8.2 | 37.92 / 8.6 | 69.67 / 8.4 | 56.74 / 4.6 |
| MiTA‡（纯路由） | 37.20 / 25.4 | 64.09 / 22.2 | 79.92 / 13.1 | 40.17 / 5.3 | 72.66 / 6.3 | 58.81 / 5.5 |
| MiTA（完整） | 37.20 / 52.5 (×4.1) | 63.47 / 37.7 (×9.9) | 79.88 / 19.6 (×10.3) | 40.72 / 13.6 (×2.4) | 73.26 / 15.3 (×2.7) | 58.91 / 2.4 (↓77%) |

完整 MiTA 的五项平均准确率为 58.91%，略高于标准 FlashAttention 的 58.19%，总训练耗时从 10.6 小时压到 2.4 小时（减少 77%），在 Retrieval 和 Text 两个 4K 任务上吞吐分别快了 10.3 倍和 9.9 倍。更有意思的是对比纯路由变体 `MiTA‡`：去掉共享压缩分支、把配额全加给路由专家宽度 $$k$$ 后，平均准确率几乎不变（58.81%），耗时却从 2.4 小时暴涨到 5.5 小时，原因正是更大的 $$k$$ 直接放大了不规则 gather 的访存开销。也就是说，共享压缩分支不仅补足全局视野，也是控制 gather 成本的关键。

作者还在同一张 RTX 4090 上用 3 层、隐藏维度 128 的 Transformer 测了 1K 到 1024K 序列长度下的推理吞吐（每组把 batch size 调到最大，MiTA 保持 $$m \times k \approx N/4$$）。1K 长度下 FlashAttention 仍略占优势，从 4K 起 MiTA 反超，到 16K、64K、256K 和 1024K 时吞吐分别达到标准注意力的 4.7 倍、19 倍、56 倍和 159 倍。

{% include figure.html src="/assets/images/mita-attention/05-inference-throughput.png" alt="论文图 5，对数坐标折线图，横轴序列长度 1K 到 1024K，纵轴每秒样本数。1K 时标准注意力橙线略高于 MiTA 蓝线，4K 起蓝线反超，箭头标出 16K 处 ×4.7、64K 处 ×19、256K 处 ×56、1024K 处 ×159" caption="出自论文图 5：3 层 128 维 Transformer 在单张 RTX 4090 上的推理吞吐对比（m × k ≈ N/4）" %}

## 超参选择与泛化特性

MiTA 的两个主要超参是专家个数 $$m$$ 和单个专家的宽度 $$k$$。在 CIFAR-100（论文图 6）和 ImageNet-1K（论文表 6）的扫描里，增大 $$m$$ 或 $$k$$ 都会让 MiTA 更逼近全注意力，但精度对 $$k$$ 明显比对 $$m$$ 更敏感：把 $$m$$ 和 $$k$$ 对调时，$$k$$ 更大的配置几乎总是胜出（ImageNet 上 16×25 为 71.0% 对 25×16 的 70.5%，25×36 为 71.7% 对 36×25 的 71.2%；CIFAR-100 上 16×25 为 74.6% 对 25×16 的 74.0%）。这印证了论文的出发点：给每个 query 单独维护私有 top-k 存在大量冗余，少建几个专家、把每个专家做宽并让多个 query 复用更划算。作者给出的调参经验是先选定 $$mk/N$$ 的比例，从 $$m = k$$ 起步，再往 $$k > m$$ 的方向尝试。

{% include figure.html src="/assets/images/mita-attention/06-cifar-mk.png" alt="论文图 6，CIFAR-100 上不同专家数 m（1 到 25）与单专家宽度 k（1 到 49）的准确率热力图，从左下 m=1,k=1 的 66.3% 升至右上 m=25,k=49 的 75.4%，同等乘积下 k 大于 m 的组合准确率更高" caption="出自论文图 6：CIFAR-100 上不同 (m, k) 组合的准确率分布（更大组合因显存不足未测）" %}

因为平均池化和 top-k 选择都不引入新的可学习权重，训练好的 MiTA 模型在推理时可以直接改大或改小 $$m$$ 和 $$k$$。论文图 10 在 ImageNet-1K 上用 $$m = k = 25$$ 训练好 MiTA-ViT-T（512 分辨率，77.1%）和 MiTA-ViT-L（224 分辨率，85.4%）后，不重新训练直接遍历 1 到 100 的推理组合：调大 $$m$$ 或 $$k$$ 时，两个模型分别有 14 格和 37 格超过训练基线（最高达到 77.7% 和 85.7%）；反之若把任意一个压得太小，精度会迅速塌陷（例如 ViT-T 在 $$m = 25, k = 1$$ 时掉到 40.1%）。因此实践里可以用较小的 $$(m, k)$$ 降低训练开销，推理时按延迟预算再调大。

{% include figure.html src="/assets/images/mita-attention/07-mk-generalization.png" alt="论文图 10，两张 10×10 热力图，横轴 k、纵轴 m 均从 1 到 100。左图 MiTA-ViT-T@512 训练红框在 m=k=25（77.1%），右图 MiTA-ViT-L@224 训练红框在 m=k=25（85.4%）；橙框圈出超过基线的组合，蓝框圈出保持 99% 基线精度的组合" caption="出自论文图 10：以 m = k = 25 训练后，推理期免训练调整 (m, k) 在 ImageNet-1K 上的准确率变化（左 ViT-T@512，右 ViT-L@224）" %}

最后，论文在附录 C 还测试了标准注意力、Agent Attention 和 MiTA 之间的直接互换（论文图 9）与微调迁移（论文表 7）。拿 ImageNet-21K 全注意力预训练的 ViT 换成不同注意力并在 ImageNet-1K 上微调 50 个 epoch 后，MiTA 在 Tiny、Small、Base、Large 四个尺寸上分别拿到 75.6%、80.9%、82.8% 和 85.5%，仅落后全注意力 0.3 到 1.6 个百分点，而 Agent Attention 即便把 agent token 从 49 加到 64，在四个尺寸上仍分别落后 2.2、1.3、2.9 和 2.1 个百分点。

{% include figure.html src="/assets/images/mita-attention/08-attention-swap.png" alt="论文图 9，DeiT-T（左）与 DeiT-S（右）在标准注意力、Agent Attention 和 MiTA 间两两替换推理的 3×3 热力图。DeiT-T 对角线为 72.1、70.3、71.1，Standard 行 MiTA 列为 66.6，MiTA 行 Standard 列为 58.7；DeiT-S 对角线为 80.0、78.5、79.8，Standard 行 MiTA 列为 76.7，MiTA 行 Standard 列为 71.3" caption="出自论文图 9：训练与推理采用不同注意力机制的零样本互换结果（左 DeiT-T，右 DeiT-S）" %}

看论文图 9 时有一处细节值得核对。原图图注写明横轴是训练注意力、纵轴是推理注意力，按这个读法，“标准注意力训练、MiTA 推理”对应第一列第三行（DeiT-T 58.7%、DeiT-S 71.3%，约保持原精度的 81% 和 89%），反过来第三列第一行才是 66.6% 和 76.7%（约 94% 和 96%）；但正文却写“标准注意力训练、MiTA 推理保留了超过 95% 的原始性能”。究竟是图注把横纵轴标反了还是正文把方向写反了，原文没有更多信息，只能保留这个疑点。

## 适用范围与尚未解决的问题

作者在附录 D 明确交代了这篇论文的适用范围：

> This work primarily focuses on the vision domain, and we do not evaluate the proposed method in the decoding phase of LLMs. This choice is mainly due to our limited computational resources. [...] The main contribution of this paper is conceptual, namely a unified perspective that facilitates principled improvements, rather than a domain-specific instantiation.（附录 D）

放到大语言模型推理的语境下看，把 MiTA 搬去自回归生成至少还有两道坎没有跨过去。第一，论文和官方代码全程面向双向注意力，平均池化与 top-k 筛选都一次性作用在整段已知序列上，没有任何因果遮挡逻辑；要做自回归 prefill，池化窗口和专家收集都必须防止未来 token 泄露给更早的 landmark 或专家。第二，在逐 token 解码阶段，query 每次只来一个而历史 KV 持续增长，每一步如何增量维护或刷新 landmark query、全局摘要以及 top-k 专家集合，同时避免反复重算和破坏 KV cache 布局，论文目前还没有给出方案。

下表把本文涉及的五种注意力机制按专家形态和访问开销做一汇总：

| 方法 | 策略 | 专家个数 | 专家形状 | 全局视野 | 单 query 访问 KV 对数 |
| --- | --- | --- | --- | --- | --- |
| 标准注意力 | 全访问 | 1 | 全部序列 | 有 | $$N$$ |
| 线性 / Agent / TTT 等 | 压缩 | 1（或少量压缩模块） | 压缩表示 | 有（有损） | 常数或 $$m$$ |
| MoBA 等 | 按块路由 | $$N / n$$ | 按位置切固定块 | 无 | 若干块 |
| Spark / DSA | top-k 路由 | $$N$$（每 query 私有） | 按内容动态挑选 | 无 | $$k$$（另加粗扫全键） |
| MiTA | 压缩 + 路由 | $$m$$（路由）+ 1（共享） | 按内容动态挑选并复用 | 有 | $$m + ks$$ |

## 参考资料

- Qishuai Wen, Zhiyuan Huang, Xianghan Meng, Wei He, Chun-Guang Li，[Mixture-of-Top-k Attention: Efficient Attention via Scalable Fast Weights](https://arxiv.org/abs/2602.01219)，arXiv 2602.01219v6（2026 年 9 月 27 日更新）：本文公式、数据与 8 张原论文配图均出自这一版本，图片按 arXiv 页面的 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可使用。
- [MiTA 官方 PyTorch 仓库](https://github.com/QishuaiWen/MiTA)：2026 年 11 月 5 日版本，用于对照核对共享专家缩放、打分复用、池化窗口及 ViT-5 与 ADE20K 的具体实现行为。
- Enzhe Lu 等，[MoBA: Mixture of Block Attention for Long-Context LLMs](https://arxiv.org/abs/2502.13189)：按固定块路由的稀疏注意力及变长 FlashAttention 合并思路。
- DeepSeek-AI，[DeepSeek-V3.2](https://arxiv.org/abs/2512.02556)：采用低精度粗扫筛选 top-k 的 DeepSeek Sparse Attention（DSA）。
- Dongchen Han 等，[Agent Attention: On the Integration of Softmax and Linear Attention](https://arxiv.org/abs/2312.08874)：用少量 agent token 做压缩共享注意力的先驱工作。
- Maxim Milakov、Natalia Gimelshein，[Online normalizer calculation for softmax](https://arxiv.org/abs/1805.02867)：拆分计算两侧注意力后精确合并所依赖的 online softmax 算法。
