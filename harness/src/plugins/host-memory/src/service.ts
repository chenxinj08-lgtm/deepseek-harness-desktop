/** Memory service: workspace-scoped persistent markdown memories for the agent.
 * Two tiers (Hermes-style): long-term memories — one named markdown file each,
 * written only on explicit request — and short-term workspace notes — one
 * `ephemeral.md` per workspace, freely auto-updated by key during a task. */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

const MEMORY_INDEX = 'MEMORY.md'
const EPHEMERAL_FILE = 'ephemeral.md'
const MAX_FILE_BYTES = 32 * 1024
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-_]{0,63}$/u
/** Short-term notes budget: bounded by construction (8 × 1 KiB). */
const EPHEMERAL_ENTRY_MAX_BYTES = 1024
const EPHEMERAL_ENTRY_MAX_COUNT = 8

/** A memory file's index line, key-point summary, and matching lines, in relevance order. */
export interface MemoryHit {
  readonly file: string
  /** Extracted key-point summary (title / bold / list lead, else first line). */
  readonly summary: string
  /** Last-write epoch ms (relevance tiebreak; lets the model judge freshness). */
  readonly updatedAt: number
  readonly lines: string[]
}

function workspaceKey(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16)
}

/** One memory index entry: file name, key-point summary, and last-write time. */
export interface MemoryEntry {
  readonly name: string
  readonly summary: string
  readonly updatedAt: number
}

/** One short-term note: key, first-line summary, and full content. */
export interface NoteEntry {
  readonly name: string
  readonly summary: string
  readonly content: string
}

/**
 * Extract the key-point summary from memory text: heading > bold lead > list
 * item > first line — the lines that actually carry the point, instead of an
 * arbitrary first sentence. Markdown syntax is stripped for index readability.
 */
