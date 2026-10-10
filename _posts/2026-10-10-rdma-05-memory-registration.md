---
title: "RDMA 入门（五）：内存注册"
description: "为什么网卡访问内存之前要先注册，ibv_reg_mr 的 access 标志各管什么，注册时内核锁页、网卡建地址转换表的过程，对端拿着 rkey 访问时网卡怎么检查和翻译地址，以及注册的开销、fork、ODP 和 GPU 显存。"
date: 2026-10-10 18:00:00 +0800
tags: [RDMA, 网络, RoCE, InfiniBand]
series: rdma
series_order: 5
---

前几篇反复出现 lkey 和 rkey：SGE 里要填 lkey，RDMA WRITE 要带对端的地址和 rkey，网卡收到请求后用它们检查权限。它们都来自内存注册。示例代码里这一步通常只有一行：

```c
mr = ibv_reg_mr(pd, buf, size,
                IBV_ACCESS_LOCAL_WRITE | IBV_ACCESS_REMOTE_READ | IBV_ACCESS_REMOTE_WRITE);
```

这一篇把这一行拆开：网卡访问内存之前为什么必须注册，access 里每个标志管什么，注册时内核和网卡做了什么，对端拿着 rkey 访问时网卡怎么检查和翻译地址，以及注册的开销和几个常见的坑。

文中涉及驱动实现的地方，仍以 NVIDIA 网卡使用的 mlx5 驱动为例。

## 为什么要注册

应用手里的缓冲区地址是虚拟地址。CPU 访问它时，由 MMU 按进程页表翻译成物理地址。网卡做 DMA 时用的是另一套地址，称为 DMA 地址，它取决于系统有没有开启 IOMMU：

- IOMMU 是位于 PCIe 设备和内存之间的地址翻译单元（Intel 平台叫 VT-d，AMD 平台叫 AMD-Vi），作用类似于给设备用的 MMU。没有开启 IOMMU 时，DMA 地址基本就是物理地址。
- 开启 IOMMU 时，设备发出的地址称为 IOVA（I/O Virtual Address，I/O 虚拟地址），由 IOMMU 按内核为这个设备建立的页表翻译成物理地址。这张页表和进程页表是两回事，只包含内核允许这个设备访问的内存。

两种情况下，网卡都看不到进程的页表，无法自己把虚拟地址翻译成能用的 DMA 地址。

即使把翻译结果告诉网卡，这个结果也不一定一直有效。普通的用户态内存页可能被换出到磁盘，可能被内核迁移到别的物理页（内存规整、NUMA 平衡），刚 `malloc` 出来、还没写过的页甚至还没有分配物理页。CPU 访问时这些情况都由缺页处理兜住，网卡 DMA 则没有这个机制：物理页一旦换了，网卡写进去的数据就落到了别处。

TCP 不需要注册，是因为数据先由 CPU 拷贝进内核的 socket 缓冲区，网卡只 DMA 内核缓冲区，这些缓冲区本来就不会被换出。RDMA 要做到零拷贝，网卡就得直接读写用户内存，于是要提前做三件事：

1.  锁定这段内存的物理页，保证注册期间不会被换出或迁移。
2.  把虚拟地址到 DMA 地址的映射交给网卡。
3.  记下这段内存允许哪些访问：只允许本地读，还是允许对端写、对端读、对端做原子操作。

注册完成后得到一个 MR（Memory Region，内存区域）对象，以及访问它要用的 lkey 和 rkey。

## ibv_reg_mr 的参数

```c
struct ibv_mr *ibv_reg_mr(struct ibv_pd *pd, void *addr,
                          size_t length, int access);

struct ibv_mr {
    struct ibv_context *context;
    struct ibv_pd      *pd;
    void               *addr;
    size_t              length;
    uint32_t            handle;
    uint32_t            lkey;
    uint32_t            rkey;
};
```

