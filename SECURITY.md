# 安全策略

## 隐私承诺

- 本应用**不收集任何统计、不发送遥测、不上传用户数据**。
- 会话、附件、记忆、API Key 全部保存在本机用户目录（macOS：`~/.dsh`；Windows：`%USERPROFILE%\.dsh`），权限 600。
- 唯一的网络请求：启动时查询官方 npm registry 的 `@deepseek-ai/dsh` 版本号（仅取版本号，不含任何本地数据）。
- 自更新仅从官方 npm registry 下载 dsh 运行时包，校验通过后替换内置 vendor。

## 签名与隐私

- 当前安装包为 **ad-hoc 签名**（macOS）与未签名（Windows）：签名仅用于完整性校验，
  **不包含任何发布者身份信息**（无证书、无 Team ID、无开发者名称、无个人数据）。
- macOS 的「无法验证开发者」提示、Windows 的「未知发布者」提示，是未公证/未签名应用的正常系统提示，
  与软件安全性无关，不影响使用。
- 若未来启用正式签名（Apple Developer / 代码签名证书），签名将公开显示发布者名称；
  届时由发布者决定使用个人名义或组织名义，并同步更新本说明。

## 漏洞报告

如发现安全问题，请通过 [GitHub Issues](../../issues) 提交（标题加 `[SECURITY]` 前缀），
或直接在仓库 Discussions 中私密反馈。请勿在公开渠道透露可复现的漏洞细节。

## 依赖安全

- 运行时依赖全部来自官方 npm registry（`@deepseek-ai/*`）。
- 随仓库分发的插件包（`vendor/extra/*.tgz`）为官方 deepseek-ai/deepseek-harness 构建产物，
  版权与安全责任归 DeepSeek（MIT）。
