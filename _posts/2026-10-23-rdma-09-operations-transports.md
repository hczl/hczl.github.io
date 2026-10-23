---
title: "RDMA 入门（九）：操作语义与传输类型"
description: "SEND/RECV、RDMA WRITE、RDMA READ 和原子操作各自在线上带什么头部、对端要不要投递接收请求、两端各产生什么完成，以及 RC、UC、UD、XRC、DC 五种传输类型的差别：谁负责确认重传、支持哪些操作、消息能多大、连接数怎么随进程数增长，最后给出怎么选。"
date: 2026-10-23 09:38:00 +0800
tags: [RDMA, 网络, RoCE, InfiniBand]
series: rdma
series_order: 9
---

上一篇跟着一次 8 KB 的 RDMA WRITE 走完了从 `ibv_post_send` 到 `ibv_poll_cq` 的全过程。那个过程里有些步骤是 WRITE 特有的：报文带 RETH，对端不消耗接收请求，对端的应用不知道数据到了。换成 SEND、READ 或原子操作，这几处都不一样。再换成 UC 或 UD，确认和重传那些步骤也没有了。这一篇把这两个维度分开讲：前半篇是四类操作的语义，后半篇是五种传输类型。

接口以 rdma-core 的 libibverbs 为准，涉及实现的地方仍用内核的软件 RoCE 驱动 rxe 来说明，NVIDIA 网卡特有的 DC 传输用 rdma-core 的 mlx5 provider 文档。规范里的规则以 InfiniBand Architecture Specification Volume 1 为准，RoCE v2 只是换了封装，传输层的规则和 InfiniBand 相同。

## 四类操作

`ibv_post_send` 的 `opcode` 字段决定一个 WR 是哪种操作。把常用的几种按语义分成四类：

| 操作 | `opcode` | 对端要投递接收请求 | 对端产生 CQE | 请求报文里的扩展头 | 响应 |
| --- | --- | --- | --- | --- | --- |
| SEND | `IBV_WR_SEND`、`IBV_WR_SEND_WITH_IMM`、`IBV_WR_SEND_WITH_INV` | 要 | 产生 | 无；带立即数时加 4 字节 ImmDt，带失效时加 4 字节 IETH | ACK |
| RDMA WRITE | `IBV_WR_RDMA_WRITE`、`IBV_WR_RDMA_WRITE_WITH_IMM` | 不要；带立即数时要 | 不产生；带立即数时产生 | RETH 16 字节；带立即数时加 ImmDt | ACK |
| RDMA READ | `IBV_WR_RDMA_READ` | 不要 | 不产生 | RETH | 带数据的 READ RESPONSE |
| 原子操作 | `IBV_WR_ATOMIC_CMP_AND_SWP`、`IBV_WR_ATOMIC_FETCH_AND_ADD` | 不要 | 不产生 | AtomicETH 28 字节 | 带 8 字节原值的 ATOMIC ACK |

“对端要投递接收请求”这一列就是双边和单边的分界。SEND 是双边操作：对端的应用必须事先调用 `ibv_post_recv`，否则报文到了没地方放。其余三种是单边操作：对端的应用不参与，网卡自己处理，对端的 CQ 里也没有记录。WRITE 带立即数是个例外，下面单独说。

四类操作的报文都共用第八篇讲的 BTH，操作码的低 5 位区分它们。消息超过路径 MTU 时切成 FIRST、MIDDLE、LAST 报文，这套规则 SEND 和 WRITE 一样，READ 的响应也一样。READ 请求和原子操作本身总是一个报文。

{% include figure.html src="/assets/images/rdma-09-operations-transports/01-operations.svg" alt="四行示意图，每行一种操作：SEND 的请求报文只有 BTH，对端消耗一个接收 WQE 并产生 CQE；RDMA WRITE 带 RETH，对端网卡直接写内存，不消耗接收 WQE、不产生 CQE；RDMA READ 的请求带 RETH 不带数据，对端网卡读内存后用响应报文把数据送回；原子操作带 AtomicETH，对端网卡在内存上执行比较交换或取加，把原值放在 ATOMIC ACK 里送回。每行右侧标出发起方的 CQE 都由本端网卡在收到响应后产生" caption="图 1：四类操作在两端各做什么，报文里各带什么" %}

### SEND 与 RECV

