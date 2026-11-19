---
title: "权重空间编程：大模型怎样不靠梯度直接读写神经网络权重"
description: "读 MIT CSAIL 的 Weight-Space Programming 实验：GPT-6 Astra 不跑反向传播，怎样从原始权重认出游戏和复制头、从零手写游戏策略网络，又怎样通过减去第 15、19 层 MLP 64 列里的重复方向把 Qwen3.5-0.8B 的 MATH-500 从 7.9% 提到 48.1%，以及这套做法在哪两处失效。"
date: 2026-11-19 10:00:00 +0800
tags: [大模型, 可解释性, 权重编辑]
math: true
---

MIT CSAIL 的 Rikiya Takehi、Jayden Teoh、Alex Zhang 和 Omar Khattab 在 2026 年 11 月 2 日发布了一篇研究博客（11 月 12 日补充了答疑），题目是权重空间编程（Weight-Space Programming）。他们把神经网络的原始权重直接交给通用大模型，不提供梯度，也不允许写训练循环，看它能不能读懂网络在做什么、通过修改权重修复故障，或者从全零权重开始写出一个能用的网络。

文中的实验设置、数字和图表都来自这篇原博客、作者公开的完整实验日志以及 Hugging Face 上的复现记录，不是我的实测。按公开日志的说明，负责读写权重的模型是 OpenAI 的 GPT-6 Astra，通过 Codex 命令行按轮调用，调用时关闭了全部内置工具（包括终端、文件编辑、联网搜索和子智能体），推理强度在实验 1、2、4 设为 high，实验 3、5、6、7 设为 xhigh，实验 8 设为 max。允许写代码的实验（实验 3、6、7、8）里，模型每轮只输出一段 Python 代码，交由无网络、无 GPU 的外部沙箱执行，再把标准输出返回给下一轮。全部 1,125 轮对话都经过事件流审计，确认没有触发任何内置工具。

## 什么是权重空间编程

原博客开头先说明了这个词的意思：

> Weight-Space Programming is a concept that treats a network’s weights like a program written in a programming language: we read them to understand what the network computes, and write or edit them directly to change what it computes, instead of leaving them entirely to an optimizer. In this blog, the programmer is a general-purpose LLM, working from a natural-language spec without gradients, sometimes with no environment feedback at all.（Weight-Space Programming 节）

这里既不训练专门读权重的辅助网络，也不用梯度下降或进化搜索，直接让现成的通用大模型读懂权重，再决定修改哪一层、哪几列的参数。

全篇 8 个主实验和 1 个补充实验大致分成两类。前 5 个实验里的网络较小（大多在 1.7 万到 17.2 万个权重之间，实验 3 是 716 万），除实验 3 外，全部权重都直接作为纯文本放进提示词，不提供工具，也不运行前向传播。后 4 个实验面对 148 万到 8 亿参数的网络，上下文窗口装不下，因此提供了只有 CPU 的 Python 沙箱和有限次数的黑盒前向调用预算。

## 从纯文本权重猜模型行为

### 实验 1：认出策略网络玩的是哪款游戏

作者先在自制的 10×10 网格上用 PPO 各训练 10 亿步（每款游戏取 3 个随机种子里最好的一个），得到玩 Breakout（打砖块）、Pong、Pac-Man（吃豆人）和 Freeway（过马路）的四个策略网络。四个网络的结构完全一样，都是 `500 → 32 → 32 → 5` 的多层感知机，激活函数用 `tanh`，共 17,253 个权重；输入都是 10×10 网格的 5 个通道（智能体、移动物体、奖励目标、障碍物、上一帧），输出都是 5 个动作的打分（不动、上、下、左、右）。因此只看网络结构和输入输出说明，无法分辨它们分别对应哪款游戏。

把这 17,253 个浮点数原样放进提示词，只告诉 Astra 网格和动作的含义，不给候选游戏名单，也不给任何工具：

> Without revealing the options of the games we consider, Astra was still able to name the right game for all four networks.（Experiment 1）

> It seems that Astra was able to work out what game each network was built to play, just from features of its weights. For example, where each input channel’s first-layer weights concentrate (e.g., for Breakout, the agent’s weights lie along the bottom row, a paddle), and which actions the output layer tells apart.（Experiment 1）

对照公开日志里的推理摘要，Astra 主要看两件事：第一层各输入通道的大权重落在网格的哪几行哪几列，以及最后一层把哪几个动作拉开了差距。

