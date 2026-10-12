---
title: "RDMA 入门（六）：QP 状态机"
description: "QP 从 RESET 到 RTS 要经过哪几步，每一步 ibv_modify_qp 填的参数管什么、两端的参数怎么对应，超时、重试和 RNR 的编码怎么换算，以及出错后 QP 处在什么状态。"
date: 2026-10-12 17:00:00 +0800
tags: [RDMA, 网络, RoCE, InfiniBand]
series: rdma
series_order: 6
---

第四篇创建出来的 QP 处于 RESET 状态，既不能发也不能收。从本端看，建立一条 RC 连接，就是对这个 QP 连续调用三次 `ibv_modify_qp`，把它依次推进到 INIT、RTR、RTS。这三次调用通常是示例代码里最长的一段，要填十几个参数：对端的 GID 和 QPN、两个方向的起始 PSN、路径 MTU、超时、重试次数、RNR 等待时间等。

这一篇逐个说明 QP 有哪些状态、每一步要填哪些参数、它们各管什么，以及两端的参数怎么对应。文中假设两端已经通过某种方式拿到了对方的 QPN、PSN、GID 等信息，怎么交换在后面单独讲。涉及驱动实现的地方仍以 mlx5 为例。

## QP 的状态

`enum ibv_qp_state` 里一共有七个状态：

| 状态 | 含义 | 能否投递接收请求 | 能否投递发送请求 | 处理收到的报文 |
| --- | --- | --- | --- | --- |
| RESET | 刚创建，或被复位 | 否 | 否 | 否 |
| INIT | 已绑定端口和访问权限 | 能，但只是排队，不处理 | 否 | 否，报文被丢弃 |
| RTR | Ready to Receive，可以接收 | 能 | 否 | 能，并回复 ACK |
| RTS | Ready to Send，可以收发 | 能 | 能 | 能 |
| SQD | Send Queue Drained，发送队列排空 | 能 | 能，但暂不执行 | 能 |
| SQE | Send Queue Error，发送队列出错，只用于 UD、UC | 能 | 否 | 能 |
| ERR | 出错 | 请求不会再被执行 | 请求不会再被执行 | 否 |

正常建链只经过前四个状态：RESET → INIT → RTR → RTS。SQD 用于在不断开连接的情况下暂停发送，SQE 只出现在不可靠的传输类型上，RC 出错时直接进入 ERR。

{% include figure.html src="/assets/images/rdma-06-qp-state-machine/01-states.svg" alt="QP 状态转换图：RESET 经 INIT、RTR 到 RTS 是建链的主路径，RTS 和 SQD 之间可以来回切换；除 RESET 外任何状态都可以进入 ERR，出错时网卡也会自动把 QP 切到 ERR；任何状态都可以复位回 RESET" caption="图 1：QP 状态转换" %}

状态转换有两种来源：

- 应用调用 `ibv_modify_qp` 主动切换。建链的三步、主动复位、主动置错都属于这一类。
- 网卡自动切换。RC 连接上重试次数用尽、远程访问出错等情况发生时，网卡把 QP 切到 ERR，应用从 CQE 和异步事件里得知。

合法的转换是固定的（内核 `drivers/infiniband/core/verbs.c` 里的 `qp_state_table` 列出了全部组合）。任何状态都可以切回 RESET；除 RESET 外，任何状态都可以切到 ERR；RESET 不能直接到 ERR。

## ibv_modify_qp 的用法

```c
int ibv_modify_qp(struct ibv_qp *qp, struct ibv_qp_attr *attr,
                  int attr_mask);
```

`struct ibv_qp_attr` 包含所有可修改的属性，`attr_mask` 指出这次要修改哪几项。每一步转换都有必须提供的属性，也有可选的属性。缺了必须项，或者带了这一步不允许改的项，调用都会失败并返回 `EINVAL`。这个调用是原子的：任何一项不合法，所有属性包括状态都不会改变。

RC 每一步必须提供的属性（`ibv_modify_qp(3)` 的表格）：

