---
title: "RDMA 入门（八）：一次传输的完整过程"
description: "以一次 8 KB 的 RDMA WRITE 为例，从 ibv_post_send 写 WQE、敲门铃，到网卡按 MTU 切包、每个报文里 BTH 和 RETH 各带什么，对端网卡怎么校验 PSN 和 rkey、怎么回 ACK，再到发起端收到 ACK 后写 CQE、ibv_poll_cq 取走它，逐步说明每个环节谁在做什么、数据在哪里。"
date: 2026-10-15 18:30:00 +0800
tags: [RDMA, 网络, RoCE, InfiniBand]
series: rdma
series_order: 8
---

前面七篇把准备工作做完了：网卡打开了，PD、CQ、QP 建好了，缓冲区注册了，两端的 QP 都到了 RTS。这一篇看真正的传输：应用投递一个请求之后，网卡做了什么，线上的报文长什么样，对端怎么处理，完成事件怎么回到应用手里。

全篇跟一个固定的例子：主机 A 向主机 B 做一次 8 KB 的 RDMA WRITE，RoCE v2，IPv4，路径 MTU 为 4096。B 已经把目标缓冲区的地址、长度和 rkey 告诉了 A。用户态的部分以 rdma-core 的 mlx5 provider 为例，网卡内部的处理没有公开的源码，这部分借助内核的软件 RoCE 驱动 rxe 来说明：rxe 用软件实现了同一套协议，它的代码就是规范里那些规则的一种可读的写法。硬件网卡在细节上可能不同，但对外的行为受同一份规范约束。

## 投递请求：ibv_post_send

A 的应用构造一个 `struct ibv_send_wr`，调用 `ibv_post_send`：

```c
struct ibv_sge sge = {
    .addr   = (uintptr_t)buf,   /* 本地缓冲区 */
    .length = 8192,
    .lkey   = mr->lkey,
};
struct ibv_send_wr wr = {
    .wr_id      = 42,
    .sg_list    = &sge,
    .num_sge    = 1,
    .opcode     = IBV_WR_RDMA_WRITE,
    .send_flags = IBV_SEND_SIGNALED,
    .wr.rdma.remote_addr = remote_addr,   /* B 告诉 A 的 */
    .wr.rdma.rkey        = remote_rkey,
};
struct ibv_send_wr *bad_wr;
int ret = ibv_post_send(qp, &wr, &bad_wr);
```

`ibv_send_wr` 里和这次传输有关的字段：

| 字段 | 作用 |
| --- | --- |
| `wr_id` | 应用自己定的 64 位标识，网卡不解释，完成时原样出现在 CQE 里 |
| `opcode` | 操作类型。RC 支持 SEND、RDMA WRITE、RDMA READ、两种原子操作，以及带立即数、带 invalidate 的变体 |
| `sg_list`、`num_sge` | 本地数据的位置：每个 SGE 是地址、长度、lkey 三元组，多个 SGE 的数据在线上拼成一条连续的消息 |
| `send_flags` | `IBV_SEND_SIGNALED` 要求这条请求完成时产生 CQE；`IBV_SEND_INLINE` 把数据直接放进 WQE；`IBV_SEND_FENCE` 要求等前面的 READ 和原子操作完成后再执行；`IBV_SEND_SOLICITED` 在报文头里置 SE 位，让对端的事件通知只对这类报文触发 |
| `wr.rdma.remote_addr`、`wr.rdma.rkey` | 对端缓冲区的虚拟地址和 rkey，原样进入报文的 RETH |
| `imm_data` | 带立即数的操作才用，32 位，放在报文头里送到对端的 CQE |

`next` 可以把多个 WR 串成链表一次投递。链表里任何一条在投递阶段就能查出的错误（队列满、SGE 数超限）会让 `ibv_post_send` 停在那一条，通过 `bad_wr` 返回，前面的已经投递成功。

### WQE 在 SQ 里长什么样

`ibv_post_send` 是 provider 实现的，不进内核。mlx5 provider 把 WR 翻译成 WQE 写进 SQ。一条 WQE 由若干个 16 字节的段组成：