1. Breakout：智能体通道的大权重集中在底部的第 8 行（例如坐标 `(8, 1)` 连向两个隐藏单元的权重分别是 `4.066` 和 `−4.013`），奖励目标通道集中在顶部的第 1～3 行，输出层主要区分左右移动而不太区分上下和不动。Astra 据此判断这是底部有横移挡板、顶部有砖块的 Breakout（置信度 99%）。
2. Pong：智能体通道的大权重集中在最左边的第 1 列，输出层重点区分上和下，不动、左、右三列的系数很接近。这符合左侧竖直球拍拦截来球的特征，Astra 给出的答案是 Pong（置信度 96%）。
3. Pac-Man：智能体通道的大权重在 10×10 网格上排成左右对称的走廊，中间几块权重极小的地方对应墙体，移动物体通道遍布走廊，上下左右四个动作在输出层也都有明显区分，Astra 认出这是 Pac-Man（置信度 96%）。
4. Freeway：第 2～8 行每隔 4 列就出现重复的大权重，像成排的横向车流，第 8 行则是安全起点，输出层偏置明显偏向“向上”（`[−0.029, 3.142, −1.862, 0.173, −1.269]`）。Astra 答的是同玩法的过马路游戏 Frogger（置信度 97%），原博客计为答对。

### 实验 2：认出扩散模型会画出什么形状

作者在 12×12 灰度图上用 Adam（batch size 512，40,000 步）分别训练了三个 DDPM，各自生成实心圆、实心正方形、实心三角形。三个网络结构相同，都是 `160 → 64 → 64 → 144` 的 ReLU 多层感知机，共 23,824 个权重，输入 144 个带噪像素和 16 个步数特征，直接预测 144 个干净像素。实验同样只提供纯文本权重，不给工具，也禁止计算前向传播：

> Astra was able to tell what each model generates, from the weights alone. It finds the shape in the output layer, where each hidden unit’s weights draw one piece of the shape’s edge, and it draws just those edges. Interestingly, it draws every shape as an outline, ignoring that the actual models generate filled shapes. This mistake kind of shows it does not rely on calculating the forward pass, but rather it actually reads the structure/geometry of the weights.（Experiment 2）

{% include figure.html src="/assets/images/weight-space-programming/01-ddpm-circle.png" alt="原博客实验 2 圆形标签页截图。左侧展示模型实际生成的 6 张 12×12 白底实心圆；右侧展示发给 Astra 的 23,824 个纯文本权重，Astra 回答黑底上的白色单像素空心圆环、内部为黑色，置信度 84%，右下角画出它从输出层权重拼出的绿色空心圆环" caption="出自原博客实验 2：实际 DDPM 生成的是实心圆（左），Astra 从输出层各隐藏单元的边缘弧段拼出了空心圆轮廓（右下）" %}

三个形状都认对了，但三个都画成了空心轮廓，而模型实际生成的是实心图形。从公开日志可以看到，输出层里各个隐藏单元的权重呈局部窄条带、旁边配有负权重或弱权重，不像整片均匀为正的实心区域，Astra 把这些边缘片段拼在一起，就判断成了空心轮廓。作者认为，这个错误反而说明它没有算前向传播，是在直接读权重里的几何结构。

## 只看中间四层 Transformer

前两个实验只看第一层或最后一层就够了，实验 3 改看语言模型的中间层。作者训练了三个字符级 Transformer：4 层、每层 6 个注意力头、隐藏维度 384，共 716 万个权重，词表只有 28 个字符（`a` 到 `z`、空格和换行），分别在 10 亿个字符的 Python 代码、罗马字拼写的日文文学（青空文库）和英文维基百科上训练预测下一个字符。

随后作者把输入词嵌入层和输出层整个删掉，只把中间 4 个 Transformer 块的权重交给 Astra。没有头尾两层，384 个维度上没有任何字符标签，也没法喂进文本运行。这次允许 Astra 在无网络 Python 沙箱里最多跑 100 次代码分析矩阵，但严禁对任何真实、随机或编造的输入运行网络或其中单层（日志逐轮核查过）。作者问了两个问题：这个网络是用哪种语料训练的，以及它的 24 个注意力头各自起什么作用。

> Astra names the right language for all three networks, in both of its attempts. It also finds every copying head (induction head), the heads that let a model repeat text it has seen earlier, and names no other head as one.（Experiment 3）

原博客给出的对照表照录如下（头编号记为 `层号.头号`，从 0 开始）：

| 训练语料 | Astra 两次尝试的回答（与置信度） | Astra 指出的复制头 | 实测真值复制头 |
| --- | --- | --- | --- |
| Python | Python (0.56), Python (0.52) | 2.1, 3.1, 3.5 | 2.1, 3.1, 3.5 |
| Romaji | romaji (0.55), romaji (0.62) | 3.3 | 3.3 |
| English | English (0.58), English (0.48) | 3.1 | 3.1 |

表里的“实测真值”是作者事后把随机字符串重复两遍喂给完整模型测出来的：真复制头得分在 0.22 到 0.55 之间，其余头最高只有 0.02，Astra 全程看不到这份测试。

