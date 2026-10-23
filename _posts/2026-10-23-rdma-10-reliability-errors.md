---
title: "RDMA 入门（十）：可靠性与出错处理"
description: "第八篇对端网卡的十项检查不通过时各发生什么：哪些报文被静默丢弃，哪些回 PSN 序列错误或 RNR NAK 让发送方重传，哪些回致命 NAK 让两端 QP 进入错误状态；发送方的超时、重传从哪个 PSN 开始、retry_cnt 和 rnr_retry 怎么被用掉；CQE 里常见错误状态的含义、flush 的规则、异步事件；QP 进入 ERR 之后怎么回收资源和重建，以及出错时按什么顺序排查。"
date: 2026-10-23 16:00:00 +0800
tags: [RDMA, 网络, RoCE, InfiniBand]
series: rdma
series_order: 10
---

第八篇跟着一次 8 KB 的 RDMA WRITE 走完了正常路径，有两处留到了这一篇：对端网卡的检查不通过时怎么办，发送方收到 NAK 怎么办。第九篇讲 SEND 和原子操作时提到的几种错误状态，也只给了结论。这一篇看出错的路径：报文丢了怎么重传，对端没准备好怎么等，请求不合法时两端各发生什么，应用怎么从 CQ 和异步事件里知道出了错，QP 进入错误状态以后怎么收拾。

全篇沿用第八篇的例子：主机 A 向主机 B 做 RDMA WRITE，RoCE v2，IPv4，路径 MTU 为 4096，传输类型是 RC。用户态的部分以 rdma-core 的 mlx5 provider 为例，网卡内部的处理仍借助内核的软件 RoCE 驱动 rxe 来说明。规则以 InfiniBand Architecture Specification Volume 1 第 9 章为准，硬件网卡在细节上可能和 rxe 不同，下文遇到这种地方会标出来。

## 对端网卡的检查不通过时

第八篇列了 B 的网卡对每个请求报文做的十项检查。每一项不通过，B 的处理是下面三种之一：

1. 丢弃报文，什么都不回。A 收不到任何回应，只能等 ACK 超时后重传。
2. 丢弃报文，回 PSN 序列错误 NAK 或 RNR NAK。这两种 NAK 的意思是“请重传”，A 照做，QP 状态不变。
3. 丢弃报文，回无效请求、远程访问错误或远程操作错误 NAK，然后把自己的 QP 切到 ERR。A 收到后不重传，这条 WR 以错误状态完成，A 的 QP 也进入 ERR。

前两种是 RC 可靠性的来源：丢包、乱序、接收方暂时没准备好，都由网卡重传消化掉，应用看不到。只有重传次数用尽，或者请求本身不合法时，错误才以 CQE 的形式出现在应用面前，这时连接已经不能用了。RC 下不存在“这一条失败、下一条继续”的情况。

每项检查对应哪一种：

| 检查 | B 的处理 | B 的 QP |
| --- | --- | --- |
| ICRC | 丢弃，不回 | 不变 |
| 目标 QP 存在且处于能收的状态 | 丢弃，不回 | 不变 |
| P_Key | 丢弃，不回，端口的 `bad_pkey_cntr` 加一 | 不变 |
| PSN 比期望值大 | 丢弃，回 PSN 序列错误 NAK（只回一次） | 不变 |
| PSN 比期望值小 | 当作重复请求，再回一次 ACK 或 READ 响应 | 不变 |
| 操作码序列 | 丢弃，回无效请求 NAK | ERR |
| QP 的 `qp_access_flags` | 丢弃，rxe 回无效请求 NAK | ERR |
| SEND 时 RQ 为空 | 丢弃，回 RNR NAK | 不变 |
| rkey、PD、MR 权限、地址范围 | 丢弃，回远程访问错误 NAK | ERR |
| 长度；SEND 时接收缓冲区放不下 | 丢弃，回无效请求 NAK | ERR |
| 原子操作地址没有 8 字节对齐 | 丢弃，回无效请求 NAK | ERR |
| 接收 WQE 本身不合法 | 丢弃，回远程操作错误 NAK | ERR |
| B 的 CQ 满了 | 丢弃，不回 | ERR |

