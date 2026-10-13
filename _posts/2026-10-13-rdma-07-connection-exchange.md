---
title: "RDMA 入门（七）：交换连接信息：socket 与 RDMA CM"
description: "建链前两端要交换哪些信息，用 TCP socket 自己交换时怎么做、要注意什么，RDMA CM 的 rdma_cm_id、地址解析、REQ/REP/RTU 报文各做了什么，它替应用填了哪些 QP 参数、填的是什么值，以及两种方式怎么选。"
date: 2026-10-13 16:30:00 +0800
tags: [RDMA, 网络, RoCE, InfiniBand]
series: rdma
series_order: 7
---

上一篇把 QP 推到 RTS 时，RTR 这一步要填对端的 QPN、起始 PSN 和 GID，这些值只有对端知道。QP 还没建好之前，两端没有 RDMA 连接可用，信息只能通过别的通道传过去。这一篇讲两种常见做法：用普通的 TCP socket 自己交换，以及用 librdmacm 提供的 RDMA CM（Communication Manager，连接管理器）。前者是示例程序和测试工具的常见做法，后者是大多数正式程序的做法。

文中以 RC 为主，涉及驱动实现的地方仍以 mlx5 为例。

## 要交换什么

把前几篇的产出汇总起来，建一条 RC 连接，一端需要从对端拿到这些值：

| 信息 | 本端来源 | 对端用在哪里 |
| --- | --- | --- |
| GID（RoCE）或 LID（InfiniBand） | `ibv_query_gid` / `ibv_query_port` | RTR 的 `ah_attr` |
| QPN | `qp->qp_num` | RTR 的 `dest_qp_num` |
| 起始 PSN | 应用自己选的随机数 | RTR 的 `rq_psn` |
| MTU | `ibv_query_port` 的 `active_mtu` | 两端取较小值填 `path_mtu` |
| 响应方资源数 | 应用决定 | 对端 RTS 的 `max_rd_atomic` 不应超过它 |
| 缓冲区地址、长度和 rkey | `ibv_reg_mr` | 发起 RDMA WRITE、READ 时使用 |

前五项是建链本身需要的，最后一项是建链之后做单边操作需要的。两种交换方式对它们的覆盖范围不同：socket 方式全部自己传；RDMA CM 替应用交换前五项，rkey 和地址仍要应用自己传。

## 方法一：用 socket 自己交换

rdma-core 自带的示例 `ibv_rc_pingpong` 就是这样做的。服务端监听一个 TCP 端口，客户端连上来，双方各把自己的信息格式化成一行文本发给对方：

```c
/* libibverbs/examples/rc_pingpong.c */
gid_to_wire_gid(&my_dest->gid, gid);
sprintf(msg, "%04x:%06x:%06x:%s", my_dest->lid, my_dest->qpn,
        my_dest->psn, gid);
write(sockfd, msg, sizeof msg);
read(sockfd, msg, sizeof msg);
sscanf(msg, "%x:%x:%x:%s", &rem_dest->lid, &rem_dest->qpn,
       &rem_dest->psn, gid);
wire_gid_to_gid(gid, &rem_dest->gid);
```

一行里是 LID、QPN、PSN 和 GID 的十六进制文本，中间用冒号隔开。性能测试工具 perftest 的做法类似，只是多传了缓冲区地址和 rkey。拿到对方的值之后，各自调用 `ibv_modify_qp` 把 QP 推到 RTS，TCP 连接就可以关掉了，之后的数据传输全部走 RDMA。

{% include figure.html src="/assets/images/rdma-07-connection-exchange/01-socket-exchange.svg" alt="客户端和服务端先各自创建好 QP，通过 TCP 交换 LID、QPN、PSN、GID 和 rkey，各自把 QP 推到 RTR，再通过 TCP 互相确认一次，然后各自推到 RTS，之后数据走 RDMA" caption="图 1：用 TCP socket 交换连接信息" %}

自己做交换时有几处要注意。

字节序和表示。两端可能是不同的机器，直接把结构体 `write` 过去，依赖的是两端字节序和结构体布局一致。pingpong 用文本避开了这个问题；传二进制的话，多字节整数要用 `htonl` 这类函数转成网络字节序，GID 本身是 16 字节的数组，按字节原样传即可。

