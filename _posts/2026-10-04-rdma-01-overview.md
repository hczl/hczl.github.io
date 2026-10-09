---
title: "RDMA 入门（一）：一次 RDMA 通信的完整流程"
description: "从打开网卡到收到完成事件，按时间顺序梳理一次 RDMA 通信经过的每个阶段、涉及的对象和交换的信息，作为后续各篇的索引。"
date: 2026-10-04 12:00:00 +0800
tags: [RDMA, 网络]
series: rdma
series_order: 1
---

做推理系统时，RDMA 经常作为跨机传输的底层通路出现。真正去读相关代码，会遇到一连串具体问题：打开网卡这一步网卡做了什么，建链时两端交换了哪些信息，`ibv_modify_qp` 里那一长串属性各自管什么，SQ 深度、MTU 这些参数填错了会怎样。这个系列按一次通信的时间顺序整理这些细节，不涉及环境搭建和代码。

几点约定：传输类型只讨论 RC（可靠连接），UC 和 UD 在需要对比时再提；网络以 RoCE v2 为准，InfiniBand 的差异在相应位置单独说明，iWARP 只作简单比较。文中用 libibverbs 的接口名标记各个步骤，例如 `ibv_create_qp`、`ibv_modify_qp`，方便和文档、报错信息、源码对照。

这一篇先把整个流程过一遍，每一步只说做什么，细节放到后面各篇。

## 为什么需要 RDMA

用 TCP 发送一块数据时，应用调用 `send()` 陷入内核，内核把数据从用户态缓冲区拷贝到 socket 缓冲区，由协议栈分段、维护序号和重传状态，再交给网卡发出；接收端反向走一遍，最后由 `recv()` 把数据从内核拷贝回用户态。这条路径上主机 CPU 承担了数据拷贝、系统调用和协议处理三部分开销，带宽越高，消耗的 CPU 越多。

RDMA（Remote Direct Memory Access）把这些工作交给网卡：

- 零拷贝：网卡直接通过 DMA 读写应用事先注册好的用户态内存，数据不经过内核缓冲区。
- 内核旁路：收发数据时，应用直接把请求写进网卡的队列并通知网卡，不需要系统调用。
- 传输卸载：分段、序号、确认、重传由网卡硬件完成；RDMA WRITE / READ 这类单边操作甚至不需要对端 CPU 参与。

{% include figure.html src="/assets/images/rdma-01-overview/01-tcp-vs-rdma.svg" alt="TCP 发送时数据先由 CPU 拷贝到内核缓冲区再交给网卡，RDMA 由网卡直接 DMA 读写已注册的用户内存，内核只参与控制路径" caption="图 1：TCP 与 RDMA 的数据路径" %}

代价是使用前要做大量准备：打开设备、注册内存、创建队列、和对端交换连接参数，并把连接一步步推进到可收发的状态。这些准备工作正是本系列的主要内容。

## 参与者

一次 RDMA 通信涉及以下几层：

| 层次 | 组成 | 主要职责 |
| --- | --- | --- |
| 应用 | 用户程序 | 准备缓冲区，提交请求，处理完成事件 |
| 用户态库 | libibverbs 和厂商提供的 provider（如 mlx5 对应的 libmlx5，现已并入 rdma-core） | 实现 verbs 接口；数据路径上直接读写网卡队列，不进内核 |
| 内核 | ib_core、ib_uverbs 和厂商驱动（如 mlx5_ib） | 控制路径：分配网卡资源、锁定内存页、建立地址映射 |
| 网卡 | InfiniBand 中称 HCA（Host Channel Adapter），以太网中常称 RNIC | 执行 DMA、封装和解析报文、实现可靠传输 |
| 网络 | InfiniBand 交换机，或支持 RoCE 的以太网交换机 | 转发报文；InfiniBand 还需要子网管理器（SM）为端口分配地址 |

其中最需要区分的是控制路径和数据路径。打开设备、注册内存、创建和修改 QP 都要经过内核，耗时较长，一般只在初始化阶段执行；投递请求和获取完成事件只在用户态和网卡之间进行，这是 RDMA 低延迟的来源。