| 段 | 大小 | 内容 |
| --- | --- | --- |
| 控制段 | 16 字节 | 操作码（mlx5 自己的编码，RDMA WRITE 是 0x08，SEND 是 0x0a，RDMA READ 是 0x10）、这条 WQE 在 SQ 中的序号、QPN、WQE 的总长度（以 16 字节为单位）、标志位（要不要 CQE、fence、solicited）、立即数 |
| 远端地址段 | 16 字节 | 64 位远端虚拟地址和 32 位 rkey。只有 RDMA WRITE、READ 和原子操作有 |
| 原子操作段 | 16 字节 | 比较值和交换值或加数。只有原子操作有 |
| 数据段 | 每个 16 字节 | 一个 SGE 一段：32 位长度、32 位 lkey、64 位地址 |
| 内联数据段 | 4 字节头加数据 | 用 `IBV_SEND_INLINE` 时代替数据段：头部是长度，最高位置 1 表示内联，后面直接跟数据，整体补齐到 16 字节 |

例子里的 WQE 是控制段、远端地址段、一个数据段，共 48 字节。SQ 以 64 字节为一个基本单元（mlx5 叫 WQEBB），一条 WQE 占用一个或多个连续的单元，48 字节的 WQE 占一个。创建 QP 时 provider 按最大可能的 WQE 长度乘以 `max_send_wr` 分配 SQ，投递时仍按条数限制，所以小 WQE 用不满这块空间。

provider 在自己的数组里记下 `wrid[序号] = wr_id`。网卡不保存 `wr_id`，完成时只报告 WQE 的序号，provider 再用它查回 `wr_id` 填进 `ibv_wc`。

### 门铃

WQE 写完后，provider 要通知网卡。mlx5 分两步：

1. 更新门铃记录（doorbell record）。这是主机内存里的一小块区域，创建 QP 时分配并告诉网卡，provider 把 SQ 的当前投递位置写进去。写之前有一个内存屏障，保证 WQE 的内容先于门铃记录对网卡可见。
2. 写门铃寄存器。第三篇说过，打开设备时内核把网卡的一页寄存器（mlx5 叫 UAR）映射到了进程地址空间。provider 往这一页里写 8 个字节，内容是控制段的前 8 个字节，网卡据此知道哪个 QP 有新 WQE。这是一次 MMIO 写，走 PCIe 到网卡，是整个投递过程中唯一一次和网卡的直接交互。

mlx5 还有一个优化叫 BlueFlame：只投递一条 WQE、WQE 不长、数据是内联的或者驱动偏好这种方式时，provider 不只写 8 个字节，而是把整条 WQE 复制到 UAR 页里。网卡从寄存器里直接拿到 WQE，省掉一次从主机内存读 WQE 的 DMA。这对小消息的延迟有帮助，对带宽没有影响。

`ibv_post_send` 返回 0 只表示 WQE 已经交给网卡，数据还没有发出，缓冲区也还不能复用。例外是内联数据：数据已经复制进 WQE，调用返回后缓冲区就可以改了。

## 网卡发送

A 的网卡看到门铃后：

1. 从 SQ 读取 WQE（BlueFlame 方式下已经拿到）。
2. 按数据段里的 lkey 找到 mkey 上下文，检查 PD 和本地权限，把虚拟地址翻译成 DMA 地址，读取数据。检查和翻译的过程在第五篇。
3. 把数据切成不超过路径 MTU 的报文发出。

### 切包

一条 WR 对应一条消息（message），一条消息按路径 MTU 切成一个或多个报文（packet）。8 KB 的消息、MTU 4096，切成两个报文。每个报文的操作码标明它在消息中的位置：

| 消息长度 | 报文序列 |
| --- | --- |
| 不超过 MTU | ONLY |
| 超过 MTU | FIRST、零个或多个 MIDDLE、LAST |

RDMA WRITE 的四个操作码是 RDMA WRITE FIRST、MIDDLE、LAST、ONLY，SEND 同样有四个，带立即数时 LAST 和 ONLY 换成 LAST WITH IMMEDIATE 和 ONLY WITH IMMEDIATE。例子里的两个报文是 RDMA WRITE FIRST 和 RDMA WRITE LAST。

除了最后一个，每个报文的载荷都正好是 MTU；最后一个是剩余的长度，不足 4 字节的倍数时补零，补了几个字节记在头部的 PadCnt 字段。长度为 0 的消息也发一个报文。

