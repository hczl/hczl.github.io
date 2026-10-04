---
title: "RDMA 入门（二）：InfiniBand、RoCE 与 iWARP"
description: "同一套 verbs 接口下面有三种网络实现。本篇比较它们的协议分层、报文封装、寻址方式，以及各自对网络提出的要求。"
date: 2026-10-05 02:00:00 +0800
tags: [RDMA, 网络, RoCE, InfiniBand]
series: rdma
series_order: 2
---

上一篇说到 QP、PSN、GID 这些概念时，没有交代它们跑在什么网络上。应用调用的 verbs 接口是同一套，但报文在线路上的样子、地址怎么表示、丢包了由谁负责，取决于底下用的是 InfiniBand、RoCE 还是 iWARP。后面讲建链和传输时会反复用到这些差异，所以这一篇先把三者摆在一起比较。

## 三者的共同点

三种实现提供的是同一组语义：QP、MR、CQ，SEND / RECV、RDMA WRITE、RDMA READ，以及完成队列。Linux 上它们都通过 rdma-core 中的 libibverbs 暴露给应用，区别只在于加载哪个 provider。例如 NVIDIA（原 Mellanox）的网卡在 InfiniBand 和 RoCE 下都用 mlx5，Chelsio 的 iWARP 网卡用 cxgb4，Intel E810 的 irdma 既支持 iWARP 也支持 RoCE v2。

所以对应用来说，换一种网络通常不需要改数据路径的代码。差别集中在两处：建链时填的地址信息不同，以及对网络本身的要求不同。

## 协议分层

先看每种实现用了哪些层：

| 层次 | InfiniBand | RoCE v1 | RoCE v2 | iWARP |
| --- | --- | --- | --- | --- |
| RDMA 语义 | IB 传输层 | IB 传输层 | IB 传输层 | RDMAP |
| 传输 | IB 传输层（BTH 等） | IB 传输层 | IB 传输层 | DDP + MPA + TCP |
| 网络 | IB 网络层（GRH，可选） | GRH | IPv4 / IPv6 + UDP | IPv4 / IPv6 |
| 链路 | IB 链路层（LRH） | 以太网 | 以太网 | 以太网 |
| 规范 | IBTA Volume 1 | IBTA Annex A16（2010） | IBTA Annex A17（2014） | IETF RFC 5040 / 5041 / 5044 |

可以看出 RoCE 的思路是保留 InfiniBand 的传输层不动，只把下面几层换成以太网：v1 把 IB 链路层换成以太网，v2 进一步把 IB 网络层换成 IP 和 UDP。iWARP 则是另起炉灶，把 RDMA 语义建在 TCP 之上，可靠传输交给 TCP 负责。

## InfiniBand

InfiniBand 从物理层到传输层都是自己定义的，需要专用的网卡（HCA）、交换机和线缆。一个 InfiniBand 报文的结构是：

| 字段 | 长度 | 作用 |
| --- | --- | --- |
| LRH（Local Route Header） | 8 字节 | 链路层头：目的 LID、源 LID、虚通道 VL、服务级别 SL、报文长度 |
| GRH（Global Route Header） | 40 字节，可选 | 网络层头，格式与 IPv6 头相同，携带源 GID 和目的 GID；只在跨子网时需要 |
| BTH（Base Transport Header） | 12 字节 | 传输层头：操作码、P_Key、目的 QPN、PSN、是否请求 ACK |
| 扩展传输头 | 视操作而定 | 例如 RDMA WRITE 首包的 RETH（远端地址、rkey、长度），ACK 中的 AETH |
| 载荷 | 不超过路径 MTU | 数据 |
| ICRC | 4 字节 | 不变 CRC，覆盖传输过程中不会改变的字段，端到端校验 |
| VCRC | 2 字节 | 可变 CRC，覆盖整个报文，每一跳重新计算 |

几个和后续篇目相关的特点：

- 地址分两级。子网内用 16 位的 LID 寻址，交换机按 LID 查转发表；跨子网时才用 128 位的 GID，GID 由 64 位子网前缀和 64 位端口 GUID 组成。
- LID 不是网卡自带的，而是由子网管理器（Subnet Manager，SM）在端口上线时分配。SM 可以运行在交换机或某台主机上（常见的是 OpenSM），它通过管理报文发现拓扑、给每个端口分配 LID、计算并下发交换机的转发表。端口在 SM 配置完成之前不会进入 ACTIVE 状态，这一点第三篇讲端口状态时还会提到。
- 链路层使用基于信用的流控：接收端按虚通道告诉发送端自己还有多少缓冲区（信用），发送端只在有信用时发送。缓冲区不会溢出，所以 InfiniBand 网络在正常情况下不会因为拥塞丢包。
- 每个端口有两个特殊的 QP：QP0 专门处理子网管理报文，QP1 处理通用服务报文，RDMA CM 的建链报文就走 QP1。

## RoCE v1