SEND 的请求报文只有 BTH 和数据。对端网卡收到一条消息的第一个报文时，从 RQ（或者 SRQ，后面讲）的头部取一个接收 WQE，消息的数据按这个 WQE 的 SGE 列表依次写入，消息结束时在接收方的 CQ 里产生一条 CQE，`opcode` 是 `IBV_WC_RECV`，`byte_len` 是实际收到的长度。接收 WQE 的消耗是严格按顺序的：第 n 条消息用第 n 个接收 WQE，发送方无法指定用哪个，接收方也无法把一个 WQE 留给某条特定的消息。

接收 WQE 描述的缓冲区总长度小于消息长度时，RC 下接收方回 NAK，发送方的 WR 以 `IBV_WC_REM_INV_REQ_ERR` 失败，接收方这边那个接收 WQE 也以错误状态完成，两端的 QP 都进入错误状态。所以接收缓冲区要按双方约定的最大消息长度准备，不能按“平均长度”准备。

RQ 里没有接收 WQE 时，RC 下接收方回 RNR NAK，发送方按第六篇讲的 `rnr_retry` 和 `min_rnr_timer` 重试，重试用完后 WR 以 `IBV_WC_RNR_RETRY_EXC_ERR` 失败。这是生产中最常见的 RC 出错原因之一：接收方投递接收请求的速度跟不上发送方。常见做法是接收方一开始就投递满一整批，每取走一条 CQE 就补投一条。

`IBV_WR_SEND_WITH_IMM` 在消息最后一个报文的 BTH 后面加 4 字节的 ImmDt 头，放 WR 里的 `imm_data`。这 4 字节不写入接收缓冲区，而是出现在接收方 CQE 的 `imm_data` 字段，`wc_flags` 带 `IBV_WC_WITH_IMM`。网卡不解释它的内容，常用来传消息类型、序号这类元数据，省得接收方从缓冲区里解析。`imm_data` 是网络字节序，两端要一致地转换。

`IBV_WR_SEND_WITH_INV` 加的是 4 字节的 IETH 头，放 WR 里的 `invalidate_rkey`。接收方网卡在交付这条消息之前让这个 rkey 失效，接收方 CQE 的 `invalidated_rkey` 字段给出被失效的 rkey，`wc_flags` 带 `IBV_WC_WITH_INV`。这是第五篇说的类型 2 内存窗口的远程失效方式，NVMe over Fabrics 这类协议用它：目标端读写完发起端的缓冲区，用带失效的 SEND 回状态，发起端收到时那块内存已经收回了，不用再投递一次 `IBV_WR_LOCAL_INV`。`IBV_WC_WITH_IMM` 和 `IBV_WC_WITH_INV` 不能同时出现，因为一个报文里 ImmDt 和 IETH 只能带一个。

SEND 的 WR 上可以设 `IBV_SEND_INLINE`，把数据直接写进 WQE，网卡不再按 lkey 去 DMA 读缓冲区，`ibv_post_send` 返回后缓冲区就可以复用。能内联的长度由创建 QP 时的 `max_inline_data` 决定，第四篇讲过。RDMA WRITE 也可以内联，READ 和原子操作不行。

### RDMA WRITE

WRITE 的全过程第八篇讲过，这里只补语义上的几点。

对端的 QP 要在 INIT 时开放 `IBV_ACCESS_REMOTE_WRITE`，目标 MR 注册时要带同样的权限，两者缺一个，对端网卡回 NAK（远程访问错误），发起方的 WR 以 `IBV_WC_REM_ACCESS_ERR` 失败。

对端的应用不知道数据到了。发起方的 CQE 只表示对端网卡已经确认写入，不表示对端的应用看过数据。要让对端知道，有三种做法：发起方再发一条 SEND 告诉它；用 `IBV_WR_RDMA_WRITE_WITH_IMM`；对端自己轮询内存里的标志。前两种有规范保证：同一个 RC QP 上的操作按投递顺序执行，后一条消息在接收方产生 CQE 时，前一条 WRITE 的数据已经写到接收方的内存里。第三种没有规范保证：规范只规定一条消息完成时数据全部可见，不规定一条消息内部各字节落地的顺序，所以轮询缓冲区末尾的字节来判断整条消息到齐，依赖具体网卡的实现。

`IBV_WR_RDMA_WRITE_WITH_IMM` 的报文和 WRITE 一样带 RETH，最后一个报文多带 ImmDt。接收方网卡在消息结束时消耗一个接收 WQE，产生一条 `opcode` 为 `IBV_WC_RECV_RDMA_WITH_IMM` 的 CQE，`imm_data` 有效，`byte_len` 是这次 WRITE 写入的长度。数据写在 RETH 指定的地址，接收 WQE 的缓冲区不用，长度为 0 的 SGE 列表也可以。所以 WRITE_WITH_IMM 是单边写入加一个双边的通知，接收方同样要提前投递接收请求，RQ 空了同样会 RNR。