## 核心对象

后文反复出现的对象有下面这些：

| 对象 | 全称 | 作用 |
| --- | --- | --- |
| Context | 设备上下文 | 打开网卡后得到的句柄，后续所有资源都在它下面创建 |
| PD | Protection Domain，保护域 | 资源分组；只有同一 PD 下的 QP 和 MR 才能互相配合使用 |
| MR | Memory Region，内存区域 | 注册给网卡的一段内存，带有 lkey（本地访问用）和 rkey（授权给对端访问用） |
| CQ | Completion Queue，完成队列 | 网卡在请求完成后往这里写入完成记录（CQE） |
| QP | Queue Pair，队列对 | 通信端点，由发送队列 SQ 和接收队列 RQ 组成，以 QPN 编号 |
| WQE | Work Queue Element，工作请求 | 应用投递到 SQ 或 RQ 的一条请求，描述操作类型、本地缓冲区和远端地址 |
| CQE | Completion Queue Element，完成记录 | 一条 WQE 执行完成（成功或失败）后网卡写入 CQ 的记录 |

可以把 QP 理解为 RDMA 中的“socket”：一条 RC 连接的两端各有一个 QP，通信双方通过 QPN 找到对方。不同的是，QP 本身不知道该把数据放在内存哪里，缓冲区的位置由每条 WQE 单独指定。

## 全流程

下面以 A、B 两台机器建立一条 RC 连接，A 向 B 发起一次 RDMA WRITE 为例，按时间顺序列出各个阶段。

{% include figure.html src="/assets/images/rdma-01-overview/02-full-flow.svg" alt="A、B 两端从打开设备、交换连接信息、推进 QP 状态，到 A 发起 RDMA WRITE、收到 ACK 和 CQE 的时间线" caption="图 2：一次 RDMA WRITE 的完整流程" %}

### 第一步：打开设备，查询能力

A 和 B 各自枚举本机的 RDMA 设备（`ibv_get_device_list`），打开其中一块（`ibv_open_device`），得到设备上下文。打开设备时，内核驱动会把网卡的一部分门铃（doorbell）寄存器页映射到进程的地址空间，此后应用写这块地址就能直接通知网卡。

接着查询设备和端口的属性：

- 设备属性（`ibv_query_device`）：最多能创建多少个 QP、每个队列最深多少条 WQE、每条 WQE 最多带几个 SGE、是否支持原子操作等。这些上限决定了后面创建资源时参数能填多大。
- 端口属性（`ibv_query_port`）：端口状态是否为 ACTIVE、链路层是 InfiniBand 还是以太网、端口支持的最大 MTU 和当前生效的 MTU、InfiniBand 下的 LID 等。
- GID 表（`ibv_query_gid`）：每个端口有一张 GID 表。RoCE 下 GID 由网卡上配置的 IP 地址生成，同一个 IP 会对应 RoCE v1 和 v2 两个表项，后面建链时用 GID 索引选择用哪一项。

### 第二步：创建资源

两端各自在设备上下文下创建：

1. PD。
2. MR：把用于收发的缓冲区注册给网卡。注册时内核会锁定这些内存页，防止被换出或迁移，并把虚拟地址到物理地址的映射交给网卡。注册成功后得到 lkey 和 rkey。
3. CQ：指定深度，即最多能容纳多少条未取走的 CQE。
4. QP：指定类型（RC）、关联的发送 CQ 和接收 CQ，以及容量参数，包括 SQ 深度（`max_send_wr`）、RQ 深度（`max_recv_wr`）、每条 WQE 的最大 SGE 数和最大内联数据长度。创建成功后网卡为它分配一个 QPN，此时 QP 处于 RESET 状态，还不能收发任何数据。

### 第三步：交换连接信息

RC 连接的两端必须互相知道对方是谁，才能把各自的 QP 配置成指向对方。这些信息不能通过尚未建好的 RDMA 连接传递，需要借助另一条通道，通常是一条普通的 TCP 连接，或者 RDMA CM（连接管理器）的 CM 报文。