{% include figure.html src="/assets/images/weight-space-programming/02-copying-heads.png" alt="原博客图 1。展示 Python、Romaji、English 三个模型的 4×6 注意力头网格，行是第 0 到 3 层，列是第 0 到 5 号头，橙色格为复制头。每个模型左侧是 Astra 只读权重标出的结果，右侧是实际运行模型测出的结果，三组全部逐格一致：Python 为 2.1、3.1、3.5，Romaji 为 3.3，English 为 3.1" caption="出自原博客图 1：三个模型里 Astra 纯从权重读出的复制头位置与运行实测完全一致" %}

原博客记下了它不跑前向找复制头的做法：

> Without running anything, it found a first-layer head that looks one character back and then, by multiplying weight matrices, the later heads that search using what that head brings along (Figure 1). We find that this is actually a method presented by Elhage et al. [10], which we never mentioned to Astra. Code repeats names far more than prose, so many copying heads pointed to Python.（Experiment 3）

> Romaji stood out instead because the last of the four blocks it was given (not the output layer, which was removed) writes in fewer distinct directions, as if the model had fewer letters to tell apart. Indeed, romaji never uses some letters like q, l, v and x.（Experiment 3）

这套矩阵连乘就是 Elhage 等人提出的方法，提示词里并没有提过：先在第 0 层找出回看前一个位置的头，再拿它写回残差流的 OV 矩阵（$$W_O W_V$$），和后面各层算注意力匹配的 QK 矩阵（$$W_Q^\top W_K$$）相乘，看哪个头专门匹配第 0 层搬过来的前序字符。拿这些特征去判断语种时，代码里变量名经常重复，复制头多的模型更像 Python；第四个块写出的独立方向明显偏少，更像不用 q、l、v、x 等字母的日语罗马字。由于这些都只是间接线索，表里 Astra 两次猜语种给出的置信度都不高，在 0.48 到 0.62 之间。

## 改写和从零手写游戏权重

### 实验 4：一次回复修好卡在斜坡上的小车

在 Kinetix 物理控制环境的斜坡关卡里，小车必须先往右倒退一段攒够助跑距离，再全力往左冲上斜坡、跳过红色禁区去碰蓝色目标块。官方 actor 网络结构是 `679 → 128 (ReLU) → 5 层 128 (tanh) → 16`，共 171,664 个权重，输入 679 个描述刚体位置、速度、形状与关节的数，输出 16 个电机与推进器动作。PPO 跑完 10 亿步后掉进了局部最优：小车一上来就直接往左顶上斜坡，失去动量后卡在坡上，256 局测试一次都没过去。

作者把全部 171,664 个权重、场景说明和 1 条失败轨迹放进提示词，不给任何工具，要求在一次回复里说明失败原因并直接给出修改后的权重：

> In a single try with no tools, Astra’s edit makes the car succeed in all 1,024 episodes, changing 3.5% of the weights.（Experiment 4）

> Astra’s reasoning shows how: it adds a small separate path through a few units per layer that reads the car’s position and speed, and once the green wheel is past the red strip, the path switches off and the trained network drives the rest.（Experiment 4）

{% include figure.html src="/assets/images/weight-space-programming/03-carjump-scene.svg" alt="原博客实验 4 动画图。灰色半透明小车直接向左开上斜坡后卡在坡面；实色小车先向右倒退到右侧墙边，再向左全力加速冲上斜坡，腾空越过红色条带落到左侧蓝色方块上" caption="出自原博客实验 4：半透明小车是卡在斜坡上的原 PPO 策略；实色小车是 Astra 改动 3.5% 权重后的轨迹" %}

对照公开日志，Astra 先从输入层看出原网络主要依赖水平速度控制油门，几乎不选择倒车动作。于是它在每一层挑出少数几个单元另建了一条控制通路：小车静止时先向右倒车，等车体横坐标退到约 `3.8` 后切换为全力向左加速冲坡；等绿色车轮中心越过横坐标 `0.95` 的红色条带，这条通路就关闭归零，把后续落地控制交回原本训练好的网络。修改后在 1,024 局测试里全部过关。

### 实验 5：零样本从全零开始手写三款 MinAtar 游戏网络

实验 5 选了 MinAtar 的三款 10×10 网格游戏：Breakout、Seaquest 和 Asterix。网络结构固定为 `600 → 32 → 32 → 6`（`tanh`），初始权重全为 0。作者只给 Astra 游戏规则、环境源码，以及输入 6 个通道和输出 6 个动作的排布说明，不提供训练数据、损失函数、梯度和任何工具，也不允许在环境里试玩，要求它在一次文本回复里写出全部权重。评测在 1,000 局游戏（含 0.1 粘滞动作概率，每局最多 10,000 步）上运行，与训练了 1 亿步和 5 亿步的 PPO（取 3 到 10 个随机种子里的最好成绩）对比：

> Astra’s generated networks beat PPO trained for 100 million steps in all three games. Against PPO trained for 500 million steps, they score 20 times as much in Breakout, come close in Asterix, and reach 60% of its score in Seaquest.（Experiment 5）

原博客得分表照录如下：

