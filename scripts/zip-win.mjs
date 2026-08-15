// 将 electron-packager 的 Windows 产物打包为 zip（便携版）
import { spawnSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const dist = join(root, 'dist')
const dirs = readdirSync(dist).filter((d) => d.startsWith('DeepSeek Harness-win32'))
if (dirs.length === 0) {
  console.error('未找到 Windows 打包产物,请先运行 npm run pack:win')
  process.exit(1)
}
for (const d of dirs) {
  const out = join(dist, 'DeepSeek-Harness-win32-x64.zip')
  rmSync(out, { force: true })
  console.log('[zip-win] ' + d + ' → ' + out)
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', 'Compress-Archive -Path "' + join(dist, d, '*') + '" -DestinationPath "' + out + '"'], { stdio: 'inherit' })
    : spawnSync('ditto', ['-c', '-k', '--keepParent', join(dist, d), out], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
console.log('[zip-win] 完成')
