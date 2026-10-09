---
title: "RDMA 入门（四）：创建资源：PD、CQ 与 QP"
description: "保护域、完成队列、队列对分别是什么，创建时每个参数管什么、填多大合适，网卡和驱动在这一步分配了什么，以及 QPN 从哪里来。"
date: 2026-10-09 15:30:00 +0800
tags: [RDMA, 网络, RoCE, InfiniBand]
series: rdma
series_order: 4
---

上一篇结束时，应用拿到了设备上下文，也查清了网卡的各项上限。接下来要创建通信用的资源。按依赖关系，顺序一般是：先分配保护域（PD），再创建完成队列（CQ），然后创建队列对（QP）；内存注册（MR）也挂在 PD 下，这一篇先只把 MR 当作网卡能直接访问的一段内存，注册过程在下一篇。

读示例代码时，这一段通常只有几行，参数大多照抄：`ibv_create_cq` 的深度填个 1024，`max_send_wr` 填个 128，`max_inline_data` 填 0 或 64。这一篇逐个说明这些参数管什么，填小了、填大了各会怎样，以及 QP 创建出来时网卡上多了什么。建链要交换的 QPN，就是在这一步产生的。

文中涉及驱动实现的地方，仍以 NVIDIA 网卡使用的 mlx5 驱动为例。

## 资源之间的关系

先看这几类对象挂在哪里：

| 对象 | 创建接口 | 属于 | 作用 |
| --- | --- | --- | --- |
| PD | `ibv_alloc_pd` | 设备上下文 | 保护域，划定哪些 QP 能访问哪些内存 |
| MR | `ibv_reg_mr` | PD | 一段已注册的内存，网卡可以直接 DMA 读写 |
| CQ | `ibv_create_cq` | 设备上下文 | 存放完成通知（CQE） |
| QP | `ibv_create_qp` | PD | 一对发送队列（SQ）和接收队列（RQ），通信的端点 |
| SRQ | `ibv_create_srq` | PD | 共享接收队列，多个 QP 共用一组接收请求（可选） |
| AH | `ibv_create_ah` | PD | 地址句柄，记录对端地址，只在 UD 等无连接类型下使用 |

{% include figure.html src="/assets/images/rdma-04-resources/01-objects.svg" alt="设备上下文下有 PD 和 CQ；QP、MR、SRQ 属于 PD；QP 的发送队列和接收队列各自关联一个 CQ，CQ 可以挂一个完成事件通道" caption="图 1：资源之间的关系" %}

值得注意的是 CQ 不属于任何 PD，它直接挂在设备上下文下。CQ 里只有完成通知，不涉及访问内存的权限，所以不需要保护域约束。一个 CQ 可以被多个 QP 共用，同一个 QP 的 SQ 和 RQ 也可以用同一个 CQ，或者各用一个。

## 保护域：ibv_alloc_pd

`ibv_alloc_pd(context)` 没有其他参数，返回一个 `struct ibv_pd`。它在网卡上分配一个保护域编号（mlx5 中叫 pdn），之后创建的 QP 和注册的 MR 都会记下自己属于哪个保护域。

保护域的检查由网卡在每次访问内存时完成：

- 本端发送时，WQE 里的每个 SGE 都带一个 lkey。网卡用 lkey 找到对应的 MR，检查这个 MR 和发起请求的 QP 是否属于同一个 PD，地址范围是否落在 MR 内，权限是否允许本地读写。
- 对端发来 RDMA WRITE、READ 或原子操作时，报文的 RETH 里带着 rkey。网卡用 rkey 找到 MR，检查它和接收这个报文的 QP 是否属于同一个 PD，以及 MR 是否开放了对应的远程访问权限。

任何一项检查不通过，本端会得到本地保护错误，对端的请求则被拒绝，发起方收到远程访问错误。这些错误都会让 QP 进入错误状态。