| 目标状态 | 必须提供的 `attr_mask` |
| --- | --- |
| INIT | `IBV_QP_STATE`、`IBV_QP_PKEY_INDEX`、`IBV_QP_PORT`、`IBV_QP_ACCESS_FLAGS` |
| RTR | `IBV_QP_STATE`、`IBV_QP_AV`、`IBV_QP_PATH_MTU`、`IBV_QP_DEST_QPN`、`IBV_QP_RQ_PSN`、`IBV_QP_MAX_DEST_RD_ATOMIC`、`IBV_QP_MIN_RNR_TIMER` |
| RTS | `IBV_QP_STATE`、`IBV_QP_SQ_PSN`、`IBV_QP_MAX_QP_RD_ATOMIC`、`IBV_QP_RETRY_CNT`、`IBV_QP_RNR_RETRY`、`IBV_QP_TIMEOUT` |

`ibv_modify_qp` 走控制路径：经过内核的 ib_uverbs 和 ib_core 检查后，交给驱动向网卡固件发命令。mlx5 中三步分别对应 `RST2INIT_QP`、`INIT2RTR_QP`、`RTR2RTS_QP` 三个固件命令，命令里带着这一步的属性，固件把它们写进 QP 上下文。应用可以用 `ibv_query_qp` 读回 QP 当前的状态和属性。

## RESET → INIT：绑定端口和访问权限

这一步要填四项：

- `port_num`：使用网卡的哪个端口，从 1 开始编号。
- `pkey_index`：P_Key 表的索引。P_Key 是 InfiniBand 的分区键，同一分区内的端口才能互相通信，作用类似 VLAN。RoCE 没有分区的概念，填 0 即可，对应默认的 P_Key 0xFFFF。
- `qp_access_flags`：这个 QP 允许对端执行哪些操作，取 `IBV_ACCESS_REMOTE_WRITE`、`IBV_ACCESS_REMOTE_READ`、`IBV_ACCESS_REMOTE_ATOMIC` 的组合。上一篇讲过，对端的 RDMA WRITE、READ 或原子操作，要 QP 和目标 MR 两边都允许才会执行。
- `qp_state`：`IBV_QPS_INIT`。

INIT 状态下已经可以投递接收请求，只是网卡还不处理收到的报文。常见做法是在切到 RTR 之前先把接收请求投递好：一旦进入 RTR，对端的 SEND 随时可能到达，RQ 为空就会触发 RNR NAK。

## INIT → RTR：填入对端的信息

进入 RTR 后 QP 就能接收和响应报文，所以这一步要把对端是谁、报文从哪个序号开始都告诉网卡。

### ah_attr：对端的地址

```c
struct ibv_ah_attr {
    struct ibv_global_route grh;
    uint16_t dlid;
    uint8_t  sl;
    uint8_t  src_path_bits;
    uint8_t  static_rate;
    uint8_t  is_global;
    uint8_t  port_num;
};

struct ibv_global_route {
    union ibv_gid dgid;
    uint32_t      flow_label;
    uint8_t       sgid_index;
    uint8_t       hop_limit;
    uint8_t       traffic_class;
};
```

`ah_attr` 是地址向量（Address Vector），描述报文发给谁、走什么路径。InfiniBand 和 RoCE 的填法不同：

| 字段 | InfiniBand（同一子网） | RoCE |
| --- | --- | --- |
| `is_global` | 0，不带 GRH | 必须为 1 |
| `dlid` | 对端端口的 LID | 不使用 |
| `grh.dgid` | 不使用 | 对端的 GID |
| `grh.sgid_index` | 不使用 | 本端 GID 表的索引，决定用 RoCE v1 还是 v2、IPv4 还是 IPv6、哪个 VLAN |
| `grh.hop_limit` | 不使用 | RoCE v2 下对应 IP 头的 TTL（IPv6 的 Hop Limit） |
| `grh.traffic_class` | 不使用 | RoCE v2 下对应 IP 头的 TOS 字节，高 6 位是 DSCP |
| `grh.flow_label` | 不使用 | 用于生成 RoCE v2 的 UDP 源端口，见下文 |
| `sl` | 服务等级，交换机据此映射到虚通道 | mlx5 中映射为以太网优先级（VLAN 头里的 PCP） |
| `port_num` | 本端端口号 | 本端端口号 |

