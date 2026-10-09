---
title: "RDMA 入门（三）：初始化网卡"
description: "从驱动加载到拿到设备上下文，再到查询设备能力、端口状态和 GID 表：初始化阶段每一步做了什么，查出来的每个字段在后面哪一步用到。"
date: 2026-10-05 11:00:00 +0800
tags: [RDMA, 网络, RoCE, InfiniBand]
series: rdma
series_order: 3
---

第一篇的全流程里，第一步是“打开设备，查询能力”，当时只列了接口名。这一篇把这一步拆开：应用调用 `ibv_get_device_list` 之前系统已经准备好了什么，`ibv_open_device` 在内核和网卡上做了什么，`ibv_query_device`、`ibv_query_port`、`ibv_query_gid` 查出来的字段各管什么、后面在哪一步用到。

文中以 RoCE v2 为主，InfiniBand 的差异单独说明；涉及具体驱动实现时以 NVIDIA 网卡使用的 mlx5 驱动为例。

## 应用开始之前：驱动加载

应用能看到 RDMA 设备，前提是内核已经完成了设备注册。以 mlx5 为例，这一过程分两层：

1. PCI 驱动 mlx5_core 探测到网卡，完成固件初始化，同时注册普通的以太网网口（如 `eth0`、`ens1f0`）。
2. RDMA 驱动 mlx5_ib 向内核的 RDMA 子系统 ib_core 注册一个 RDMA 设备，名字形如 `mlx5_0`。注册后，ib_uverbs 模块为它创建一个字符设备 `/dev/infiniband/uverbsN`，用户态程序通过这个文件和内核的 RDMA 驱动通信。

同时，sysfs 中会出现两组目录：

- `/sys/class/infiniband/mlx5_0/`：设备本身的信息，包括每个端口的状态、速率、GID 表等，后面查询端口时看到的大部分字段都能在这里找到。
- `/sys/class/infiniband_verbs/uverbsN/`：字符设备和 RDMA 设备的对应关系。

RoCE 网卡上，RDMA 设备的端口和以太网网口一一绑定，端口状态、MTU、IP 地址都跟随对应的网口。InfiniBand 网卡没有以太网网口，这些信息由子网管理器配置。

## 枚举设备：ibv_get_device_list

`ibv_get_device_list` 是 libibverbs 的入口。它扫描 `/sys/class/infiniband_verbs/` 下的条目，找出本机所有 RDMA 设备，再根据设备对应的驱动加载用户态 provider 库（mlx5 对应 libmlx5）。provider 实现了数据路径上直接操作网卡队列的那部分代码，不同厂商的网卡队列格式不同，所以必须由厂商提供。

返回的是一个设备列表，每一项只包含设备名、GUID 等静态信息。此时还没有和网卡建立任何联系，也没有分配任何资源。

## 打开设备：ibv_open_device

`ibv_open_device` 打开对应的 `/dev/infiniband/uverbsN`，并在内核中为这个进程创建一个用户态上下文（ucontext）。之后这个进程创建的所有 PD、CQ、QP、MR 都挂在这个上下文下，进程退出时内核会据此回收全部资源。

打开设备时最关键的一步是映射门铃页。以 mlx5 为例，驱动为这个上下文分配若干 UAR（User Access Region）页，每一页对应网卡 PCI BAR 空间中的一段寄存器，再把它们通过 `mmap` 映射到进程的地址空间。此后应用投递请求时，provider 直接往这些页里写门铃，网卡立刻就能感知，不需要系统调用。第一篇说的“数据路径不经过内核”，前提就是这一步。

{% include figure.html src="/assets/images/rdma-03-device-init/01-sw-stack.svg" alt="控制路径经过内核驱动到网卡，数据路径上用户态库直接写映射到进程地址空间的门铃页" caption="图 1：控制路径与数据路径" %}

返回的 `struct ibv_context` 里有两个文件描述符：

- `cmd_fd`：控制路径的命令通道。创建 QP、注册内存等操作都是通过它向内核发命令完成的。
- `async_fd`：异步事件通道。端口状态变化、GID 表变化、QP 出现致命错误等事件都从这里上报，应用用 `ibv_get_async_event` 读取。例如网线拔掉时会收到 `IBV_EVENT_PORT_ERR`，链路恢复时收到 `IBV_EVENT_PORT_ACTIVE`，网口新增或删除 IP 地址时收到 `IBV_EVENT_GID_CHANGE`。

## 查询设备能力：ibv_query_device

`ibv_query_device` 返回 `struct ibv_device_attr`，描述这块网卡的硬件上限。字段很多，和后续步骤关系最密切的是下面这些：