前三项不通过时不回 NAK，是因为这时 B 还不能确定报文属于哪个连接，报文本身也可能已经损坏。第二项包括 B 的 QP 已经销毁或者已经在 ERR 的情况，所以 B 的进程退出以后，A 看到的不是一个明确的错误，而是一段时间的重传，最后以 `IBV_WC_RETRY_EXC_ERR` 告终。

`qp_access_flags` 这一项，rxe 把 QP 不允许的操作当作不支持的操作码处理，回的是无效请求 NAK，A 看到 `IBV_WC_REM_INV_REQ_ERR`；MR 那一层的检查不通过，才回远程访问错误 NAK，A 看到 `IBV_WC_REM_ACCESS_ERR`。

最后一行是个特例：B 的 CQ 满了，B 的 QP 直接进 ERR，但不回 NAK，A 等不到确认，最后也是超时。

{% include figure.html src="/assets/images/rdma-10-reliability-errors/01-responder.jpg" alt="接收方处理一个请求报文的流程：依次经过 ICRC 与 QP、PSN、操作码与权限、接收资源、长度与 rkey 几道检查，全部通过后写入内存并回 ACK。每道检查向下分出失败的去向：前几项静默丢弃；PSN 比期望值大回 PSN 序列错误 NAK；RQ 为空回 RNR NAK；其余回无效请求、远程访问错误或远程操作错误 NAK，并让接收方 QP 进入 ERR" caption="图 1：接收方每道检查不通过时的去向" %}

下面三节分别看这三种处理在 A 那边引起什么。

## 丢包与重传

### FIRST 丢了

8 KB 的 WRITE 切成两个报文，FIRST 的 PSN 为 n，LAST 为 n+1。假设 FIRST 在网络里丢了，LAST 到了 B：

1. B 期望的 PSN 是 n，收到 n+1，比期望值大，丢弃 LAST，回一个 PSN 序列错误 NAK。NAK 里 BTH 的 PSN 填 B 期望的 PSN，也就是 n。
2. B 记下已经回过 NAK。此后到达的 PSN 不等于 n 的报文，B 一律静默丢弃，不再回 NAK，直到 PSN 为 n 的报文到来。
3. A 收到 NAK。NAK 的 PSN 之前的报文视为已经确认，A 把发送位置拉回 n，重新发出 FIRST 和 LAST。
4. B 收到 PSN 为 n 的 FIRST，一切恢复正常，最后回 ACK。

如果 A 在 LAST 之后还发了别的 WR，比如 PSN 为 n+2、n+3 的报文，它们也已经被 B 丢弃，A 要从 n 开始全部重发。这叫 go-back-N：从缺失的位置开始，后面的全部重来，接收方不缓存乱序到达的报文。所以 RC 丢一个报文的代价是一个往返时间，加上后面所有在途报文的重传。如果那个 NAK 也丢了，代价就变成一个完整的超时周期。

重传的第一条 WR 不一定从头发：SEND 和 WRITE 从缺失的那个报文开始；READ 从已经收到的数据之后开始，按收到的字节数算出新的远端地址重新发请求。后面的 WR 都从头发。

### LAST 丢了

换成 LAST 丢了。B 收到 FIRST，PSN 正好是期望值，正常写入内存；之后再没有报文到来，B 没有发现任何 PSN 不对的报文，不会回 NAK。A 只能等第六篇说的 ACK 超时定时器到期（4.096 µs × 2^`timeout`），然后从最早未确认的 PSN，也就是 n+1，重发 LAST。

ACK 本身丢了也是同样的结果：A 等到超时后重发 LAST，B 收到的是 PSN 比期望值小的重复报文，再回一次 ACK。重复的 WRITE 不会被写第二次，B 只是重新确认。

`timeout` 填 0 时 A 不启动定时器，这种情况下 QP 会一直等下去。rxe 用内核定时器实现超时，时间换算成 jiffies 后最少 1 个 jiffy，所以 `timeout` 填得很小时，实际等待比公式算出来的长。

{% include figure.html src="/assets/images/rdma-10-reliability-errors/02-retransmit.jpg" alt="发送方和接收方两条时间线：发送方连续发出 PSN n、n+1、n+2 三个报文，n 在网络中丢失；接收方收到 n+1 时回 PSN 序列错误 NAK，PSN 为 n，之后的 n+2 被静默丢弃；发送方收到 NAK 后从 n 开始重传 n、n+1、n+2，接收方回 ACK。下方另一组时间线表示最后一个报文丢失时，接收方不回任何东西，发送方等 ACK 超时后重传" caption="图 2：go-back-N 重传：NAK 触发和超时触发" %}