`pd` 是 MR 所属的保护域。上一篇讲过，网卡只允许同一个 PD 下的 QP 访问这个 MR。`addr` 和 `length` 是要注册的虚拟地址范围，不要求按页对齐，但锁页和地址翻译都以页为单位，首尾所在的整页都会被锁定。`length` 不能超过 `ibv_query_device` 返回的 `max_mr_size`，进程能注册的 MR 总数受 `max_mr` 限制。

返回的 `struct ibv_mr` 里，`lkey` 用于本端：投递请求时填进每个 SGE。`rkey` 交给对端：对端发起 RDMA WRITE、READ 或原子操作时，把它和目标地址一起填进请求。`handle` 是内核里这个对象的编号，应用一般用不到。

### access 标志

`access` 是下面几个标志的组合，也可以是 0：

| 标志 | 含义 |
| --- | --- |
| `IBV_ACCESS_LOCAL_WRITE` | 允许本端网卡写这段内存 |
| `IBV_ACCESS_REMOTE_WRITE` | 允许对端 RDMA WRITE |
| `IBV_ACCESS_REMOTE_READ` | 允许对端 RDMA READ |
| `IBV_ACCESS_REMOTE_ATOMIC` | 允许对端做原子操作（需要网卡支持） |
| `IBV_ACCESS_MW_BIND` | 允许在这个 MR 上绑定内存窗口（见后文） |
| `IBV_ACCESS_ZERO_BASED` | 对端访问时用相对 MR 起点的偏移，而不是虚拟地址 |
| `IBV_ACCESS_ON_DEMAND` | 按需分页（ODP），不锁页（见后文） |
| `IBV_ACCESS_RELAXED_ORDERING` | 允许网卡以乱序写入这段内存，可能提高性能 |

另外还有 `IBV_ACCESS_HUGETLB`（只和显式 ODP 一起用）和两个 `IBV_ACCESS_FLUSH_*`（远程持久化，需要网卡支持），一般用不到。

有两条规则：

- 本地读总是允许的，没有单独的标志。
- 设置了 `REMOTE_WRITE` 或 `REMOTE_ATOMIC`，就必须同时设置 `LOCAL_WRITE`，否则注册失败，返回 `EINVAL`。内核里的检查在 `ib_check_mr_access` 中。

“本地写”的含义容易误解。它不是指 CPU 能不能写这段内存，CPU 怎么读写都不受 MR 影响；它指的是本端网卡能不能往这段内存里写数据。

`IBV_ACCESS_RELAXED_ORDERING` 打开后，对端连续两次 RDMA WRITE 到达内存的先后不再有保证；但 CQE 的语义不变，看到完成时，此前所有写入的数据都已可见。

### 各种操作需要哪些权限

| 操作 | 本端缓冲区 | 对端缓冲区 |
| --- | --- | --- |
| SEND / 接收 | 发送方的源缓冲区只需本地读 | 接收方投递的接收缓冲区需要 `LOCAL_WRITE`，因为是接收方自己的网卡把数据写进去 |
| RDMA WRITE | 本地读 | `REMOTE_WRITE` |
| RDMA READ | `LOCAL_WRITE`，读回的数据要由本端网卡写进本地缓冲区 | `REMOTE_READ` |
| 原子操作 | `LOCAL_WRITE`，对端内存的原值要写回本地 | `REMOTE_ATOMIC` |

所以只用来发送的缓冲区，`access` 填 0 就够了；接收缓冲区和 RDMA READ 的目的缓冲区要 `LOCAL_WRITE`；只有准备让对端直接访问的内存才需要 `REMOTE_*` 标志。远程权限相当于把这段内存开放给持有 rkey 的对端，示例代码里给所有缓冲区都加上 `REMOTE_READ | REMOTE_WRITE`，权限给得比需要的大。

除了 MR，QP 自己也有一组远程访问权限（`qp_access_flags`），在把 QP 切换到 INIT 状态时设置。对端的 RDMA WRITE、READ 或原子操作，只有 QP 和 MR 两边都允许时才会被执行。