每个报文有一个 PSN，同一个 QP 发出的报文 PSN 连续递增，24 位，到头回绕。消息的第一个报文用的是 QP 当前的发送 PSN，起点就是第六篇 RTS 时填的 `sq_psn`。网卡记下这条 WR 的第一个和最后一个 PSN，后面匹配 ACK 要用。

### 报文格式

RoCE v2 下，一个 RDMA WRITE FIRST 报文从外到内是：

{% include figure.html src="/assets/images/rdma-08-one-transfer/01-packet.svg" alt="RoCE v2 报文的头部序列：以太网头 14 字节、IPv4 头 20 字节、UDP 头 8 字节且目的端口 4791、BTH 12 字节、RETH 16 字节、载荷、ICRC 4 字节、以太网 FCS 4 字节；下方展开 BTH 的各个字段和 RETH 的三个字段" caption="图 1：RoCE v2 报文的头部和 BTH、RETH 的字段" %}

| 头部 | 长度 | 要点 |
| --- | --- | --- |
| 以太网头 | 14 字节（带 VLAN 标签 18 字节） | 目的 MAC 是第六篇建链时按对端 IP 解析出来的 |
| IPv4 头 | 20 字节（IPv6 为 40 字节） | 源和目的 IP 来自两端的 GID；DSCP 和 TTL 来自 `ah_attr.grh` 的 `traffic_class` 和 `hop_limit` |
| UDP 头 | 8 字节 | 目的端口固定为 4791；源端口在 49152 到 65535 之间，内核按 flow label 算出来，没有 flow label 时按两端 QPN 算，目的是让交换机的 ECMP 把不同连接的流量散到不同链路上 |
| BTH | 12 字节 | 传输层的基本头部，所有 RDMA 报文都有，字段见下表 |
| RETH | 16 字节 | 64 位远端虚拟地址、32 位 rkey、32 位消息总长度，来自 WR 的 `wr.rdma`。只有 RDMA WRITE 的 FIRST 和 ONLY 报文、RDMA READ 请求有，MIDDLE 和 LAST 没有 |
| 载荷 | 不超过 MTU | |
| ICRC | 4 字节 | 覆盖 IP 头、UDP 头、BTH 和后面全部内容的 CRC32，由网卡计算和校验 |
| 以太网 FCS | 4 字节 | |

BTH 的字段：

| 字段 | 位数 | 内容 |
| --- | --- | --- |
| OpCode | 8 | 高 3 位是传输类型（RC 为 000，UC 为 001，UD 为 011），低 5 位是操作。RC 的 RDMA WRITE FIRST 是 0x06，LAST 是 0x08，ONLY 是 0x0a，ACK 是 0x11 |
| SE | 1 | Solicited Event，由 `IBV_SEND_SOLICITED` 置位，只在消息的最后一个报文上有意义 |
| M | 1 | 迁移相关，RoCE 下不用 |
| PadCnt | 2 | 载荷末尾补了几个字节 |
| TVer | 4 | 传输头版本，为 0 |
| P_Key | 16 | 分区键，来自 INIT 时的 `pkey_index` |
| DestQP | 24 | 对端的 QPN，来自 RTR 时的 `dest_qp_num`。对端网卡靠它找到 QP |
| AckReq | 1 | 要求对端回 ACK |
| PSN | 24 | 这个报文的序号 |

两个保留字段共 15 位，没有列出。

AckReq 值得单独说。RC 的可靠性靠 ACK，但规范不要求每个报文都确认，发送方在需要确认的报文上置 AckReq，接收方收到这样的报文必须回 ACK，其它报文可以攒着一起确认。rxe 的做法是在每条消息的最后一个报文上置位，另外连续 64 个报文没要过 ACK 也置一次。例子里的 FIRST 报文不置，LAST 报文置位。

ICRC 的计算范围有一个细节：IP 头里的 TTL、DSCP 和校验和、UDP 头里的校验和、BTH 里的一个保留字节，这些在传输中会变或者和传输层无关的字段，计算时按全 1 代入。这样报文经过路由器被改了 TTL 之后，ICRC 仍然能对上。校验和起点是一个固定的种子，对应 InfiniBand 下被屏蔽掉的 LRH。

### 一个报文的开销

