// 从 DeepSeek-Harness.icns 生成多尺寸 build/icon.ico（PNG 压缩条目,Vista+）
// 依赖 macOS 自带 sips
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const work = join(root, 'build', '.ico-tmp')
const sizes = [256, 128, 64, 48, 32, 16]
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const big = join(work, '512.png')
let r = spawnSync('sips', ['-s', 'format', 'png', join(root, 'DeepSeek-Harness.icns'), '--out', big], { stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status ?? 1)

const pngs = []
for (const s of sizes) {
  const f = join(work, s + '.png')
  r = spawnSync('sips', ['-z', String(s), String(s), big, '--out', f], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
  pngs.push([s, readFileSync(f)])
}

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(pngs.length, 4)
const entries = []
let offset = 6 + 16 * pngs.length
for (const [s, data] of pngs) {
  const e = Buffer.alloc(16)
  e.writeUInt8(s >= 256 ? 0 : s, 0)
  e.writeUInt8(s >= 256 ? 0 : s, 1)
  e.writeUInt8(0, 2)
  e.writeUInt8(0, 3)
  e.writeUInt16LE(1, 4)
  e.writeUInt16LE(32, 6)
  e.writeUInt32LE(data.length, 8)
  e.writeUInt32LE(offset, 12)
  offset += data.length
  entries.push(e)
}
writeFileSync(join(root, 'build', 'icon.ico'), Buffer.concat([header, ...entries, ...pngs.map(([, d]) => d)]))
rmSync(work, { recursive: true, force: true })
console.log('build/icon.ico 已生成')
