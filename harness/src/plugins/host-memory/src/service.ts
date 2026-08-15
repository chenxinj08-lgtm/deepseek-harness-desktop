/** Memory service: workspace-scoped persistent markdown memories for the agent. */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

const MEMORY_INDEX = 'MEMORY.md'
const MAX_FILE_BYTES = 32 * 1024
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-_]{0,63}$/u

/** A memory file's index line and its content, in search order. */
export interface MemoryHit {
  readonly file: string
  readonly lines: string[]
}

function workspaceKey(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16)
}

/** One memory index entry: file name plus its first-line summary. */
export interface MemoryEntry {
  readonly name: string
  readonly summary: string
}

/** Config already validated and defaulted by the plugin schema. */
export interface MemoryServiceConfig {
  readonly storageRoot: string
}

export class MemoryService extends Service {
  /** In-memory index cache so system-prompt injection stays synchronous
   * (assembly resolves section text without awaiting disk). Refreshed on
   * initialize and after every add, so a new memory is visible next turn. */
  private readonly cachedIndex = new Map<string, string>()
  private cachedGlobal = ''
  /** 工作区索引缓存上限:超限按插入序淘汰最旧(防不同 cwd 字符串无限增长)。 */
  private static readonly INDEX_CACHE_MAX = 64

  constructor(ctx: Context, private readonly config: MemoryServiceConfig) {
    super(ctx, 'memory')
  }

  /** Create the storage root and the current workspace's directory. */
  async initialize(cwd: string | undefined): Promise<void> {
    await mkdir(this.config.storageRoot, { recursive: true })
    if (cwd !== undefined) await mkdir(this.workspaceDir(cwd), { recursive: true })
    this.cachedGlobal = (await this.readIfExists(join(this.config.storageRoot, MEMORY_INDEX))) ?? ''
  }

  private workspaceDir(cwd: string): string {
    return join(this.config.storageRoot, 'workspaces', workspaceKey(cwd))
  }

  private async readIfExists(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf8')
    } catch {
      return null
    }
  }

  /** Synchronous snapshot of the global index for system-prompt injection. */
  globalIndexSnapshot(): string {
    return this.cachedGlobal
  }

  /** Synchronous snapshot of one workspace's index for system-prompt injection. */
  workspaceIndexSnapshot(cwd: string): string {
    return this.cachedIndex.get(workspaceKey(cwd)) ?? ''
  }

  /** Parse index lines into entries (global then workspace). Reads the
   * index files from disk so the settings surface reflects manual edits,
   * unlike the cached snapshots used for system-prompt injection. */
  async list(cwd: string | undefined): Promise<{ global: MemoryEntry[]; workspace: MemoryEntry[] }> {
    const parse = (index: string): MemoryEntry[] => index.split('\n')
      .map(line => /^- \[([^\]]+)\]\(([^)]+)\.md\) — (.+)$/u.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(match => ({ name: match[1]!, summary: match[3]! }))
    const globalText = (await this.readIfExists(join(this.config.storageRoot, MEMORY_INDEX))) ?? ''
    const workspaceText = cwd === undefined
      ? ''
      : (await this.readIfExists(join(this.workspaceDir(cwd), MEMORY_INDEX))) ?? ''
    return { global: parse(globalText), workspace: parse(workspaceText) }
  }

  /** Read one memory file by name, preferring the current workspace then the global root. */
  async read(cwd: string | undefined, name: string): Promise<string | null> {
    if (!NAME_PATTERN.test(name)) return null
    const candidates = [
      ...(cwd === undefined ? [] : [join(this.workspaceDir(cwd), `${name}.md`)]),
      join(this.config.storageRoot, `${name}.md`),
    ]
    for (const file of candidates) {
      const text = await this.readIfExists(file)
      if (text !== null) return text.slice(0, MAX_FILE_BYTES)
    }
    return null
  }

  /** Substring search over the current workspace's and the global root's markdown files. */
  async search(cwd: string | undefined, query: string): Promise<MemoryHit[]> {
    const needle = query.trim().toLowerCase()
    if (needle === '') return []
    const dirs = [
      ...(cwd === undefined ? [] : [this.workspaceDir(cwd)]),
      this.config.storageRoot,
    ]
    const hits: MemoryHit[] = []
    for (const dir of dirs) {
      let entries: string[]
      try {
        entries = await readdir(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue
        const text = await this.readIfExists(join(dir, entry))
        if (text === null) continue
        const lines = text.slice(0, MAX_FILE_BYTES).split('\n') // 与 read 一致:整读截断到 32 KiB
        const matched: string[] = lines
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.toLowerCase().includes(needle))
          .slice(0, 8)
          .map(({ line, index }) => `${index + 1}: ${line.slice(0, 200)}`)
        if (matched.length > 0) hits.push({ file: entry, lines: matched })
      }
    }
    return hits.slice(0, 10)
  }

  /** Write a new memory into the current workspace and append its index line. */
  async add(cwd: string | undefined, name: string, content: string): Promise<string> {
    if (!NAME_PATTERN.test(name)) throw new Error(`memory name must match ${NAME_PATTERN.source}`)
    const trimmed = content.trim()
    if (trimmed === '') throw new Error('memory content must be non-empty')
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_FILE_BYTES) {
      throw new Error(`memory content exceeds ${MAX_FILE_BYTES} bytes`)
    }
    const dir = cwd === undefined ? this.config.storageRoot : this.workspaceDir(cwd)
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${name}.md`)
    const summary = trimmed.split('\n')[0]!.slice(0, 80)
    await writeFile(file, `${trimmed}\n`, 'utf8')
    // Maintain the index: one link line per memory file (idempotent replace).
    const indexFile = join(dir, MEMORY_INDEX)
    const index = (await this.readIfExists(indexFile)) ?? ''
    const line = `- [${name}](${name}.md) — ${summary}`
    const kept = index.split('\n').filter(existing => !existing.startsWith(`- [${name}]`))
    kept.push(line)
    const next = `${kept.filter(line => line.trim() !== '').join('\n')}\n`
    await writeFile(indexFile, next, 'utf8')
    // Refresh the injection cache so the new memory is visible next turn.
    if (cwd === undefined) this.cachedGlobal = next
    else this.cacheWorkspaceIndex(cwd, next)
    return file
  }

  /** 写入工作区索引缓存;超过上限时淘汰最旧(防 cwd 字符串无限增长)。 */
  private cacheWorkspaceIndex(cwd: string, text: string): void {
    const key = workspaceKey(cwd)
    if (!this.cachedIndex.has(key) && this.cachedIndex.size >= MemoryService.INDEX_CACHE_MAX) {
      const oldest = this.cachedIndex.keys().next().value as string
      this.cachedIndex.delete(oldest)
    }
    this.cachedIndex.set(key, text)
  }
}
