// 制作专业拖拽安装 DMG:
//  1. ad-hoc 签名(或 DSH_CODESIGN_IDENTITY 指定证书)
//  2. 磁盘镜像内放置 Applications 快捷方式(拖拽安装)
//  3. 卷图标与卷名
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
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
  //    Electron 官方流程:先逐个签框架,再签应用主体(新版 codesign 对
  //    ReactiveObjC 等框架直接 --deep 重签会报 code has no resources)
  const identity = process.env.DSH_CODESIGN_IDENTITY || '-'
  const sign = (target) => {
    const r = spawnSync('codesign', ['--force', '--sign', identity, target], { stdio: 'inherit' })
    return r.status === 0
  }
  console.log('[make-dmg] codesign: ' + appPath)
  const fwRoot = join(appPath, 'Contents', 'Frameworks')
  let ok = true
  if (statSync(fwRoot, { throwIfNoEntry: false })) {
    const fw = spawnSync('find', [fwRoot, '-name', '*.framework', '-o', '-name', '*.app', '-o', '-name', '*.dylib'], { encoding: 'utf8' })
    for (const t of (fw.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (!sign(t)) { ok = false; break }
    }
  }
  if (ok) ok = sign(appPath)
  if (!ok) {
    console.error('[make-dmg] 逐组件签名失败,回退 --deep 签名')
    const r = spawnSync('codesign', ['--force', '--deep', '--sign', identity, appPath], { stdio: 'inherit' })
    ok = r.status === 0
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