保护域的意义在于隔离：即使对端拿到了某个 rkey，也只能通过同一个 PD 下的 QP 使用它。一个进程里多个互不信任的模块（例如服务多个租户）可以各用一个 PD，彼此的内存就不会被对方的连接访问到。大多数程序只用一个 PD，所有 QP 和 MR 都放在里面。

释放时顺序相反：PD 下还有 QP、MR 等资源没有销毁时，`ibv_dealloc_pd` 会失败。

## 完成队列：ibv_create_cq

应用通过 `ibv_post_send`、`ibv_post_recv` 把工作请求（WR）投递给网卡，网卡执行完后，在 CQ 里写一条完成通知（CQE）。应用从 CQ 里取出 CQE，才知道某个请求是否完成、是否出错。

```c
struct ibv_cq *ibv_create_cq(struct ibv_context *context, int cqe,
                             void *cq_context,
                             struct ibv_comp_channel *channel,
                             int comp_vector);
```

### cqe：CQ 的深度

`cqe` 是 CQ 至少要能容纳的 CQE 条数，不能超过 `ibv_query_device` 返回的 `max_cqe`。驱动可能分配得比请求的更多（mlx5 会向上取整到 2 的幂），实际容量写在返回的 `cq->cqe` 里。

深度要按最坏情况估算：所有挂在这个 CQ 上的队列，可能同时产生、但应用还没取走的 CQE 总数。例如 8 个 QP 共用一个 CQ，每个 QP 的 SQ 深度 128、RQ 深度 512，并且所有发送请求都要求产生 CQE，那么 CQ 至少要有 8 × (128 + 512) = 5120 项。

CQ 填满后网卡还要写入新的 CQE，就是 CQ 溢出。溢出不会静默丢掉 CQE：网卡通过异步事件上报 `IBV_EVENT_CQ_ERR`，CQ 进入错误状态，挂在它上面的 QP 也无法继续工作。所以 CQ 深度宁可大一些，代价只是多占一些内存。

### CQE 的内容

`ibv_poll_cq` 每次取出若干条 CQE，每条填进一个 `struct ibv_wc`。和通信关系最密切的字段：

| 字段 | 含义 |
| --- | --- |
| `wr_id` | 投递请求时应用填的 64 位标识，原样带回。应用靠它找到是哪个请求完成了 |
| `status` | 完成状态。`IBV_WC_SUCCESS` 表示成功，其余都是错误，例如重试次数用尽、远程访问错误 |
| `opcode` | 完成的是哪类操作：SEND、RDMA WRITE、RDMA READ、接收等 |
| `qp_num` | 这条 CQE 属于哪个本端 QP。多个 QP 共用一个 CQ 时靠它区分 |
| `byte_len` | 接收完成时，实际收到的数据长度 |
| `imm_data`、`wc_flags` | 立即数（immediate data）是发送方随 SEND 或 RDMA WRITE 附带的 32 位数据，放在报文头里，不占接收缓冲区，直接出现在接收方的 CQE 中，常用来通知对端“数据已经写完”或者传一个编号。`wc_flags` 含 `IBV_WC_WITH_IMM` 时，`imm_data` 就是这个值 |
| `src_qp`、`slid` | 发送方的 QPN 和 LID。主要在 UD（不可靠数据报，一个 QP 可以和任意多个对端通信，见下文“qp_type：传输类型”）下使用，接收方靠它们知道报文来自谁；RC 下对端固定，一般不需要看 |
| `vendor_err` | 出错时的厂商错误码，排查问题时有用 |

`ibv_poll_cq` 不经过内核：CQ 的缓冲区在用户态分配，由内核锁定物理页后交给网卡，网卡直接把 CQE 写进这块内存，provider 读取并检查每条 CQE 的有效标志即可。这也是轮询方式延迟最低的原因。

### 完成事件：channel 和 comp_vector

不想一直轮询时，可以让 CQ 在有新 CQE 时发出事件：