### 重传的次数

收到 PSN 序列错误 NAK 和 ACK 超时，消耗的是同一个计数 `retry_cnt`。每重传一轮减一，减到 0 后再需要重传时，这条 WR 以 `IBV_WC_RETRY_EXC_ERR` 完成，A 的 QP 进入 ERR。

第六篇说 `retry_cnt` 是重传的次数上限，准确地说是连续重传的上限：A 收到任何一个推进了确认位置的 ACK 或 READ 响应，`retry_cnt` 就恢复成 RTS 时设的值。所以一条长期使用的连接偶尔丢包不会累积到失败，只有连续 `retry_cnt` 轮重传都没有进展才会。`timeout` 为 14、`retry_cnt` 为 7 时，从对端失联到报错约 8 个超时周期，0.54 s，这是第六篇算过的数。

rxe 在这里和规范不一致：它把 `retry_cnt` 为 7 当作无限重试。规范里只有 `rnr_retry` 的 7 表示无限，硬件网卡按规范处理。用 rxe 做实验观察重传用尽时，`retry_cnt` 要填小于 7 的值。

### READ 不能被隐式确认

WRITE 和 SEND 的 ACK 是累积的，确认 PSN 为 m 的报文，就确认了 m 之前的全部请求。READ 不一样，数据没回来就是没回来。假设 A 先发了一个 READ，后面跟着一个 WRITE，READ 的响应丢了，WRITE 的 ACK 到了。A 的网卡不会因为这个 ACK 把 READ 当作完成，而是从这个 READ 开始重传。原子操作同理。

## 对端没准备好：RNR

换一个例子：A 向 B 发 SEND，B 的 RQ 是空的。B 回 RNR NAK，AETH 的低 5 位填 B 在 RTR 时设的 `min_rnr_timer`，B 的 QP 状态不变。A 收到后：

1. `rnr_retry` 大于 0 时减一，等于 7 时不减，即无限重试。
2. 按 NAK 里的 `min_rnr_timer` 等待一段时间。
3. 从这条 SEND 开始重发。

`rnr_retry` 减到 0 后又收到 RNR NAK，这条 SEND 以 `IBV_WC_RNR_RETRY_EXC_ERR` 完成，A 的 QP 进入 ERR。和 `retry_cnt` 一样，A 收到正常的确认后，`rnr_retry` 也会恢复。

`min_rnr_timer` 是 5 位编码，和等待时间的对应关系由规范给出，不是线性的：

| `min_rnr_timer` | 等待时间 |
| --- | --- |
| 0 | 655.36 ms |
| 1 | 0.01 ms |
| 4 | 0.04 ms |
| 8 | 0.12 ms |
| 12 | 0.64 ms |
| 16 | 2.56 ms |
| 20 | 10.24 ms |
| 24 | 40.96 ms |
| 31 | 491.52 ms |

0 是最长的一档，不是“不等待”。把它当成普通数值填 0，每次 RNR 都要等 0.65 秒，吞吐几乎降到零，现象上很像网络断了。

## 请求不合法：两端都进入 ERR

再换一个例子：A 做 RDMA WRITE 用的 rkey 不对，比如 B 已经注销了那个 MR。

B 的网卡在检查 rkey 时失败，回远程访问错误 NAK，然后把自己的 QP 切到 ERR。WRITE 不消耗 B 的接收 WQE，B 的 CQ 里不会有任何记录，B 的应用无从得知。为此规范要求这种没法挂到某条接收 WQE 上的错误用异步事件报告，rxe 给 B 发 `IBV_EVENT_QP_ACCESS_ERR`。

A 收到 NAK，不重传，这条 WR 以 `IBV_WC_REM_ACCESS_ERR` 完成。即使 A 没给它置 `IBV_SEND_SIGNALED`，错误完成也一定写 CQE。然后 A 的 QP 也进入 ERR。

三种致命 NAK 在 A 那边对应的状态：