### RDMA READ

READ 的请求报文带 RETH，不带数据；对端网卡检查权限（`IBV_ACCESS_REMOTE_READ`）和 rkey 之后从自己的内存读数据，切成 READ RESPONSE 报文送回，发起方网卡按请求的 SGE 列表把数据写进本地内存。发起方 CQE 的 `opcode` 是 `IBV_WC_RDMA_READ`，`byte_len` 是读到的长度。对端的应用同样不参与，CQ 里同样没有记录。

READ 占用第六篇讲的响应方资源：对端要记住每个未完成的 READ，直到全部响应发完，所以本端同时在途的 READ 数不能超过 `max_rd_atomic`，对端的 `max_dest_rd_atomic` 要不小于它。超过时网卡不会报错，后面的 READ 在 SQ 里等前面的完成，表现为延迟增加。一次 READ 的往返是请求过去、数据回来，比 WRITE 多半个来回，所以同样的数据量，发起方 WRITE 到对端比发起方从对端 READ 快一些，很多协议因此让持有数据的一方做 WRITE，而不是让需要数据的一方做 READ。

READ 完成的顺序和它后面的 WR 有一个常见的坑。同一个 QP 上的 WR 按顺序开始执行，但 READ 和原子操作是等响应回来才完成的，而后面的 SEND 或 WRITE 不等前面的 READ 响应回来就可以发出。如果后一个 WR 要用前一个 READ 读回来的数据（例如把读到的数据再 SEND 给第三方），就要在后一个 WR 上设 `IBV_SEND_FENCE`：网卡等前面所有 READ 和原子操作完成后才开始执行它。rxe 的实现是 `rxe_req.c` 里的 `rxe_wqe_is_fenced`：带 FENCE 的 WQE 要等在途的 READ 和原子操作计数回到零。`ibv_post_send` 的手册页说明 `IBV_SEND_FENCE` 只对 RC 类型有效。

### 原子操作

两种原子操作都作用在对端内存里的 8 字节：

- `IBV_WR_ATOMIC_CMP_AND_SWP`（比较并交换）：读出 8 字节原值，等于 `compare_add` 则写入 `swap`，不等则不写；原值送回发起方。
- `IBV_WR_ATOMIC_FETCH_AND_ADD`（取并加）：读出 8 字节原值，加上 `compare_add` 后写回；原值送回发起方。

WR 里的 `wr.atomic` 给出 `remote_addr`、`rkey`、`compare_add`、`swap`，请求报文带 28 字节的 AtomicETH：8 字节地址、4 字节 rkey、8 字节交换值或加数、8 字节比较值。响应是 ATOMIC ACK，AETH 后面跟 8 字节的 ATOMIC ACK ETH，放原值。发起方网卡把原值写进 WR 的 SGE 指向的本地缓冲区（长度 8 字节），CQE 的 `opcode` 是 `IBV_WC_COMP_SWAP` 或 `IBV_WC_FETCH_ADD`。

原子操作的约束：

- 对端地址必须 8 字节对齐，否则对端回 NAK（无效请求），发起方的 WR 以 `IBV_WC_REM_INV_REQ_ERR` 失败。rxe 的响应方为此专门有一个状态 `RESPST_ERR_MISALIGNED_ATOMIC`。
- 对端 QP 和目标 MR 都要有 `IBV_ACCESS_REMOTE_ATOMIC`。
- 和 READ 一样占用响应方资源，受 `max_rd_atomic` 和 `max_dest_rd_atomic` 限制，也受 `IBV_SEND_FENCE` 约束。

原子性的范围由 `ibv_query_device` 返回的 `atomic_cap` 说明：`IBV_ATOMIC_NONE` 不支持原子操作；`IBV_ATOMIC_HCA` 表示只在同一块网卡处理的原子操作之间保证原子性；`IBV_ATOMIC_GLOB` 表示还和主机 CPU 的原子指令之间保证原子性。只有 `IBV_ATOMIC_GLOB` 时，对端的 CPU 才能用自己的原子指令和远端的原子操作同时改一个计数器。这个值取决于网卡和主机平台，程序要在用之前查，不要假设。

原子操作每次只处理 8 字节，一个往返才完成一次，吞吐远低于 WRITE，用途是分布式锁、远程计数器、无锁队列的尾指针这类同步原语，不是搬数据。

### 消息长度