1.  先用 `ibv_create_comp_channel` 创建一个完成事件通道，它对应一个文件描述符，可以放进 `epoll` 等待。
2.  创建 CQ 时把这个通道传给 `channel` 参数。
3.  调用 `ibv_req_notify_cq` 让 CQ 在下一条 CQE 到来时触发事件。这个设置是一次性的，收到一次事件后要重新调用。
4.  用 `ibv_get_cq_event` 取得事件，再用 `ibv_poll_cq` 把 CQE 取空，并用 `ibv_ack_cq_events` 确认事件。

事件方式需要经过中断和内核，延迟比轮询高，但不占用 CPU。常见做法是两者结合：收到事件后连续轮询，取空后再重新等待事件。

`comp_vector` 指定完成事件走哪个中断向量，取值从 0 到 `context->num_comp_vectors - 1`。不同中断向量可以绑定到不同 CPU 核上，多个 CQ 分散到不同向量，就能把中断处理分散到多个核。只用轮询时，这个参数填 0 即可。

`cq_context` 是应用自己的指针，在 `ibv_get_cq_event` 取得事件时原样带回，用来找到对应的应用数据结构。

## 队列对：ibv_create_qp

QP 是通信的端点。建链就是把本端的一个 QP 和对端的一个 QP 配成一对，之后所有数据收发都通过它进行。

```c
struct ibv_qp *ibv_create_qp(struct ibv_pd *pd,
                             struct ibv_qp_init_attr *qp_init_attr);

struct ibv_qp_init_attr {
    void               *qp_context;
    struct ibv_cq      *send_cq;
    struct ibv_cq      *recv_cq;
    struct ibv_srq     *srq;
    struct ibv_qp_cap   cap;
    enum ibv_qp_type    qp_type;
    int                 sq_sig_all;
};

struct ibv_qp_cap {
    uint32_t max_send_wr;
    uint32_t max_recv_wr;
    uint32_t max_send_sge;
    uint32_t max_recv_sge;
    uint32_t max_inline_data;
};
```

### qp_type：传输类型

`qp_type` 决定这个 QP 用哪种传输服务，创建后不能更改：

- `IBV_QPT_RC`：可靠连接。一个 QP 只和对端一个 QP 通信，网卡负责确认、重传和保序，支持 SEND、RDMA WRITE、RDMA READ 和原子操作。本系列以它为主线。
- `IBV_QPT_UC`：不可靠连接。一对一，但不确认、不重传，不支持 READ 和原子操作。
- `IBV_QPT_UD`：不可靠数据报。一个 QP 可以和任意多个对端通信，每次发送时用 AH 指定对端，只支持 SEND，单条消息不能超过路径 MTU。

### send_cq、recv_cq 和 srq

`send_cq`、`recv_cq` 分别指定 SQ 和 RQ 的完成通知写到哪个 CQ。

`srq` 不为空时，这个 QP 不再使用自己的 RQ，接收请求从共享接收队列里取，`max_recv_wr`、`max_recv_sge` 被忽略。SRQ 用于连接数很多的场景：如果每个 RC 连接都要预先放好几百个接收缓冲区，1000 个连接就要几十万个，用 SRQ 可以让这些连接共用一组。

### max_send_wr：SQ 的深度

`max_send_wr` 是 SQ 能同时容纳的发送请求数，也就是已投递、但还没确认完成的请求的上限。上限是 `ibv_query_device` 返回的 `max_qp_wr`。

SQ 满了以后，`ibv_post_send` 直接返回错误（`ENOMEM`），不会阻塞等待。一个发送请求占用的位置要等到它的完成被应用从 CQ 取走后才释放。这里有一个容易踩的坑：如果一个请求不要求产生 CQE（见下文 `sq_sig_all`），它占用的位置要等到后面某个要求产生 CQE 的请求完成并被取走，才一起释放。所以全部不要求 CQE 的话，SQ 迟早会被填满。常见做法是每隔若干个请求（不超过 SQ 深度）要求一次 CQE。