按上面的长度算，一个 MIDDLE 报文在 4096 字节载荷之外有 14 + 20 + 8 + 12 + 4 + 4 = 62 字节的头部和校验，FIRST 报文再加 16 字节 RETH。这也解释了为什么 RoCE 的 4096 MTU 需要以太网开巨型帧：内核把网口 MTU 减去 96 字节（按 IPv6 的 GRH、UDP、BTH、最长的扩展头和 ICRC 算）之后，向下取到 256、512、1024、2048、4096 中最大的一档，作为端口的 `active_mtu`。网口 MTU 为 1500 时端口 MTU 只有 1024，要用 4096 至少要把网口 MTU 设到 4192，常见做法是 9000。

### 发送方的记账

报文发出后，A 的网卡还没有完事。它记着这条 WR 从哪个 PSN 到哪个 PSN，启动了第六篇说的 ACK 超时定时器，并限制未确认的报文数量：rxe 最多允许 128 个 PSN 在途，硬件的上限由各自实现决定。在收到 ACK 之前，WQE 留在 SQ 里，数据缓冲区也不能动，因为可能要重传。

## 对端网卡处理

B 的网卡收到报文后，按顺序做下面的检查，任何一步不通过都有对应的处理：

1. 校验 ICRC，不对的报文直接丢弃，不做任何回应。
2. 按 BTH 的 DestQP 找到 QP。QP 不存在或者不在能收的状态，丢弃。
3. 检查 P_Key 和 QP 的一致。
4. 比较 PSN 和 QP 期望的下一个 PSN，期望值的起点是第六篇 RTR 时填的 `rq_psn`。相等，继续。比期望值大，说明中间丢了报文，回一个 PSN 序列错误的 NAK，然后丢弃后续所有不等于期望值的报文，直到发送方从期望的 PSN 重传；这个 NAK 只发一次。比期望值小，是重传的重复报文，对 SEND 和 WRITE 再回一次 ACK，对 READ 重新回数据。
5. 检查操作码序列：FIRST 之后只能跟 MIDDLE 或 LAST，ONLY 和 FIRST 只能在前一条消息结束后出现。
6. 检查 QP 的 `qp_access_flags` 是否开放了这类操作。RDMA WRITE 需要 `IBV_ACCESS_REMOTE_WRITE`。
7. FIRST 和 ONLY 报文从 RETH 取地址、rkey 和长度，按第五篇的步骤检查 rkey、PD、权限和范围。MIDDLE 和 LAST 沿用 FIRST 记下的位置，每收一个报文往后推进。
8. 检查长度：MIDDLE 报文的载荷必须正好是 MTU，LAST 报文的载荷必须正好是剩余长度，PadCnt 要和长度对得上。
9. DMA 把载荷写进 B 的内存。
10. 更新期望的 PSN 为当前 PSN 加一。消息结束时，MSN（Message Sequence Number，已完成的消息计数）加一。

整个过程 B 的 CPU 不参与。RDMA WRITE 不消耗 B 的接收 WQE，也不在 B 的 CQ 里产生 CQE，B 的应用不知道有数据写进来了。要让 B 知道，发送方要用 RDMA WRITE WITH IMMEDIATE：它消耗 B 的一条接收 WQE（缓冲区本身不用，只是占一条），在 B 的 CQ 里产生一条 `IBV_WC_RECV_RDMA_WITH_IMM` 的 CQE，`imm_data` 是发送方给的 32 位值，`byte_len` 是写入的总长度。

如果是 SEND，第 7 步换成从 RQ 取一条接收 WQE，数据写进它的 SGE 指向的缓冲区，消息结束时产生 `IBV_WC_RECV` 的 CQE。RQ 空着时，B 回 RNR NAK，NAK 里带着 RTR 时设的 `min_rnr_timer`，告诉 A 等多久再重传。

### ACK 报文

收到置了 AckReq 的 LAST 报文后，B 的网卡回一个 ACK。ACK 也是一个 RDMA 报文，操作码是 ACKNOWLEDGE（0x11），BTH 的 PSN 填被确认的报文的 PSN，BTH 后面跟 4 字节的 AETH（ACK Extended Transport Header）：