| 字段 | 含义 | 后面在哪里用到 |
| --- | --- | --- |
| `fw_ver`、`vendor_id`、`vendor_part_id`、`hw_ver` | 固件版本和硬件型号 | 排查问题时确认网卡和固件 |
| `node_guid` | 设备的全局唯一标识 | 识别网卡；注意 InfiniBand 下 GID 用的是每个端口自己的端口 GUID，不是它 |
| `phys_port_cnt` | 物理端口数 | 后续以端口号（从 1 开始）指定使用哪个端口 |
| `max_qp` | 最多能创建多少个 QP | 限制连接数 |
| `max_qp_wr` | 单个队列最多容纳多少条 WQE | 创建 QP 时 `max_send_wr`、`max_recv_wr` 不能超过它，即 SQ、RQ 深度的上限 |
| `max_sge` | 单条 WQE 最多带几个 SGE | 创建 QP 时 `max_send_sge`、`max_recv_sge` 的上限 |
| `max_cq`、`max_cqe` | 最多能创建多少个 CQ，单个 CQ 最多多少条 CQE | 创建 CQ 时深度的上限 |
| `max_mr`、`max_mr_size` | 最多能注册多少个 MR，单个 MR 最大多大 | 注册 MR 时数量和长度的上限 |
| `max_pd` | 最多能创建多少个 PD | 创建 PD 时数量的上限 |
| `max_qp_rd_atom` | 单个 QP 作为响应方，最多同时处理多少个对端发来的 READ 或原子操作 | RTR 阶段的 `max_dest_rd_atomic` 不能超过它 |
| `max_qp_init_rd_atom` | 单个 QP 作为发起方，最多同时发出多少个 READ 或原子操作 | RTS 阶段的 `max_rd_atomic` 不能超过它 |
| `atomic_cap` | 是否支持原子操作，以及原子性的保证范围 | 决定能否使用 Compare-and-Swap、Fetch-and-Add |
| `device_cap_flags` | 一组能力位，例如是否支持自动路径迁移、内存窗口、端口激活事件等 | 按需检查 |

需要注意两点：

- 这些都是硬件的理论上限，实际能创建的数量还受内存、其他进程占用、驱动实现等因素影响。例如 SGE 数或内联数据长度增大后单条 WQE 会变大，同时把 `max_qp_wr` 和 `max_sge` 填满不一定能创建成功。创建 QP 时，`ibv_create_qp` 会把实际分配的容量写回参数结构，以这个值为准。
- 新的特性一般不再往这个结构里加字段，而是通过 `ibv_query_device_ex` 查询扩展属性，例如设备是否支持 ODP（按需分页）、时间戳等。

命令行工具 `ibv_devinfo -v` 打印的就是这个结构和下面端口属性中的字段，可以对照着看。

## 查询端口：ibv_query_port

一块网卡可以有多个端口，每个端口独立连网。`ibv_query_port` 按端口号返回 `struct ibv_port_attr`。

### 端口状态

`state` 是建链前必须检查的字段。它是逻辑状态，取值如下：

| 状态 | 值 | InfiniBand 下的含义 |
| --- | --- | --- |
| `IBV_PORT_DOWN` | 1 | 物理链路没有建立 |
| `IBV_PORT_INIT` | 2 | 物理链路已建立，等待子网管理器配置 |
| `IBV_PORT_ARMED` | 3 | 子网管理器已完成配置，等待最后激活 |
| `IBV_PORT_ACTIVE` | 4 | 可以收发数据 |
| `IBV_PORT_ACTIVE_DEFER` | 5 | 处于激活状态，但链路暂时出现问题 |

{% include figure.html src="/assets/images/rdma-03-device-init/02-port-state.svg" alt="InfiniBand 端口在链路建立后进入 INIT，由子网管理器分配 LID 后进入 ARMED，再激活为 ACTIVE；RoCE 端口状态直接跟随以太网链路" caption="图 2：端口逻辑状态与子网管理器" %}

InfiniBand 端口从 DOWN 到 ACTIVE 需要子网管理器参与：物理链路建立后端口进入 INIT，子网管理器扫描到它，为它分配 LID、配置分区表，然后把它推进到 ARMED 和 ACTIVE。如果网络中没有运行子网管理器，端口会一直停在 INIT，所有建链都会失败。这是 InfiniBand 环境中常见的问题。

RoCE 没有子网管理器，端口状态直接跟随以太网网口：网口链路建立就是 ACTIVE，网线断开或网口被关闭就是 DOWN。

