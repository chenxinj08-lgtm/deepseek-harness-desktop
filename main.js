// DeepSeek Harness 桌面壳 —— 自包含:内置 Node + 内置 dsh 包,不依赖系统 Node/npm
const { app, BrowserWindow, shell, Menu, dialog, screen, ipcMain, session } = require('electron')
const http = require('http'), https = require('https')
const { spawn, spawnSync } = require('child_process')
const fs = require('fs'), path = require('path'), os = require('os')

const PORT = 3080, URL = `http://127.0.0.1:${PORT}`
const NODE = process.execPath // Electron 二进制 = 内置 Node
// 开发时 vendor 在项目根;打包后 --extra-resource 放到 Contents/Resources/vendor
const VENDOR = fs.existsSync(path.join(__dirname, 'vendor')) ? path.join(__dirname, 'vendor') : path.join(process.resourcesPath, 'vendor')
const BIN = path.join(VENDOR, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const NODE_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1' } // 让 Electron 以纯 Node 模式跑 BIN
// 日志文件:跨平台便携路径(不硬编码用户名);Windows 落到 userData/logs
const logFile = () => {
  const dir = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Logs', 'dsh-desktop')
    : path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'dsh-web.log')
}
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json')

// —— 自更新配置(零上传:官方 npm 为信号源与下载源,更新 dsh 运行时) ——
const UPD = path.join(app.getPath('userData'), 'updates')
const REG = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest'
// npm 可执行文件:优先常见安装位置,找不到则回退到 PATH;Windows 用 npm.cmd
const NPM_BIN = (() => {
  if (process.platform === 'win32') return 'npm.cmd'
  for (const c of ['/opt/homebrew/bin/npm', '/usr/local/bin/npm', 'npm']) {
    if (c === 'npm' || fs.existsSync(c)) return c
  }
  return 'npm'
})()

const PAGE = (h, b) => 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html><html><body style="margin:0;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,sans-serif;color:#1d1d1f">${b}<h3 style="font-weight:600;margin:0">${h}</h3></body></html>`)
const LOADING = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html><html><head><style>
body{margin:0;height:100vh;background:#fff;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.card{display:flex;flex-direction:column;align-items:center;gap:16px}
.card img{display:block}
.wordmark{font-size:16px;line-height:24px;font-weight:600;letter-spacing:.08em;color:#0f1115}
.spinner{width:20px;height:20px;border-radius:50%;border:2px solid rgba(0,0,0,.1);border-top-color:#0f1115}
.hint{font-size:12px;line-height:18px;color:#81858c}
</style></head><body><div class="card">
<img src="data:image/png;base64,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" width="96" height="71" alt="">
<div class="wordmark">HARNESS</div>
<div class="spinner"></div>
<div class="hint">Loading plugins…</div>
</div></body></html>`)
const RETRY = PAGE('服务未就绪', `<p style="font-size:14px;color:#6e6e73">正常启动约 2 秒;超过 20 秒仍未就绪说明服务异常,请重试。</p><a href="${URL}" style="margin-top:14px;padding:8px 26px;border-radius:8px;background:#0a84ff;color:#fff;text-decoration:none;font-size:14px">重试</a>`)

let serverProc = null, win = null, saveTimer = null, starting = false