SEND、WRITE 和 READ 一条消息的上限是 `ibv_query_port` 返回的 `max_msg_sz`，rxe 给的是 2^31 字节。超过上限的 WR 在 `ibv_post_send` 时不一定被拒绝，可能以本地长度错误完成，所以大块数据按这个值分段。UD 的上限是路径 MTU，下面讲。

## 五种传输类型

`ibv_create_qp` 的 `qp_type` 决定传输类型，创建后不能改。libibverbs 的 `enum ibv_qp_type` 里和本文有关的是 `IBV_QPT_RC`、`IBV_QPT_UC`、`IBV_QPT_UD`、`IBV_QPT_XRC_SEND`、`IBV_QPT_XRC_RECV`，还有 `IBV_QPT_DRIVER` 给厂商扩展用，mlx5 的 DC 走这个值。

| | RC | UC | UD | XRC | DC |
| --- | --- | --- | --- | --- | --- |
| 对端 | 固定一个 | 固定一个 | 每次发送时指定 | 发送方固定到对端节点，接收方由 SRQ 编号指定 | 每次发送时指定 |
| 确认、重传、保序 | 有 | 无 | 无 | 有 | 有 |
| SEND | 支持 | 支持 | 支持 | 支持 | 支持 |
| RDMA WRITE | 支持 | 支持 | 不支持 | 支持 | 支持 |
| RDMA READ、原子操作 | 支持 | 不支持 | 不支持 | 支持 | 支持 |
| 消息长度上限 | `max_msg_sz` | `max_msg_sz` | 路径 MTU | `max_msg_sz` | `max_msg_sz` |
| 规范 | IBTA 卷 1 | IBTA 卷 1 | IBTA 卷 1 | IBTA 卷 1 附录 A14 | NVIDIA 私有 |

`ibv_post_send` 的手册页有一张操作码和传输类型的对照表，和上表一致：UD 只有 SEND 和 SEND_WITH_IMM；UC 多了 WRITE、WRITE_WITH_IMM 和内存窗口相关的几个；READ 和原子操作只有 RC 和 XRC。BTH 操作码的高 3 位就是传输类型：RC 为 000，UC 为 001，RD 为 010，UD 为 011，XRC 为 101（这是第八篇那张表的另一半）。RD（可靠数据报）在规范里有定义，没有网卡实现，libibverbs 也没有对应的 QP 类型，这里不讲。

### RC

前八篇讲的都是 RC：一个 QP 对一个 QP，建链时交换 QPN、PSN 和地址，网卡做 ACK、超时重传、PSN 保序，四类操作都支持。缺点只有一个，就是连接数。N 个节点每个节点 P 个进程，每个进程要和其他所有进程通信，每个进程要建 (N − 1) × P 个 RC QP，每个节点上有 (N − 1) × P × P 个，网卡要为每个 QP 保存上下文，第四篇说过上下文放不进网卡缓存时性能下降。后面三种类型都是为了减少这个数。

### UC

UC 和 RC 一样是一对一的连接，状态机也一样要从 INIT 到 RTR 到 RTS，RTR 时同样要填对端的 QPN、起始 PSN 和地址向量。区别是接收方不回 ACK，发送方不重传，所以 RTS 时不用填 `timeout`、`retry_cnt`、`rnr_retry`，RTR 时不用填 `max_dest_rd_atomic`，`ibv_modify_qp` 的手册页列出了 UC 各状态的必填属性。

发送方 CQE 的含义变了：RC 下 CQE 表示对端网卡已经确认收到，UC 下 CQE 只表示本端网卡已经把报文发出去。丢包时接收方怎么处理，rxe 的 `rxe_resp.c` 写得很直接：PSN 对不上时，如果这个报文是一条消息的 FIRST 或 ONLY，从它开始正常接收；否则丢掉这个报文，并把 `drop_msg` 置 1，这条消息后面的报文全部丢掉，直到下一条消息的第一个报文到来。也就是说 UC 下丢一个报文丢掉整条消息，但不影响后面的消息，QP 也不进入错误状态。接收方不会产生任何记录，发送方也不知道。

UC 适合的场景是丢了也没关系、重传反而误事的数据，比如实时视频流。实际用得很少：RoCE 网络上一般配了 PFC 或者 ECN，RC 的重传很少触发，RC 的开销和 UC 差别不大，UC 又少了 READ 和原子操作。

### UD

UD 没有连接。一个 UD QP 可以向任意多个对端发送，也接收来自任意对端的消息。状态机还是 INIT、RTR、RTS 三步，但 INIT 时要填 `qkey`，RTR 时除了状态什么都不用填，RTS 时只填 `sq_psn`。对端信息不在 QP 上下文里，而是每次发送时在 WR 的 `wr.ud` 里给：