顺序。上一篇讲过，一端进入 RTS 后就可能发出第一个请求，此时对端如果还没到 RTR，报文会被丢掉，只能靠超时重传补救。pingpong 的处理是：客户端发完自己的信息、收到服务端的信息后，把 QP 推到 RTS，再回一个 `done`；服务端收到客户端的信息后先推到 RTR，再把自己的信息发过去，收到 `done` 才继续。这样保证了服务端先到 RTR，客户端才会发送。自己实现时也要有类似的一次确认。

参数一致。`path_mtu` 两端要相同，`max_rd_atomic` 不能超过对端的 `max_dest_rd_atomic`。socket 方式下没有人替你检查，要么在交换的信息里带上这些值，要么两端用同一份写死的配置。

错误处理。socket 方式只负责交换，建链过程中任何一步失败（对端的 QP 已经销毁、GID 填错、MTU 不一致）都不会有明确的错误通知，表现为连接建立后发不出数据，最终以重试超时告终。断开也是一样：对端进程崩溃后，本端的 QP 不会收到任何通知，直到下一次发送重试超时，才在 CQE 里看到错误。

这些问题在实验程序里都可以接受，所以 pingpong 和 perftest 都用这种方式。

## 方法二：RDMA CM

RDMA CM 是 Linux 内核 RDMA 子系统的一部分（`rdma_cm` 模块），用户态接口在 librdmacm 库里。它的 API 仿照 socket 设计，用 IP 地址和端口号标识对端，把地址解析、参数交换、QP 状态切换都包进去，应用不再直接调用 `ibv_modify_qp`。

### rdma_cm_id 和事件通道

`rdma_cm_id` 是 RDMA CM 里的核心对象，作用相当于一个 socket：

```c
struct rdma_cm_id {
    struct ibv_context      *verbs;
    struct rdma_event_channel *channel;
    void                    *context;
    struct ibv_qp           *qp;
    struct rdma_route        route;
    enum rdma_port_space     ps;
    uint8_t                  port_num;
    struct rdma_cm_event    *event;
    struct ibv_comp_channel *send_cq_channel;
    struct ibv_cq           *send_cq;
    struct ibv_comp_channel *recv_cq_channel;
    struct ibv_cq           *recv_cq;
    struct ibv_srq          *srq;
    struct ibv_pd           *pd;
    enum ibv_qp_type         qp_type;
};
```

和 socket 不同的是，`rdma_cm_id` 创建时还不知道用哪块网卡（`verbs` 为空），要等地址解析完成，确定了走哪个端口出去，才和一个 RDMA 设备绑定。绑定之后才能在它上面创建 QP。

RDMA CM 的操作大多是异步的：调用发起操作，结果以事件的形式从事件通道（`rdma_event_channel`，对应一个文件描述符）里取出，每个事件取出后要用 `rdma_ack_cm_event` 确认。创建 `rdma_cm_id` 时不传事件通道，调用就变成同步的，函数返回时操作已经完成，示例代码里常用这种写法。

`rdma_create_id` 的 `ps` 参数是端口空间。`RDMA_PS_TCP` 用于 RC 这类面向连接的 QP，`RDMA_PS_UDP` 用于 UD。两个端口空间的端口号互不冲突，也和真正的 TCP、UDP 端口无关：监听 RDMA CM 的 7471 端口，不影响别的程序监听 TCP 的 7471 端口。

### 建链的调用顺序

客户端（主动方）：

1.  `rdma_create_id`：创建 `rdma_cm_id`。
2.  `rdma_resolve_addr`：给定对端的 IP 地址，解析出对端的 GID，同时选定本端用哪块网卡、哪个 GID，并把 `rdma_cm_id` 绑定到这个设备。完成后产生 `RDMA_CM_EVENT_ADDR_RESOLVED` 事件。
3.  `rdma_create_qp`：在这个 `rdma_cm_id` 上创建 QP。参数和 `ibv_create_qp` 相同，不指定 CQ 时 RDMA CM 会自己创建。创建后 QP 自动切到 INIT。
4.  `rdma_resolve_route`：解析到对端的路径，完成后产生 `RDMA_CM_EVENT_ROUTE_RESOLVED`。
5.  `rdma_connect`：发起连接，参数 `rdma_conn_param` 见下文。连接建立后产生 `RDMA_CM_EVENT_ESTABLISHED`，此时 QP 已处于 RTS。

服务端（被动方）：

