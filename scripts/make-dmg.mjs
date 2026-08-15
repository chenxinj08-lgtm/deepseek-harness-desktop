// 将 electron-packager 的 .app 产物制作成只读 DMG（macOS,需 hdiutil）
import { spawnSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
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
  const arch = dir.includes('arm64') ? 'arm64' : 'x64'
  const out = join(dist, 'DeepSeek-Harness-' + arch + '.dmg')
  rmSync(out, { force: true })
  console.log('[make-dmg] ' + inner + ' → ' + out)
  const r = spawnSync('hdiutil', ['create', '-volname', 'DeepSeek Harness', '-srcfolder', join(dist, dir, inner), '-ov', '-format', 'UDZO', out], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
console.log('[make-dmg] 完成')