`static_rate` 用于限速，填 0 表示不限。`src_path_bits` 只在一个端口配置了多个 LID 时使用，一般填 0。

RoCE 下的 `traffic_class` 和 `sl` 值得单独说。它们决定报文在以太网上属于哪个优先级，而第二篇讲过，RoCE 依赖 PFC 和 ECN，网络通常只为 RDMA 流量配置一个无损优先级。

- `traffic_class` 是 8 位，RoCE v2 下原样填进 IP 头的 TOS 字节（IPv6 的 Traffic Class）。按 IP 头的定义，这 8 位里高 6 位是 DSCP，低 2 位是 ECN 字段。应用通常只关心 DSCP，所以要填的值是 DSCP 左移 2 位：想用 DSCP 26，`traffic_class` 就填 104。mlx5 驱动在切到 RTR 时也是取 `traffic_class >> 2` 作为 DSCP 写进 QP 上下文的（内核 `drivers/infiniband/hw/mlx5/qp.c`）。低 2 位一般填 0，报文的 ECN 标记由网卡的拥塞控制配置决定，不靠这里。
- `sl` 是 4 位的服务等级。InfiniBand 下它是报文 LRH 里的字段，交换机按 SL 到 VL 的映射表把报文放进对应的虚通道。RoCE 没有 SL 这个概念，mlx5 取它的低 3 位作为以太网优先级，也就是 802.1Q VLAN 头里的 PCP（0 到 7）。报文不带 VLAN 头时，这个值在线上没有位置，交换机看不到。

交换机拿到报文后，按它的信任模式决定看哪个字段：信任 PCP 时按 VLAN 头的优先级分队列，信任 DSCP 时按 IP 头的 DSCP 分队列，再在对应的队列上开启 PFC。所以两个字段怎么填，取决于网络那边的配置。无 VLAN 的 RoCE v2 网络一般用 DSCP：常见的一种配置是 DSCP 26 对应优先级 3，对应的 `traffic_class` 填 104，`sl` 填 3。填错了，报文会落到普通的有损队列，拥塞时直接丢包，表现为吞吐不稳、重传增多。

这两个字段也不只影响数据报文。拥塞通知报文 CNP 由网卡自己生成，用的 DSCP 和优先级是网卡单独配置的，要和数据报文区分开，交换机通常给它更高的优先级。

RoCE 下切到 RTR 时，内核还要做一件事：根据 `dgid` 解析出下一跳的 MAC 地址（内核 `ib_resolve_eth_dmac`，通过系统的邻居表，即 ARP 或 IPv6 邻居发现），写进 QP 上下文。之后网卡发包时直接使用这个 MAC 地址，不再经过内核。对端 IP 不可达、解析不出 MAC 时，这一步的 `ibv_modify_qp` 会失败。

RoCE v2 的 UDP 目的端口固定是 4791，源端口则按连接生成。内核的约定（`rdma_get_udp_sport`）是：`flow_label` 不为 0 时由它换算出源端口；为 0 时先由本端和对端的 QPN 算出一个 flow label，两端算出的值相同，再换算成源端口。交换机做 ECMP 时按五元组哈希选路径，不同连接的源端口不同，就会分散到不同路径上；同一连接的源端口固定，报文不会乱序。

### path_mtu

`path_mtu` 是这条连接使用的最大报文载荷，取值 `IBV_MTU_256` 到 `IBV_MTU_4096`。第三篇讲过，通常取两端 `active_mtu` 的较小值，两端要填同一个值。消息长度超过它时，网卡把一条消息切成多个报文发送。

### dest_qp_num 和 rq_psn

`dest_qp_num` 是对端 QP 的编号。本端发出的每个报文，BTH 里的目的 QP 字段都填这个值。