## 注册时发生了什么

`ibv_reg_mr` 走的是控制路径：libibverbs 通过 `cmd_fd` 把请求发给内核的 ib_uverbs，再交给网卡驱动。以 mlx5 为例，内核里大致做了这些事：

1.  锁页。内核的 `ib_umem_get` 调用 `pin_user_pages_fast`（带 `FOLL_LONGTERM` 标志）锁定范围内的每一页。还没分配物理页的地址，此时会先分配。锁定的页数计入进程的 `pinned_vm`，没有 `CAP_IPC_LOCK` 权限的进程不能超过 `RLIMIT_MEMLOCK`，也就是 `ulimit -l` 的值，超过时注册失败，返回 `ENOMEM`。
2.  建立 DMA 映射。内核为这些物理页做 DMA 映射，得到网卡访问它们要用的地址。开启 IOMMU 时，这一步同时建立 IOMMU 页表。
3.  选择页大小。物理上连续、并且对齐的页可以合并成更大的块。驱动在网卡支持的页大小里，选一个能覆盖这段内存的最大值，块越大，后面的转换表项越少。
4.  在网卡上创建内存键（mlx5 中叫 mkey）。mkey 的上下文里记录：所属 PD、起始虚拟地址、长度、访问权限，以及转换表的位置。转换表（mlx5 中叫 MTT，Memory Translation Table）按页顺序存放每一页的 DMA 地址，每项 8 字节。
5.  返回 key。驱动把 mkey 的编号作为 lkey 和 rkey 返回给用户态。

{% include figure.html src="/assets/images/rdma-05-memory-registration/01-register.svg" alt="应用的虚拟地址范围由若干页组成，注册时每一页被锁定在某个物理页上，物理页在内存中并不连续；网卡上创建一个 mkey，上下文记录 PD、起始地址、长度和权限，并指向一张按页排列的转换表，表项是各物理页的地址；注册返回 lkey 和 rkey" caption="图 1：注册时锁页并在网卡上建立转换表" %}

mlx5 的 mkey 是 32 位：高 24 位是网卡上 mkey 表的索引，低 8 位是一个变体值，每创建一个 mkey 就加一。mlx5 返回的 lkey 和 rkey 是同一个值。规范里两者是两个独立的 key，其他厂商的网卡不一定相等，应用不应依赖这一点。

逐个创建 mkey 要给固件发命令，比较慢。mlx5 驱动会预先创建一批 mkey 放在缓存里，注册时取一个，再通过网卡的 UMR（User-mode Memory Registration）操作把转换表和权限写进去，以缩短注册时间。

## 对端访问时网卡做什么

本端把 MR 的地址、长度和 rkey 告诉对端后，对端发起 RDMA WRITE 时，在请求里填 `wr.rdma.remote_addr` 和 `wr.rdma.rkey`。这两个值和总长度一起放进第一个报文的 RETH：64 位虚拟地址、32 位 R_Key、32 位 DMA 长度，共 16 字节。

本端网卡收到报文后：

1.  用 R_Key 的索引部分找到 mkey 上下文。mkey 不存在，或者变体值对不上，说明 key 无效。
2.  检查 mkey 和接收报文的 QP 是否属于同一个 PD，是否开放了这次操作需要的远程权限，`[地址, 地址 + 长度)` 是否落在 MR 的范围内。
3.  翻译地址：用报文里的虚拟地址减去 MR 的起始地址，得到偏移；偏移除以页大小得到页号，查转换表得到这一页的 DMA 地址，再加上页内偏移。
4.  按翻译出的地址 DMA 写入数据。一次传输跨页时，每一页分别查表。

{% include figure.html src="/assets/images/rdma-05-memory-registration/02-remote-access.svg" alt="RDMA WRITE 报文的 RETH 中带有虚拟地址、R_Key 和长度；接收方网卡用 R_Key 找到 mkey 上下文，检查 PD、权限和地址范围，算出页号后查转换表得到物理页地址，最后把数据 DMA 写进主机内存" caption="图 2：对端访问时的检查和地址翻译" %}

