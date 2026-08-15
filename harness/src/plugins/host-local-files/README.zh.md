# @deepseek-ai/dsh-host-local-files

[English](README.md) | 中文

DeepSeek Harness 的第三方 vendor 扩展。包名遵循 Harness 工作区约定，不表示上游官方支持。

该插件添加一条独立的通用文件生命周期，不会扩大仅支持图片的 `ctx.attachments` 契约。原始 `PUT /local-files/v1/import` 请求体以背压把任意浏览器 `File` 流式传到 Harness 宿主，并在同一遍执行递增大小限制、有界前缀识别和 SHA-256。完成的载荷与元数据提交到已配置的本地存储根目录。过程中不创建 Base64 或 multipart 信封。

文件按会话工作区建立键，但保留在仓库之外的 `$DSH_HOME/local-files`。文件引用只包含 UUID、名称、媒体类型、字节大小和读取器种类。模型接收短引用，并可调用 `local_file_inspect`、`local_file_read`、`local_file_search` 或 `local_file_read_bytes`；只有有界工具结果进入 DeepSeek 模型上下文。文件扩展名只是提示，不是准入白名单。未知或无法安全解码的内容保留为 `binary`。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `storageRoot` | 必填 | 宿主本地暂存根目录的绝对路径。 |
| `trustedHosts` | `[]` | 同源／DNS rebinding 防护接受的非 loopback authority。 |
| `maxFileBytes` | 8 GiB | 原始导入最大大小。 |
| `maxReadRecords` | 200 | 单次分页读取返回的最大记录数。 |
| `maxReadBytes` | 64 KiB | 面向模型的读取正文上限。 |
| `maxBinaryReadBytes` | 16 KiB | 单次字节窗口返回的最大原始字节数。 |
| `maxRecordChars` | 8000 | 单条记录字符上限。 |
| `maxSearchMatches` | 50 | 搜索最大匹配数。 |
| `maxSearchExcerptChars` | 600 | 搜索摘录窗口。 |

## 安全与隐私

导入端点在读取请求体前执行 Host、Fetch Metadata 和 Origin 防护。存储路径由规范工作区哈希加 UUID 派生；浏览器文件名永远不会成为目录组件。载荷使用仅所有者可访问的模式，且只有载荷改名成功后才发布元数据。

原始文件不会发送给模型提供方。模型调用读取或搜索工具后返回的文本属于普通模型上下文，因此会发送到已配置的 DeepSeek 端点。

## 模型体验

### 本地文件系统提示词

#### 模型看到的内容

插件活跃时，模型会看到一个顺序为 103 的固定提示词区段。

##### 精确区段

```markdown
A user message may contain <local_file> references. Use local_file_inspect first. Use local_file_read or local_file_search for supported text, CSV, XLSX, and DOCX content; use local_file_read_bytes only for a bounded byte window of other formats. Continue with next_start or next_offset when more data is needed. Do not claim to have reviewed the complete file unless the paged operation reached its end marker.
```

#### Token 影响

插件活跃时，该区段会为每次请求增加少量固定 token。

#### KV Cache 影响

只要插件版本与组合不变，该区段就保持前缀稳定。

### 文件引用消息

#### 模型看到的内容

每个附件只在用户消息中贡献一个短 `<local_file id="…" name="…" size_bytes="…" />` 标记；不包含原始文件字节。模型从 `local_file_inspect` 获取权威读取器类型，而不信任浏览器提供的元数据。

#### Token 影响

成本随文件标记数量和元数据长度增长，不随原始文件大小增长。

#### KV Cache 影响

该标记是普通的只追加用户内容，不会改变更早的可复用前缀。

### 本地文件工具与结果

#### 模型看到的内容

模型可调用 `local_file_inspect`、`local_file_read`、`local_file_search` 和 `local_file_read_bytes`。记录读取、搜索与编码字节窗口均有上限；只有这些返回片段进入模型历史。

#### Token 影响

四个固定定义会增加稳定的工具 token。每次调用增加其参数和有界结果；后续页面使历史逐步增长。

#### KV Cache 影响

配置不变时定义保持前缀稳定，工具调用／结果追加在可复用前缀之后。

## 已知限制与延期工作

- 浏览器拖放不会公开操作系统路径，因此 Web 界面必须把浏览器 `File` 复制到 Harness 宿主。未来 Electron／原生传输可在同一服务和引用协议之后采用或硬链接路径。
- XLSX 行以流式方式读取，但 Excel 共享字符串表会缓存在内存中；后续页面也会从头重扫 ZIP 流。
- DOCX 只读取段落文本；不会投影修订、批注、页眉、页脚和嵌入对象。
- 所有格式都会存储，但只有 UTF-8 文本、CSV/TSV、XLSX 和 DOCX 具备语义读取器。旧式 Office、加密文档、PDF、压缩包、音频、视频和专有格式回退为元数据加有界编码字节。
- 导入文件会一直保留，直到操作员删除对应的 `$DSH_HOME/local-files` 数据；保留策略仍属延期工作。