`rq_psn` 是本端接收方向期望的第一个 PSN，也就是对端发送方向的起始 PSN（对端 RTS 时填的 `sq_psn`）。PSN 是 24 位的报文序号，每发一个报文加一，到 0xFFFFFF 后回绕到 0。接收方按 PSN 检查报文是否按序：PSN 等于期望值的报文被接受；比期望值小的是重复报文，重新回 ACK 后丢弃；比期望值大的说明中间有丢包，回复序号错误的 NAK，让发送方从缺失的位置重传。

起始 PSN 通常取随机数，不从 0 开始。QP 编号会被复用，如果新连接沿用上一条连接的 QPN，而网络里还残留着旧连接的报文，随机的起始 PSN 能让这些旧报文大概率落在期望窗口之外，被识别出来。

### max_dest_rd_atomic

`max_dest_rd_atomic` 是本端作为响应方，最多同时处理多少个对端发来的 RDMA READ 和原子操作，不能超过 `ibv_query_device` 返回的 `max_qp_rd_atom`。

READ 和原子操作需要响应方单独记账。响应方要为每个未完成的 READ 记住它的地址、长度和起始 PSN，因为响应报文可能丢失，发起方会重发同一个 READ 请求，响应方要能识别出这是重复请求并重新发送数据。这些记录占用网卡上的资源，称为响应方资源（responder resources），`max_dest_rd_atomic` 就是为这个 QP 预留多少份。填 0 表示这个 QP 不接受 READ 和原子操作。

### min_rnr_timer

`min_rnr_timer` 用在本端作为接收方的时候：SEND 到达而 RQ 为空时，网卡回复 RNR NAK，NAK 里带着这个值，告诉发送方至少等多久再重发。

它是一个 5 位的编码，对应的时间不是线性的（内核 `include/rdma/ib_verbs.h` 中的 `IB_RNR_TIMER_*` 列出了全部 32 个值）。部分取值：

| 编码 | 等待时间 |
| --- | --- |
| 1 | 0.01 ms |
| 6 | 0.08 ms |
| 12 | 0.64 ms |
| 18 | 5.12 ms |
| 24 | 40.96 ms |
| 31 | 491.52 ms |
| 0 | 655.36 ms（最长） |

0 不表示不等待，而是表示最长的 655.36 ms，这一点容易填错。

切到 RTR 之后，QP 已经能接收对端的报文并回复 ACK，但还不能主动发送。

## RTR → RTS：设置发送方向

### sq_psn

`sq_psn` 是本端发送方向的起始 PSN，要和告诉对端的值一致，对端会把它填进自己的 `rq_psn`。

### timeout

`timeout` 是本端发出请求后等待 ACK 的超时时间，即规范中的 Local ACK Timeout。它也是一个 5 位的编码，实际时间是 4.096 µs × 2^timeout：

| timeout | 超时时间 |
| --- | --- |
| 8 | 约 1.05 ms |
| 14 | 约 67.1 ms |
| 18 | 约 1.07 s |
| 20 | 约 4.29 s |
| 0 | 不超时，永远等待 |

超时要大于网络往返时间加上对端处理请求的时间。填得太小，网络稍有拥塞就会触发不必要的重传；填得太大，对端真的失联时，要很久才能发现。填 0 时一旦丢包、请求得不到确认，QP 会一直等下去，不建议使用。

### retry_cnt

`retry_cnt` 是重传的次数上限，3 位，取值 0 到 7。超时没有收到 ACK，或者收到序号错误的 NAK 时，发送方从未确认的位置重传，每重传一轮计一次。次数用尽后，请求以 `IBV_WC_RETRY_EXC_ERR` 状态完成，QP 进入 ERR。

`timeout` 和 `retry_cnt` 一起决定了对端失联后多久能发现。例如 `timeout` 为 14、`retry_cnt` 为 7，最坏情况要等第一次发送加 7 次重传，共 8 个超时周期，约 0.54 s。

### rnr_retry