深度需要多大，取决于希望同时在网络上飞行多少个请求。RC 下网卡发出请求后要等对端确认，一个请求从发出到确认至少要一个往返时间。想把链路跑满，同时在途的数据量要不少于带宽乘以往返时间。例如 100 Gb/s 链路、往返时间 10 微秒，在途数据要有约 125 KB；每个请求 4 KB 的话，SQ 里至少要有约 32 个请求同时在途。消息越小，需要的深度越大。

### max_recv_wr：RQ 的深度

`max_recv_wr` 是 RQ 能同时容纳的接收请求数。接收请求的作用是预先告诉网卡：下一条 SEND 到来时，数据放进哪块内存。

接收请求必须在对端的 SEND 到达之前投递好。RC 下，SEND 到达时如果 RQ 是空的，接收方网卡不会丢掉报文了事，而是回一个 RNR NAK（Receiver Not Ready，接收方未就绪），发送方网卡等待一段时间后重发，重试次数由建链时的 `rnr_retry` 决定。重试次数用尽后，发送方的请求以错误完成，连接进入错误状态。因此接收方要保证 RQ 里始终有足够的接收请求，深度至少要覆盖对端在一轮补充之前可能连续发来的 SEND 数量。

RDMA WRITE 和 READ 不消耗对端的接收请求，只有 SEND 和带立即数的 RDMA WRITE 才消耗。只用单边操作的连接，RQ 深度可以很小。

接收请求每条都会产生 CQE，没有“不要求 CQE”的选项。

### max_send_sge 和 max_recv_sge

SGE（Scatter/Gather Element）描述一段内存：地址、长度和 lkey。一个请求可以带多个 SGE，发送时网卡把多段内存的数据依次读出拼成一条消息（gather），接收时把一条消息依次写进多段内存（scatter）。

`max_send_sge`、`max_recv_sge` 是单个请求最多能带的 SGE 数，上限是 `max_sge`。它们直接影响每条 WQE 的大小，填多了会让队列占用更多内存，多数程序填 1 到 4 即可。

### max_inline_data：内联数据

正常的发送请求里，WQE 只记录数据在哪里，网卡收到门铃后，先 DMA 读取 WQE，再按 SGE 去 DMA 读取数据，要两次读主机内存。内联发送（投递时加 `IBV_SEND_INLINE` 标志）把数据直接复制进 WQE，网卡读 WQE 时数据就一起到了，省掉一次 DMA 读，小消息的延迟明显更低。内联数据所在的缓冲区也不需要注册，投递返回后即可复用。

`max_inline_data` 是单个请求最多能内联多少字节。它同样会增大 WQE：mlx5 的发送队列以 64 字节为一个基本块（WQEBB），一条 WQE 占一个或多个基本块，内联数据越长占用的块越多。内联只适用于发送方向（SEND、RDMA WRITE），一般用于几十到几百字节的小消息。

### sq_sig_all 和 qp_context

`sq_sig_all` 控制发送请求完成后要不要产生 CQE。一个请求完成时网卡为它写一条 CQE，这个请求就称为 signaled 的。`sq_sig_all` 为 1 时，每个发送请求都是 signaled 的；为 0 时，只有投递时在 `send_flags` 里带 `IBV_SEND_SIGNALED` 标志的请求才是，其余请求完成时网卡不写 CQE，应用也就无法单独得知它们何时完成。减少 CQE 可以降低网卡写 CQE 和应用轮询的开销，但要注意上面说的 SQ 位置释放问题。出错时不受这个设置影响：请求出错一定会产生带错误状态的 CQE。

`qp_context` 是应用自己的指针，可以通过 `qp->qp_context` 取回。

### 实际容量以返回值为准

