# 配图提示词模板（Excalidraw 手绘风）

博客配图统一用 Excalidraw 手绘白板风格。用 OpenAI 兼容的 `POST /v1/images/generations` 接口生成，`size` 为 `1536x1024`。接口地址和密钥只放在本机环境变量里，不要写进这个仓库。

把下面整段里的占位符换成具体内容后作为 `prompt` 发送，前后不要再加别的话。

```text
技术博客横版配图：{subject}。
画面从左到右：{components}。
{annotations}
部件之间只有一条从左到右的箭头链表示 {main_flow}；{secondary_flow}
风格：Excalidraw 手绘白板图。矩形和箭头的线条明显略微抖动，转角不完全闭合，线宽一致且偏细，像 Excalidraw 默认的手绘描边；标签用 Excalidraw 的 Virgil 手写体。
纯白背景，黑色线条，最多只用一种浅蓝色（#a5d8ff）做少量填充。不要渐变、阴影、3D、等距视角，正面平视。
数据块或重点元素两侧带几笔表示动态的短线；除此之外不要任何装饰，不要图标、星星或其他点缀。
文字只允许这些英文：{labels}，以及 {sub_labels}。不要任何其他文字：部件表面（芯片、SSD、板卡）保持空白，不要写型号或 CPU、NVMe 等字样。
```

## 占位符

| 占位符 | 含义 | 示例（KV Cache 三级存储图） |
| --- | --- | --- |
| `{subject}` | 一句话说明图要表达的内容 | 大模型推理中 KV Cache 从 GPU 显存逐级卸载到 CPU 内存，再卸载到 NVMe SSD |
| `{components}` | 从左到右的部件及画法 | 数据中心 GPU 加速卡（无风扇的简洁加速卡方框，不要游戏显卡）、CPU 芯片加几根内存条、M.2 NVMe SSD |
| `{annotations}` | 数据块的画法 | 每个部件上方画一摞代表 KV Cache 块的扁平方块，每摞上方各标一次 "KV Cache"；方块数量从左到右依次为 3、4、5 层，表示容量递增。 |
| `{main_flow}` | 主箭头的含义 | 逐级卸载 |
| `{secondary_flow}` | 可选的辅助箭头，没有就留空 | 画面下方另有一条虚线箭头从 SSD 指回 GPU，表示读回。 |
| `{labels}` | 主标签 | GPU HBM、CPU DRAM、NVMe SSD、KV Cache |
| `{sub_labels}` | 主标签下方的小字 | GPU HBM 下写 "fast, small"，CPU DRAM 下写 "larger"，NVMe SSD 下写 "largest, slower" |

## 注意

- 同一提示词出的图细节会变：试过一次方块层数一张是 3/4/5、另一张是 2/3/4。每张都要人工核对文字、数量和箭头方向，图里的信息不能和正文矛盾。
- 模型偶尔会在部件上加字（如 "CPU"、"NVMe"），出现时重新生成。
- 多张一起生成时分散到不同接口地址并走 HTTP/1.1；同一地址并发 4 个请求时全部报过 HTTP2 framing error。单张耗时约 30～110 秒。
- 生成的 PNG 约 1.3 MB，放进 `assets/images/英文短名/` 前用 `sips -s format jpeg -s formatOptions 80` 或其他工具压缩到 500 KB 以内。
