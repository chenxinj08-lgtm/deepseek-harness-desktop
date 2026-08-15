/** 最小 yauzl 类型声明(yauzl 3.x 为纯 JS 无类型,仅覆盖 readers.ts 用到的 API)。 */
declare module 'yauzl' {
  import type { Readable } from 'node:stream'

  export interface Entry {
    readonly fileName: string
  }

  export class ZipFile extends Readable {
    readEntry(): void
    openReadStream(entry: Entry, callback: (error: Error | null, stream: Readable) => void): void
    close(): void
  }

  export interface OpenOptions {
    readonly autoClose?: boolean
    readonly lazyEntries?: boolean
  }

  export function open(
    path: string,
    options: OpenOptions,
    callback: (error: Error | null, zipFile: ZipFile) => void,
  ): void
}