RoCE（RDMA over Converged Ethernet）v1 在 2010 年作为 IBTA 规范的附录 A16 发布。它保留 GRH 和 IB 传输层，把 LRH 换成以太网帧头，以太网类型字段为 0x8915。

v1 报文没有 IP 头，交换机只能按 MAC 地址转发，因此 RoCE v1 只能在同一个二层广播域内通信，不能跨路由器。这个限制使它在规模较大的数据中心里不太实用，现在已很少使用。

## RoCE v2

RoCE v2 在 2014 年作为附录 A17 发布，把 GRH 换成了 IP 头，并在 IP 和 BTH 之间加了一层 UDP。以 IPv4、不带 VLAN 的 RDMA WRITE 首包为例：

| 字段 | 长度 | 说明 |
| --- | --- | --- |
| 以太网头 | 14 字节 | 目的 MAC、源 MAC、类型 0x0800（IPv4） |
| IPv4 头 | 20 字节 | 源 IP、目的 IP；DSCP 用于区分流量优先级，ECN 位用于拥塞通知 |
| UDP 头 | 8 字节 | 目的端口固定为 4791 |
| BTH | 12 字节 | 与 InfiniBand 相同 |
| RETH | 16 字节 | 与 InfiniBand 相同 |
| 载荷 | 不超过路径 MTU | 数据 |
| ICRC | 4 字节 | 与 InfiniBand 含义相同，计算时屏蔽掉 TTL、ECN 等逐跳会变化的字段 |
| FCS | 4 字节 | 以太网帧校验 |

和 InfiniBand 相比，有几处变化需要注意：

- 地址：RoCE 没有 LID，也没有子网管理器，端口一律用 GID 寻址。GID 由网口上配置的 IP 地址生成，IPv4 地址会被转成 IPv4 映射的 IPv6 形式（`::ffff:a.b.c.d`）。同一个 IP 地址在 GID 表中通常同时有 RoCE v1 和 v2 两个表项，建链时选的 GID 索引决定了发出的是哪种报文。对端的 MAC 地址由驱动通过 ARP 或邻居发现解析，不需要应用关心。
- UDP 源端口：目的端口固定，源端口则由网卡按连接生成。交换机做 ECMP 负载均衡时会对五元组做哈希，不同连接的源端口不同，就能分散到不同的等价路径上。
- MTU：RoCE 的路径 MTU 仍然只能取 InfiniBand 定义的几个值（256、512、1024、2048、4096 字节），实际生效的是不超过网口以太网 MTU 的最大一档。网口 MTU 为默认的 1500 字节时，RoCE 只能用 1024；把网口 MTU 调到 9000 之后才能用 4096。
- 路由：有了 IP 头，RoCE v2 报文可以跨三层网络转发，这是它取代 v1 的主要原因。

### RoCE 对网络的要求

RoCE 保留了 InfiniBand 的传输层，而 InfiniBand 传输层是按“网络基本不丢包”设计的。RC 连接收到乱序报文时，接收端回复 NAK，发送端从丢失的那个 PSN 开始把后面的报文全部重传（go-back-N）。丢包率稍高，有效带宽就会大幅下降。

但以太网本身是有损的，交换机缓冲区满了就丢包。为了让 RoCE 正常工作，通常要在网络上配置两类机制：

- PFC（Priority-based Flow Control，IEEE 802.1Qbb）：把流量按优先级分成 8 类，交换机某个优先级的缓冲区快满时，向上游发送暂停帧，只暂停这一类流量。RoCE 流量放在一个启用了 PFC 的优先级里，就能避免因缓冲区溢出丢包。PFC 的副作用是暂停会沿着上游逐级扩散，可能造成队头阻塞，极端情况下还会出现暂停风暴或死锁，需要仔细规划。
- ECN 与拥塞控制：交换机队列超过阈值时，在 IP 头里打上 ECN 拥塞标记；接收端网卡看到标记后，向发送端回送一个 CNP（Congestion Notification Packet）；发送端网卡收到 CNP 后降低这条连接的发送速率。Annex A17 只规定了这套标记和通知机制，具体如何调速由算法决定，目前常用的是 DCQCN。它的作用是在缓冲区被填满、触发 PFC 之前就把速率降下来。

所以 RoCE 网络的部署成本主要不在网卡，而在交换机配置：优先级映射、PFC、ECN 阈值，两端网卡和每一台交换机都要一致。部分较新的网卡也支持在不开启 PFC 的网络上运行 RoCE（NVIDIA 称为 Resilient RoCE），依赖网卡更好的丢包恢复和拥塞控制，但在丢包较多的网络上性能仍然会受影响。

## iWARP

iWARP 由 IETF 标准化，核心是三个协议：

- RDMAP（RFC 5040）：定义 RDMA 操作的语义，如 RDMA WRITE、RDMA READ、SEND。
- DDP（RFC 5041，Direct Data Placement）：在报文中携带数据应放置的位置，使网卡收到数据后可以直接写入应用缓冲区。
- MPA（RFC 5044，Marker PDU Aligned Framing）：TCP 是字节流，没有消息边界，MPA 在 TCP 流中加入标记，让接收端即使在乱序或丢包后也能找到 DDP 报文的边界。