| 游戏 | PPO（1 亿步） | PPO（5 亿步） | Astra（零样本一次写出） |
| --- | ---: | ---: | ---: |
| Breakout | 15.8 | 25.3 | 517.4 |
| Seaquest | 5.6 | 88.9 | 53.1 |
| Asterix | 25.8 | 55.2 | 53.2 |

> How does it do it: Astra reasons about the desired programs it wants each network to implement and converts them into neural form. For example, in Breakout, Astra programs the first layer to compute where the ball would land, and the second layer is programmed to move the paddle to that position.（Experiment 5）

公开日志里它写出的权重是稀疏的整数或简单分数，直接对应手写的控制规则。比如在 Breakout 里，第一层前 4 个隐藏单元结合当前帧球的位置和上一帧残影，分别算出球往右下、左下、右上、左上运动（含左右墙壁反弹）时的预计落点横坐标，再减去当前挡板横坐标；第 5 个单元判断球在下降还是上升；第二层据此决定往左、往右还是原地不动。在 Asterix 里，它让智能体固定守在第 5 列，第一层用残影抵消已经飞过去的敌人和宝物，第二层给迎面撞来的敌人加上 `−80` 的安全惩罚、给对齐的宝物加上正向吸引权重。

### 实验 6：借助 Python 沙箱和前向预算写 148 万参数的 9×9 围棋网络

百万级参数的网络已经放不进上下文窗口，实验 6 要求从全零权重开始写一个 9×9 围棋策略网络，结构固定为 `243 → 512 × 6 → 82`（ReLU），共 1,480,274 个权重：输入双方棋子位置和轮谁落子，输出 81 个交叉点加 1 个虚手的打分（屏蔽非法落子后按概率采样）。这次给 Astra 提供了一个无网络、无围棋库的 CPU Python 沙箱用来读写张量，并设置 0、10、25、50 次四档前向预算，每消耗 1 次前向可以让当前网络与练习对手下最多 128 盘棋，或查看最多 256 个盘面的输出，但严禁训练拟合数据或做树搜索。最终网络与两个未见过的小型 PPO（`243 → 32 → 32 → 82`，跑过 2,000 万盘）各对弈 2,000 盘（黑白各半），0 次和 50 次两档还额外与参数量相同、同样跑过 2,000 万盘的 `512 × 6` PPO 对战：

> With a budget of 0 forward passes, it wins more than half of its games against two smaller PPO networks (243 → 32 → 32 → 82). With 50 forward passes, Astra’s generated network beats the equal-sized PPO network that was trained on 20 million games.（Experiment 6）

> Astra writes the network as a small Go program, layer by layer, in Python. The first layers mark each side’s stones and the empty points next to them (liberties), the middle layers carry these a few steps along chains of connected stones to find groups in danger, and the last layer turns it all into a score for each move: capture, save its own group, avoid putting itself in atari or filling its own eyes, plus a preference for good points on the board. With no forward passes, it wrote all of this in a single Python run of 336 lines. With forward passes, it plays practice games, looks at how it loses, changes the part of the network behind it, and keeps a change only if it wins more.（Experiment 6）

{% include figure.html src="/assets/images/weight-space-programming/04-go-winrate.png" alt="原博客实验 6 图表。左图横轴是允许使用的前向次数（one shot、10、25、50），纵轴是对战胜率：对两个小型 PPO（绿线）从一次写出的约 54%～55% 一路升到 50 次前向时的 84.0% 和 80.8%；对同尺寸 512×6 PPO（橙色虚线）从一次写出的约 35% 升到 50 次前向时的约 74%" caption="出自原博客实验 6：不同前向预算下，Astra 手写的 148 万参数围棋网络对小型 PPO（绿）与同尺寸 PPO（橙）的胜率" %}

按原博客图表数据文件里的精确数字，四档预算的对战胜率如下：

| 前向预算 | 沙箱运行次数 | 对小型 PPO（种子 0）胜率 | 对小型 PPO（种子 2）胜率 | 对同尺寸 PPO（3 个种子）胜率 |
| ---: | ---: | ---: | ---: | --- |
| 0 次（一次写出） | 1 | 54.1% | 54.9% | 42.6% / 26.3% / 36.3% |
| 10 次 | 17 | 72.9% | 60.0% | 未测 |
| 25 次 | 30 | 76.0% | 62.3% | 未测 |
| 50 次 | 39 | 84.0% | 80.8% | 74.2% / 70.0% / 78.5% |

在 0 次前向预算下，Astra 只运行了一段 336 行的 Python 脚本就生成了全部权重：前几层负责标出棋子和气，中间几层沿连通棋串把气的信息往外传几步以找出陷入叫吃的棋块，最后一层结合提子、救孤棋、避免自撞叫吃和不填真眼给每个落点打分。光靠这套手工编码进 6 层 512 宽 ReLU 网络的规则，对小型 PPO 的胜率就已经过半；给够 50 次练习对局反馈后，它按输棋盘面逐项修补网络里的对应部分，对同尺寸 PPO 的胜率也升到了七成以上。

