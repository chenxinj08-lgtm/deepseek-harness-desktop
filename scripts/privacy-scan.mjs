#!/usr/bin/env node
// ============================================================
// 发布内容检查 —— 提交前对仓库内容执行敏感信息检查
// 用法:
//   node scripts/privacy-scan.mjs
//   node scripts/privacy-scan.mjs --range=A..B
// 退出码: 0 = 通过; 1 = 存在命中(禁止推送)
// ============================================================
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const args = process.argv.slice(2)
const rangeArg = args.find((a) => a.startsWith('--range='))?.slice(8) || null

// ---------- 规则表 ----------
// BLOCK = 真实隐私风险,出现即禁止发布;WARN = 需人工复核
const RULES = [
  { id: 'DEEPSEEK_API_KEY', level: 'BLOCK', re: /sk-[A-Za-z0-9]{20,}/g, desc: 'DeepSeek API Key(sk-*)' },
  { id: 'OPENAI_API_KEY', level: 'BLOCK', re: /sk-proj-[A-Za-z0-9]{16,}/g, desc: 'OpenAI API Key(sk-proj-*)' },
  { id: 'ANTHROPIC_API_KEY', level: 'BLOCK', re: /sk-ant-[A-Za-z0-9]{16,}/g, desc: 'Anthropic API Key(sk-ant-*)' },
  { id: 'GOOGLE_API_KEY', level: 'BLOCK', re: /AIza[0-9A-Za-z_-]{30,}/g, desc: 'Google API Key(AIza*)' },
  { id: 'GITHUB_TOKEN', level: 'BLOCK', re: /gh[pousr]_[A-Za-z0-9]{20,}/g, desc: 'GitHub Token(gh*)' },
  { id: 'GITLAB_TOKEN', level: 'BLOCK', re: /glpat-[A-Za-z0-9_-]{16,}/g, desc: 'GitLab Token(glpat-*)' },
  { id: 'SLACK_TOKEN', level: 'BLOCK', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, desc: 'Slack Token(xox*)' },
  { id: 'AWS_ACCESS_KEY', level: 'BLOCK', re: /AKIA[0-9A-Z]{16}/g, desc: 'AWS Access Key(AKIA*)' },
  { id: 'PRIVATE_KEY', level: 'BLOCK', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, desc: '私钥内容' },
  { id: 'JWT_TOKEN', level: 'BLOCK', re: /eyJ[A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]{10,}/g, desc: 'JWT Token' },
  { id: 'USER_HOME_PATH', level: 'BLOCK', re: /\/Users\/[A-Za-z0-9_.-]+/g, desc: 'macOS 用户主目录路径(暴露本机用户名)', allow: ['/Users/test', '/Users/example', '/Users/user', '/Users/yourname', '/Users/username', '/Users/tester'] },
  { id: 'PHONE_CN', level: 'BLOCK', re: /(?<![0-9])([+]?86[ -]?)?1[3-9][0-9]{9}(?![0-9])/g, desc: '中国手机号', allow: ['13800138000', '13900139000', '18888888888', '15888888888'] },
  { id: 'EMAIL', level: 'BLOCK', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}/g, desc: '邮箱地址', allowDomains: ['example.com', 'example.org', 'example.net', 'test.com', 'harness.internal', 'localhost', 'users.noreply.github.com', 'deepseek.com', 'deepseek-ai.com'] },
  { id: 'CN_ID_CARD', level: 'WARN', re: /(?<![0-9])[0-9]{17}[0-9Xx](?![0-9])/g, desc: '疑似 18 位身份证号(需人工确认)' },
  { id: 'GENERIC_SECRET', level: 'BLOCK', re: /(api[_-]?key|apikey|secret|client_secret|access_token|auth_token|password|passwd|private_key)[^A-Za-z0-9]{1,3}['"][A-Za-z0-9_./+-]{20,}['"]/gi, desc: '密钥类赋值语句', allowValues: ['example', 'test', 'dummy', 'changeme', 'your', 'placeholder', 'xxx', 'redacted'] },
  { id: 'MACHINE_PATH', level: 'WARN', re: /\/Applications\/|\/opt\/homebrew|\/usr\/local\/bin|\/Library\/Logs/g, desc: '本机软件路径(无个人标识,公开前建议泛化)' },
  { id: 'PUBLIC_IP', level: 'WARN', re: /(?<![0-9])(?!(10[.]|192[.]168[.]|172[.](1[6-9]|2[0-9]|3[01])[.]|127[.]|0[.]|255[.]|192[.]0[.]2[.]|198[.]51[.]100[.]|203[.]0[.]113[.]))[0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}(?![0-9])/g, desc: '公网 IP(需确认是否为示例数据)' },
  { id: 'ENV_FILE', level: 'BLOCK', re: /^[A-Za-z_][A-Za-z0-9_]*=[^#\n]{0,200}$/gm, desc: '.env 类环境变量文件', onlyFiles: ['.env', '.env.local', '.env.production', '.env.development'] },
]

// 本机用户名:显式注入(DSH_SCAN_USERNAMES)优先;未注入时自动读取 $USER,
// 但忽略 CI 等通用账户名(runner/root/ubuntu 等),避免误报
const GENERIC_USERS = new Set(['runner', 'root', 'ubuntu', 'vsts', 'admin', 'builder', 'azure', 'actions', 'test', 'user'])
const usernames = new Set()
if (process.env.DSH_SCAN_USERNAMES !== undefined) {
  for (const s of process.env.DSH_SCAN_USERNAMES.split(',')) {
    const t = s.trim()
    if (t) usernames.add(t)
  }
} else {
  const u = (process.env.USER || '').trim()
  if (u && !GENERIC_USERS.has(u)) usernames.add(u)
}

function scanText(text, label, hits) {
  const lines = String(text).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const rule of RULES) {
      if (!rule.re || (rule.onlyFiles && !rule.onlyFiles.some((f) => label.endsWith(f)))) continue
      rule.re.lastIndex = 0
      const m = rule.re.exec(line)
      if (!m) continue
      const val = m[0]
      if (rule.allow && rule.allow.includes(val)) continue
      if (rule.allowDomains && rule.allowDomains.some((d) => val.toLowerCase().endsWith('@' + d))) continue
      if (rule.allowValues && rule.allowValues.some((v) => val.toLowerCase().includes(v))) continue
      hits.push({ level: rule.level, rule: rule.id, desc: rule.desc, file: label, line: i + 1, sample: val.slice(0, 80) })
    }
    for (const u of usernames) {
      if (u.length >= 3 && /^[A-Za-z0-9_]+$/.test(u) && new RegExp('(^|[^A-Za-z0-9])' + u + '([^A-Za-z0-9]|$)').test(line)) {
        hits.push({ level: 'BLOCK', rule: 'USERNAME_LEAK', desc: '本机用户名出现', file: label, line: i + 1, sample: u })
      }
    }
  }
}

// ---------- 文件收集(排除生成/依赖目录) ----------
// lib/ 为本地构建产物目录(已 gitignore,不入库;其内容含本机构建路径,不随发布)
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor/node_modules', 'dist', '.backup', '.npm-cache', '.ico-tmp', '.zcode', '.github', 'lib'])
function walk(dir, base, out) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, base, out)
    else if (e.isFile()) out.push(relative(base, p))
  }
}

