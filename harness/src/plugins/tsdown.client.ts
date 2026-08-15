/**
 * Client 插件共享 tsdown 配置:emit ModuleLoader bundle(lib/client.js,
 * window.__ModuleLoader__.load) + host 侧 node half(lib/index.js, esm)。
 * CSS Modules 经 lightningcss 内联为 <style data-plugin> 注入。
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const CSS_PREFIX = '\0dsh-css:'
const CSS_SUFFIX = '.mjs'

/** 平台模块:外壳冻结模块表的共享入口,client 打包一律 external。 */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** Client 打包 external:平台模块 + fork 间值 import 的包。 */
export const CLIENT_EXTERNALS: readonly string[] = [
  ...PLATFORM_MODULES,
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-ui-input-trigger/client',
  '@deepseek-ai/dsh-client-ui-layout/client',
]

/** 生成一个 host 插件的打包配置(纯 node half,从 src 直打)。
 * @param subpaths - 需按官方 exports 布局输出的子路径(如 {'types/api/index': 'src/api/index.ts'})。
 */
export function hostLibrary(
  id: string,
  srcEntries: readonly string[],
  subpaths: Record<string, string> = {},
): UserConfig[] {
  const entries: Record<string, string> = {}
  for (const entry of srcEntries) entries[entry.replace(/^src\//, '').replace(/\.ts$/, '')] = entry
  return [{
    name: id,
    entry: { ...entries, ...subpaths },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }]
}

/** 生成一个 client 插件的完整打包配置(node half + browser bundle)。入口从 src 直接打包
 * (rolldown 原生转换 TS + 解析 tsconfig paths),不再依赖 tsc 先产出 lib/types ——
 * 单包 tsc 的 rootDir 与跨包 paths 冲突(TS6059),官方靠 references 编译产物图解决,
 * fork 无产物图,故构建统一走 tsdown。 */
export function clientBundle(id: string, srcEntries: readonly string[]): UserConfig[] {
  return [
    {
      name: id,
      entry: [...srcEntries],
      outDir: 'lib',
      format: ['esm'],
      platform: 'node',
      target: 'es2024',
      fixedExtension: false,
      dts: false,
      clean: false,
    },
    {
      name: `${id}/client`,
      entry: { client: 'src/client/index.ts' },
      outDir: 'lib',
      format: 'cjs',
      platform: 'browser',
      dts: false,
      sourcemap: true,
      clean: false,
      external: [...CLIENT_EXTERNALS],
      define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
        'import.meta.env.MODE': JSON.stringify('production'),
        'import.meta.env': JSON.stringify({ MODE: 'production' }),
      },
      noExternal: (dep: string) => (CLIENT_EXTERNALS.includes(dep) ? undefined : true),
      plugins: [cssModuleInline(id)],
      outputOptions: {
        entryFileNames: 'client.js',
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
        footer: 'return module.exports; } });',
        intro: 'var module = { exports: {} }; var exports = module.exports;',
      },
    },
  ]
}

/** 把 .module.css 编译为 hashed classMap + <style> 注入代码(与官方产物同构)。 */
function cssModuleInline(id: string) {
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
      return CSS_PREFIX + abs + CSS_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_PREFIX)) return null
      const fileId = virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      const tagId = `${id}/${basename(fileId)}`
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
        "  const tag = document.createElement('style');",
        `  tag.dataset.plugin = ${JSON.stringify(id)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}
