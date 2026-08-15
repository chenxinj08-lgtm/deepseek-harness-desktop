// 制作专业拖拽安装 DMG:
//  1. ad-hoc 签名(或 DSH_CODESIGN_IDENTITY 指定证书)
//  2. 磁盘镜像内放置 Applications 快捷方式(拖拽安装)
//  3. 卷图标与卷名
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const dist = join(root, 'dist')
const dirs = readdirSync(dist).filter((d) => d.startsWith('DeepSeek Harness-darwin'))
if (dirs.length === 0) {
  console.error('未找到打包产物,请先运行 npm run pack:mac')
  process.exit(1)
}

for (const dir of dirs) {
  const inner = readdirSync(join(dist, dir)).find((f) => f.endsWith('.app'))
  if (!inner) {
    console.error('跳过 ' + dir + ': 未找到 .app')
    continue
  }
  const appPath = join(dist, dir, inner)
  const arch = dir.includes('arm64') ? 'arm64' : 'x64'
  const out = join(dist, 'DeepSeek-Harness-' + arch + '.dmg')
  const stage = join(dist, '.dmg-stage-' + arch)
  const vol = 'DeepSeek Harness'

  // 1) 签名(ad-hoc;有证书则用 DSH_CODESIGN_IDENTITY)
  //    按 electron-builder 标准流程:动态库 → framework 版本目录 → Helper → 主应用;
  //    无二进制的 framework(如 ReactiveObjC)自动跳过
  const identity = process.env.DSH_CODESIGN_IDENTITY || '-'
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { stdio: 'inherit' })
    return r.status === 0
  }
  // 0) 清理 vendor 内指向本机路径的符号链接(npm .bin 链接),
  //    否则既导致签名失败(目标不存在)又会在产物中留下本机路径
  const binDir = join(appPath, 'Contents', 'Resources', 'vendor', 'node_modules', '.bin')
  if (statSync(binDir, { throwIfNoEntry: false })) {
    const links = spawnSync('find', [binDir, '-type', 'l'], { encoding: 'utf8' })
    for (const l of (links.stdout || '').split('\n').filter(Boolean)) {
      rmSync(l, { force: true })
    }
    console.log('[make-dmg] 已清理 vendor/.bin 符号链接')
  }

  console.log('[make-dmg] codesign: ' + appPath)
  const fwRoot = join(appPath, 'Contents', 'Frameworks')
  let ok = true

  // 1a. 所有动态库
  const dylibs = spawnSync('find', [appPath, '-name', '*.dylib'], { encoding: 'utf8' })
  for (const t of (dylibs.stdout || '').split('\n').filter(Boolean)) {
    if (!run('codesign', ['--force', '--sign', identity, t])) ok = false
  }
  // 1b. 每个 framework 的真实版本目录(仅当存在二进制时)
  const fws = spawnSync('find', [fwRoot, '-maxdepth', '1', '-name', '*.framework'], { encoding: 'utf8' })
  for (const fw of (fws.stdout || '').split('\n').filter(Boolean)) {
    const name = fw.slice(0, -'.framework'.length).split('/').pop()
    const ver = join(fw, 'Versions', 'A')
    if (existsSync(join(ver, name))) {
      if (!run('codesign', ['--force', '--sign', identity, ver])) ok = false
    }
  }
  // 1c. Helper 应用
  const helpers = spawnSync('find', [fwRoot, '-name', '*.app'], { encoding: 'utf8' })
  for (const t of (helpers.stdout || '').split('\n').filter(Boolean)) {
    if (!run('codesign', ['--force', '--sign', identity, t])) ok = false
  }
  // 1d. 主应用
  if (ok) ok = run('codesign', ['--force', '--sign', identity, appPath])
  if (!ok) {
    console.error('[make-dmg] 逐组件签名失败,回退 --deep 签名')
    ok = run('codesign', ['--force', '--deep', '--sign', identity, appPath])
  }
  if (!ok) process.exit(1)
  let r = spawnSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
  console.log('[make-dmg] 签名校验通过')

  // 2) 构建拖拽安装布局
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  spawnSync('cp', ['-R', appPath, join(stage, inner)], { stdio: 'inherit' })
  try { symlinkSync('/Applications', join(stage, 'Applications')) } catch { /* 已存在 */ }
  spawnSync('cp', [join(root, 'DeepSeek-Harness.icns'), join(stage, '.VolumeIcon.icns')], { stdio: 'inherit' })
  console.log('[make-dmg] staging: ' + readdirSync(stage).join(', '))

  // 3) 生成 DMG
  rmSync(out, { force: true })
  console.log('[make-dmg] ' + inner + ' → ' + out)
  r = spawnSync('hdiutil', ['create', '-volname', vol, '-srcfolder', stage, '-ov', '-format', 'UDZO', '-imagekey', 'zlib-level=9', out], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
  rmSync(stage, { recursive: true, force: true })
  console.log('[make-dmg] 完成: ' + out)
}
