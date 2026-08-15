# dsh 运行时 fork 源码

本目录承载 DeepSeek Harness Desktop 的插件体系**完整源码**：

- **自建插件**：本地文件（local-files）、视觉检查（vision）、记忆（memory）、消息编辑（message-edit）
- **fork 官方包**：llm / llm-deepseek / llm-pi-ai / apiproxy / connection / ui-conversation（附件结构化改造）

运行时产物（vendor 的 node_modules、构建产物 lib/）不入库，由源码按下方流程重建。

> **内部过程记录（不开源）**：本文件与 CHANGELOG.md 中标注「内部过程记录:不开源」的段落为开发过程详情，
> 仅作内部留存，不随开源发布。功能记录与构建流程为公开内容。

## 目录结构

```
harness/
├── app/                      Electron 壳源码副本（与仓库根目录同步）
│   ├── main.js               # 壳主进程：服务生命周期 / 自更新器 / 窗口状态 / 静默下载
│   ├── preload.js            # contextBridge：dsh.apply / dsh.reboot
│   └── package.json          # 壳包清单（electron-packager 打包）
├── src/
│   ├── bundle/
│   │   └── cordis.patch.yml          # 用户层插件注册参考（实际生效于 ~/.dsh/profiles/web/）
│   └── plugins/
│       ├── ui-local-files/           # 本地文件插件（client 端：附件 store + 卡片 + 预览）
│       ├── ui-conversation/          # fork 官方对话包（send-inject / send-content-inject 钩子）
│       ├── ui-message-edit/          # 消息编辑插件（fork 分支语义）
│       ├── host-local-files/         # host 本地文件（导入/下载/预览端点、信任围栏）
│       ├── host-vision/              # 视觉插件（eyes-only 感知传感器）
│       ├── host-memory/              # 记忆插件（memory_read/search/add + 索引注入）
│       ├── llm/                      # fork 官方：LocalFileBlock + 共享 flattenModelText
│       ├── llm-deepseek/             # fork 官方：DeepSeek 序列化（改用共享函数）
│       ├── llm-pi-ai/                # fork 官方：pi-ai 上下文（改用共享函数）
│       ├── apiproxy/                 # fork 官方：durablePromptContent 回填 local-file 元数据
│       └── connection/               # fork 官方：fixture 补 local-file 分支
└── CHANGELOG.md              # 详细变更记录（含内部过程记录，已标注）
```

> **2026-08-15 仓库重建说明** <!-- 内部过程记录:不开源 -->:dsh-app 目录曾被清空,本仓库从运行时
> vendor(app.asar 解包)、/tmp 工作区、用户层注册(~/.dsh/profiles/web/cordis.patch.yml)全量恢复;
> 8/14 后 git 历史以 v0.3.11 重建提交为新基线,CHANGELOG 保留全部历史条目。

## 历史说明

本仓库在 v0.2.4 前无 git 历史,以里程碑归档写入 CHANGELOG;v0.2.4 为基线,v0.3.11 起为重建基线
(过程细节见 CHANGELOG 中标注「内部过程记录:不开源」的条目)。

## 重建 vendor 流程（源码 → 运行时）

1. **类型门禁**（host 与 client 全绿）：
   `npx tsc --noEmit -p tsconfig.host-plugins.json`
   `npx tsc --noEmit -p tsconfig.client-plugins.json`
2. **构建 bundle**（rolldown 从 src 直接打包，含 TS 转换与 paths 解析；无需 tsc 先产出）：
   `npx tsdown --config src/plugins/<包>/tsdown.config.ts`
   host 包产出 lib/index.js(+invariant.js)，client 包另产出 lib/client.js(ModuleLoader bundle)。
3. 将 `lib/` 产物注入运行时 vendor：
   `rsync -a --exclude node_modules <包>/ "$APP_DIR/DeepSeek Harness.app/Contents/Resources/vendor/node_modules/@deepseek-ai/<包>/"`($APP_DIR = 应用安装目录,如 /Applications)
4. **插件注册在用户层**，不在官方包内（保证官方升级不抹掉）：
   - `~/.dsh/profiles/web/cordis.patch.yml` 含 `local-files`(host)、`ui-local-files`(client)、
     `vision-inspect`(host)、`memory`(host)、`ui-memory`(client) 等 insert；
   - 自建包通过 `~/.dsh/profiles/web/node_modules/@deepseek-ai/` 下的 symlink 解析到 vendor；
   - vendored `dsh-web-app` 保持官方原样。
5. 壳改动同步回 `app/` 并在仓库根目录 `npx electron-packager …` 重打包。

## 开发规范（内部） <!-- 内部过程记录:不开源 -->

每次变更（壳、插件、补丁、文档）必须走以下流程，缺一不可：

1. **改源码**：壳在 `app/`，插件在 `src/plugins/`。
2. **举证**：跑对应验证并记录结果（单测、tsc 门禁、断言、运行时端点、浏览器实测）。
   证据写入提交信息与 CHANGELOG。
3. **记录**：在 `CHANGELOG.md` 新增一条（版本/日期/改动/证据）。
4. **提交**：`git commit` 信息格式：`<动作>: <摘要>` + `证据: <测试结果>`。
5. **发布**：重建 bundle → 注入 vendor → 重打包安装（需用户确认后重启）。
6. **第二轮全量验证**：从头再走一遍类型门禁、断言、既有套件、冒烟，并反向复核本次改动清单。
