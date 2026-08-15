# DeepSeek Harness Desktop

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 以原生桌面应用形态带到 **macOS 与 Windows** 的社区客户端 —— 内置官方 dsh 运行时与本地文件、视觉、记忆插件，**数据全本地，开箱即用**。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue.svg)](../../releases)
[![Runtime](https://img.shields.io/badge/runtime-%40deepseek-ai%2Fdsh%20rc.6-4b6eff.svg)](vendor/package.json)

> **非官方项目声明**：本仓库为社区维护的桌面封装，非 DeepSeek 官方产品。内置运行时与插件版权归 DeepSeek（MIT 许可，见 [NOTICE.md](NOTICE.md)）。

---

## 特性

| 能力 | 说明 |
| --- | --- |
| 原生桌面体验 | Electron 自包含运行时，不依赖系统 Node/npm，双击即用 |
| 本地文件工作流 | 拖拽/粘贴附件上传、主流大图预览、图片视觉检查（eyes-only 感知） |
| 会话消息编辑 | 分支语义编辑已发送消息：fork 新会话、替换原文，原会话不受影响 |
| 跨会话记忆 | 记忆插件：记忆读取/搜索/写入，模型可跨会话调用 |
| 零遥测 | 所有数据保存在本机；唯一网络访问为启动时查询官方 npm 版本号 |
| 自更新 | 以官方 npm registry 为信号源，应用内一键升级 dsh 运行时，不碰用户数据 |
| 原生交互 | 右键菜单、下载静默落盘、外链交系统浏览器、窗口状态记忆 |

## 快速开始

从 [Releases](../../releases) 下载对应平台安装包：

| 平台 | 安装包 |
| --- | --- |
| macOS（Apple Silicon） | `DeepSeek-Harness-arm64.dmg`（拖拽安装） |
| macOS（Intel） | `DeepSeek-Harness-x64.dmg`（拖拽安装） |
| Windows x64 | `DeepSeek-Harness-Setup-x64.exe`（安装器，含卸载程序） |
| Windows x64（便携版） | `DeepSeek-Harness-win32-x64.zip` |

> 签名状态：macOS 为 ad-hoc 签名（未公证），首次打开请在 Finder 中右键 → 「打开」；
> Windows 安装器未做代码签名，SmartScreen 提示时选择「更多信息 → 仍要运行」。

**一键下载**

```bash
bash <(curl -sL https://raw.githubusercontent.com/chenxinj08-lgtm/deepseek-harness-desktop/main/scripts/download-latest.sh)
# 或
gh release download -R chenxinj08-lgtm/deepseek-harness-desktop --pattern '*'
```

## 从源码构建

**前置要求**：Node.js ≥ 18、npm；macOS 打包 dmg 需要系统自带的 hdiutil。

```bash
npm install        # 安装 electron 与打包工具
npm run setup      # 安装官方 dsh 运行时到 vendor/，并装入随仓库分发的官方插件包
npm start          # 开发启动

npm run pack:mac   # 打包 macOS arm64（Apple Silicon）
npm run pack:mac:x64
npm run pack:win   # 打包 Windows x64（建议在 Windows 或 CI 上执行）
npm run dmg:mac    # 生成 .dmg
npm run zip:win    # 生成 Windows .zip
```

> Windows 交叉构建提示：Windows 原生依赖（sharp 等）需在 Windows 环境重新执行 `npm run setup` 后打包；
> 仓库自带的 [GitHub Actions 工作流](.github/workflows/release.yml) 可在 tag 推送时自动完成三平台构建与发布。

## 架构

```
┌──────────────────────────────────────────────────────┐
│                 DeepSeek Harness Desktop              │
│  ┌──────────────┐      ┌──────────────────────────┐  │
│  │ Electron 壳    │      │ 内置 dsh 运行时            │  │
│  │ main.js       │ ───▶ │ @deepseek-ai/dsh (rc.6)  │  │
│  └──────────────┘      └──────────┬───────────────┘  │
│                                   │                  │
│  ┌────────────────────────────────▼───────────────┐  │
│  │ 插件层: local-files · vision · memory · 消息编辑  │  │
│  └────────────────────────────────┬───────────────┘  │
│                                   │                  │
│  ┌────────────────────────────────▼───────────────┐  │
│  │ 用户层注册 ~/.dsh（官方升级不被覆盖）            │  │
│  └────────────────────────────────────────────────┘  │
│            数据全本地 · 无遥测 · 无上传                │
└──────────────────────────────────────────────────────┘
```

## 隐私

**数据边界**：会话、附件、记忆、API Key 全部保存在本机用户目录（macOS：`~/.dsh`；Windows：`%USERPROFILE%\.dsh`），
不收集任何统计，不发送遥测，唯一外联为查询官方 npm 版本号。

## 更新机制

内置自更新器：启动后静默查询官方 npm registry 的 `@deepseek-ai/dsh` 最新版本 → 与内置版本不一致时右下角出现提示 →
点击「重启安装」下载并替换内置运行时 → 重启生效。更新只动官方 dsh 包，不碰用户数据与插件注册。

## 文档

- [安装说明](docs/INSTALL.md)（macOS / Windows 极简安装指引）
- [插件注册模板](docs/cordis.patch.yml.example)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)

## 目录结构

```
├── main.js / preload.js      Electron 壳主进程与预加载脚本
├── package.json              壳清单与打包脚本（pack:mac / pack:win / dmg / zip）
├── harness/                  dsh 运行时 fork 源码（插件体系：local-files / vision / memory / 消息编辑）
│   ├── app/                  Electron 壳源码副本（与根目录同步）
│   ├── src/plugins/          fork 官方包与自建插件的完整源码
│   └── CHANGELOG.md          详细变更记录
├── vendor/                   运行时依赖清单与随仓库分发的官方插件包（vendor/extra/*.tgz）
├── scripts/                  构建与打包脚本
├── docs/                     插件注册模板等文档
└── .github/workflows/        CI：三平台构建
```

## 社区

- 官方社区介绍帖：[deepseek-ai/deepseek-harness#discussions/1727](https://github.com/deepseek-ai/deepseek-harness/discussions/1727)
- 仓库 Discussions：[讨论区](../../discussions)
- 本仓库已收录 `dsh-plugin` 话题，可在官方插件生态中检索发现

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：官方运行时与插件体系（MIT）
- [Electron](https://github.com/electron/electron)：桌面应用框架
- [Cordis](https://github.com/cordiverse/cordis)：插件化架构
- [NSIS](https://nsis.sourceforge.io/)：Windows 安装器

## 免责声明

本项目为社区项目，**非 DeepSeek 官方出品**。「DeepSeek Harness」为官方项目名称
（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，MIT 开源），
本仓库仅对其做桌面化封装。内置运行时与插件版权归 DeepSeek（MIT），见 [NOTICE.md](NOTICE.md)。

## 许可证

- 壳代码（main.js / preload.js / scripts / docs）：MIT，见 [LICENSE](LICENSE)
- 内置运行时与插件（`vendor/extra/*.tgz`）：DeepSeek 官方 deepseek-ai/deepseek-harness，MIT
