# @deepseek-ai/dsh-client-ui-local-files

[English](README.md) | 中文

DeepSeek Harness 的第三方 vendor 扩展。包名遵循 Harness 工作区约定，不表示上游官方支持。

浏览器插件向三个官方 slot 提交内容：`conversation.input.left` 中的单一文件选择器、`conversation.input.overlay` 中处于捕获阶段的粘贴／拖放遮罩，以及 `conversation.input.dock` 中可移除的本地文件 chip。选择器和手势可接收一个混合批次。PNG、JPEG、WebP 和 GIF 文件通过 `IConversation.stageDraftImages` 进入既有图片栏；浏览器中的其他所有 `File` 进入宿主本地流。捕获该手势可防止 InputBar 的后备图片监听器重复添加同一图片。

客户端会同步插入一个普通 U+FFFC 输入 occurrence，随后在后台流式传输通用文件字节。若用户立即发送，来源 codec 会等待同一次宿主原子提交；导入失败会阻止序列化，而不会发出悬空引用。提交序列化把 occurrence 转成短 `<local_file id="…" name="…" size_bytes="…" />` 标记。输入框不会序列化文件字节或提取内容，嗅探得到的读取器类型以宿主为准。

通用文件使用同源原始 `PUT`，不使用 JSON、Base64 或 multipart。宿主包负责校验、背压、存储、分类和模型工具。图片刻意保留上游图片生命周期及其提示词序列化。

## 模型体验

### 富引用提交投影

#### 模型看到的内容

每个富输入 occurrence 序列化为一个短 `<local_file id="…" name="…" size_bytes="…" />` 标记。工具说明、权威读取器类型和有界结果由 `@deepseek-ai/dsh-host-local-files` 拥有。

#### Token 影响

标记只产生元数据 token；本包不会序列化文件字节或提取内容。

#### KV Cache 影响

标记是只追加的用户内容，前面的请求前缀仍可复用。

## 已知限制与延期工作

- 浏览器 API 公开 `File` 而不是操作系统绝对路径，因此 Web 界面会向 Harness 宿主流式传输一份本地暂存副本。
- 标准 `fetch` 不公开上传进度。本地 loopback 路径显示忙碌状态，并在每个原子提交完成后插入对应 chip。
- 接收所有通用格式不表示拥有所有格式的语义解析器。未知或无法安全解码的内容以 `binary` 存储，只通过元数据和有界字节窗口公开。
- 上游图片提交仍会物化每张图片并在请求中编码为 Base64；本包不会替换图片附件生命周期。
- 复制 chip 会产生 `@local-file(<uuid>)`；在后续页面粘贴该纯文本不会在第一版中重建富 occurrence。
