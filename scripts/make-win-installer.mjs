// 用 NSIS 构建 Windows 正规安装器(Setup.exe)
// 依赖: devDependency "nsis"(自带 makensis,支持 mac/linux/win)
import { existsSync, readdirSync, rmSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const dist = join(root, 'dist')
const dirs = readdirSync(dist).filter((d) => d.startsWith('DeepSeek Harness-win32'))
if (dirs.length === 0) {
  console.error('未找到 Windows 打包产物,请先运行 npm run pack:win')
  process.exit(1)
}

// makensis 解析顺序:环境变量 MAKENSIS > node_modules/nsis-bin > PATH
function findMakensis() {
  if (process.env.MAKENSIS && existsSync(process.env.MAKENSIS)) return process.env.MAKENSIS
  const local = join(root, 'node_modules', 'nsis-bin', process.platform === 'win32' ? 'makensis.exe' : 'makensis')
  if (existsSync(local)) return local
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['makensis'], { encoding: 'utf8' })
  if (probe.status === 0) return 'makensis'
  return null
}
const makensis = findMakensis()
if (!makensis) {
  console.error('缺少 NSIS:macOS 请 brew install nsis;Windows 请 choco install nsis -y(或设置 MAKENSIS 环境变量)')
  process.exit(1)
}

const pkg = JSON.parse(require('node:fs').readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
for (const dir of dirs) {
  const appDir = join(dist, dir)
  const out = join(dist, 'DeepSeek-Harness-Setup-x64.exe')
  rmSync(out, { force: true })
  const licenseFile = join(dist, 'LICENSE.txt')
  copyFileSync(join(root, 'LICENSE'), licenseFile)
  console.log('[make-win-installer] ' + dir + ' → ' + out)
  const args = [
    '-V4',
    '-DOUT_FILE=' + out,
    '-DAPP_DIR=' + appDir,
    '-DICON=' + join(root, 'DeepSeek-Harness.ico'),
    '-DLICENSE_FILE=' + licenseFile,
    '-DVERSION=' + version,
    join(root, 'scripts', 'installer.nsi'),
  ]
  const r = makensis.includes('/') || makensis.includes('\\')
    ? spawnSync(makensis, args, { stdio: 'inherit' })
    : spawnSync('makensis', args, { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
  console.log('[make-win-installer] 完成: ' + out)
}