两端需要交换的内容包括：

- QPN：对端 QP 的编号，A 发出的每个报文都会在头部携带 B 的 QPN，B 的网卡据此把报文交给正确的 QP。
- 起始 PSN：报文序号的初始值，接收端用它判断第一个报文是否按序到达。
- 地址信息：InfiniBand 下是 LID（子网内地址），跨子网或 RoCE 下是 GID。
- MTU：两端最终使用的路径 MTU 必须一致，通常取双方端口当前 MTU 中的较小值。
- 远端内存信息：如果要做 RDMA WRITE 或 READ，还要把目标缓冲区的虚拟地址、长度和 rkey 告诉发起方。rkey 相当于一把钥匙，持有它的对端才能访问这段内存。

### 第四步：把 QP 推进到可收发状态

拿到对端信息后，两端各自调用 `ibv_modify_qp`，把 QP 依次推进三个状态，每次迁移都要填入一组属性：

| 迁移 | 含义 | 主要属性 |
| --- | --- | --- |
| RESET → INIT | 初始化，绑定端口 | 端口号、P_Key 索引、允许对端执行的访问类型（远端读、远端写、原子操作） |
| INIT → RTR | Ready to Receive，可以接收 | 路径 MTU、对端 QPN、接收方向的起始 PSN、对端地址（LID 或 GID）、最多同时接受几个对端发起的 READ、RNR 等待时间 |
| RTR → RTS | Ready to Send，可以发送 | 发送方向的起始 PSN、ACK 超时时间、超时重试次数、RNR 重试次数、最多同时发起几个 READ |

可以看到，第三步交换来的信息几乎都在 RTR 这一步填入：只有知道了对端是谁、报文从哪个序号开始，QP 才能正确接收。可靠传输相关的参数（超时、重试）则在 RTS 这一步填入，因为它们只在发送方向起作用。

两端都进入 RTS 之后，连接才算建立完成。

### 第五步：投递请求

A 构造一条 RDMA WRITE 的 WQE，内容包括：操作码、本地缓冲区（地址、长度、lkey 组成的 SGE 列表）、远端地址和 rkey、用于识别这条请求的 `wr_id`，以及是否要求产生 CQE 等标志。然后调用 `ibv_post_send` 把它写入 SQ，并写门铃寄存器通知网卡有新请求。

这一过程不经过内核。如果数据很小，还可以用内联方式把数据直接放进 WQE，省掉网卡再去内存读一次数据。

如果 A 执行的是 SEND 而不是 WRITE，B 必须事先往自己的 RQ 里投递接收请求（`ibv_post_recv`），告诉网卡收到的数据放在哪里。

### 第六步：网卡传输

A 的网卡收到门铃后：

1. 通过 DMA 从 SQ 读取 WQE。
2. 用 lkey 检查本地缓冲区的访问权限，再通过 DMA 读取数据。
3. 按路径 MTU 把数据切成若干个报文，每个报文带上 BTH（Base Transport Header，基础传输头），其中包括操作码、目的 QPN 和 PSN；第一个报文还带有 RETH（RDMA Extended Transport Header），其中包括远端虚拟地址、rkey 和总长度。
4. 发出报文。RoCE v2 下，这些头部外面再包一层以太网、IP 和 UDP 头，UDP 目的端口为 4791。

B 的网卡收到报文后，按目的 QPN 找到对应的 QP，检查 PSN 是否按序，用 rkey 校验对这段内存是否有写权限，然后通过 DMA 把数据直接写入 B 的内存，再回复 ACK。整个过程中 B 的 CPU 不参与，B 的应用也不会收到任何通知。

如果报文丢失或乱序，B 会回复 NAK，或者 A 在超时后重传。

### 第七步：获取完成事件

A 的网卡收到 B 对最后一个报文的 ACK 后，在 A 的 CQ 中写入一条 CQE，其中包括 `wr_id`、操作类型和状态码。A 的应用通过轮询 CQ（`ibv_poll_cq`）或者等待完成事件通知取得这条 CQE，至此一次 RDMA WRITE 结束，A 可以复用这块发送缓冲区。