`ibv_create_qp` 会把实际分配的容量写回 `qp_init_attr->cap`，保证不小于请求值。mlx5 会把队列深度向上取整到 2 的幂，也可能因为 SGE 数和内联长度的组合，实际可用的值比请求的更大。应用应以写回的值为准，例如按实际的 `max_inline_data` 判断某条消息能否内联。

请求超过硬件上限，或者几个参数组合起来单条 WQE 太大，创建会失败并返回 `EINVAL` 或 `ENOMEM`。上一篇提到，`max_qp_wr` 和 `max_sge` 同时填满往往创建不出来，就是这个原因。

## 创建 QP 时发生了什么

以 mlx5 为例，`ibv_create_qp` 在用户态和内核里依次做了这些事：

1.  provider 在用户态分配 SQ 和 RQ 的缓冲区，大小按深度和单条 WQE 大小算出；另外分配一小块门铃记录（doorbell record），用来存放队列的生产者计数。
2.  通过 `cmd_fd` 把这些信息交给内核。内核锁定这些缓冲区的物理页，建立网卡访问它们所需的地址转换表。
3.  驱动向网卡固件发出创建 QP 的命令，命令里是 QP 上下文：传输类型、所属 PD、关联的 CQ、队列缓冲区的位置和大小、使用的门铃页等。
4.  固件分配一个 QP 编号并返回，就是 QPN。驱动把它填进 `qp->qp_num`。

{% include figure.html src="/assets/images/rdma-04-resources/02-queues.svg" alt="SQ、RQ 和 CQ 的缓冲区都在主机内存里；网卡上保存 QP 上下文；应用写 WQE 并敲门铃，网卡 DMA 读取 WQE、把 CQE 写回 CQ，应用轮询 CQ 取出完成" caption="图 2：队列在主机内存，上下文在网卡" %}

可以看到，SQ、RQ、CQ 这些队列本身都在主机内存里，网卡上保存的是 QP 上下文：队列在哪、读到了哪一项、当前状态、以及后面建链时要填进去的对端信息。队列深度设得再大，占用的主要也是主机内存。

刚创建的 QP 处于 RESET 状态，既不能发也不能收。它要经过 INIT、RTR、RTS 几步才能通信。

## 再看 QPN 和 QP 的数量

### QPN 是什么

QPN 是网卡给 QP 分配的编号，24 位，取值 0 到 0xFFFFFF。编号只在一块网卡（一个 RDMA 设备）内唯一，不同网卡上的 QP 可以有相同的编号。所以要在网络中确定一个 QP，需要地址加 QPN：InfiniBand 下是 LID（跨子网时是 GID）加 QPN，RoCE 下是 GID 加 QPN。建链时两端要交换的正是这两样。

每个报文都带着 QPN：BTH 里的目的 QP 字段就是接收方 QP 的编号。接收方网卡收到报文后，用它找到对应的 QP 上下文，再按上下文里的状态、期望的 PSN、所属 PD 等信息处理报文。BTH 里没有源 QPN。RC 连接建立时双方已经记下了对方的 QPN，接收方从目的 QP 的上下文就知道对端是谁；UD 没有固定的对端，源 QPN 放在扩展头 DETH 里，接收方从 CQE 的 `src_qp` 读到。

有几个编号有固定用途：

- QP0：InfiniBand 子网管理（SMI），只在 InfiniBand 端口上存在，RoCE 没有。
- QP1：通用服务（GSI），RDMA CM 建链时的通信管理报文就发给对端的 QP1。
- 0xFFFFFF：组播，只在 UD 组播中使用。

其余编号由固件分配，应用不能指定。编号本身不携带含义，不能从数值推断创建顺序或属于哪个进程。QP 销毁后，它的编号可能被之后创建的 QP 复用。

### QP 是硬件资源还是软件资源