| 字段 | 位数 | 内容 |
| --- | --- | --- |
| Syndrome | 8 | 高 3 位是类型：000 为 ACK，001 为 RNR NAK，011 为 NAK。低 5 位的含义随类型变：ACK 时是信用值，0x1f 表示不限制；RNR NAK 时是 `min_rnr_timer` 的编码；NAK 时是错误码，0 为 PSN 序列错误，1 为无效请求，2 为远程访问错误，3 为远程操作错误 |
| MSN | 24 | 接收方已完成的消息计数 |

ACK 是累积的：确认 PSN 为 n 的报文，就等于确认了 n 之前的全部报文。所以例子里 B 只回一个 ACK，PSN 为 LAST 报文的 PSN，A 据此知道 FIRST 也到了。

RDMA READ 的响应报文也带 AETH，数据和确认合在一起回来，不单独发 ACK。原子操作的响应带 AETH 和 8 字节的原始值。

{% include figure.html src="/assets/images/rdma-08-one-transfer/02-sequence.svg" alt="A、B 两端的时间线：A 写 WQE 和门铃记录、写门铃寄存器，网卡读 WQE 和数据，发出 RDMA WRITE FIRST（PSN n，带 RETH）和 RDMA WRITE LAST（PSN n+1，AckReq）；B 的网卡逐个校验 PSN 和 rkey 后 DMA 写入内存，回 ACK（PSN n+1，AETH）；A 的网卡收到 ACK 后写 CQE，应用 ibv_poll_cq 取出 wr_id 为 42 的完成" caption="图 2：8 KB RDMA WRITE 的报文交换和两端的动作" %}

## 发送方收到 ACK

A 的网卡收到 ACK，先校验 ICRC，按 DestQP 找到 QP，然后拿 ACK 的 PSN 和 SQ 里最早一条未完成的 WR 比较：

- ACK 的 PSN 大于等于这条 WR 的最后一个 PSN，这条 WR 完成，重试计数复位，定时器重新计时，下一个期望确认的 PSN 变成最后一个 PSN 加一。
- ACK 的 PSN 落在这条 WR 中间，只说明前面的报文到了，WR 还没完成。
- NAK 的处理放到第十篇。

WR 完成后，网卡决定要不要写 CQE：请求置了 `IBV_SEND_SIGNALED`，或者 QP 创建时 `sq_sig_all` 为 1，或者完成状态是错误，就写；否则不写。不写 CQE 的请求叫 unsignaled，它占用的 SQ 单元在后面某条 signaled 请求完成时一起释放。这是常见的降低开销的手段：连续发十条，只给最后一条置 signaled，取一条 CQE就知道十条都完成了。代价是应用不能靠 CQE 判断前九条的缓冲区何时能复用，只能等第十条。

### CQE 怎么到应用手里

CQ 的缓冲区在主机内存里，网卡用 DMA 写 CQE。mlx5 的 CQE 默认 64 字节，里面有 WQE 的序号、操作码、状态或错误码、字节数、立即数、QPN。CQE 有一个所有权位，网卡每写满一圈翻转一次，provider 按自己的消费位置算出这一圈应该是什么值，对得上才算是新的 CQE。这样 provider 不需要和网卡交换任何计数就能知道有没有新的完成。

`ibv_poll_cq` 做的事：

1. 看消费位置上的 CQE 所有权位是不是新的。不是，返回 0。
2. 是，按 CQE 里的 QPN 找到 QP，按 WQE 序号查 `wrid` 数组得到 `wr_id`，把操作码、状态翻译成 `ibv_wc` 的字段。发送完成的 `opcode` 是 WQE 的操作码，例子里是 `IBV_WC_RDMA_WRITE`；mlx5 只在 READ 和原子操作的发送完成里填 `byte_len`。
3. 消费位置加一，把新的消费位置写进 CQ 的门铃记录，网卡据此知道 CQ 里还有多少空位。

整个过程不进内核，也不碰网卡寄存器，所以轮询的开销只是读一个缓存行。CQE 的状态不是 `IBV_WC_SUCCESS` 时，`ibv_wc` 里只有 `wr_id`、`status`、`qp_num` 和 `vendor_err` 有效，其余字段不要读。

