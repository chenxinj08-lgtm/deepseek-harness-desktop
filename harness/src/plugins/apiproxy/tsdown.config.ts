import { hostLibrary } from '../tsdown.client.ts'

// api 子路径按官方 exports 布局输出(lib/types/api/index.js),connection 等包
// 运行时按 exports 解析该子路径。
export default hostLibrary('@deepseek-ai/dsh-host-apiproxy', ['src/index.ts', 'src/invariant.ts'], {
  'types/api/index': 'src/api/index.ts',
  'types/fetch/client': 'src/fetch/client.ts',
})