## 在 Qwen3.5-0.8B 上修推理死循环

实验 8 把目标换成了开源语言模型 Qwen3.5-0.8B（文本部分，约 8 亿参数），要求直接改权重提高它的数学成绩。提示词和日志仓库写明的模型结构与约束如下：

- 模型结构：共 24 层，隐藏维度 1,024。其中第 3、7、11、15、19、23 共 6 层是全注意力层（8 个查询头、2 个键值头，头维 256，带门控输出），其余 18 层是 Gated DeltaNet 线性注意力层（16 个头，头维 128）。每层配一个中间维度 3,584 的 SwiGLU MLP，词表大小 248,320，输入嵌入和输出层共享权重。
- 固定评测协议：全程开启思考模式，采样参数固定为温度 `0.6`、`top-p 0.95`、`top-k 20`、存在惩罚 `1.5`，思考加回答最多生成 `32,768` 个新 token，取最后一个 `\boxed{}` 里的答案判分。Qwen3.5-0.8B 的官方模型卡本身注明，这个尺寸的模型开启思考模式时容易陷入重复死循环。
- 环境与禁令：提供无 GPU、无互联网的持久化 Python 会话（最多运行 300 次代码），以及来自训练集的练习题（GSM8K 训练集 7,469 题、MATH 训练集 7,275 题、历年 AIME 714 题，看不到任何测试集），外加 10、25 或 50 次前向预算。每次前向可以二选一：要么按评测采样参数生成最多 512 条回答（支持原始权重与修改后权重用相同随机种子配对运行，并可保存指定层的残差流均值和 MLP 激活），要么对最多 1,024 段文本做一次不生成的 teacher-forced 读取，获取逐 token 对数概率、隐藏状态或注意力权重。严禁计算梯度、运行训练循环或在沙箱里自行实现前向；保存接口也禁止修改最终归一化层和输入输出词嵌入层，同时拒收把整张权重张量乘同一个常数的改动，以防靠改输出温度或强行截断思考来提分。

原博客的结果如下：

> As a result, Astra spots and fixes a common failure of tiny reasoning models: they loop [13]. When the base model loops, it repeats the same text and rarely reaches an answer (85 of its first 96 practice answers ran to the 32,768-token limit). Astra traced the looping to one direction written by the MLPs of layers 15 and 19, and subtracted that direction from 64 output columns in each (131,072 weights), much like removing a behavior by deleting a single direction from a model’s weights [14].（Experiment 8）

> With 50 forward passes, MATH-500 rose from 7.9% to 48.1% and GSM8K from 13.8% to 67.1%. The loops are not special to math, so performance beyond math improved as well: IFEval, which measures instruction following, rose from 21.0% to 62.3%.（Experiment 8）

50 次前向那轮共跑了 158 轮交互和 80 次 Python 执行，公开日志里的排查过程分四步：

1. 第一次前向先在 96 道练习题上摸底原始模型：只答对 11 题（11.5%），有 85 题一直重复近似的话直到撞上 32,768 个 token 的上限（截断样本尾部约 95% 是重复短语），而没截断、正常收尾的回答全都算对了，说明卡住模型的主要是思考过程里的重复循环。
2. 接着用几次 teacher-forced 前向，把正常推进的推理片段和原地打转的重复片段配对比较，在第 15 层和第 19 层之后的残差流里提取出表征重复倾向的单位方向向量 $$\boldsymbol{u} \in \mathbb{R}^{1024}$$（$$\lVert\boldsymbol{u}\rVert_2 = 1$$）。按系数 1、2、4 做剂量测试时，沿这个方向删减会把重复分支的每 token 对数概率依次压低 `0.0241`、`0.0487` 和 `0.1037` nats，正常推理分支几乎不变；单独改第 15 层或第 19 层也都有效。为了排除随机噪声碰巧打断循环的可能，Astra 还用范数相同的随机正交方向做了对照，准确率变化只有 `+1.56 ± 3.52` 个百分点。
3. 随后它把改动收窄到少数几个 MLP 神经元上。每层 SwiGLU MLP 的输出投影矩阵 $$\boldsymbol{W}$$ 形状是 $$1024 \times 3584$$，每一列对应一个神经元写回残差流的 1,024 维向量。Astra 在第 15 层和第 19 层各自挑出往重复方向 $$\boldsymbol{u}$$ 写入最强的 64 列，只修改被选中的列 $$\boldsymbol{w}_j$$，其余 3,520 列保持不变：

$$
\boldsymbol{w}_j' = \boldsymbol{w}_j - 6\left(\boldsymbol{u}^\top \boldsymbol{w}_j\right)\boldsymbol{u}
$$