任何一项检查不通过，网卡回复远程访问错误的 NAK，发起方的请求以 `IBV_WC_REM_ACCESS_ERR` 状态完成，连接进入错误状态。本端用 lkey 访问自己的缓冲区时，检查和翻译过程相同，只是检查的是本地权限，出错时得到的是本地保护错误（`IBV_WC_LOC_PROT_ERR`）。

### ZERO_BASED 和 iova

默认情况下，对端在 RETH 里填的是本端进程里的虚拟地址，这等于把本端的地址布局告诉了对端。注册时加 `IBV_ACCESS_ZERO_BASED`，对端改用相对 MR 起点的偏移访问。更一般的形式是 `ibv_reg_mr_iova`，由应用指定对端访问时使用的起始地址 `hca_va`，网卡把 `hca_va` 对应到 `addr`。多个进程各自注册一块缓冲区、但希望对端用同一套地址访问时，可以用它。

### 转换表的大小

转换表要存放在网卡能访问的内存里，网卡芯片内只缓存最近用到的部分，和上一篇讲的 QP 上下文类似。按 4 KB 页注册 1 GB 内存，转换表有 262144 项，以 mlx5 每项 8 字节计，共 2 MB；同样的内存如果用 2 MB 大页，只要 512 项、4 KB。表项少，网卡缓存命中率高，随机访问大块内存时延迟更稳定。这是 RDMA 程序常用大页分配通信缓冲区的原因之一。

## 注册的开销

注册要锁定每一页、做 DMA 映射、写转换表，耗时随内存大小增长，而且要进内核。所以注册应该放在初始化阶段，不要出现在每次传输的路径上。

常见做法有两种：

- 启动时一次性注册一大块内存，应用自己从里面切分缓冲区。大多数 RDMA 程序这样做。
- 注册缓存。MPI、UCX 这类通信库无法预知应用会传哪块内存，会按地址范围缓存已注册的 MR，下次传输同一块内存时直接复用。

注册缓存有一个坑。应用 `free` 一块内存后，如果这段地址被归还给操作系统（`munmap`），之后再 `malloc` 可能拿到同一段虚拟地址，背后却是新的物理页。缓存里的 MR 还锁着旧的物理页，按地址查缓存会命中这个过期的 MR，网卡把数据写进旧页，应用在新页上什么也读不到。所以注册缓存必须跟踪内存释放：通信库一般会拦截 `free`、`munmap` 等调用，或者借助内核的通知机制，在内存释放时把对应的缓存项作废。

另一个影响是锁页内存不能被换出，会直接占用物理内存。容器和 systemd 服务里 `ulimit -l` 的默认值常常很小，注册稍大的内存就会失败，需要调大 `RLIMIT_MEMLOCK`（例如 systemd 的 `LimitMEMLOCK`）或者设为不限。

## 锁页与 fork

锁页和 `fork` 一起使用时，有一个经典问题。`fork` 之后父子进程以写时复制的方式共享内存页，父进程先写某一页时，内核给父进程分配一个新页并复制内容。而网卡的转换表里仍是旧页的地址，旧页留给了子进程。此后网卡写入的数据进了子进程的内存，父进程看不到；父进程准备发送的数据，网卡也读不到。

旧的解决办法是调用 `ibv_fork_init`（或设置环境变量 `RDMAV_FORK_SAFE`），libibverbs 会对注册的内存调用 `madvise(MADV_DONTFORK)`，子进程里不再映射这些地址，父进程的页也就不会被复制。它必须在注册任何内存之前调用，而且会让每次注册多一次系统调用。

较新的内核在 `fork` 时会把已锁定的页直接复制一份给子进程，父进程保留原来的页，问题就不存在了。可以用 `ibv_is_fork_initialized` 检查：返回 `IBV_FORK_UNNEEDED` 时，说明内核已经这样处理，不需要再调用 `ibv_fork_init`。