// —— 服务生命周期(内置 Node 跑内置包) ——
const up = () => new Promise((r) => {
  const q = http.get(URL, (s) => { s.resume(); r(s.statusCode === 200) })
  q.on('error', () => r(false))
  q.setTimeout(3000, () => { q.destroy(); r(false) })
})
const waitUp = (tries, interval = 250) => new Promise(async (r) => {
  for (let i = 0; i < tries; i++) {
    if (await up()) return r(true)
    await new Promise((s) => setTimeout(s, interval))
  }
  r(false)
})
async function start() {
  if (serverProc || starting) return
  starting = true
  try {
    if (await up()) return // 端口已被服务 → 不重复 spawn,根除 EADDRINUSE
    const fd = fs.openSync(logFile(), 'a')
    serverProc = spawn(NODE, ['--expose-internals', BIN, 'web'], {
      detached: true, stdio: ['ignore', fd, fd], env: NODE_ENV,
    })
    serverProc.on('exit', () => { serverProc = null }) // 崩溃即清句柄,允许重启
  } finally { starting = false }
}
function stop() {
  if (serverProc && serverProc.pid) {
    try { process.kill(-serverProc.pid, 'SIGTERM') } catch (e) {}
    serverProc = null
  }
}
async function boot() {
  win.loadURL(LOADING)
  await start() // 自守卫:端口已占用则不重复 spawn
  if (await waitUp(80)) { // 20 秒预算:正常 0.8s 就绪,超时才进重试页
    // 壳页整组(鲸鱼+HARNESS+spinner+Loading)极慢渐隐 2.5s 只淡到 0.82(视觉无感)
    // 渐隐早期切官方直显 → 官方 1.0 同点位元素接管,鲸鱼与文字"一直在",无空档无闪
    try {
      await win.webContents.executeJavaScript(
        `(() => { const c = document.getElementById('dsh-card'); if (c) { c.style.transition = 'opacity 2.5s ease'; c.style.opacity = '0.82' } })()`,
      )
      await new Promise((r) => setTimeout(r, 400))
    } catch (e) {}
    win.loadURL(URL)
  } else if (serverProc === null) { // 首次启动崩溃 → 重试一轮
    await start()
    if (await waitUp(80)) win.loadURL(URL)
    else win.loadURL(RETRY)
  } else win.loadURL(RETRY)
}
start() // 顶层立即启动:与窗口初始化并行

// —— 自更新器(零上传:检测官方 npm 新 dsh → 下载 → 替换内置 vendor) ——
let update = null, dlState = { done: false }

const getJSON = (url) => new Promise((resolve) => {
  const req = https.get(url, { headers: { 'User-Agent': 'dsh-desktop' } }, (res) => {
    let d = ''
    res.on('data', (c) => { d += c })
    res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { resolve(null) } })
  })
  req.on('error', () => resolve(null))
})

// 官方 npm 最新 dsh 版本
const latestDsh = async () => {
  const d = await getJSON(REG)
  return d && d.version ? d.version : null
}
// 当前内置 dsh 版本
const builtinDsh = () => {
  try {
    return spawnSync(NODE, ['--expose-internals', BIN, '--version'], { encoding: 'utf8', timeout: 15000, env: NODE_ENV })
      .stdout.trim().split('\n').pop() || null
  } catch (e) { return null }
}

// 应用内角标:注入到 app 主窗口右下角(非桌面角);悬停展开 release notes
// 全部在主进程轻量执行,不新建窗口、不阻塞 UI
function overlay(html, notes) {
  if (!win || win.isDestroyed()) return
  win.webContents.executeJavaScript(`(() => {
    let t = document.getElementById('dsh-toast')
    if (!t) {
      t = document.createElement('div')
      t.id = 'dsh-toast'
      t.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;background:#fff;border:1px solid rgba(0,0,0,.1);border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.14);overflow:hidden;font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#1d1d1f;max-width:280px;cursor:default'
      t.innerHTML = '<div class="dsh-tb" style="padding:10px 14px"></div><div class="dsh-tn" style="max-height:0;overflow:hidden;transition:max-height .25s;border-top:1px solid #f0f0f0;font-size:11px;color:#6e6e73;white-space:pre-wrap;padding:0 14px"></div>'
      document.body.appendChild(t)
      t.addEventListener('mouseenter', () => { const n = t.querySelector('.dsh-tn'); if (n.textContent.trim()) n.style.maxHeight = '180px' })
      t.addEventListener('mouseleave', () => { t.querySelector('.dsh-tn').style.maxHeight = '0' })
    }
    t.querySelector('.dsh-tb').innerHTML = ${JSON.stringify(html)}
    t.querySelector('.dsh-tn').textContent = ${JSON.stringify(notes || '')}
    t.style.display = 'block'
  })()`).catch(() => {})
}