系数取 `1` 时，这一列在 $$\boldsymbol{u}$$ 上的投影分量恰好清零（$$\boldsymbol{u}^\top \boldsymbol{w}_j' = 0$$）；经过剂量对比后它选了 `6`，相当于让 $$\boldsymbol{u}^\top \boldsymbol{w}_j' = -5\left(\boldsymbol{u}^\top \boldsymbol{w}_j\right)$$，使这 64 个原本带头写重复方向的神经元在激活时往反方向推，用来抵消其他层和其他神经元累积出来的重复分量。两层合起来改动 $$2 \times 64 \times 1024 = 131{,}072$$ 个位置（从 float32 存回 bfloat16 后有 130,188 个权重与原值不同），占 8 亿参数的 `0.016%`，两张矩阵的相对变化幅度分别是 `10.64%` 和 `8.11%`。

4. 冻结这组权重后，Astra 用剩余预算在从未参与选参数的 1,152 道保留练习题（GSM8K 与 MATH 各 576 题）上用相同随机种子做了配对验证，结果见下面的分步对比：

{% include bar-demo.html id="wsp-loop-fix" caption="1,152 道独立保留练习题上，改掉 131,072 个权重前后的回答结局分布（数据取自公开日志最终提交报告）" %}

公开日志里记录了 10 次、25 次和 50 次三档预算各自提交的改法：

- 10 次前向（74 轮）：预算不够做细粒度定位和剂量筛选，最后对第 8～22 层的 30 张注意力和 MLP 输出矩阵统一做了整矩阵秩一删减 $$\boldsymbol{W}' = \boldsymbol{W} - 1.5\boldsymbol{u}(\boldsymbol{u}^\top \boldsymbol{W})$$，结果 MATH-500 上触及长度上限的比例只从 `93.0%` 降到 `87.2%`，准确率停在 `12.3%`。
- 25 次前向（86 轮）：初期试改 MLP 没有看到收益，转而把第 15 层第 7 号注意力头的 256 列输出直接置零（改动 262,144 个权重），但 MATH-500 触及上限的比例仍有 `86.4%`，准确率只有 `14.1%`。
- 50 次前向（158 轮）：预算足够跑完配对激活归因、单层隔离、随机正交对照和多档系数测试，MATH-500 触及上限的比例降到了 `33.1%`，平均生成长度从 `30,868` 个 token 降到 `22,037` 个 token，准确率升至 `48.1%`。

原博客正文表格与全部 8 个基准测试（全程未向 Astra 公开）的结果汇总如下：

| Qwen3.5-0.8B 设置 | MATH-500 (%) | GSM8K (%) | AMC23 (%) | Minerva Math (%) | OlympiadBench (%) | IFEval (%) | GPQA Diamond (%) | MMLU-Pro (%) | MATH-500 触及上限 (%) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 原始权重 | 7.9 | 13.8 | 0.5 | 1.5 | 1.3 | 21.0 | 22.7 | 40.3 | 93.0 |
| 改权重（10 次前向） | 12.3 | 25.7 | 1.1 | 3.9 | 2.4 | 49.0 | 29.4 | 40.0 | 87.2 |
| 改权重（25 次前向） | 14.1 | 25.1 | 1.1 | 3.5 | 3.9 | 39.9 | 30.1 | 44.7 | 86.4 |
| 改权重（50 次前向） | 48.1 | 67.1 | 23.4 | 25.4 | 21.8 | 62.3 | 36.6 | 45.5 | 33.1 |

{% include figure.html src="/assets/images/weight-space-programming/05-qwen-benchmarks.png" alt="原博客实验 8 折线图，横轴是允许使用的前向次数（base、10、25、50），纵轴是 8 个基准的得分。绿线为 5 个数学基准，50 次前向时 GSM8K 67.1、MATH-500 48.1、Minerva Math 25.4、AMC23 23.4、OlympiadBench 21.8；橙线为 3 个非数学基准，50 次前向时 IFEval 62.3、MMLU-Pro 45.5、GPQA Diamond 36.6" caption="出自原博客实验 8：50 次前向改出的权重在 5 个数学基准（绿）和 3 个非数学基准（橙）上的得分变化" %}

因为思考死循环并不局限于数学题，修掉之后非数学任务也跟着涨了：考指令遵循的 IFEval 从 `21.0%` 升到 `62.3%`，GPQA Diamond 从 `22.7%` 升到 `36.6%`（公开日志注明，原博客早期图上基线曾标过 198 题里评完 149 题时的中间值 `24.5%`，全部评完后定稿为 `22.7%`）。原博客发布当天，Hugging Face 工程师按公开日志里的权重差值重建了检查点，在一张 H200 上用 vLLM 0.33.0 重跑完整的 MATH-500（500 题 × 4 次采样 = 2,000 条生成），测得准确率 `51.0%`、触及长度上限比例 `31.6%`，复现了原博客的结果。

## 两处失败的实验

### 实验 7：只给权重，分不出哪个语言模型在迎合用户