另有一个字段 `phys_state` 描述物理层状态，例如正在协商链路（Polling）、链路已建立（LinkUp）、端口被禁用（Disabled）。端口不是 ACTIVE 时，先看物理状态能区分是线缆和对端的问题，还是子网管理器的问题。

### MTU

端口属性里有两个 MTU：

- `max_mtu`：端口硬件支持的最大 MTU。
- `active_mtu`：当前生效的 MTU。

两者的取值都是枚举，`IBV_MTU_256` 到 `IBV_MTU_4096` 分别为 1 到 5，对应 256、512、1024、2048、4096 字节。InfiniBand 下 `active_mtu` 由链路两端和子网管理器协商决定；RoCE 下按第二篇所说，取不超过以太网网口 MTU 的最大一档。

`active_mtu` 是建链时 `path_mtu` 的依据。路径 MTU 必须两端一致，并且不能超过路径上任何一段链路的 MTU，通常取两端 `active_mtu` 的较小值。如果一端填了 4096、而路径上的网口 MTU 只有 1500，超长的报文无法通过而被丢弃，表现为连接建立后发不出数据、最终重试超时。

### 地址相关字段

| 字段 | 含义 |
| --- | --- |
| `link_layer` | 链路层类型：`IBV_LINK_LAYER_INFINIBAND` 或 `IBV_LINK_LAYER_ETHERNET`。程序据此决定建链时用 LID 还是 GID 寻址 |
| `lid` | 本端口的 LID，由子网管理器分配；RoCE 下为 0 |
| `lmc` | LID Mask Control。值为 n 时，端口占用连续 2^n 个 LID，用于多路径；RoCE 下无意义 |
| `sm_lid`、`sm_sl` | 子网管理器所在端口的 LID 和服务级别，向子网管理器发查询时使用 |
| `gid_tbl_len` | GID 表的长度 |
| `pkey_tbl_len` | P_Key 表的长度 |

P_Key（Partition Key）是 InfiniBand 的分区机制，类似以太网的 VLAN：只有 P_Key 匹配的两个 QP 才能通信。每个报文的 BTH 里都带有 P_Key。建链时 RESET → INIT 一步填的 `pkey_index`，就是在这张表里选一项。RoCE 下分区由 VLAN 承担，P_Key 表只有默认值 0xFFFF 一项，`pkey_index` 填 0 即可。

### 速率

`active_width` 和 `active_speed` 描述链路的通道数和每通道速率，两者相乘得到链路带宽，例如 4 个通道、每通道 50 Gb/s，链路就是 200 Gb/s。这两个字段不影响建链，只用于确认链路是否协商到了预期速率。

`max_msg_sz` 是单条消息的最大长度，一次 SEND 或 RDMA WRITE 的数据量不能超过它，正常使用很少碰到。

## 查询 GID 表：ibv_query_gid

GID 是建链时最容易出错的地方，尤其在 RoCE 下。

每个端口有一张 GID 表，`ibv_query_gid(context, port, index, &gid)` 按索引读出其中一项，`ibv_query_gid_ex` 或 `ibv_query_gid_table` 还能同时给出这一项的类型和关联的网口。在 sysfs 中，GID 表位于 `/sys/class/infiniband/<设备>/ports/<端口>/gids/`，每一项的类型在同一端口目录的 `gid_attrs/types/` 下。

### InfiniBand 下的 GID

InfiniBand 端口的 GID 由 64 位子网前缀和 64 位端口 GUID 拼成。索引 0 是默认 GID，子网前缀默认为 `fe80::`。子网内通信只用 LID，GID 只在跨子网路由时用到，所以大多数 InfiniBand 程序不需要关心 GID 索引。

### RoCE 下的 GID

RoCE 端口没有 LID，GID 是唯一的寻址方式，GID 表的内容由网口上的地址决定：

- 网口的每个 IP 地址（包括 IPv6 链路本地地址和 VLAN 子接口上的地址）都会在表中生成表项。IPv4 地址以 `::ffff:a.b.c.d` 的形式出现。
- 在同时启用 RoCE v1 和 v2 的网卡上，同一个地址会生成两项，类型分别为 RoCE v1 和 RoCE v2（sysfs 中显示为 `IB/RoCE v1` 和 `RoCE v2`）。
- 网口增删 IP 地址时，表项随之增删，并上报 `IBV_EVENT_GID_CHANGE`。

建链时，本端选用哪一项由 RTR 阶段地址信息里的 `sgid_index`（源 GID 索引）指定，这一项同时决定了三件事：