| NAK | A 的 CQE 状态 | 常见原因 |
| --- | --- | --- |
| 无效请求 | `IBV_WC_REM_INV_REQ_ERR` | SEND 超过接收缓冲区、原子操作没对齐、B 不接受 READ 或原子操作 |
| 远程访问错误 | `IBV_WC_REM_ACCESS_ERR` | rkey 不对、MR 已经注销、地址或长度越界、MR 没有对应权限 |
| 远程操作错误 | `IBV_WC_REM_OP_ERR` | B 本地出了问题，比如接收 WQE 不合法 |

如果出错的请求消耗了 B 的接收 WQE，比如 SEND 超过了接收缓冲区，B 的 CQ 里会有一条错误的接收 CQE，rxe 里状态是 `IBV_WC_REM_INV_REQ_ERR`。

## 应用看到的错误

### CQE 的状态

第八篇说过，CQE 的状态不是 `IBV_WC_SUCCESS` 时，`ibv_wc` 里只有 `wr_id`、`status`、`qp_num` 和 `vendor_err` 有效。`ibv_wc_status_str` 把状态转成可读的字符串。除了上面几节出现的，RC 上常见的还有：

| 状态 | 含义 |
| --- | --- |
| `IBV_WC_WR_FLUSH_ERR` | QP 已经在 ERR，这条请求没有执行。是结果，不是原因 |
| `IBV_WC_LOC_PROT_ERR` | 本端的 lkey 不对，或者本地缓冲区超出了 MR 的范围；READ 的响应数据写不进本地缓冲区也是这个 |
| `IBV_WC_LOC_QP_OP_ERR` | 本端 WQE 不合法，比如 SGE 数超过 QP 的上限 |
| `IBV_WC_LOC_LEN_ERR` | 本端长度错误，比如消息超过端口的 `max_msg_sz` |
| `IBV_WC_BAD_RESP_ERR` | 收到的响应和请求对不上，正常情况下见不到 |

`vendor_err` 是网卡厂商自己的错误码，向厂商报问题时要带上，但取值没有标准，程序逻辑不要依赖它。

### flush

QP 进入 ERR 后，SQ 和 RQ 里没完成的 WR 全部以 `IBV_WC_WR_FLUSH_ERR` 完成。ERR 状态下新投递的 WR 也一样，`ibv_post_send` 照常返回成功，随后得到一条 flush 的 CQE。

SQ 是按顺序完成的，所以 CQ 里第一条非 flush 的错误 CQE 之前，这个 QP 的 WR 都已经成功，包括没写 CQE 的 unsignaled 请求；这一条之后的全部被 flush。排查时要找的就是这第一条，它的 `wr_id` 指向真正出问题的请求。

flush 的 CQE 同样占 CQ 的位置。SQ 和 RQ 都满时，一次 flush 就是两个队列深度之和的 CQE，按正常负载估算的 CQ 可能装不下。CQ 溢出后这个 CQ 不能再用，挂在它上面的 QP 也跟着出错。

用 SRQ 时情况不同。SRQ 里的接收 WQE 是多个 QP 共享的，一个 QP 进 ERR 不能把它们 flush 掉，网卡改为发一个异步事件 `IBV_EVENT_QP_LAST_WQE_REACHED`，表示这个 QP 不会再从 SRQ 取 WQE 了。

### 异步事件

不对应任何一条 WR 的错误，只能通过异步事件报告。应用用 `ibv_get_async_event` 读取，每个事件处理完都要调用 `ibv_ack_async_event`，否则之后销毁对应的 QP、CQ 时会一直阻塞。和出错有关的几个：

| 事件 | 含义 |
| --- | --- |
| `IBV_EVENT_QP_FATAL` | QP 出错进入 ERR，原因挂不到某条 WR 上 |
| `IBV_EVENT_QP_REQ_ERR` | 作为接收方检测到无效请求，QP 进入 ERR |
| `IBV_EVENT_QP_ACCESS_ERR` | 作为接收方检测到访问违规，QP 进入 ERR |
| `IBV_EVENT_QP_LAST_WQE_REACHED` | 用 SRQ 的 QP 进入 ERR 后，不会再从 SRQ 取 WQE |
| `IBV_EVENT_CQ_ERR` | CQ 溢出 |
| `IBV_EVENT_PORT_ERR`、`IBV_EVENT_PORT_ACTIVE` | 端口断开、恢复 |
| `IBV_EVENT_DEVICE_FATAL` | 网卡整体故障，所有资源都要重建 |