const hits = []
const files = []
walk(root, root, files)
for (const f of files) {
  const full = join(root, f)
  try {
    const buf = readFileSync(full)
    const text = buf.toString('utf8')
    if (text.includes('\u0000')) {
      const printable = buf.toString('latin1').match(/[ -~]{6,}/g) || []
      scanText(printable.join('\n'), f + ' (binary)', hits)
    } else {
      scanText(text, f, hits)
    }
  } catch { /* 忽略不可读文件 */ }
}

// 插件 tarball 内容扫描
const extra = join(root, 'vendor', 'extra')
if (statSync(extra, { throwIfNoEntry: false })) {
  for (const tgz of readdirSync(extra).filter((f) => f.endsWith('.tgz'))) {
    const r = spawnSync('tar', ['-xOf', join(extra, tgz)], { maxBuffer: 64 * 1024 * 1024 })
    if (r.status === 0) scanText(r.stdout.toString('utf8'), 'vendor/extra/' + tgz, hits)
  }
}

// 提交范围新增行(配合 pre-push hook)
if (rangeArg) {
  const r = spawnSync('git', ['diff', '--no-color', rangeArg], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
  if (r.status === 0) {
    const added = r.stdout.toString('utf8').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n')
    scanText(added, rangeArg + ' (提交新增行)', hits)
  }
}

// ---------- 输出 ----------
const blocks = hits.filter((h) => h.level === 'BLOCK')
const warns = hits.filter((h) => h.level === 'WARN')
for (const h of [...blocks, ...warns]) {
  console.log('[' + h.level + '] ' + h.file + ':' + h.line + '  规则=' + h.rule + ' ' + h.desc + '  命中=' + h.sample)
}
console.log('---')
console.log('扫描完成: 文件=' + files.length + '  BLOCK=' + blocks.length + '  WARN=' + warns.length)
if (blocks.length) {
  console.log('存在 BLOCK 级隐私风险,禁止推送/发布。请清理后重试。')
  process.exit(1)
}
console.log('无 BLOCK 级隐私风险' + (warns.length ? '(WARN 项请人工复核)' : ''))
process.exit(0)