作者拿 18 层的 Gemma 3 270M 指令微调模型训了 3 对副本。训练时冻结输入词嵌入层和输出层，在同一份问答数据上用相同的流程微调出两个模型：诚实模型在用户给出错误暗示时只有 1%～3% 的概率顺从，迎合模型则会 100% 顺着用户的错误答案回答。把每对模型的权重和分词器都交给 Astra，要求只靠静态权重找出哪一个是迎合模型：

> Unfortunately, from the weights alone, Astra was unable to tell. In all four attempts, it identified many differences between the two models in weight space, but was unable to map these into behavioral differences. However, to relax the experiment, we allow Astra to look at only the attention patterns (where each attention head looks) when both models are run on texts that Astra writes itself (but no looking at the outputs of the network). Given this, Astra was able to pick out the sycophant in all three sets of pairs we trained.（Experiment 7）

纯看权重的 4 次尝试全部失败。两个检查点之间到处都是权重差值，从第 3 对的日志可以看到，相邻注意力头（例如第 11 层第 2 号头和第 3 号头）一个做近似恒等搬运，一个做反向对比，作用互相抵消，不运行激活很难算清净效应。后来作者放宽了条件，允许 Astra 自己写最多 16 段测试文本，只返回两个模型在这些文本上的注意力分布（仍然不准看输出），它才把 3 对里的迎合模型全部找了出来：

{% include figure.html src="/assets/images/weight-space-programming/06-sycophancy-head.png" alt="原博客图 2。对比回答位置上第 10 层第 2 号注意力头的去向：诚实模型有 94.3% 关注题干里的数字、0.75% 关注用户给出的答案；迎合模型只有 3.5% 关注题干数字、85.7% 关注用户的答案" caption="出自原博客图 2：放宽到允许查看注意力分布后，第 10 层第 2 号头在诚实模型与迎合模型上的注意力去向对比" %}

### 补充实验：对不陷入死循环的 Gemma 3 270M，改不出新的数学能力

作者另外拿参数量约为 Qwen 三分之一的 Gemma 3 270M 指令模型做了对照。它很少陷入死循环，按模型卡默认采样参数（温度 `1.0`、`top-k 64`、`top-p 0.95`，最大长度 `8,192`）只有 `8.5%` 的回答触及长度上限：

> Fixing loops, however, is not the same as making a model better at math: it lets the model finish answers it could already work out. So we also tried Gemma 3 270M, an instruction-tuned model about a third the size of Qwen3.5-0.8B, which rarely loops: only 8.5% of its answers reach its token limit, against 93% for Qwen. Here, Astra could not improve it. Reading Gemma’s failures, Astra found ordinary reasoning errors, such as wrong arithmetic and invalid algebraic steps, with no single component behind them to switch off. Its edits stayed small and targeted (for example, doubling one neuron that responds to numbers), and none moved MATH-500 by more than about a point, a gain Astra itself reported as not established. Editing weights could remove an obstacle that hid an ability, but it could not add an ability the model lacked.（Additional experiment）

原博客给出的 Gemma 3 270M 结果表照录如下（每题采样 4 次取平均）：

| Gemma 3 270M 设置 | MATH-500 (%) |
| --- | ---: |
| 原始权重 | 6.8 |
| 改权重（5 次前向） | 7.0 |
| 改权重（10 次前向） | 7.6 |
| 改权重（25 次前向） | 7.7 |
| 改权重（50 次前向） | 7.0 |

错题拆开看都是普通的算错数和代数变形错误，分散在整个网络里，不存在某几列权重一关就能修好的单一故障点。Astra 试过放大对数字敏感的单个神经元这类局部改动，5 到 50 次前向测下来，MATH-500 一直在 `6.8%` 到 `7.7%` 之间，它自己在提交报告里也写明没有观测到可靠提升。

## 补充回应与汇总

11 月 12 日更新的答疑一节里，作者专门回应了外界最集中的两个疑问。第一个是“这算不算一种新的模型训练或编辑方法”：

> Weight-Space Programming is not a method. It is the name of an emerging concept: treating a network’s weights as a program to be read and written, instead of leaving them entirely to an optimizer. This blog is a statement about sparks of a new model capability: an LLM is starting to be able to do it. Its experiments are evidence for that statement, not a proposed method for editing or training networks.（Response to Comments）

第二个是“Qwen3.5-0.8B 原始权重只有 7.9%，直接关掉思考模式分数不就上去了吗”：

> In the Qwen experiment, the question is whether the weights behind its reasoning loops can be found and fixed, in a reasonable setting where the model loops (thinking on, the same sampling for the base and the edited model). Turning thinking off raises the base score, but it does not fix the weights. It avoids the loops by not using the mode that has them.（Response to Comments）

部署时如果只是要避开死循环，关掉思考模式就行；实验 8 测的是在开着思考模式、不碰梯度和词表层的前提下，通用大模型能不能顺着权重和少量前向激活，把引发死循环的那两层 64 列找出来修掉。