上一节的 B 就是例子：单边操作出错时，接收方没有 CQE，异步事件是它唯一能及时知道的途径。

## QP 进入 ERR 之后

### 对端怎么知道

RC 的传输层没有“断开连接”的报文。A 的 QP 进了 ERR，B 不会收到任何通知；B 下次发请求时，A 的网卡因为 QP 不在能收的状态而静默丢弃，B 重传用尽，以 `IBV_WC_RETRY_EXC_ERR` 告终。如果 B 之后一直不发请求，它可能永远不知道。

用 RDMA CM 建链的程序多一层通知：`rdma_disconnect` 把本端 QP 切到 ERR，同时通过 CM 发断开请求，对端收到 `RDMA_CM_EVENT_DISCONNECTED`。进程崩溃时内核清理它的 CM ID，同样会发出断开请求。第七篇那种用 TCP 交换信息、自己建链的程序，要靠那条 TCP 连接或者心跳来发现对端失联。

### 回收资源

应用靠 `wr_id` 认领缓冲区。一条 WR 没拿到它的 CQE，就不能确定网卡已经不再访问它的缓冲区。所以 QP 进入 ERR 之后，要等所有已投递的 WR 都以 flush 状态出现在 CQ 里，再复位或销毁 QP。第六篇说过，复位会清空 SQ 和 RQ，里面的请求直接丢弃，不产生 CQE，先复位就再也拿不到那些 `wr_id` 了。

怎么知道 flush 已经全部出来：在 QP 进入 ERR 之后，向 SQ 和 RQ 各投递一条做标记的 WR，等到这条 WR 的 flush CQE。队列按顺序 flush，它之前的必然都已经出来了。内核态的 `ib_drain_qp` 就是这样做的，用户态没有现成的函数，要自己写。用 SRQ 时，还要等到 `IBV_EVENT_QP_LAST_WQE_REACHED` 再销毁 QP。

### 重建

ERR 不能直接回到 RTS。要么把 QP 切回 RESET，重新走 INIT、RTR、RTS；要么销毁后新建。两种做法都要两端重新交换信息：新建的 QP 的 QPN 变了，复位的 QP 要选新的起始 PSN，否则网络里残留的旧报文可能被当成新连接的报文。所以实际上就是两端各自清理，再按第七篇的流程重新建一次连接。大多数程序选择销毁重建，代码路径和第一次建链完全相同。

## 排查

出了错，先看 CQE，再看计数器，最后抓包。

看 CQE 的步骤：

1. 找第一条非 flush 的错误 CQE，打印状态、`vendor_err`、`qp_num`、`wr_id`。由 `wr_id` 找到出问题的请求：哪种操作，本地地址和 lkey，远端地址和 rkey，长度。
2. 状态是 `IBV_WC_REM_` 开头的，问题在对端。拿请求里的远端地址、rkey、长度去对端核对：MR 还在不在，权限对不对，范围够不够，接收缓冲区够不够大。对端应该同时收到了异步事件或错误的接收 CQE。
3. 状态是 `IBV_WC_LOC_` 开头的，问题在本端的 WR：lkey、地址、长度、SGE 数。
4. `IBV_WC_RETRY_EXC_ERR`，先确认对端进程和 QP 还活着，再查网络。`IBV_WC_RNR_RETRY_EXC_ERR`，查对端投递接收请求的逻辑。

网卡在每个端口上维护一组计数器，在 `/sys/class/infiniband/<设备>/ports/<端口>/hw_counters/` 下，也可以用 `rdma statistic show` 查看。跑一段负载前后各读一次，看增量。mlx5 上和这一篇有关的几个：

| 计数器 | 含义 |
| --- | --- |
| `out_of_sequence` | 作为接收方，收到 PSN 比期望值大的报文 |
| `packet_seq_err` | 作为发送方，收到 PSN 序列错误 NAK |
| `local_ack_timeout_err` | 作为发送方，ACK 超时 |
| `duplicate_request` | 作为接收方，收到重复请求 |
| `out_of_buffer` | 作为接收方，RQ 为空，回了 RNR NAK |
| `rnr_nak_retry_err` | RNR 重试用尽 |