1.  `rdma_create_id`、`rdma_bind_addr`、`rdma_listen`：绑定本端 IP 和端口，开始监听。绑定到具体 IP 时，监听限定在这个 IP 所在的网卡；只绑定端口时，所有 RDMA 设备上都监听。
2.  等到 `RDMA_CM_EVENT_CONNECT_REQUEST` 事件。事件里带着一个新的 `rdma_cm_id`，代表这条连接，已经绑定到收到请求的那块网卡；监听用的 `rdma_cm_id` 继续监听。
3.  在新的 `rdma_cm_id` 上 `rdma_create_qp`。
4.  `rdma_accept`：接受连接。之后收到 `RDMA_CM_EVENT_ESTABLISHED`，QP 已处于 RTS。

{% include figure.html src="/assets/images/rdma-07-connection-exchange/02-rdma-cm.svg" alt="客户端依次调用 rdma_resolve_addr、rdma_create_qp、rdma_resolve_route、rdma_connect，服务端 rdma_listen 后等待连接请求、rdma_create_qp、rdma_accept；中间经过 REQ、REP、RTU 三个 CM 报文，每个报文到达后对应一端的 QP 切换一次状态，最后两端各收到 ESTABLISHED 事件" caption="图 2：RDMA CM 建链的调用、报文和 QP 状态" %}

### 地址解析和路由解析

`rdma_resolve_addr` 把 IP 地址变成 RDMA 地址。RoCE 下，GID 本身就是由 IP 地址构成的（第三篇），这一步做的是：按本地路由表确定从哪个网口出去，这个网口对应的 RDMA 设备和端口就是本端设备，网口的 IP 对应的 GID 表项就是本端 GID；对端 IP 直接构成对端 GID。InfiniBand 下 GID 和 IP 没有关系，RDMA CM 要通过 IPoIB 接口做 ARP，从对端的 IPoIB 硬件地址里取出 GID，所以两端都要配置 IPoIB。

`rdma_resolve_route` 确定到对端的路径。InfiniBand 下这一步向子网管理器查询路径记录（path record），拿到 SL、MTU、包生存时间等参数；RoCE 没有子网管理器，内核自己生成一条路径：MTU 取本端端口的 `active_mtu`，包生存时间用一个固定值（`CMA_IBOE_PACKET_LIFETIME`，16），SL 和 traffic class 来自 `rdma_set_option` 设置的 TOS。解析出的路径存在 `rdma_cm_id->route` 里，之后填进 QP 的 `ah_attr`。

### rdma_conn_param

`rdma_connect` 和 `rdma_accept` 都接受一个 `rdma_conn_param`：

```c
struct rdma_conn_param {
    const void *private_data;
    uint8_t     private_data_len;
    uint8_t     responder_resources;
    uint8_t     initiator_depth;
    uint8_t     flow_control;
    uint8_t     retry_count;       /* accept 时忽略 */
    uint8_t     rnr_retry_count;
    uint8_t     srq;               /* 已在 rdma_cm_id 上创建 QP 时忽略 */
    uint32_t    qp_num;            /* 同上 */
};
```

| 字段 | 含义 | 对应上一篇的属性 |
| --- | --- | --- |
| `responder_resources` | 本端作为响应方，最多同时处理多少个对端的 READ 和原子操作 | 本端的 `max_dest_rd_atomic` |
| `initiator_depth` | 本端作为发起方，最多同时发出多少个 READ 和原子操作 | 本端的 `max_rd_atomic` |
| `retry_count` | 超时重传次数 | `retry_cnt` |
| `rnr_retry_count` | RNR 重试次数 | `rnr_retry` |
| `flow_control` | 是否支持端到端流控，只是交换给对端，不配置 QP | 无 |
| `private_data`、`private_data_len` | 随连接请求或应答一起带给对端的应用数据 | 无 |

`responder_resources` 和 `initiator_depth` 会协商：客户端在请求里带上自己的值，服务端 `rdma_accept` 时可以调低，最终两端按协商结果各自设置 `max_rd_atomic` 和 `max_dest_rd_atomic`。`rdma_accept` 的 `conn_param` 传空指针时，RDMA CM 直接用请求里的值，按本端硬件上限调低。

private data 是 RDMA CM 唯一开放给应用的自定义字段，`RDMA_PS_TCP` 下最多 56 字节（CM 报文里给 private data 留了 92 字节，RDMA CM 自己用掉 36 字节放 IP 地址和端口）。rkey 和缓冲区地址可以放在这里，也可以等连接建好后用 SEND 发给对端。