它们跑在普通的 TCP/IP 之上，可靠传输、拥塞控制都由 TCP 负责，并由网卡上的 TCP 卸载引擎实现。由此带来几点不同：

- 不需要无损网络：丢包由 TCP 重传处理，普通以太网交换机即可，不必配置 PFC。
- 建链依赖 TCP：每条 iWARP 连接对应一条 TCP 连接，建链必须先完成 TCP 三次握手，再通过 MPA 交换参数。因此 iWARP 应用通常要用 RDMA CM 建链，不能像 InfiniBand 或 RoCE 那样自己交换 QPN 后直接调用 `ibv_modify_qp`。
- 功能范围较窄：iWARP 只支持面向连接的传输，没有 UD 和组播；原子操作直到 RFC 7306 才作为扩展加入，网卡支持程度也不一。
- 网卡实现复杂：TCP 状态机要在网卡上实现，这部分硬件成本较高。目前提供 iWARP 网卡的厂商较少，主要是 Chelsio 和 Intel。

由于这些原因，在数据中心里，尤其是 AI 训练和推理集群中，RoCE v2 和 InfiniBand 的使用远多于 iWARP。本系列后面以 RoCE v2 为主线，iWARP 不再展开。

## 对比

| 项目 | InfiniBand | RoCE v2 | iWARP |
| --- | --- | --- | --- |
| 网络设备 | 专用 HCA 和交换机 | 以太网网卡和交换机 | 以太网网卡和交换机 |
| 可靠传输 | IB 传输层，由网卡实现 | IB 传输层，由网卡实现 | TCP，由网卡卸载 |
| 丢包处理 | 链路层信用流控，基本不丢包 | 需要 PFC / ECN 等机制避免丢包 | TCP 重传 |
| 子网内寻址 | LID | GID（来自 IP 地址） | IP 地址 |
| 地址分配 | 子网管理器 | 网口 IP 配置 | 网口 IP 配置 |
| 路由 | 子网内按 LID，跨子网用 GID | 三层 IP 路由 | 三层 IP 路由 |
| 建链 | 自行交换或 RDMA CM | 自行交换或 RDMA CM | 一般使用 RDMA CM |
| 传输类型 | RC、UC、UD 等 | RC、UC、UD 等 | 仅面向连接 |

对后续篇目来说，最重要的是寻址这一行：同样是建链时填写对端地址，InfiniBand 下填 LID，RoCE v2 下填 GID 和 GID 索引。第三篇讲初始化网卡时会看到，这些信息都来自 `ibv_query_port` 和 `ibv_query_gid` 的查询结果。

## 参考资料

规范与标准（IBTA 规范需在官网登记后下载）：

- InfiniBand Trade Association. InfiniBand Architecture Specification Volume 1. <https://www.infinibandta.org/ibta-specification/>
- InfiniBand Trade Association. Supplement to InfiniBand Architecture Specification Volume 1 Release 1.2.1, Annex A16: RoCE, April 2010.
- InfiniBand Trade Association. Supplement to InfiniBand Architecture Specification Volume 1 Release 1.2.1, Annex A17: RoCEv2, September 2014.
- IANA. Service Name and Transport Protocol Port Number Registry（UDP 4791，roce）. <https://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.xhtml?search=4791>
- R. Recio et al. RFC 5040: A Remote Direct Memory Access Protocol Specification, 2007. <https://www.rfc-editor.org/rfc/rfc5040>
- H. Shah et al. RFC 5041: Direct Data Placement over Reliable Transports, 2007. <https://www.rfc-editor.org/rfc/rfc5041>
- P. Culley et al. RFC 5044: Marker PDU Aligned Framing for TCP Specification, 2007. <https://www.rfc-editor.org/rfc/rfc5044>
- H. Shah et al. RFC 7306: Remote Direct Memory Access (RDMA) Protocol Extensions, 2014. <https://www.rfc-editor.org/rfc/rfc7306>
- IEEE 802.1Qbb: Priority-based Flow Control. <https://1.ieee802.org/dcb/802-1qbb/>
- K. Ramakrishnan, S. Floyd, D. Black. RFC 3168: The Addition of Explicit Congestion Notification (ECN) to IP, 2001. <https://www.rfc-editor.org/rfc/rfc3168>

论文：

- Y. Zhu et al. Congestion Control for Large-Scale RDMA Deployments. ACM SIGCOMM 2015. <https://www.microsoft.com/en-us/research/publication/congestion-control-for-large-scale-rdma-deployments/>（DCQCN）

文档与代码：

- NVIDIA. RDMA-Aware Networks Programming Guide. <https://networking-docs.nvidia.com/doca/sdk/rdma-aware-networks-programming-guide>
- linux-rdma. rdma-core. <https://github.com/linux-rdma/rdma-core>
- OpenSM（InfiniBand 子网管理器）. <https://github.com/linux-rdma/opensm>