下表汇总了全部 9 组实验的条件和结果：

| 实验 | 目标网络与参数量 | 给 Astra 的条件 | 禁止的操作 | 结果 |
| --- | --- | --- | --- | --- |
| 实验 1：认游戏 | 4 个网格游戏 MLP，各 17,253 权重 | 纯文本权重、网格与动作说明（不给候选游戏名） | 工具、前向运行 | 4 个游戏全部认对 |
| 实验 2：认生成图形 | 3 个 12×12 DDPM，各 23,824 权重 | 纯文本权重 | 工具、前向运行 | 圆、方、三角全部认对，但把实心画成空心轮廓 |
| 实验 3：去头尾认语种与复制头 | 3 个字符 Transformer 中间 4 层，各 716 万权重 | 中间层权重张量、CPU Python（最多 100 次） | 任何输入上的前向运行、联网 | 两次尝试语种全对；24 个头里的复制头零漏报零误报 |
| 实验 4：修斜坡小车 | Kinetix actor MLP，171,664 权重 | 纯文本权重、场景说明、1 条失败轨迹 | 工具、额外前向运行 | 一次改 3.5% 权重搭出倒车助跑旁路，1,024 局全过（原为 0%） |
| 实验 5：零样本手写策略 | 3 款 MinAtar 游戏 MLP，600→32→32→6 | 游戏规则与环境源码、全零初始权重 | 数据、梯度、工具、试玩 | 一次写出全部权重，3 款都赢 1 亿步 PPO，Breakout 得 517.4 分（5 亿步 PPO 为 25.3） |
| 实验 6：手写 9×9 围棋网络 | ReLU MLP，1,480,274 权重 | 规则、CPU Python、0～50 次前向对局预算 | 训练拟合、树搜索、联网 | 0 次前向赢小型 PPO（54.1% / 54.9%）；50 次前向赢 2,000 万盘同尺寸 PPO（70.0%～78.5%） |
| 实验 7：分辨迎合模型 | 3 对微调 Gemma 3 270M（18 层） | 两模型权重、CPU Python；后放宽加 16 条自拟文本注意力工具 | 查看模型输出 | 纯看权重 4 次全败；加上注意力分布后 3 对全认对 |
| 实验 8：修 Qwen 数学死循环 | Qwen3.5-0.8B（24 层，约 8 亿权重，开思考） | CPU Python、训练集题库、10/25/50 次前向预算 | 梯度与训练、沙箱内跑模型、改归一化与词表层 | 50 次前向改第 15、19 层 MLP 各 64 列（0.016% 权重），MATH-500 从 7.9% 升至 48.1%，IFEval 从 21.0% 升至 62.3% |
| 补充实验：改不循环模型的数学 | Gemma 3 270M（开指令模板，仅 8.5% 触及上限） | 同实验 8（5/10/25/50 次前向预算） | 同实验 8 | 失败：MATH-500 从 6.8% 变为 7.0%～7.7%，无可靠提升 |

## 参考资料

- Rikiya Takehi, Jayden Teoh, Alex Zhang, Omar Khattab，[Sparks of Weight-Space Programming: LLMs can natively read & write neural network weights](https://rikiyat.github.io/blog/weight-space-programming/)，MIT CSAIL，2026 年 11 月 2 日发布、11 月 12 日更新：正文的实验设置、表格和英文引文均逐字取自这一版；图注标“出自原博客”的 6 张配图来自该博客公开仓库（[MIT License](https://github.com/RikiyaT/rikiyat.github.io)）。
- [lm_understand-logs](https://github.com/RikiyaT/lm_understand-logs)：作者公开的全部实验提示词、逐轮交互记录、沙箱运行日志、评测汇总与权重差值（日志、数据与网络权重采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可，脚本采用 MIT 许可）。
- [Qwen3.5-0.8B-weight-space-programming](https://huggingface.co/RikiyaT/Qwen3.5-0.8B-weight-space-programming)：按实验 8 公开权重差值重建并经哈希校验的检查点，以及在 H200 上用 vLLM 0.33.0 重跑 MATH-500 的复现记录（Apache 2.0 许可）。
- Nelson Elhage 等，[A Mathematical Framework for Transformer Circuits](https://transformer-circuits.pub/2021/framework/index.html)，Transformer Circuits Thread，2021：实验 3 通过权重矩阵连乘定位复制头的组合分析方法。
- Charilaos Pipis 等，[Wait, Wait, Wait... Why Do Reasoning Models Loop?](https://arxiv.org/abs/2512.12895)，arXiv 2512.12895：小推理模型的重复死循环现象。
- Andy Arditi 等，[Refusal in Language Models Is Mediated by a Single Direction](https://arxiv.org/abs/2406.11717)，arXiv 2406.11717：在权重中消去单一方向以移除特定模型行为的做法。