// 用系统 npm(下载快,非上传)拉取官方最新 dsh 到临时目录
function npmInstall(target, v) {
  return new Promise((resolve) => {
    const p = spawn(NPM_BIN, ['install', `@deepseek-ai/dsh@${v}`, '--no-audit', '--no-fund', '--prefix', target], { stdio: 'ignore', shell: process.platform === 'win32' })
    p.on('error', () => resolve(false))
    p.on('close', (code) => resolve(code === 0))
  })
}

async function checkUpdate(silent) {
  if (dlState.done) return
  const box = (o) => dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, o)
  const v = await latestDsh()
  if (!v) { if (!silent) box({ message: '检查更新', detail: '无法获取官方最新版本,请检查网络后重试。', buttons: ['知道了'] }); return }
  const c = builtinDsh()
  if (v === c) { if (!silent) box({ message: '检查更新', detail: `已是最新版本 v${v}`, buttons: ['知道了'] }); return }
  if (silent && update && update.v === v) return // 同一新版本不重复提示
  update = { v, notes: `官方 DeepSeek Harness 新版本 v${v} 已发布` }
  overlay(`<span style="color:#3964fe">⬇</span> 官方新版本 v${v} 可更新 · <a href="#" onclick="window.dsh&&window.dsh.apply();return false" style="color:#3964fe;text-decoration:none">重启安装</a>`, update.notes)
}

