# 安全修复记录

## 修复日期: 2026-08-15

### 修复 1: CSP 策略 (main.js:365-380)

**问题**: 缺少 Content-Security-Policy 头,无法防止 XSS 和资源注入攻击。

**修复**: 添加严格的 CSP 策略,只允许本地服务资源:
- `default-src 'self' http://127.0.0.1:3080`
- `object-src 'none'` (禁止插件)
- `base-uri 'none'` (防 base URI 劫持)
- `form-action 'none'` (禁止表单提交)
- `frame-ancestors 'none'` (防点击劫持)

**验证**: Electron `webRequest.onHeadersReceived` API 在所有响应前拦截注入 CSP 头。

---

### 修复 2: shell.openExternal 协议过滤 (main.js:333-337)

**问题**: `shell.openExternal(url)` 接受任意 URL,可能打开 `file:` / `javascript:` 等危险协议。

**修复**: 添加协议白名单,只允许 `https://`、`http://`、`mailto:`。

**验证**:
```
✗ file:///etc/passwd    → 不匹配白名单 → 阻止
✗ javascript:alert(1)   → 不匹配 → 阻止
✓ https://deepseek.com  → 匹配 → 允许
```

---

### 修复 3: Electron 安全配置显式声明 (main.js:326-331)

**问题**: `webPreferences` 未显式设置安全选项,依赖默认值。

**修复**: 显式声明:
- `contextIsolation: true` (preload 与页面隔离)
- `nodeIntegration: false` (页面不能访问 Node API)
- `sandbox: true` (渲染进程沙箱化)

**验证**: 打开应用后,在 DevTools Console 执行:
- `typeof require` → `'undefined'`
- `window.process` → `undefined`

---

### 修复 4: overlay innerHTML XSS 防护 (main.js:143-160)

**问题**: `overlay()` 函数使用 `innerHTML` 注入动态内容,版本号等外部数据可能包含恶意 HTML。

**修复**: 
1. 添加 `sanitizeVersion()` 函数,用 SEMVER_RE 正则验证版本号格式
2. 添加 `safeOverlayHtml()` 函数,先转义所有 HTML 实体,再只恢复白名单标签:
   - 简单开闭合标签: `<span>`, `<b>`, `<i>`, `<strong>`, `<em>`, `<br>`
   - 带 style 的 span: 只允许 `color` 和 `text-decoration` 样式
   - 带 onclick 的 a 标签: 只允许 `window.dsh` 开头的固定模式

**验证测试结果**:
```
✓ XSS img: v<img src=x onerror=alert(1)> → 转义为文本
✓ XSS script: <script>alert(1)</script> → 转义为文本
✓ onclick injection: <span onclick="malicious()"> → 转义为文本
✓ external link: <a href="https://evil.com"> → 转义为文本
✓ whitelist span: <span>ok</span> → 保留
✓ whitelist style: <span style="color:#3964fe">ok</span> → 保留
```

---

### 未修复项 (已评估风险)

#### new Function (schemastery 库)
- **位置**: `vendor/node_modules/@deepseek-ai/schemastery/src/index.ts:261`
- **风险**: 低 — 需要修改配置文件(权限 0o600)才能注入
- **建议**: 向上游提 PR 用 JSON.parse 替代

#### --expose-internals 标志
- **位置**: `main.js:72, 138`
- **风险**: 低 — 服务进程与渲染进程隔离,只监听 localhost
- **原因**: dsh 运行时的 cordis 框架需要此标志访问内部 ESM loader
- **建议**: 向上游提 issue 探索替代方案