export function extractSummary(text: string): string {
  const lines = text.split('\n')
  const candidate = lines.find(line => /^#{1,3}\s/u.test(line.trim()))
    ?? lines.find(line => /\*\*[^*\n]+\*\*/u.test(line))
    ?? lines.find(line => /^[-*]\s/u.test(line.trim()))
    ?? lines[0]
  return (candidate ?? '').replace(/[#*`]/gu, '').trim().slice(0, 80)
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
  /** Short-term notes snapshot per workspace (same cache discipline as the index). */
  private readonly cachedNotes = new Map<string, string>()

  constructor(ctx: Context, private readonly config: MemoryServiceConfig) {
    super(ctx, 'memory')
  }

  /** Create the storage root and the current workspace's directory. */
  async initialize(cwd: string | undefined): Promise<void> {
    await mkdir(this.config.storageRoot, { recursive: true })
    if (cwd !== undefined) {
      await mkdir(this.workspaceDir(cwd), { recursive: true })
      const notes = await this.readEphemeral(cwd)
      this.cacheWorkspaceNotes(cwd, notes.length === 0 ? '' : this.notesToText(notes))
    }
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

  /** Synchronous snapshot of one workspace's short-term notes for injection. */
  workspaceNotesSnapshot(cwd: string): string {
    return this.cachedNotes.get(workspaceKey(cwd)) ?? ''
  }

  /** Parse index lines into entries (global then workspace). Reads the
   * index files from disk so the settings surface reflects manual edits,
   * unlike the cached snapshots used for system-prompt injection. */
  async list(cwd: string | undefined): Promise<{ global: MemoryEntry[]; workspace: MemoryEntry[] }> {
    const parse = (index: string, dir: string): Promise<MemoryEntry[]> =>
      Promise.all(index.split('\n')
        .map(line => /^- \[([^\]]+)\]\(([^)]+)\.md\) — (.+)$/u.exec(line.trim()))
        .filter((match): match is RegExpExecArray => match !== null)
        .map(async match => {
          let updatedAt = 0
          try {
            updatedAt = (await stat(join(dir, `${match[1]!}.md`))).mtimeMs
          } catch {
            // index entry without a backing file (manual edit): keep 0.
          }
          return { name: match[1]!, summary: match[3]!, updatedAt }
        }))
    const globalText = (await this.readIfExists(join(this.config.storageRoot, MEMORY_INDEX))) ?? ''
    const workspaceText = cwd === undefined
      ? ''
      : (await this.readIfExists(join(this.workspaceDir(cwd), MEMORY_INDEX))) ?? ''
    return {
      global: await parse(globalText, this.config.storageRoot),
      workspace: cwd === undefined ? [] : await parse(workspaceText, this.workspaceDir(cwd)),
    }
  }

  /** Short-term notes of one workspace, in insertion order (disk truth). */
  async listNotes(cwd: string): Promise<NoteEntry[]> {
    return this.readEphemeral(cwd)
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

  /** Substring search over the current workspace's and the global root's markdown files.
   * Results are ranked by relevance (exact-word > title > line matches, then
   * the older file), each carrying a key-point summary and last-write time so
   * the model can judge freshness before reading. */
  async search(cwd: string | undefined, query: string): Promise<MemoryHit[]> {
    const needle = query.trim().toLowerCase()
    if (needle === '') return []
    const terms = needle.split(/\s+/u).filter(term => term !== '')
    if (terms.length === 0) return []
    const dirs = [
      ...(cwd === undefined ? [] : [{ dir: this.workspaceDir(cwd), scoped: true as const }]),
      { dir: this.config.storageRoot, scoped: false as const },
    ]
    const hits: Array<MemoryHit & { score: number }> = []
    for (const { dir } of dirs) {
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
        const lines = text.slice(0, MAX_FILE_BYTES).split('\n')
        let score = 0
        const matched: string[] = []
        let titleScore = 0
        for (let index = 0; index < lines.length; index++) {
          const lower = lines[index]!.toLowerCase()
          if (!terms.some(term => lower.includes(term))) continue
          if (index === 0) titleScore = 1
          else if (/^#/u.test(lines[index]!.trim())) titleScore = Math.max(titleScore, 1)
          // Whole-term match scores higher than a substring fragment.
          score += terms.some(term => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u').test(lower)) ? 2 : 1
          if (matched.length < 4) matched.push(`${index + 1}: ${lines[index]!.slice(0, 200)}`)
        }
        if (score === 0) continue
        const file = entry.replace(/\.md$/u, '')
        let updatedAt = 0
        try {
          updatedAt = (await stat(join(dir, entry))).mtimeMs
        } catch {
          // stat raced the file away: keep 0.
        }
        hits.push({
          file,
          summary: extractSummary(text),
          updatedAt,
          lines: matched,
          score: score * 10 + titleScore * 5 + (updatedAt === 0 ? 0 : Math.min(updatedAt / 1e11, 1)),
        })
      }
    }
    hits.sort((left, right) => right.score - left.score)
    return hits.slice(0, 10).map(({ file, summary, updatedAt, lines }) => ({ file, summary, updatedAt, lines }))
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
    const summary = extractSummary(trimmed)
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

  /** Permanently delete one long-term memory (workspace first, then global) and its index line. */
  async remove(cwd: string | undefined, name: string): Promise<void> {
    if (!NAME_PATTERN.test(name)) throw new Error(`memory name must match ${NAME_PATTERN.source}`)
    const workspaceFile = cwd === undefined ? null : join(this.workspaceDir(cwd), `${name}.md`)
    const globalFile = join(this.config.storageRoot, `${name}.md`)
    const file = workspaceFile !== null && (await this.readIfExists(workspaceFile)) !== null
      ? workspaceFile
      : (await this.readIfExists(globalFile)) !== null ? globalFile : null
    if (file === null) throw new Error(`memory "${name}" was not found`)
    await rm(file)
    const owningDir = cwd !== undefined && file === workspaceFile
      ? this.workspaceDir(cwd)
      : this.config.storageRoot
    const indexFile = join(owningDir, MEMORY_INDEX)
    const index = (await this.readIfExists(indexFile)) ?? ''
    const next = `${index.split('\n').filter(line => line.trim() !== '' && !line.startsWith(`- [${name}]`)).join('\n')}\n`
    await writeFile(indexFile, next, 'utf8')
    if (owningDir === this.config.storageRoot) this.cachedGlobal = next
    else this.cacheWorkspaceIndex(cwd!, next)
  }

  /** Create or update one short-term workspace note (same key overwrites; bounded store). */
  async noteSet(cwd: string, key: string, content: string): Promise<void> {
    if (!NAME_PATTERN.test(key)) throw new Error(`memory note key must match ${NAME_PATTERN.source}`)
    const trimmed = content.trim()
    if (trimmed === '') throw new Error('memory note content must be non-empty')
    if (Buffer.byteLength(trimmed, 'utf8') > EPHEMERAL_ENTRY_MAX_BYTES) {
      throw new Error(`memory note content exceeds ${EPHEMERAL_ENTRY_MAX_BYTES} bytes`)
    }
    const entries = await this.readEphemeral(cwd)
    const kept = entries.filter(entry => entry.name !== key)
    kept.push({ name: key, summary: extractSummary(trimmed), content: trimmed })
    await this.writeEphemeral(cwd, kept.slice(-EPHEMERAL_ENTRY_MAX_COUNT))
  }

  /** Delete one short-term workspace note (idempotent). */
  async noteClear(cwd: string, key: string): Promise<void> {
    if (!NAME_PATTERN.test(key)) return
    const entries = await this.readEphemeral(cwd)
    const kept = entries.filter(entry => entry.name !== key)
    if (kept.length === entries.length) return
    await this.writeEphemeral(cwd, kept)
  }

  /** Parse `## key` sections of the ephemeral notes file. */
  private parseNotes(text: string): NoteEntry[] {
    const entries: NoteEntry[] = []
    let key: string | undefined
    let body: string[] = []
    const flush = (): void => {
      if (key !== undefined) {
        const content = body.join('\n').trim()
        if (content !== '') {
          entries.push({ name: key, summary: content.split('\n')[0]!.slice(0, 80), content })
        }
      }
      body = []
    }
    for (const line of text.split('\n')) {
      if (line.startsWith('## ')) {
        flush()
        key = line.slice(3).trim()
      } else {
        body.push(line)
      }
    }
    flush()
    return entries
  }

  /** Settle short-term notes into a long-term memory file (harvest), then clear the notes.
   * The model calls this when wrapping up: working state becomes durable memory
   * the next session can read, and the bounded note store stays fresh. */
  async harvest(cwd: string, name: string): Promise<string> {
    if (!NAME_PATTERN.test(name)) throw new Error(`memory name must match ${NAME_PATTERN.source}`)
    const notes = await this.readEphemeral(cwd)
    if (notes.length === 0) throw new Error('no notes to harvest in this workspace')
    const blocks = notes
      .map(note => `### ${note.name}\n\n${note.content}`)
      .join('\n\n')
    const dir = this.workspaceDir(cwd)
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${name}.md`)
    const summary = extractSummary(blocks)
    const existing = (await this.readIfExists(file)) ?? ''
    const content = existing === '' ? blocks : `${existing.trimEnd()}\n\n${blocks}\n`
    await writeFile(file, content, 'utf8')
    const indexFile = join(dir, MEMORY_INDEX)
    const index = (await this.readIfExists(indexFile)) ?? ''
    const line = `- [${name}](${name}.md) — ${summary}`
    const kept = index.split('\n').filter(existingLine => !existingLine.startsWith(`- [${name}]`))
    kept.push(line)
    const next = `${kept.filter(line => line.trim() !== '').join('\n')}\n`
    await writeFile(indexFile, next, 'utf8')
    await this.writeEphemeral(cwd, [])
    this.cacheWorkspaceIndex(cwd, next)
    return file
  }

  private async readEphemeral(cwd: string): Promise<NoteEntry[]> {
    const text = await this.readIfExists(join(this.workspaceDir(cwd), EPHEMERAL_FILE))
    return text === null ? [] : this.parseNotes(text)
  }

  private notesToText(entries: readonly NoteEntry[]): string {
    return `${entries.map(entry => `## ${entry.name}\n${entry.content}`).join('\n\n')}\n`
  }

  private async writeEphemeral(cwd: string, entries: readonly NoteEntry[]): Promise<void> {
    const dir = this.workspaceDir(cwd)
    await mkdir(dir, { recursive: true })
    const text = entries.length === 0 ? '' : this.notesToText(entries)
    await writeFile(join(dir, EPHEMERAL_FILE), text, 'utf8')
    this.cacheWorkspaceNotes(cwd, text)
  }

  /** 写入工作区索引缓存;超过上限时淘汰最旧(防 cwd 字符串无限增长)。 */
  private cacheWorkspaceIndex(cwd: string, text: string): void {
    MemoryService.lruSet(this.cachedIndex, workspaceKey(cwd), text)
  }

  /** 写入工作区便签缓存(同上限纪律)。 */
  private cacheWorkspaceNotes(cwd: string, text: string): void {
    MemoryService.lruSet(this.cachedNotes, workspaceKey(cwd), text)
  }

  private static lruSet(map: Map<string, string>, key: string, value: string): void {
    if (!map.has(key) && map.size >= MemoryService.INDEX_CACHE_MAX) {
      const oldest = map.keys().next().value as string
      map.delete(oldest)
    }
    map.set(key, value)
  }
}
