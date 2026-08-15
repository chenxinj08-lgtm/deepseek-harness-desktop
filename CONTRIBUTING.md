# 贡献指南

感谢你关注 DeepSeek Harness Desktop。本仓库为社区项目，欢迎以任何形式参与：反馈问题、改进文档、提交代码。

## 提交前检查

1. **内容自查**：提交内容不得包含任何凭据、个人信息或本机路径。
2. **提交信息规范**：`<type>: <摘要>`（type：feat / fix / perf / docs / chore / refactor）。
3. **变更记录**：涉及 `harness/` 下插件源码的变更，需在 `harness/CHANGELOG.md` 补充条目。

## 工作流

```bash
# 1. 安装依赖与运行时
npm install
npm run setup

# 2. 开发启动
npm start

# 3. 变更后验证
npm run pack:mac                 # 打包验证（或对应平台）

# 4. 提交
git commit -m "feat: <摘要>"
```

## 目录指引

- 壳（Electron 主进程 / 自更新 / 窗口管理）：根目录 `main.js`、`preload.js`
- 插件源码：`harness/src/plugins/`（构建与注册流程见 `harness/README.md`）
- 构建与打包脚本：`scripts/`

## 行为准则

- 不引入任何遥测、统计上报或用户数据上传。
- 不将个人密钥、凭据、本机路径提交入库。
- 尊重 DeepSeek 官方项目（deepseek-ai/deepseek-harness）的 MIT 许可与署名要求。