用事件通知时，`ibv_req_notify_cq` 让 provider 写 CQ 的门铃记录和一个 CQ 门铃寄存器，告诉网卡下一条 CQE 写入后发中断。中断由内核处理，最终让完成事件通道的文件描述符可读，`ibv_get_cq_event` 返回。第四篇说过这个通知是一次性的，取完事件要再调一次 `ibv_req_notify_cq`，并且重新调之后还要再轮询一遍 CQ，因为通知设置和上一次轮询之间可能已经来了新的 CQE。

到这里，A 的应用拿到了 `wr_id` 为 42、状态为成功的 CQE，缓冲区可以复用，一次 RDMA WRITE 结束。

## 各个环节谁在做什么

把上面的过程按参与者整理一下：

| 环节 | A 的 CPU | A 的网卡 | B 的网卡 | B 的 CPU |
| --- | --- | --- | --- | --- |
| 投递 | 写 WQE、门铃记录、门铃寄存器 | | | |
| 取请求 | | 读 WQE，检查 lkey，读数据 | | |
| 发送 | | 切包，加头部和 ICRC，发出 | | |
| 接收 | | | 校验 ICRC、PSN、rkey，DMA 写入 | |
| 确认 | | | 回 ACK | |
| 完成 | | 匹配 ACK，写 CQE | | |
| 取完成 | 轮询 CQ，更新消费位置 | | | |

B 的 CPU 一列是空的，这就是单边操作的含义。A 的 CPU 做的两件事都不进内核，和网卡的交互只有一次 MMIO 写。

数据在这个过程中的位置：A 的缓冲区，通过 PCIe 到 A 的网卡，网络，B 的网卡，通过 PCIe 到 B 的缓冲区。中间没有任何一次内存拷贝，第一篇说的“零拷贝”指的就是这条路径。

## SEND 和 READ 的不同

同样的框架套到另外两种操作上：

SEND 的报文没有 RETH，数据写到哪里由 B 的接收 WQE 决定。B 的应用要提前用 `ibv_post_recv` 投递接收请求，接收 WQE 只有 SGE 列表和 `wr_id`，mlx5 的 `ibv_post_recv` 只更新 RQ 的门铃记录，不写寄存器。B 的网卡按报文到达的顺序消耗接收 WQE，一条消息用一条，缓冲区比消息小时回 NAK（无效请求），消息结束时在 B 的 CQ 里产生 CQE，`byte_len` 是收到的长度。

RDMA READ 的请求只有一个报文，带 RETH，不带数据。B 的网卡做和 WRITE 同样的检查，然后从自己的内存读数据，切成 RDMA READ RESPONSE FIRST、MIDDLE、LAST 或 ONLY 报文回给 A，FIRST、LAST 和 ONLY 带 AETH。A 的网卡把响应数据按请求的 SGE 写进 A 的内存，最后一个响应到达时 WR 完成，CQE 的 `byte_len` 是读到的长度。一次 READ 在 B 端要占用一份第六篇说的响应方资源，直到全部响应发完，所以同时在途的 READ 数量受 `max_rd_atomic` 和 `max_dest_rd_atomic` 限制。

三种操作的语义差别、各自适合什么场景，以及 UC 和 UD 下这个过程少了哪些步骤，放到下一篇。

## 这一步的产出

一次 RDMA WRITE 结束时，数据到了 B 的缓冲区，A 拿到了一条 CQE。回头看，第一篇的流程图里“投递请求”和“获取完成事件”两个框之间，是这一篇展开的内容：WQE 的格式、门铃、切包、BTH 和 RETH 的字段、对端的十项检查、ACK 和 AETH、CQE 的所有权位。这些在正常情况下应用都看不到，排查丢包、乱序、性能问题时就要用到。下一篇讲操作语义和传输类型，第十篇讲这里面每一项检查不通过时发生什么。

## 参考资料

接口文档（rdma-core man page）：

