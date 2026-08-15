# Changelog

本项目变更记录。插件层的详细记录见 [harness/CHANGELOG.md](harness/CHANGELOG.md)。

## [0.2.5] - 2026-08-15

### 新增

- 消息编辑插件（ui-message-edit）：分支语义编辑已发送消息（fork 新会话，原会话不变）
- 记忆插件（host-memory / ui-memory）：跨会话记忆的读取 / 搜索 / 写入
- 隐私扫描器与 pre-push 钩子（`scripts/privacy-scan.mjs` + `scripts/install-hook.sh`）
- CI 隐私扫描任务（workflow `privacy` job，每次推送自动执行）
- 一键下载脚本（`scripts/download-latest.sh`）

### 变更

- 插件构建链路统一为 tsdown（从 src 直打，摆脱单包 tsc 的 rootDir 冲突）
- 文档全面专业化重构（README / SECURITY / CONTRIBUTING / 目录结构重组）
- 源码目录重命名：`dsh-项目文件` → `harness`

### 安全

- 三重防护发布机制：本地全盘扫描 + CI 交叉验证 + GitHub Secret Scanning
- 提交身份统一使用 GitHub noreply 邮箱（不暴露个人邮箱）
- 数据边界：全本地存储，无遥测、无上传