## 不锁页的注册：ODP

ODP（On-Demand Paging，按需分页）是另一种注册方式。注册时加 `IBV_ACCESS_ON_DEMAND`，内核不锁页，转换表一开始可以是空的。网卡访问到还没有映射的页时，向驱动报告缺页，驱动把页调入内存、更新转换表，网卡再继续这次访问。页被换出或迁移时，内核通过 MMU 通知机制告诉驱动，驱动把对应的转换表项作废。

ODP 的好处是注册几乎不花时间，不受 `RLIMIT_MEMLOCK` 限制，还可以把整个地址空间注册成一个 MR（隐式 ODP：`addr` 填 0、`length` 填 `SIZE_MAX`）。代价是缺页时延迟大幅增加。对延迟敏感的场景，可以用 `ibv_advise_mr` 提前把即将访问的范围预取进来。网卡和驱动是否支持 ODP、支持哪些操作，可以通过 `ibv_query_device_ex` 返回的 `odp_caps` 查询。

## GPU 显存的注册

GPUDirect RDMA 让网卡直接读写 GPU 显存，数据不经过主机内存。显存不在进程的普通页表里，内核没法像锁普通页那样锁定它，需要 GPU 驱动提供显存的物理地址。有两种方式：

- 加载 NVIDIA 的 `nvidia-peermem` 内核模块后，`ibv_reg_mr` 可以直接接受 `cudaMalloc` 得到的显存地址。
- dma-buf 方式：dma-buf 是 Linux 内核里在不同设备驱动之间共享缓冲区的机制。一个驱动把自己管理的一块缓冲区导出为文件描述符，另一个驱动拿到这个描述符后导入，就能得到这块缓冲区的 DMA 地址，不需要知道它是怎么分配的。这里导出方是 GPU 驱动，导入方是 RDMA 驱动：用 CUDA 的 `cuMemGetHandleForAddressRange` 把一段显存导出为 dma-buf 文件描述符，再调用 `ibv_reg_dmabuf_mr`，按文件描述符和偏移注册。这种方式只支持 `LOCAL_WRITE`、`REMOTE_WRITE`、`REMOTE_READ`、`REMOTE_ATOMIC` 和 `RELAXED_ORDERING` 几个标志。

注册之后的用法和普通 MR 一样，lkey 和 rkey 的含义也不变。

## 内存窗口

MR 的范围和权限在注册时确定，要改就得重新注册或者调用 `ibv_rereg_mr`，都要进内核。有时应用想临时把一块内存的一部分开放给某个对端，用完立即收回，这时可以用内存窗口（MW，Memory Window）：

1.  用 `ibv_alloc_mw` 在 PD 下分配一个 MW。
2.  把它绑定到某个 MR（注册时要带 `IBV_ACCESS_MW_BIND`）的一个子范围上，并指定远程权限，绑定后得到一个新的 rkey。
3.  把这个 rkey 交给对端。不再需要时让它失效，对端再拿它访问就会失败。

MW 分两类：类型 1 用 `ibv_bind_mw` 绑定，再用长度为 0 的绑定让它失效；类型 2 通过 `ibv_post_send` 投递绑定请求（`IBV_WR_BIND_MW`），失效用 `IBV_WR_LOCAL_INV` 请求，也可以由对端发送带失效标记的 SEND（`IBV_WR_SEND_WITH_INV`）。两类的绑定都是向 QP 投递请求、由网卡执行，不经过内核。大多数程序用不到 MW，直接给需要远程访问的缓冲区注册 MR 即可。

## 注销：ibv_dereg_mr

`ibv_dereg_mr` 销毁网卡上的 mkey，解除 DMA 映射，解锁物理页。注销之后，这个 MR 的 lkey 和 rkey 都失效。