- ibv_post_send(3)（`struct ibv_send_wr`、`send_flags`、各传输类型支持的操作码）. <https://man7.org/linux/man-pages/man3/ibv_post_send.3.html>
- ibv_post_recv(3)（`struct ibv_recv_wr`）. <https://man7.org/linux/man-pages/man3/ibv_post_recv.3.html>
- ibv_poll_cq(3)（`struct ibv_wc`、出错时哪些字段有效）. <https://man7.org/linux/man-pages/man3/ibv_poll_cq.3.html>
- ibv_req_notify_cq(3)（通知是一次性的，solicited 的含义）. <https://man7.org/linux/man-pages/man3/ibv_req_notify_cq.3.html>
- ibv_get_cq_event(3)（事件方式的完整示例和竞争条件说明）. <https://man7.org/linux/man-pages/man3/ibv_get_cq_event.3.html>
- ibv_wr_post(3)（新的投递接口 `ibv_wr_start`、`ibv_wr_rdma_write`、`ibv_wr_set_sge`、`ibv_wr_complete`）. <https://man7.org/linux/man-pages/man3/ibv_wr_post.3.html>

rdma-core 源码：

- `providers/mlx5/qp.c`（`mlx5_post_send` 的 WQE 构造、`post_send_db` 的门铃记录和 BlueFlame、`mlx5_post_recv`）. <https://github.com/linux-rdma/rdma-core/blob/master/providers/mlx5/qp.c>
- `providers/mlx5/cq.c`（`get_sw_cqe` 的所有权位判断、`handle_good_req`、`mlx5_handle_error_cqe`、`mlx5_arm_cq`）. <https://github.com/linux-rdma/rdma-core/blob/master/providers/mlx5/cq.c>
- `providers/mlx5/mlx5dv.h`（`mlx5_wqe_ctrl_seg`、`mlx5_wqe_raddr_seg`、`mlx5_wqe_data_seg`、`mlx5_cqe64`、mlx5 操作码）. <https://github.com/linux-rdma/rdma-core/blob/master/providers/mlx5/mlx5dv.h>
- `libibverbs/examples/rc_pingpong.c`（`pp_post_send`、`pp_post_recv` 和轮询、事件两种取完成的写法）. <https://github.com/linux-rdma/rdma-core/blob/master/libibverbs/examples/rc_pingpong.c>

内核源码：

- Linux `include/rdma/ib_pack.h`（各头部的长度、`IB_OPCODE_*` 操作码编码、`ib_unpacked_bth`）. <https://github.com/torvalds/linux/blob/master/include/rdma/ib_pack.h>
- Linux `drivers/infiniband/core/ud_header.c`（`bth_table`：BTH 各字段的位置和位数）. <https://github.com/torvalds/linux/blob/master/drivers/infiniband/core/ud_header.c>
- Linux `include/rdma/ib_addr.h`（`iboe_get_mtu`：网口 MTU 到端口 MTU 的换算）. <https://github.com/torvalds/linux/blob/master/include/rdma/ib_addr.h>
- Linux `include/rdma/ib_verbs.h`（`rdma_get_udp_sport`：RoCE v2 UDP 源端口）. <https://github.com/torvalds/linux/blob/master/include/rdma/ib_verbs.h>
- Linux 软件 RoCE 驱动 `drivers/infiniband/sw/rxe/`：`rxe_hdr.h`（BTH、RETH、AETH 的结构和 AETH syndrome 编码）、`rxe_opcode.c`（每种操作码带哪些头部）、`rxe_req.c`（切包、操作码序列、AckReq、PSN 记账）、`rxe_resp.c`（接收方的检查顺序、ACK 和 NAK 的发送）、`rxe_comp.c`（ACK 匹配、重试计数、CQE 生成）、`rxe_icrc.c`（ICRC 的计算范围和屏蔽字段）、`rxe_net.c`（UDP 封装）、`rxe_param.h`（在途报文数和 ACK 间隔的常量）. <https://github.com/torvalds/linux/tree/master/drivers/infiniband/sw/rxe>

规范与手册：

- InfiniBand Trade Association. InfiniBand Architecture Specification Volume 1（第 5 章数据报文格式，第 9 章传输层：PSN、AckReq、ACK 合并、AETH、ICRC）. <https://www.infinibandta.org/ibta-specification/>
- InfiniBand Trade Association. Annex A17: RoCEv2（UDP 封装、源端口的选取、ICRC 的计算范围）. <https://www.infinibandta.org/ibta-specification/>
- IANA. Service Name and Transport Protocol Port Number Registry（UDP 4791，RoCE v2）. <https://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.xhtml?search=4791>
- NVIDIA. RDMA-Aware Networks Programming Guide. <https://networking-docs.nvidia.com/doca/sdk/rdma-aware-networks-programming-guide>