`rnr_retry` 是收到 RNR NAK 后的重试次数上限，同样是 3 位，但 7 有特殊含义：无限重试。每次重试前等待的时间由对端 RTR 时设置的 `min_rnr_timer` 决定。次数用尽后，请求以 `IBV_WC_RNR_RETRY_EXC_ERR` 状态完成。

RNR 只说明对端暂时没有准备好接收缓冲区，连接本身是正常的。很多程序把 `rnr_retry` 设为 7，接收方慢一点也不至于断开连接；代价是对端程序如果再也不补充接收请求，发送方会一直重试下去。

### max_rd_atomic

`max_rd_atomic` 是本端作为发起方，最多同时有多少个 RDMA READ 和原子操作在等待响应，不能超过 `max_qp_init_rd_atom`，也不应超过对端的 `max_dest_rd_atomic`，否则对端没有足够的响应方资源。达到上限后，后续的 READ 和原子操作要等前面的完成才会发出。

切到 RTS 之后，QP 可以投递发送请求，连接建立完成。

## 两端的参数怎么对应

建链时，一端的很多参数要和另一端对应起来：

| 本端的值 | 对端填在哪里 |
| --- | --- |
| QPN（`qp->qp_num`） | 对端 RTR 的 `dest_qp_num` |
| 发送方向起始 PSN（本端 RTS 的 `sq_psn`） | 对端 RTR 的 `rq_psn` |
| GID（RoCE）或 LID（InfiniBand） | 对端 RTR 的 `ah_attr.grh.dgid` 或 `ah_attr.dlid` |
| `active_mtu` | 两端取较小值，各自填进 RTR 的 `path_mtu` |
| `max_dest_rd_atomic` | 对端 RTS 的 `max_rd_atomic` 不应超过它 |
| MR 的地址、长度和 rkey | 对端发起 RDMA WRITE、READ 时使用，和 QP 状态无关 |

{% include figure.html src="/assets/images/rdma-06-qp-state-machine/02-exchange.svg" alt="主机 A 和 B 各自的 QPN、起始 PSN 和 GID 交叉填入对方 RTR 阶段的 dest_qp_num、rq_psn 和 dgid；本端的起始 PSN 同时作为自己 RTS 阶段的 sq_psn" caption="图 2：两端参数的对应关系" %}

两端切换的先后也有讲究。A 进入 RTS 后就可能发出第一个请求，如果此时 B 还没有进入 RTR，B 的网卡会丢掉这个报文，A 只能等超时后重传。重传次数够用时连接最终能建起来，但会多等至少一个超时周期。所以常见的做法是两端都切到 RTR 后再互相通知一次，然后各自切到 RTS。

接收方 QP 在 RTR 状态下收到第一个报文时，网卡会上报一个 `IBV_EVENT_COMM_EST` 异步事件，表示通信已经建立。大多数程序不处理这个事件。

## 在 RTS 状态下修改属性

连接建立后，大部分属性不能再改。RC 的 QP 在 RTS 状态下，用 `ibv_modify_qp` 把状态保持为 RTS（RTS → RTS），只能修改访问权限、`min_rnr_timer` 和备用路径等少数几项。`timeout`、`retry_cnt` 这类参数只在 RTR → RTS 这一步设置，要换就得把 QP 复位后重新建链。

## 出错与复位

QP 进入 ERR 后不再执行任何请求。SQ 和 RQ 里还没完成的请求全部以 `IBV_WC_WR_FLUSH_ERR` 状态完成，称为 flush。真正引起错误的那个请求会带着具体的错误状态出现在 CQ 里，例如 `IBV_WC_RETRY_EXC_ERR` 或 `IBV_WC_REM_ACCESS_ERR`，排查问题时应该找它，而不是后面成片的 flush 错误。

ERR 不能直接回到 RTS。要恢复通信，先把 QP 切回 RESET，再重新走 INIT、RTR、RTS 三步。复位会清空 SQ 和 RQ，里面的请求直接丢弃，不产生 CQE。重新建链时两端都要参与，通常会选新的起始 PSN，所以两端要重新交换信息。也可以直接销毁 QP 再创建一个新的，效果相同，只是 QPN 会变。