```c
wr.wr.ud.ah          = ah;          /* ibv_create_ah 创建，记录对端的 GID、流量类别等 */
wr.wr.ud.remote_qpn  = remote_qpn;  /* 对端 QPN */
wr.wr.ud.remote_qkey = remote_qkey; /* 对端 QP 的 Q_Key */
```

AH 是第四篇提到的地址句柄，用 `ibv_create_ah` 从 `struct ibv_ah_attr` 创建，内容就是第六篇 RTR 时填进 `ah_attr` 的那些字段：目的 GID、源 GID 索引、流量类别、跳数限制、服务等级。RC 把这些信息在建链时写进 QP 上下文，UD 把它们放在 AH 里，每个 WR 指一个 AH。一个进程要和一千个对端通信，RC 要建一千个 QP，UD 只要一个 QP 和一千个 AH，AH 比 QP 轻得多。

报文格式上，UD 的 BTH 后面多一个 8 字节的 DETH：4 字节 Q_Key，4 字节源 QPN。接收方网卡从 BTH 的目的 QPN 找到 QP 之后，比较 DETH 里的 Q_Key 和这个 QP 的 `qkey`，不一致就丢弃并把端口的 `qkey_viol_cntr` 计数器加一，rxe 在 `rxe_recv.c` 的 `check_keys` 里做这个检查。Q_Key 是 UD 下唯一的访问控制：没有连接，任何知道 QPN 的人都能发报文过来，Q_Key 不对的报文到不了应用。Q_Key 的最高位为 1 时有特殊含义（特权 Q_Key，只有内核能用，QP1 用的 0x80010000 就是），应用自己选的 Q_Key 最高位要为 0。

接收方 CQE 的 `src_qp` 是 DETH 里的源 QPN，`wc_flags` 带 `IBV_WC_GRH` 时接收缓冲区的前 40 字节是 GRH（RoCE 下是 IP 头，rxe 把 IPv4 头拷到这 40 字节里，IPv6 头本身就是 40 字节），消息数据从第 41 字节开始。`ibv_post_recv` 的手册页说得很明确：UD QP 的接收缓冲区无论有没有 GRH，数据都从偏移 40 开始，前 40 字节在没有 GRH 时内容未定义。所以 UD 的接收缓冲区要比最大消息多留 40 字节，取数据时要跳过它们。接收方靠 `src_qp` 和 GRH 里的源地址知道报文来自谁，要回复时就用这两个值创建 AH。

一条 UD 消息不能超过路径 MTU，因为没有 PSN 和重组，网卡不切包。规范（C10-93.1.1）规定超过 MTU 的 UD 消息一个报文都不发，而且不算错误；rxe 的 `rxe_req.c` 照此实现：对超长的 UD WR 直接“伪造”一个成功的完成。所以 UD 下 CQE 成功不代表发出去了，消息长度要应用自己保证。路径 MTU 限制的是消息数据，接收缓冲区还要在这个基础上多留 40 字节放 GRH。UD 也没有 ACK，发送方不知道对端有没有收到，可靠性要应用自己做。

UD 是唯一支持组播的类型：QP 用 `ibv_attach_mcast` 加入一个组播组后，发往组播 GID 的报文会被组里所有 QP 收到。UD 的用途：第七篇讲的 CM 报文走 QP1，是 UD；IPoIB 的数据报模式是 UD；MPI 库在进程数很多时用 UD 发小消息，自己做可靠性。

### SRQ

接下来两种类型都建立在 SRQ 上，先讲 SRQ。

RC 下每个 QP 有自己的 RQ，接收缓冲区要按 QP 预留：一千个连接，每个投递 64 个 4 KB 的接收请求，就是 256 MB，而同一时刻只有少数连接在收数据。SRQ（Shared Receive Queue，共享接收队列）让多个 QP 共用一个接收队列：用 `ibv_create_srq` 在 PD 下创建，`max_wr` 和 `max_sge` 和 RQ 的含义一样，创建 QP 时把 `srq` 字段指向它，这个 QP 的 `max_recv_wr` 和 `max_recv_sge` 就被忽略了。接收请求用 `ibv_post_srq_recv` 投递到 SRQ 上，哪个 QP 先收到消息就从 SRQ 头部取走一个 WQE，CQE 还是进该 QP 的 `recv_cq`，`qp_num` 字段说明是哪个 QP 收的。

SRQ 多了一个 `srq_limit`：用 `ibv_modify_srq` 设置一个阈值，SRQ 里的 WQE 数降到阈值以下时产生一个 `IBV_EVENT_SRQ_LIMIT_REACHED` 异步事件，应用收到后补投，比按 QP 盯着方便。SRQ 不能解决 RNR 的问题，只是把补投集中到一个地方。