注销前要确保没有请求还在使用它。本端 SQ 里还有引用这个 lkey 的请求时注销，网卡执行到它时会得到本地保护错误；对端还拿着 rkey 时注销，对端下一次访问就会收到远程访问错误。mlx5 的变体值在这里起作用：同一个 mkey 索引被释放后再分配给新的 MR，变体值已经不同，对端手里的旧 rkey 对不上新的 key，访问会被拒绝，而不会误写到新 MR 上。

有 MW 绑定在 MR 上时，`ibv_dereg_mr` 会失败。PD 下还有 MR 时，`ibv_dealloc_pd` 会失败，所以释放顺序是先注销 MR，再释放 PD。

## 这一步的产出

| 信息 | 来源 | 后面在哪里用到 |
| --- | --- | --- |
| lkey | `mr->lkey` | 本端投递请求时填进每个 SGE |
| 地址和长度 | `mr->addr`、`mr->length`（或注册时指定的 iova） | 交换给对端，作为 RDMA WRITE、READ 的目标地址 |
| rkey | `mr->rkey` | 交换给对端，填进请求的 `wr.rdma.rkey` |

加上前几篇得到的 GID、QPN 和起始 PSN，建链前需要准备的本端信息就齐了。

## 参考资料

接口文档（rdma-core man page）：

- ibv_reg_mr(3)（含 ibv_reg_mr_iova、ibv_reg_dmabuf_mr、ibv_dereg_mr）. <https://man7.org/linux/man-pages/man3/ibv_reg_mr.3.html>
- ibv_rereg_mr(3). <https://man7.org/linux/man-pages/man3/ibv_rereg_mr.3.html>
- ibv_alloc_mw(3). <https://man7.org/linux/man-pages/man3/ibv_alloc_mw.3.html>
- ibv_bind_mw(3). <https://man7.org/linux/man-pages/man3/ibv_bind_mw.3.html>
- ibv_fork_init(3). <https://man7.org/linux/man-pages/man3/ibv_fork_init.3.html>
- ibv_is_fork_initialized(3). <https://man7.org/linux/man-pages/man3/ibv_is_fork_initialized.3.html>
- ibv_advise_mr(3). <https://man7.org/linux/man-pages/man3/ibv_advise_mr.3.html>
- ibv_query_device_ex(3). <https://man7.org/linux/man-pages/man3/ibv_query_device_ex.3.html>
- linux-rdma. rdma-core（`libibverbs/verbs.h` 中有 `struct ibv_mr` 和 `enum ibv_access_flags` 的定义）. <https://github.com/linux-rdma/rdma-core>

内核源码与文档：

- Userspace verbs access（Memory pinning 一节）. <https://docs.kernel.org/infiniband/user_verbs.html>
- Linux `drivers/infiniband/core/umem.c`（`ib_umem_get`：锁页、`RLIMIT_MEMLOCK` 检查、DMA 映射）. <https://github.com/torvalds/linux/blob/master/drivers/infiniband/core/umem.c>
- Linux `include/rdma/ib_verbs.h`（`ib_check_mr_access`）. <https://github.com/torvalds/linux/blob/master/include/rdma/ib_verbs.h>
- Linux `drivers/infiniband/hw/mlx5/mr.c`（mlx5 的 MR 注册、mkey 缓存与变体值）. <https://github.com/torvalds/linux/blob/master/drivers/infiniband/hw/mlx5/mr.c>
- Linux `include/linux/mlx5/driver.h`（`mlx5_mkey_to_idx`、`mlx5_mkey_variant`）. <https://github.com/torvalds/linux/blob/master/include/linux/mlx5/driver.h>

规范与手册：

- InfiniBand Trade Association. InfiniBand Architecture Specification Volume 1（内存区域、内存窗口、L_Key 与 R_Key、RETH）. <https://www.infinibandta.org/ibta-specification/>
- NVIDIA. RDMA-Aware Networks Programming Guide. <https://networking-docs.nvidia.com/doca/sdk/rdma-aware-networks-programming-guide>
- NVIDIA. GPUDirect RDMA. <https://docs.nvidia.com/cuda/gpudirect-rdma/>