// 更新后自检:插件注册与包都在用户层,官方升级只动 dsh 包;这里兜底确认
// ①三个插件包仍在 ②用户层注册行仍在 ③新 dsh 依赖的 web-app 版本未漂移。
function verifyPlugins() {
  const problems = []
  const pkgs = ['dsh-host-local-files', 'dsh-client-ui-local-files', 'dsh-client-ui-conversation']
  for (const p of pkgs) {
    if (!fs.existsSync(path.join(VENDOR, 'node_modules', '@deepseek-ai', p))) problems.push(`缺少包 ${p}`)
  }
  const patchPath = path.join(app.getPath('home'), '.dsh', 'profiles', 'web', 'cordis.patch.yml')
  try {
    const patch = fs.readFileSync(patchPath, 'utf8')
    if (!patch.includes('dsh-host-local-files') || !patch.includes('dsh-client-ui-local-files')) {
      problems.push('用户层注册行缺失')
    }
  } catch (e) { problems.push('用户层注册文件不可读') }
  try {
    const dshPkg = JSON.parse(fs.readFileSync(path.join(VENDOR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    const want = dshPkg.dependencies?.['@deepseek-ai/dsh-web-app']
    const webAppPkg = JSON.parse(fs.readFileSync(path.join(VENDOR, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json'), 'utf8'))
    if (want && webAppPkg.version && !want.replace(/^\^/, '').startsWith(webAppPkg.version.replace(/-rc.*/, ''))) {
      problems.push(`web-app 版本漂移:依赖 ${want},实际 ${webAppPkg.version}`)
    }
  } catch (e) { /* 读取失败由上面问题项兜底 */ }
  return problems
}

// 下载并安装:拉取新 dsh → 替换内置 vendor 的 @deepseek-ai/dsh → 重启(只动官方包,不动壳)
async function applyUpdate() {
  if (dlState.done || !update) return
  const target = path.join(UPD, 'dl')
  try {
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(target, { recursive: true })
    overlay(`<span style="color:#3964fe">⬇</span> 正在下载官方 v${update.v}…`, update.notes)
    if (!(await npmInstall(target, update.v))) throw new Error('npm')
    const src = path.join(target, 'node_modules', '@deepseek-ai', 'dsh')
    const dst = path.join(VENDOR, 'node_modules', '@deepseek-ai', 'dsh')
    if (!fs.existsSync(src) || !fs.existsSync(dst)) throw new Error('path')
    fs.rmSync(dst, { recursive: true, force: true })
    fs.cpSync(src, dst, { recursive: true })
    dlState = { done: true, version: update.v }
    const problems = verifyPlugins()
    if (problems.length > 0) {
      overlay(`<span style="color:#f0a020">⚠</span> 官方 v${update.v} 已下载,但自检发现问题:${problems.join('; ')} · 建议先核对插件再重启`, update.notes)
    } else {
      overlay(`<span style="color:#34c759">✓</span> 官方 v${update.v} 已安装 · 点击重启生效 · <a href="#" onclick="window.dsh&&window.dsh.reboot();return false" style="color:#3964fe;text-decoration:none">重启</a>`, update.notes)
    }
  } catch (e) {
    overlay('<span style="color:#ff3b30">✕</span> 更新失败,请稍后重试')
  }
}

ipcMain.on('apply-update', () => {
  const { response } = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
    type: 'info', message: `下载并安装官方 v${update.v}?`, detail: '下载官方最新 dsh 包并替换内置版本,完成后提示重启。', buttons: ['下载安装', '稍后'], defaultId: 0, cancelId: 1,
  })
  if (response === 0) applyUpdate()
})
ipcMain.on('dsh-reboot', () => {
  const { response } = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
    type: 'info', message: `重启以使用官方 v${dlState.version}?`, detail: '应用将自动退出并重新打开,新版本立即生效。', buttons: ['重启', '稍后'], defaultId: 0, cancelId: 1,
  })
  if (response === 0) { stop(); setTimeout(() => { app.relaunch(); app.exit(0) }, 300) }
})

// —— 窗口状态记忆 ——
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch (e) { return null } }
function queueSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) {
      try { fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds())) } catch (e) {}
    }
  }, 200)
}
function makeWin() {
  const opts = { width: 1280, height: 840, title: 'DeepSeek Harness', backgroundColor: '#f5f5f7', show: false }
  const saved = loadState()
  if (saved && screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return saved.x < a.x + a.width && saved.x + saved.width > a.x &&
           saved.y < a.y + a.height && saved.y + saved.height > a.y
  })) Object.assign(opts, saved)
  win = new BrowserWindow({ ...opts, webPreferences: { preload: path.join(__dirname, 'preload.js') } })
  win.once('ready-to-show', () => win.show())
  win.setMenuBarVisibility(false)
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  // Electron 默认无右键菜单;按可编辑/有选区给复制粘贴等原生动作。
  win.webContents.on('context-menu', (_e, params) => {
    const items = []
    if (params.isEditable) items.push(
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
    )
    else if (params.selectionText) items.push({ role: 'copy', label: '复制' })
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: win })
  })
  win.webContents.on('did-fail-load', (_e, code) => {
    if (code === -3 || win.isDestroyed()) return
    win.loadURL(RETRY)
  })
  win.on('resize', queueSave)
  win.on('move', queueSave)
  win.on('closed', () => { win = null })
  return win
}

app.whenReady().then(() => {
  // 下载静默落盘到"下载"文件夹,不弹保存对话框(Session 导出等浏览器下载)。
  session.defaultSession.on('will-download', (_e, item) => {
    item.setSavePath(path.join(app.getPath('downloads'), item.getFilename()))
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
    ]},
    { label: '操作', submenu: [
      { label: '检查更新…', click: () => checkUpdate(false) },
      { type: 'separator' },
      { role: 'quit', label: '退出' },
    ]},
  ]))
  makeWin(); boot()
  setTimeout(() => checkUpdate(true), 4000) // 启动后静默检查,发现新版才弹角落提示
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { makeWin(); boot() } })
})
app.on('before-quit', stop)
app.on('window-all-closed', () => app.quit())