### CM 报文：REQ、REP、RTU

`rdma_connect` 之后，两端之间走的是 CM 报文。它们由内核的 `ib_cm` 模块以 MAD（Management Datagram，管理数据报）形式发送，用的是每个端口固定的 QP1（第四篇提到过）。RoCE 下 QP1 也是 UD 类型，CM 报文同样封装在 UDP 4791 里发给对端的 QP1。

建链用到三个报文：

| 报文 | 方向 | 主要内容 |
| --- | --- | --- |
| REQ | 客户端到服务端 | 服务 ID（端口空间加端口号）、本端 QPN、起始 PSN、路径（两端 GID 或 LID、SL、traffic class、MTU 等）、`responder_resources`、`initiator_depth`、`retry_count`、`rnr_retry_count`、本端 ACK 超时、private data |
| REP | 服务端到客户端 | 本端 QPN、起始 PSN、协商后的 `responder_resources` 和 `initiator_depth`、`rnr_retry_count`、本端 ACK 延迟、private data |
| RTU | 客户端到服务端 | Ready to Use，确认收到 REP |

对照上一篇，REQ 和 REP 里的 QPN 和起始 PSN，正是对方 RTR 要填的 `dest_qp_num` 和 `rq_psn`；起始 PSN 由 RDMA CM 随机生成，应用不用管。QP 状态的切换也跟着报文走：

- 服务端收到 REQ、应用调用 `rdma_accept` 时，把自己的 QP 从 INIT 切到 RTR（这时已经知道客户端的 QPN 和 PSN），再切到 RTS，然后发出 REP。
- 客户端收到 REP，把 QP 切到 RTR、再到 RTS，发出 RTU，应用收到 `RDMA_CM_EVENT_ESTABLISHED`。
- 服务端收到 RTU，应用收到 `RDMA_CM_EVENT_ESTABLISHED`。

服务端先到 RTS 也没有关系：RC 下两端都要先投递接收请求，服务端在 `rdma_accept` 前投递好，客户端收到 REP 时服务端已经能接收了。上一篇说的“谁先发送”的问题，在这里由报文顺序保证。

服务端不想接受时调用 `rdma_reject`，对端收到 REJ 报文和 `RDMA_CM_EVENT_REJECTED` 事件。这个报文也可以带 private data，用来说明拒绝原因。

### RDMA CM 替应用填了什么

应用不调用 `ibv_modify_qp`，但那些参数还是要有值。RDMA CM 填的值（内核 `drivers/infiniband/core/cm.c` 的 `ib_cm_init_qp_attr`）：

| 属性 | RDMA CM 填的值 |
| --- | --- |
| `qp_access_flags` | 总是开放远程写；`responder_resources` 不为 0 时再开放远程读和原子操作 |
| `pkey_index`、`port_num` | 来自地址解析 |
| `ah_attr`、`path_mtu` | 来自路由解析 |
| `dest_qp_num`、`rq_psn` | 来自 REQ 或 REP |
| `max_dest_rd_atomic`、`max_rd_atomic` | 协商后的 `responder_resources`、`initiator_depth` |
| `min_rnr_timer` | 0，即 655.36 ms |
| `timeout` | 按路径的包生存时间和网卡的 ACK 延迟算出，RoCE 下默认约为 18，对应 1 秒左右 |
| `retry_cnt`、`rnr_retry` | 来自 `rdma_conn_param` |
| `sq_psn` | RDMA CM 生成的随机数 |

有两项值得留意。`min_rnr_timer` 固定填 0，是最长的 655 ms：对端 RQ 空了一次，发送方就要等 655 ms 才重试，延迟敏感的程序要保证接收请求充足。`timeout` 可以用 `rdma_set_option` 的 `RDMA_OPTION_ID_ACK_TIMEOUT` 在连接前修改，默认值对局域网来说偏大。想完全自己控制 QP 参数，可以不在 `rdma_cm_id` 上创建 QP，而是自己创建，用 `rdma_init_qp_attr` 取出 RDMA CM 算好的属性，改过之后自己调用 `ibv_modify_qp`。

### 断开

任意一端调用 `rdma_disconnect`，内核发出 DREQ 报文，对端回 DREP，两端都收到 `RDMA_CM_EVENT_DISCONNECTED` 事件，QP 被切到 ERR，没完成的请求以 flush 错误结束。对端进程崩溃时，内核在清理它的 `rdma_cm_id` 时也会发 DREQ，本端能及时收到事件。这是 socket 方式没有的。