### XRC

XRC（eXtended Reliable Connected，扩展可靠连接）是 IBTA 规范附录 A14 定义的，目标是把每个节点上的 RC QP 数从 (N − 1) × P × P 降到 (N − 1) × P 量级。做法是把 RC 的“一个 QP 对一个 QP”改成“一个发送 QP 对一个节点”：发送方的一个 XRC QP 连到对端节点的一个 XRC 接收 QP，报文里带一个 SRQ 编号，对端节点上哪个进程收由这个编号决定，不同进程各有自己的 SRQ。

涉及的对象：

- XRC 域（`struct ibv_xrcd`）：用 `ibv_open_xrcd` 打开，参数是一个文件描述符和 `O_CREAT`、`O_EXCL` 标志。同一节点上多个进程要共用一个 XRC 域，就打开同一个文件，内核用 inode 来识别是同一个域；`fd` 填 −1 时创建一个只有本进程用的域。
- XRC SRQ：`ibv_create_srq_ex` 创建，`srq_type` 为 `IBV_SRQT_XRC`，要给 `xrcd` 和 `cq`，因为收到的消息要进哪个 CQ 不再由 QP 决定，而由 SRQ 决定。SRQ 的编号 `srq_num` 要告诉发送方。
- 发送 QP：`qp_type` 为 `IBV_QPT_XRC_SEND`，用 `ibv_create_qp_ex` 创建，像 RC 一样有 SQ 和 `send_cq`，没有 RQ。
- 接收 QP：`qp_type` 为 `IBV_QPT_XRC_RECV`，创建时给 `xrcd`，没有 SQ 也没有 RQ，只是一个接收端点，所在节点上所有打开同一个 XRC 域的进程都可以通过它收消息。

发送时在 WR 里填目标 SRQ 的编号：老接口是 `wr.qp_type.xrc.remote_srqn`，新接口是 `ibv_wr_set_xrc_srqn`。报文里 BTH 后面多一个 4 字节的 XRCETH，放这个编号；对端网卡找到接收 QP 后，再按 XRCETH 里的编号找 SRQ，从那个 SRQ 取接收 WQE，CQE 进那个 SRQ 的 CQ。RDMA WRITE 和 READ 也一样要填 `remote_srqn`，虽然它们不消耗接收 WQE，规范仍要求报文带 XRCETH。

建链比 RC 复杂：接收 QP 在创建它的进程里建，别的进程通过 `ibv_open_qp` 按 QPN 打开它才能让它在自己这里持续存在，状态机的推进也要由某个进程来做。librdmacm 支持 XRC（`RDMA_PS_IB` 端口空间），MPI 库是 XRC 的主要用户。

### DC

DC（Dynamically Connected，动态连接）是 NVIDIA 网卡的私有传输，从 Connect-IB 开始支持，目标是把每个进程的 QP 数降到常数。接口在 rdma-core 的 mlx5 provider 里：`mlx5dv_create_qp`，`qp_type` 填 `IBV_QPT_DRIVER`，`comp_mask` 带 `MLX5DV_QP_INIT_ATTR_MASK_DC`，`dc_init_attr.dc_type` 选：

- `MLX5DV_DCTYPE_DCI`：发起端（DC Initiator），像 RC 的发送端，但对端不固定，每个 WR 用 AH 加对端的 DCT 编号指定目标，一次发送前网卡先和对端的 DCT 建立一条临时连接，消息发完就拆掉，下一个 WR 发给别的对端时再建。
- `MLX5DV_DCTYPE_DCT`：目标端（DC Target），没有 SQ，创建时给 `dct_access_key`，发起端要带同样的值才能连上，作用类似 UD 的 Q_Key；收消息走 SRQ。

DC 的报文有 ACK 和重传，语义和 RC 一样，四类操作都支持，一个 DCI 可以依次和任意多个 DCT 通信。代价是每次换对端要多一个建连的往返，所以 mlx5 允许一个 DCI 开多条并发的流（`dci_streams`）。一个进程只要几个 DCI 和一个 DCT，QP 数和节点数、进程数无关。DC 不在 IBTA 规范里，也不在 libibverbs 的通用接口里，只有 NVIDIA 网卡上的 UCX、MPI 这类库在用。

### rdma_cm 的端口空间

