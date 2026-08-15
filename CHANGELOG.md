# Changelog

本项目变更记录。插件层的详细记录见 [harness/CHANGELOG.md](harness/CHANGELOG.md)。

## [0.2.5] - 2026-08-15

### 新增

- 消息编辑插件（ui-message-edit）：分支语义编辑已发送消息（fork 新会话，原会话不变）
- 记忆插件（host-memory / ui-memory）：跨会话记忆的读取 / 搜索 / 写入
- 一键下载脚本（`scripts/download-latest.sh`）

### 变更

- 插件构建链路统一为 tsdown（从 src 直打）
- 文档全面重构（README / SECURITY / CONTRIBUTING / 目录结构重组）
- 源码目录重命名：`dsh-项目文件` → `harness`
- 发布产物升级：macOS 拖拽安装 DMG（含签名）、Windows NSIS 安装器、SHA256SUMS 校验清单