## 怎么选

socket 方式的好处是透明：每个参数都是自己填的，出了问题知道去哪里查。缺点上面已经列过：顺序、参数一致性、错误和断开通知都要自己处理，而且需要额外维护一条 TCP 连接。

RDMA CM 的好处是把这些都包掉了，用 IP 和端口寻址，也和 InfiniBand、RoCE 的差异隔离开：同一份代码在两种网络上都能跑，不用关心 LID 和 GID 的区别。缺点是有些参数被它决定了（`min_rnr_timer`、默认超时），要改得绕一下；InfiniBand 下还要求 IPoIB。

一个实用的判断：写测试程序和实验代码，用 socket 交换，参数一目了然；写要长期运行的服务，用 RDMA CM。一些通信库有自己的控制面（比如启动时已经有一套 TCP 连接用于协调），会直接用它交换连接信息，不再引入 RDMA CM。

## 这一步的产出

无论哪种方式，这一步结束时两端的 QP 都处于 RTS，建链完成。到这里，第一篇列出的准备工作全部做完，下一篇开始看一次传输在网卡上是怎么执行的。

## 参考资料

接口文档（rdma-core man page）：

- rdma_cm(7)（RDMA CM 总览，客户端和服务端的调用顺序）. <https://man7.org/linux/man-pages/man7/rdma_cm.7.html>
- rdma_create_id(3)（端口空间）. <https://man7.org/linux/man-pages/man3/rdma_create_id.3.html>
- rdma_resolve_addr(3). <https://man7.org/linux/man-pages/man3/rdma_resolve_addr.3.html>
- rdma_resolve_route(3). <https://man7.org/linux/man-pages/man3/rdma_resolve_route.3.html>
- rdma_create_qp(3). <https://man7.org/linux/man-pages/man3/rdma_create_qp.3.html>
- rdma_connect(3)（`rdma_conn_param` 各字段、private data 长度限制、InfiniBand 下的超时计算）. <https://man7.org/linux/man-pages/man3/rdma_connect.3.html>
- rdma_accept(3). <https://man7.org/linux/man-pages/man3/rdma_accept.3.html>
- rdma_get_cm_event(3)（事件类型和事件数据）. <https://man7.org/linux/man-pages/man3/rdma_get_cm_event.3.html>
- rdma_disconnect(3). <https://man7.org/linux/man-pages/man3/rdma_disconnect.3.html>
- rdma_set_option(3). <https://man7.org/linux/man-pages/man3/rdma_set_option.3.html>
- linux-rdma. rdma-core `libibverbs/examples/rc_pingpong.c`（用 TCP 交换连接信息的示例）. <https://github.com/linux-rdma/rdma-core/blob/master/libibverbs/examples/rc_pingpong.c>
- linux-rdma. rdma-core `librdmacm/examples/rdma_client.c`、`rdma_server.c`（RDMA CM 示例）. <https://github.com/linux-rdma/rdma-core/tree/master/librdmacm/examples>
- linux-rdma. rdma-core `librdmacm/rdma_cma.h`（`struct rdma_cm_id`、`struct rdma_conn_param`、事件类型）. <https://github.com/linux-rdma/rdma-core/blob/master/librdmacm/rdma_cma.h>

内核源码：

- Linux `drivers/infiniband/core/cma.c`（RDMA CM：地址解析、RoCE 路径生成、REQ 和 REP 的填写、private data 头）. <https://github.com/torvalds/linux/blob/master/drivers/infiniband/core/cma.c>
- Linux `drivers/infiniband/core/cm.c`（CM 报文的收发、`ib_cm_init_qp_attr`、ACK 超时计算）. <https://github.com/torvalds/linux/blob/master/drivers/infiniband/core/cm.c>
- Linux `include/rdma/ib_cm.h`（各 CM 报文 private data 的长度）. <https://github.com/torvalds/linux/blob/master/include/rdma/ib_cm.h>

规范与手册：

- InfiniBand Trade Association. InfiniBand Architecture Specification Volume 1（Communication Management：REQ、REP、RTU、REJ、DREQ 报文格式与状态机）. <https://www.infinibandta.org/ibta-specification/>
- NVIDIA. RDMA-Aware Networks Programming Guide. <https://networking-docs.nvidia.com/doca/sdk/rdma-aware-networks-programming-guide>