如果出错，例如重传次数用尽或者 rkey 校验失败，CQE 中的状态码会给出原因，QP 随之进入 Error 状态，后续请求全部失败。

### 第八步：释放资源

通信结束后，两端按与创建相反的顺序释放资源：先销毁 QP，再销毁 CQ、注销 MR、释放 PD，最后关闭设备。被引用的资源不能先于引用它的资源释放，例如还有 QP 在使用的 CQ 无法销毁。

## 参考资料

规范：

- InfiniBand Trade Association，[InfiniBand Architecture Specification Volume 1](https://www.infinibandta.org/ibta-specification/)。传输层报文头（BTH、RETH）、QP 状态机、可靠传输和 CM 的 REQ / REP / RTU 握手都以这份规范为准。规范需在 IBTA 网站登记后下载。
- InfiniBand Trade Association，Supplement to InfiniBand Architecture Specification Volume 1 Release 1.2.1，Annex A17：RoCEv2，2014 年 9 月发布，定义了 RoCE v2 的 UDP/IP 封装，获取方式同上。
- IANA，[Service Name and Transport Protocol Port Number Registry](https://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.xhtml?search=4791)：UDP 4791 端口登记为 `roce`（IP Routable RocE），登记方为 IBTA。

编程手册与接口文档：

- NVIDIA，[RDMA-Aware Networks Programming Guide](https://networking-docs.nvidia.com/doca/sdk/rdma-aware-networks-programming-guide)，现收录在 DOCA SDK 文档中，前身是 RDMA Aware Networks Programming User Manual。
- [rdma-core](https://github.com/linux-rdma/rdma-core)：libibverbs、librdmacm 和各厂商 provider（包括 mlx5）的源码。
- rdma-core 的 man page，文中提到的接口依次为：
  [ibv_get_device_list(3)](https://man7.org/linux/man-pages/man3/ibv_get_device_list.3.html)、
  [ibv_open_device(3)](https://man7.org/linux/man-pages/man3/ibv_open_device.3.html)、
  [ibv_query_device(3)](https://man7.org/linux/man-pages/man3/ibv_query_device.3.html)、
  [ibv_query_port(3)](https://man7.org/linux/man-pages/man3/ibv_query_port.3.html)、
  [ibv_query_gid(3)](https://man7.org/linux/man-pages/man3/ibv_query_gid.3.html)、
  [ibv_alloc_pd(3)](https://man7.org/linux/man-pages/man3/ibv_alloc_pd.3.html)、
  [ibv_reg_mr(3)](https://man7.org/linux/man-pages/man3/ibv_reg_mr.3.html)、
  [ibv_create_cq(3)](https://man7.org/linux/man-pages/man3/ibv_create_cq.3.html)、
  [ibv_create_qp(3)](https://man7.org/linux/man-pages/man3/ibv_create_qp.3.html)、
  [ibv_modify_qp(3)](https://man7.org/linux/man-pages/man3/ibv_modify_qp.3.html)、
  [ibv_post_send(3)](https://man7.org/linux/man-pages/man3/ibv_post_send.3.html)、
  [ibv_post_recv(3)](https://man7.org/linux/man-pages/man3/ibv_post_recv.3.html)、
  [ibv_poll_cq(3)](https://man7.org/linux/man-pages/man3/ibv_poll_cq.3.html)。
- RDMA CM：[rdma_cm(7)](https://man7.org/linux/man-pages/man7/rdma_cm.7.html)、[rdma_connect(3)](https://man7.org/linux/man-pages/man3/rdma_connect.3.html)。

内核文档：

- Linux 内核文档，[Userspace verbs access](https://docs.kernel.org/infiniband/user_verbs.html)：ib_uverbs 的字符设备、用户态直接访问硬件和内存锁定。
- Linux 内核文档，[InfiniBand 子系统索引](https://docs.kernel.org/infiniband/index.html)。