`out_of_sequence` 和 `packet_seq_err` 持续增长，说明网络在丢包。RoCE 依赖无损网络，第六篇说过 DSCP 或 PCP 填错会让报文落进有损队列，交换机的 PFC 配置也要一起查。只有 `local_ack_timeout_err` 增长，丢的多半是消息的最后一个报文或 ACK，或者对端已经不响应。接收方 `duplicate_request` 增长、却没有丢包的计数，说明数据到了发送方还在重传，常见原因是 `timeout` 比往返时间加对端处理时间还小。没有丢包而吞吐上不去时，看 `np_cnp_sent`、`rp_cnp_handled` 这类拥塞计数器，它们增长说明网卡在按 ECN 标记降速，问题在拥塞。

用 rxe 时，RoCE 报文走内核协议栈，在 rxe 绑定的网卡上用 tcpdump 抓 UDP 4791 端口就能看到，Wireshark 能解析出 BTH 和 AETH，NAK 的类型和 PSN 一目了然。mlx5 的 RoCE 流量不经过内核协议栈，在以太网接口上抓不到，要在 `mlx5_0` 这样的 RDMA 设备上抓。

## 这一步的产出

到这里，RDMA 入门这个系列的十篇写完了。前九篇按第一篇流程图的顺序，从选网络、打开网卡、创建资源、注册内存、QP 状态迁移、交换信息，走到一次传输的报文和操作语义；这一篇补上出错的路径。第六篇里 `timeout`、`retry_cnt`、`rnr_retry`、`min_rnr_timer` 这几个参数当时只是表格里的数字，这一篇看到了它们分别在什么时候被用掉。归结起来，RC 出错只有两种结果：网卡重传消化掉，或者连接作废、两端重新建链；后一种情况下，应用要做的是找第一条错误 CQE、收齐 flush、处理异步事件。

## 参考资料

接口文档（rdma-core man page）：

- ibv_poll_cq(3)（`enum ibv_wc_status`，非 SUCCESS 时只有 `wr_id`、`status`、`qp_num`、`vendor_err` 有效）. <https://man7.org/linux/man-pages/man3/ibv_poll_cq.3.html>
- ibv_wc_status_str(3). <https://man7.org/linux/man-pages/man3/ibv_wc_status_str.3.html>
- ibv_get_async_event(3)、ibv_ack_async_event(3)（各异步事件的含义）. <https://man7.org/linux/man-pages/man3/ibv_get_async_event.3.html>
- ibv_modify_qp(3)（`timeout`、`retry_cnt`、`rnr_retry`、`min_rnr_timer`，ERR 和 RESET 状态）. <https://man7.org/linux/man-pages/man3/ibv_modify_qp.3.html>
- rdma_disconnect(3)、rdma_get_cm_event(3)（`RDMA_CM_EVENT_DISCONNECTED`）. <https://man7.org/linux/man-pages/man3/rdma_disconnect.3.html>、<https://man7.org/linux/man-pages/man3/rdma_get_cm_event.3.html>
- rdma-statistic(8). <https://man7.org/linux/man-pages/man8/rdma-statistic.8.html>

内核源码：

- Linux 软件 RoCE 驱动 rxe（接收方的检查和错误分类、四种 NAK 的处理、重传和 RNR 重试、flush）. <https://github.com/torvalds/linux/tree/master/drivers/infiniband/sw/rxe>

规范与手册：

- InfiniBand Trade Association. InfiniBand Architecture Specification Volume 1（第 9 章传输层：接收方的检查和错误分类、NAK 码、PSN 序列错误和重复请求、Local ACK Timeout 和重试计数、RNR NAK 与定时器编码、异步错误的报告；第 10 章 QP 状态和 flush；第 11 章完成状态和异步事件）. <https://www.infinibandta.org/ibta-specification/>
- NVIDIA. RDMA-Aware Networks Programming Guide（错误完成状态和异步事件）. <https://networking-docs.nvidia.com/doca/sdk/rdma-aware-networks-programming-guide>
- NVIDIA. Understanding mlx5 Linux Counters and Status Parameters. <https://enterprise-support.nvidia.com/s/article/understanding-mlx5-linux-counters-and-status-parameters>