第七篇讲 `rdma_create_id` 的 `ps` 参数时只说了 `RDMA_PS_TCP` 用于 RC。`rdma_create_id` 的手册页给出完整的对应关系：`RDMA_PS_TCP` 是可靠的、面向连接的 QP，对应 RC；`RDMA_PS_UDP` 是不可靠、无连接的 QP，对应 UD，也支持组播；`RDMA_PS_IB` 对应任何 InfiniBand 传输服务，包括 UD、UC、RC、XRC。UD 下 `rdma_connect` 并不建立连接，只是和对端交换 QPN 和 Q_Key，`RDMA_CM_EVENT_ESTABLISHED` 事件的 `param.ud` 里带回对端的 `qp_num`、`qkey` 和创建 AH 用的 `ah_attr`，之后也不需要 `rdma_disconnect`。

{% include figure.html src="/assets/images/rdma-09-operations-transports/02-transports.svg" alt="三组示意图：RC 下节点 A 的每个进程和节点 B 的每个进程之间各有一对 QP；UD 下每个进程只有一个 QP，对端用 AH 指定，报文带 Q_Key；XRC 下每个进程只有一个发送 QP 连到对端节点的接收 QP，对端节点上各进程各有一个 SRQ，报文里的 SRQ 编号决定进哪个 SRQ" caption="图 2：RC、UD、XRC 下两个节点各两个进程之间的 QP 布局" %}

## 怎么选

- 默认用 RC。语义最完整，所有网卡都支持，librdmacm 支持最好，连接数在几百个以内时不用考虑别的。
- 对端很多、消息很小、能接受应用层做可靠性，或者需要组播：UD。
- 对端很多、需要 RC 的语义：NVIDIA 网卡上用 DC，其他网卡用 XRC；两者都要自己管理 SRQ，一般通过 UCX、MPI 这类库间接使用。
- UC 基本不用。

操作的选择：双方都要知道消息边界和到达时机的，用 SEND；大块数据、持有数据的一方知道对端缓冲区地址的，用 WRITE，再用 SEND 或 WRITE_WITH_IMM 通知；需要数据的一方主动拉取、不想打扰对端的，用 READ；同步原语用原子操作。

## 这一步的产出

到这里，一次 RDMA 通信的正常路径讲完了：第一篇的流程图上每一步都展开过，这一篇补上了流程图没画的另外三类操作和另外四种传输类型。实际程序里最常见的组合是 RC 加 SEND/RECV 和 RDMA WRITE，大多数问题也出在这个组合上。下一篇讲出错：第八篇对端的十项检查不通过时各回什么 NAK，超时和重传怎么工作，CQE 里的各种错误状态是什么意思，QP 进入错误状态后怎么恢复。

## 参考资料

接口文档（rdma-core man page）：