## 这一步的产出

到这里，两端的 QP 都处于 RTS，连接建立完成。RC 建链涉及的全部属性汇总如下：

| 属性 | 设置时机 | 来源 | 常见取值 |
| --- | --- | --- | --- |
| `port_num` | INIT | 本端 | 1 |
| `pkey_index` | INIT | 本端 | 0 |
| `qp_access_flags` | INIT | 本端 | 按需开放 `REMOTE_*` |
| `ah_attr` | RTR | 对端的 GID 或 LID，本端的 GID 索引 | RoCE 下 `is_global = 1` |
| `path_mtu` | RTR | 两端 `active_mtu` 的较小值 | `IBV_MTU_1024` 或 `IBV_MTU_4096` |
| `dest_qp_num` | RTR | 对端 QPN | |
| `rq_psn` | RTR | 对端的起始 PSN | |
| `max_dest_rd_atomic` | RTR | 本端 | 不超过 `max_qp_rd_atom` |
| `min_rnr_timer` | RTR | 本端 | 12（0.64 ms） |
| `sq_psn` | RTS | 本端的起始 PSN | 随机数 |
| `timeout` | RTS | 本端 | 14（约 67 ms） |
| `retry_cnt` | RTS | 本端 | 7 |
| `rnr_retry` | RTS | 本端 | 7（无限） |
| `max_rd_atomic` | RTS | 本端 | 不超过 `max_qp_init_rd_atom` 和对端的 `max_dest_rd_atomic` |

## 参考资料

接口文档（rdma-core man page）：

- ibv_modify_qp(3)（`struct ibv_qp_attr`、`attr_mask` 和各传输类型每一步的必须属性）. <https://man7.org/linux/man-pages/man3/ibv_modify_qp.3.html>
- ibv_query_qp(3). <https://man7.org/linux/man-pages/man3/ibv_query_qp.3.html>
- ibv_create_ah(3)（`struct ibv_ah_attr`）. <https://man7.org/linux/man-pages/man3/ibv_create_ah.3.html>
- ibv_get_async_event(3)（`IBV_EVENT_COMM_EST` 等 QP 异步事件）. <https://man7.org/linux/man-pages/man3/ibv_get_async_event.3.html>
- ibv_poll_cq(3)（`IBV_WC_RETRY_EXC_ERR`、`IBV_WC_RNR_RETRY_EXC_ERR`、`IBV_WC_WR_FLUSH_ERR`）. <https://man7.org/linux/man-pages/man3/ibv_poll_cq.3.html>
- linux-rdma. rdma-core（`libibverbs/verbs.h` 中有 `enum ibv_qp_state` 和上述结构体的定义）. <https://github.com/linux-rdma/rdma-core>

内核源码：

- Linux `drivers/infiniband/core/verbs.c`（`qp_state_table`：合法的状态转换和每一步的必须、可选属性；`ib_resolve_eth_dmac`：RoCE 下解析目的 MAC）. <https://github.com/torvalds/linux/blob/master/drivers/infiniband/core/verbs.c>
- Linux `include/rdma/ib_verbs.h`（`IB_RNR_TIMER_*` 编码表；`rdma_get_udp_sport`：RoCE v2 UDP 源端口）. <https://github.com/torvalds/linux/blob/master/include/rdma/ib_verbs.h>
- Linux `drivers/infiniband/hw/mlx5/qp.c`（mlx5 的状态转换固件命令，`sl` 到以太网优先级的映射）. <https://github.com/torvalds/linux/blob/master/drivers/infiniband/hw/mlx5/qp.c>

规范与手册：

- InfiniBand Trade Association. InfiniBand Architecture Specification Volume 1（QP 状态机、Local ACK Timeout、重试与 RNR NAK、PSN 校验、响应方资源）. <https://www.infinibandta.org/ibta-specification/>
- NVIDIA. RDMA-Aware Networks Programming Guide. <https://networking-docs.nvidia.com/doca/sdk/rdma-aware-networks-programming-guide>