1. 报文的源 IP 地址。
2. 报文是 RoCE v1 还是 v2 格式。
3. 报文走哪个网口，是否带 VLAN 标签。

选错索引的常见后果：

- 选了 RoCE v1 类型的项，而网络需要三层路由，报文无法跨越路由器。
- 选了 IPv6 链路本地地址对应的项，而对端用的是 IPv4 地址，两端地址不在同一网络。
- 网络按 VLAN 标签里的优先级（PCP）识别 RoCE 流量时，选了不带 VLAN 的项，报文没有优先级标记，交换机不会对它启用 PFC，丢包时性能明显下降。

这些错误在建链阶段都不会报错，`ibv_modify_qp` 照样成功，直到发送数据时重试超时，CQE 中出现重试次数用尽的错误。因此 GID 索引不能在程序里写死成某个数字：不同机器上 IP 地址的数量和顺序不同，同样的索引可能对应完全不同的地址。程序应当遍历 GID 表，按类型（RoCE v2）和地址（与对端同网段的 IPv4 地址）挑选；使用 RDMA CM 建链时，这一步由 CM 根据 IP 地址自动完成，这也是 RDMA CM 被广泛使用的原因之一。

## 初始化阶段的产出

初始化结束后，应用手里有了建链需要的本端信息：

| 信息 | 来源 | 后面在哪里用到 |
| --- | --- | --- |
| 设备上下文 | `ibv_open_device` | 创建所有资源 |
| 端口号 | 应用选定，`ibv_query_port` 确认 ACTIVE | RESET → INIT 的 `port_num` |
| `active_mtu` | `ibv_query_port` | 与对端协商后作为 RTR 的 `path_mtu` |
| LID（InfiniBand） | `ibv_query_port` | 交换给对端，作为对端 RTR 的 `dlid` |
| GID 和 GID 索引（RoCE） | `ibv_query_gid` | GID 交换给对端作为 `dgid`，索引作为本端 RTR 的 `sgid_index` |
| P_Key 索引 | `ibv_query_pkey` | RESET → INIT 的 `pkey_index` |
| 各种上限 | `ibv_query_device` | 创建 CQ、QP 时的容量参数，RTR / RTS 的 READ 并发数 |

还缺的是 QPN 和起始 PSN：QPN 要等 QP 创建出来才有，PSN 由应用自己选定。

## 参考资料

接口文档（rdma-core man page）：

- ibv_get_device_list(3). <https://man7.org/linux/man-pages/man3/ibv_get_device_list.3.html>
- ibv_open_device(3). <https://man7.org/linux/man-pages/man3/ibv_open_device.3.html>
- ibv_get_async_event(3). <https://man7.org/linux/man-pages/man3/ibv_get_async_event.3.html>
- ibv_query_device(3). <https://man7.org/linux/man-pages/man3/ibv_query_device.3.html>
- ibv_query_device_ex(3). <https://man7.org/linux/man-pages/man3/ibv_query_device_ex.3.html>
- ibv_query_port(3). <https://man7.org/linux/man-pages/man3/ibv_query_port.3.html>
- ibv_query_gid(3). <https://man7.org/linux/man-pages/man3/ibv_query_gid.3.html>
- ibv_query_pkey(3). <https://man7.org/linux/man-pages/man3/ibv_query_pkey.3.html>
- ibv_query_gid_ex(3). <https://man7.org/linux/man-pages/man3/ibv_query_gid_ex.3.html>
- ibv_query_gid_table(3). <https://man7.org/linux/man-pages/man3/ibv_query_gid_table.3.html>
- ibv_devinfo(1). <https://man7.org/linux/man-pages/man1/ibv_devinfo.1.html>
- linux-rdma. rdma-core（`libibverbs/verbs.h` 中有上述结构体和枚举的定义）. <https://github.com/linux-rdma/rdma-core>

内核文档：

- Userspace verbs access. <https://docs.kernel.org/infiniband/user_verbs.html>
- sysfs-class-infiniband（`/sys/class/infiniband` 下各文件的说明）. <https://www.kernel.org/doc/Documentation/ABI/stable/sysfs-class-infiniband>

规范与手册：

- InfiniBand Trade Association. InfiniBand Architecture Specification Volume 1（端口状态机、P_Key、GID 格式）. <https://www.infinibandta.org/ibta-specification/>
- InfiniBand Trade Association. Supplement to InfiniBand Architecture Specification Volume 1 Release 1.2.1, Annex A17: RoCEv2, September 2014.
- NVIDIA. RDMA-Aware Networks Programming Guide. <https://networking-docs.nvidia.com/doca/sdk/rdma-aware-networks-programming-guide>