- ibv_post_send(3)（`struct ibv_send_wr` 的 `rdma`、`atomic`、`ud`、`xrc` 字段，`send_flags`，各传输类型支持的操作码表）. <https://man7.org/linux/man-pages/man3/ibv_post_send.3.html>
- ibv_post_recv(3)（UD 接收缓冲区前 40 字节放 GRH）. <https://man7.org/linux/man-pages/man3/ibv_post_recv.3.html>
- ibv_poll_cq(3)（`struct ibv_wc` 的 `imm_data`、`invalidated_rkey`、`src_qp`，`wc_flags` 的 `IBV_WC_GRH`、`IBV_WC_WITH_IMM`、`IBV_WC_WITH_INV`）. <https://man7.org/linux/man-pages/man3/ibv_poll_cq.3.html>
- ibv_wr_post(3)（`ibv_wr_atomic_cmp_swp`、`ibv_wr_atomic_fetch_add`、`ibv_wr_send_imm`、`ibv_wr_send_inv`、`ibv_wr_set_ud_addr`、`ibv_wr_set_xrc_srqn`，以及每种操作适用的 QP 类型表）. <https://man7.org/linux/man-pages/man3/ibv_wr_post.3.html>
- ibv_create_qp_ex(3)（`struct ibv_qp_init_attr_ex` 的 `qp_type`、`xrcd`、`srq`）. <https://man7.org/linux/man-pages/man3/ibv_create_qp_ex.3.html>
- ibv_open_qp(3)（打开别的进程创建的 XRC 接收 QP）. <https://man7.org/linux/man-pages/man3/ibv_open_qp.3.html>
- ibv_open_xrcd(3)（`fd`、`O_CREAT`、`O_EXCL` 的含义）. <https://man7.org/linux/man-pages/man3/ibv_open_xrcd.3.html>
- ibv_create_srq(3)、ibv_create_srq_ex(3)（`struct ibv_srq_init_attr_ex` 的 `srq_type`、`xrcd`、`cq`）. <https://man7.org/linux/man-pages/man3/ibv_create_srq.3.html>、<https://man7.org/linux/man-pages/man3/ibv_create_srq_ex.3.html>
- ibv_post_srq_recv(3). <https://man7.org/linux/man-pages/man3/ibv_post_srq_recv.3.html>
- ibv_modify_srq(3)（`srq_limit` 和 `IBV_EVENT_SRQ_LIMIT_REACHED`）. <https://man7.org/linux/man-pages/man3/ibv_modify_srq.3.html>
- ibv_modify_qp(3)（UD、UC、RC 各状态的必填属性表）. <https://man7.org/linux/man-pages/man3/ibv_modify_qp.3.html>
- ibv_create_ah(3)（`struct ibv_ah_attr`）. <https://man7.org/linux/man-pages/man3/ibv_create_ah.3.html>
- ibv_attach_mcast(3)（UD 组播）. <https://man7.org/linux/man-pages/man3/ibv_attach_mcast.3.html>
- ibv_query_device(3)（`atomic_cap`、`max_qp_rd_atom`、`max_qp_init_rd_atom`）. <https://man7.org/linux/man-pages/man3/ibv_query_device.3.html>
- ibv_query_port(3)（`max_msg_sz`、`qkey_viol_cntr`、`bad_pkey_cntr`）. <https://man7.org/linux/man-pages/man3/ibv_query_port.3.html>
- mlx5dv_create_qp(3)（`MLX5DV_QP_INIT_ATTR_MASK_DC`、`mlx5dv_dc_init_attr`、`MLX5DV_DCTYPE_DCI`、`MLX5DV_DCTYPE_DCT`、`dct_access_key`、`dci_streams`）. <https://github.com/linux-rdma/rdma-core/blob/master/providers/mlx5/man/mlx5dv_create_qp.3.md>
- rdma_create_id(3)（`RDMA_PS_TCP`、`RDMA_PS_UDP`、`RDMA_PS_IB` 各提供什么服务）. <https://man7.org/linux/man-pages/man3/rdma_create_id.3.html>
- rdma_cm(7)（UD 下的建链过程）. <https://man7.org/linux/man-pages/man7/rdma_cm.7.html>

内核源码（Linux 软件 RoCE 驱动 `drivers/infiniband/sw/rxe/`）：

- `rxe_hdr.h`（DETH、AtomicETH、ATOMIC ACK ETH、ImmDt、IETH 的结构和长度）
- `rxe_opcode.c`（UD、UC、RC 各操作码带哪些头部）
- `rxe_req.c`（`rxe_wqe_is_fenced` 的 FENCE 实现、超过 MTU 的 UD 消息的处理、各传输类型的操作码选择）
- `rxe_resp.c`（UC 下 PSN 不连续时的 `drop_msg`、UD 接收时 40 字节 GRH 的写入、WRITE_WITH_IMM 消耗接收 WQE 和 CQE 的 `IB_WC_RECV_RDMA_WITH_IMM`、`RESPST_ERR_MISALIGNED_ATOMIC`）
- `rxe_recv.c`（`check_keys`：P_Key 和 Q_Key 检查及计数器）
- `rxe_param.h`（`RXE_PORT_MAX_MSG_SZ`）
- <https://github.com/torvalds/linux/tree/master/drivers/infiniband/sw/rxe>
- Linux `include/rdma/ib_verbs.h`（`enum ib_atomic_cap`）. <https://github.com/torvalds/linux/blob/master/include/rdma/ib_verbs.h>
- Linux `include/rdma/ib_pack.h`（`IB_GRH_BYTES`、`IB_DETH_BYTES` 等头部长度）. <https://github.com/torvalds/linux/blob/master/include/rdma/ib_pack.h>

规范与手册：

- InfiniBand Trade Association. InfiniBand Architecture Specification Volume 1（第 9 章传输层：各传输服务类型、操作语义、原子操作的对齐和原子性要求、FENCE、UD 消息长度 C10-93.1.1；第 5 章 DETH、AtomicETH、ImmDt、IETH 的格式）. <https://www.infinibandta.org/ibta-specification/>
- InfiniBand Trade Association. Annex A14: Extended Reliable Connected (XRC) Transport Service（XRC 域、XRC SRQ、XRCETH）. <https://www.infinibandta.org/ibta-specification/>
- NVIDIA. RDMA-Aware Networks Programming Guide（传输类型一节、UD 和 AH 的用法）. <https://networking-docs.nvidia.com/doca/sdk/rdma-aware-networks-programming-guide>