两者都有，限制主要在硬件一侧。QP 的队列（SQ、RQ）在主机内存里，由软件分配；QP 上下文则是网卡固件管理的对象，网卡处理每一个报文都要读写它。以 mlx5 为例，网卡片上存储有限，固件会让驱动划出一部分主机内存给网卡专用（称为 ICM），所有 QP 上下文都存放在这里，网卡芯片内只缓存最近用到的一部分。

因此 QP 的数量受两层限制：

- 上限：`ibv_query_device` 返回的 `max_qp`，由网卡型号和固件决定，可以用 `ibv_devinfo -v` 查看。
- 性能：同时活跃的 QP 多到网卡缓存放不下时，处理报文经常要先从主机内存重新读取上下文，延迟升高、吞吐下降。连接数很多的场景（例如每对进程之间各建一条 RC 连接）常因此改用 SRQ、UD，或 NVIDIA 网卡上的 DC（动态连接）来减少 QP 数量。

## 这一步的产出

资源创建完成后，建链需要的本端信息又多了一项：

| 信息 | 来源 | 后面在哪里用到 |
| --- | --- | --- |
| QPN | `ibv_create_qp` 返回的 `qp->qp_num` | 交换给对端，作为对端 RTR 的 `dest_qp_num` |
| 起始 PSN | 应用自己选定（24 位，通常取随机数） | 本端 RTS 的 `sq_psn`；交换给对端，作为对端 RTR 的 `rq_psn` |
| SQ、RQ 实际深度 | `qp_init_attr->cap` 写回值 | 控制同时投递的请求数，决定 CQ 深度 |

建链时要交换的还有内存地址和 rkey，它们来自内存注册。

## 参考资料

接口文档（rdma-core man page）：

- ibv_alloc_pd(3). <https://man7.org/linux/man-pages/man3/ibv_alloc_pd.3.html>
- ibv_create_cq(3). <https://man7.org/linux/man-pages/man3/ibv_create_cq.3.html>
- ibv_create_cq_ex(3). <https://man7.org/linux/man-pages/man3/ibv_create_cq_ex.3.html>
- ibv_create_comp_channel(3). <https://man7.org/linux/man-pages/man3/ibv_create_comp_channel.3.html>
- ibv_req_notify_cq(3). <https://man7.org/linux/man-pages/man3/ibv_req_notify_cq.3.html>
- ibv_get_cq_event(3). <https://man7.org/linux/man-pages/man3/ibv_get_cq_event.3.html>
- ibv_poll_cq(3). <https://man7.org/linux/man-pages/man3/ibv_poll_cq.3.html>
- ibv_create_qp(3). <https://man7.org/linux/man-pages/man3/ibv_create_qp.3.html>
- ibv_create_srq(3). <https://man7.org/linux/man-pages/man3/ibv_create_srq.3.html>
- ibv_post_send(3). <https://man7.org/linux/man-pages/man3/ibv_post_send.3.html>
- ibv_post_recv(3). <https://man7.org/linux/man-pages/man3/ibv_post_recv.3.html>
- ibv_get_async_event(3). <https://man7.org/linux/man-pages/man3/ibv_get_async_event.3.html>
- linux-rdma. rdma-core（`libibverbs/verbs.h` 中有上述结构体的定义）. <https://github.com/linux-rdma/rdma-core>
- linux-rdma. rdma-core `providers/mlx5/mlx5dv.h`（`MLX5_SEND_WQE_BB` 等 mlx5 队列格式常量）. <https://github.com/linux-rdma/rdma-core/blob/master/providers/mlx5/mlx5dv.h>

内核文档：

- Userspace verbs access. <https://docs.kernel.org/infiniband/user_verbs.html>

规范与手册：

- InfiniBand Trade Association. InfiniBand Architecture Specification Volume 1（保护域、队列对、完成队列、RNR NAK、QP0 与 QP1）. <https://www.infinibandta.org/ibta-specification/>
- NVIDIA. RDMA-Aware Networks Programming Guide. <https://networking-docs.nvidia.com/doca/sdk/rdma-aware-networks-programming-guide>
