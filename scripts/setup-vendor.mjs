// 安装官方 dsh 运行时到 vendor/,并装入 vendor/extra/ 下的官方插件包
// （local-files / vision 为官方仓库构建产物,尚未发布到 npm,随本仓库分发）
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const vendor = join(root, 'vendor')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar'

const run = (args, cwd) => {
  const r = spawnSync(args[0], args.slice(1), {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (r.status !== 0) {
    console.error('[setup-vendor] 失败: ' + args.join(' '))
    process.exit(r.status ?? 1)
  }
}

console.log('[setup-vendor] 安装 @deepseek-ai/dsh 运行时 …')
run([npm, 'install', '--no-audit', '--no-fund'], vendor)

const extra = join(vendor, 'extra')
const target = join(vendor, 'node_modules', '@deepseek-ai')
mkdirSync(target, { recursive: true })
for (const f of readdirSync(extra).filter((f) => f.endsWith('.tgz')).sort()) {
  const tmp = join(vendor, '.plugin-tmp')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  run([tar, '-xzf', join(extra, f), '-C', tmp])
  const pkgDir = join(tmp, 'package')
  const pj = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  // 官方仓库以 pnpm workspace: 协议声明依赖,npm 无法解析;清洗为通配版本
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const d = pj[section]
    if (!d) continue
    for (const k of Object.keys(d)) if (String(d[k]).startsWith('workspace:')) d[k] = '*'
  }
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pj, null, 2) + '\n')
  const name = pj.name.startsWith('@') ? pj.name.split('/')[1] : pj.name
  const dest = join(target, name)
  rmSync(dest, { recursive: true, force: true })
  renameSync(pkgDir, dest)
  rmSync(tmp, { recursive: true, force: true })
  console.log('[setup-vendor] 装入插件包 ' + pj.name + '@' + pj.version)
}

console.log('[setup-vendor] 完成: vendor 已就绪')