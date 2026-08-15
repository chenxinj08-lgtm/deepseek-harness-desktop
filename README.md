# DeepSeek Harness 桌面版（deepseek-harness-desktop）

自包含的 Electron 桌面壳：内置官方 dsh 运行时（`@deepseek-ai/dsh`）与本地文件 / 视觉插件，
把 DeepSeek Harness 变成一键启动的桌面应用。**数据全部保存在本地，无遥测、无上传。**

## ✨ 功能特性

- **一键启动**：内置 Node 运行时（Electron 二进制），不依赖系统 Node / npm
- **本地文件附件**：拖拽 / 粘贴上传本地文件与图片，图片主流大图预览（官方 local-files 插件）
- **视觉检查**：图片 eyes-only 视觉观察（官方 host-vision 插件）
- **无缝启动过渡**：品牌加载页渐隐 → 官方界面接管，无闪烁、无空档
- **窗口状态记忆**：窗口位置与大小自动恢复
- **自更新（零上传）**：以官方 npm registry 为信号源，检测到新 dsh 版本后在应用内提示 → 下载 → 替换内置运行时 → 重启生效
- **原生体验**：右键菜单（撤销 / 剪切 / 复制 / 粘贴）、下载静默落盘、外链交给系统浏览器
- **跨平台**：macOS（Apple Silicon / Intel）与 Windows x64

## 📦 下载安装

在 [GitHub Releases](../../releases) 下载：

| 平台 | 文件 |
| --- | --- |
| macOS（Apple Silicon） | `DeepSeek-Harness-arm64.dmg` |
| macOS（Intel） | `DeepSeek-Harness-x64.dmg` |
| Windows x64 | `DeepSeek-Harness-win32-x64.zip` |

### 一键下载

```bash
# macOS / Linux / Windows(Git Bash)
bash <(curl -sL https://raw.githubusercontent.com/chenxinj08-lgtm/deepseek-harness-desktop/main/scripts/download-latest.sh)
# 或
gh release download -R chenxinj08-lgtm/deepseek-harness-desktop --pattern '*'
```

直接下载链接（latest）：
- macOS（Apple Silicon）：`https://github.com/chenxinj08-lgtm/deepseek-harness-desktop/releases/latest/download/DeepSeek-Harness-arm64.dmg`
- macOS（Intel）：`https://github.com/chenxinj08-lgtm/deepseek-harness-desktop/releases/latest/download/DeepSeek-Harness-x64.dmg`
- Windows x64：`https://github.com/chenxinj08-lgtm/deepseek-harness-desktop/releases/latest/download/DeepSeek-Harness-win32-x64.zip`

> 目前为未签名构建：
> - macOS：首次打开请在 Finder 中右键应用 → 「打开」
> - Windows：SmartScreen 提示时点击「更多信息 → 仍要运行」

## 🔧 从源码构建

前置：Node.js ≥ 18、npm；macOS 打包 dmg 需系统自带的 hdiutil。

```bash
npm install        # 安装 electron 与打包工具
npm run setup      # 安装官方 dsh 运行时到 vendor/，并装入内置插件包
npm start          # 开发启动

npm run pack:mac   # 打包 macOS arm64（Apple Silicon）
npm run pack:mac:x64
npm run pack:win   # 打包 Windows x64（建议在 Windows 或 CI 上执行）
npm run dmg:mac    # 生成 .dmg
npm run zip:win    # 生成 Windows .zip
```

> Windows 交叉构建提示：Windows 原生依赖（sharp 等）需要在 Windows 环境重新执行
> `npm run setup` 后打包；也可以直接用仓库自带的
> [GitHub Actions 工作流](.github/workflows/release.yml) 双平台构建。

## 🔒 隐私与安全

- 不收集任何统计，不发送遥测
- API Key 只保存在本机用户目录（macOS：`~/.dsh/settings.yaml`、`~/.dsh/.credentials.yaml`；Windows：`%USERPROFILE%\.dsh\...`），权限 600
- 会话、附件、本地文件全部保存在本机
- 唯一的网络访问：启动后查询官方 npm registry 的 `@deepseek-ai/dsh` 最新版本（只取版本号，不上传任何数据）

## 🔄 更新机制

应用内置自更新器：静默查询 npm registry 官方 dsh 版本 → 与内置版本不同时右下角出现角标提示 →
点击「重启安装」下载并替换内置 vendor → 重启生效。更新只动官方 dsh 包，不碰用户数据与插件注册。

## 🗂 目录结构

```
main.js        Electron 主进程：服务生命周期 / 自更新 / 窗口管理 / 菜单
preload.js     预加载脚本（更新角标的下载安装 / 重启桥接）
vendor/        运行时目录（npm run setup 生成；extra/ 内置官方插件包）
scripts/       构建脚本（setup-vendor / make-dmg / zip-win / make-ico）
docs/          用户层插件注册模板（cordis.patch.yml.example）
```

## 🔐 隐私与发布安全(三重防护)

推送/发布前必须全部通过,任何 BLOCK 级命中都会阻止推送:

1. **本地全盘扫描(第一道)**:`scripts/privacy-scan.mjs` —— 密钥/邮箱/手机号/用户名/本机路径/身份证号等 18 类规则,
   报告精确到「文件:行号:命中内容」;已通过 `scripts/install-hook.sh` 安装为 pre-push 钩子,推送即查。
2. **CI 扫描(第二道)**:GitHub Actions 每次推送自动运行同一扫描(`privacy` 任务),与本地结果交叉验证。
3. **GitHub Secret Scanning(第三道)**:仓库已启用密钥推送保护,服务端再拦一道。

```bash
node scripts/privacy-scan.mjs                 # 全盘扫描工作树(含插件包内部)
node scripts/privacy-scan.mjs --range=A..B    # 额外扫描提交范围内新增行
bash scripts/install-hook.sh                  # 安装 pre-push 钩子
```

## ⚖️ 免责声明

本项目是社区桌面壳，**非 DeepSeek 官方产品**。「DeepSeek Harness」为官方项目名称
（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，MIT 开源），
本壳仅对其做桌面化封装。内置运行时与插件版权归 DeepSeek 所有（MIT）。

## 📄 License

- 壳代码（main.js / preload.js / scripts / docs）：MIT，见 [LICENSE](LICENSE)
- 内置运行时与插件（`vendor/extra/*.tgz`）：DeepSeek 官方 deepseek-ai/deepseek-harness，MIT
