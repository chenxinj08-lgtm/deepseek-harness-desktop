/** Local-file service: streamed import, atomic commit, and workspace-scoped lookup. */
import { createHash } from 'node:crypto'
import { constants as fsConstants, createWriteStream } from 'node:fs'
import {
  lstat, mkdir, open, readFile, realpath, rename, rmdir, stat, unlink, writeFile,
} from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { Transform } from 'node:stream'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import {
  LOCAL_FILE_METADATA_VERSION, LocalFileId, type LocalFileImportResponse, type LocalFileKind,
  type LocalFileMetadata, type LocalFileRecord,
} from './protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    localFiles: LocalFileService
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const WORKSPACE_KEY_PATTERN = /^[0-9a-f]{32}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const MAX_METADATA_BYTES = 64 * 1024
const MAX_FILE_NAME_CODEPOINTS = 240
const MAX_SNIFF_BYTES = 16 * 1024

/** Config already validated and defaulted by the plugin schema. */
export interface LocalFileServiceConfig {
  readonly storageRoot: string
  readonly maxFileBytes: number
}

/** Stable operational error used by both the route and model-facing tools. */
export class LocalFileError extends Error {
  /** @param code - stable machine-readable failure code. */
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'LocalFileError'
  }
}

interface ImportInput {
  readonly cwd: string
  readonly id: LocalFileId
  readonly name: string
  readonly mediaType: string
  readonly expectedSize: number
  readonly body: Readable
}

const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.conf', '.cpp', '.css', '.go', '.h', '.hpp', '.htm', '.html', '.ini', '.java', '.js', '.json',
  '.jsonl', '.jsx', '.log', '.lua', '.md', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.svg', '.toml', '.ts',
  '.tsx', '.txt', '.xml', '.yaml', '.yml',
])

function startsWith(bytes: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value)
}

function looksLikeUtf8Text(bytes: Buffer): boolean {
  if (bytes.length === 0) return true
  if (bytes.includes(0)) return false
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
  } catch {
    return false
  }
  let controls = 0
  let characters = 0
  for (const character of text) {
    characters += 1
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 && character !== '\n' && character !== '\r' && character !== '\t' && character !== '\f') {
      controls += 1
    }
  }
  return controls <= Math.max(1, Math.floor(characters * 0.01))
}

function hasBinarySignature(bytes: Buffer): boolean {
  return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
    || startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])
    || startsWith(bytes, [0xff, 0xd8, 0xff])
    || startsWith(bytes, [0x47, 0x49, 0x46, 0x38])
    || startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
    || startsWith(bytes, [0x1f, 0x8b])
    || startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
    || startsWith(bytes, [0x52, 0x61, 0x72, 0x21])
    || startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])
    || startsWith(bytes, [0x4d, 0x5a])
    || startsWith(bytes, [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33])
    || bytes.subarray(257, 262).equals(Buffer.from('ustar'))
}

function fileKind(extension: string, mediaType: string, sample: Buffer): LocalFileKind {
  const zip = startsWith(sample, [0x50, 0x4b, 0x03, 0x04])
  if (zip && (extension === '.xlsx'
    || mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) return 'xlsx'
  if (zip && (extension === '.docx'
    || mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')) return 'docx'
  if (zip || hasBinarySignature(sample)) return 'binary'
  const text = looksLikeUtf8Text(sample)
  if (text && (extension === '.csv' || extension === '.tsv'
    || mediaType === 'text/csv' || mediaType === 'text/tab-separated-values')) return 'csv'
  if (text && (mediaType.startsWith('text/') || TEXT_EXTENSIONS.has(extension) || sample.length > 0)) return 'text'
  return 'binary'
}

function sanitizeFileName(input: string): string {
  const replaced = input.normalize('NFC').split('')
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f || character === '/' || character === '\\' ? '_' : character
    })
    .join('')
    .trim()
  const safe = basename(replaced)
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(safe),
    item => item.segment,
  )
  const shortened = graphemes.length > MAX_FILE_NAME_CODEPOINTS
    ? graphemes.slice(0, MAX_FILE_NAME_CODEPOINTS).join('')
    : safe
  if (shortened === '' || shortened === '.' || shortened === '..') {
    throw new LocalFileError('INVALID_FILE_NAME', 'file name is empty after normalization')
  }
  return shortened
}

function parseMetadata(value: unknown, expectedId: LocalFileId, expectedWorkspaceKey: string): LocalFileMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalFileError('CORRUPT_METADATA', 'local file metadata is not an object', 500)
  }
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (record.version !== LOCAL_FILE_METADATA_VERSION
    || record.id !== expectedId
    || record.workspaceKey !== expectedWorkspaceKey
    || typeof record.name !== 'string'
    || typeof record.extension !== 'string'
    || (kind !== 'text' && kind !== 'csv' && kind !== 'xlsx' && kind !== 'docx' && kind !== 'binary')
    || typeof record.mediaType !== 'string'
    || typeof record.size !== 'number'
    || !Number.isSafeInteger(record.size)
    || record.size < 0
    || typeof record.sha256 !== 'string'
    || !SHA256_PATTERN.test(record.sha256)
    || typeof record.importedAt !== 'number'
    || !Number.isSafeInteger(record.importedAt)
    || record.importedAt < 0) {
    throw new LocalFileError('CORRUPT_METADATA', 'local file metadata failed validation', 500)
  }
  return record as unknown as LocalFileMetadata
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Service definition and local provider used by the import route and tool consumer. */
export class LocalFileService extends Service {
  private storageRoot = ''

  /** @param ctx - owning plugin context. */
  constructor(ctx: Context, private readonly config: LocalFileServiceConfig) {
    super(ctx, 'localFiles')
  }

  /** Validate and create the private local store before publishing endpoint behavior. */
  async initialize(): Promise<void> {
    if (!isAbsolute(this.config.storageRoot)) {
      throw new Error(`host-local-files: storageRoot must be absolute, got ${JSON.stringify(this.config.storageRoot)}`)
    }
    await mkdir(this.config.storageRoot, { recursive: true, mode: 0o700 })
    const info = await stat(this.config.storageRoot)
    if (!info.isDirectory()) throw new Error('host-local-files: storageRoot is not a directory')
    this.storageRoot = await realpath(this.config.storageRoot)
  }

  /**
   * Validate an opaque local-file UUID received across HTTP or tool JSON.
   * @param value - untrusted identifier text.
   * @returns normalized branded identity.
   */
  parseId(value: string): LocalFileId {
    const normalized = value.toLowerCase()
    if (!UUID_PATTERN.test(normalized)) {
      throw new LocalFileError('INVALID_FILE_ID', 'file_id must be a UUID')
    }
    return LocalFileId(normalized)
  }

  /**
   * Stream a raw request body into the local store and publish metadata atomically.
   * @param input - workspace, metadata, expected size, and raw byte stream.
   * @returns committed reference metadata for the browser.
   */
  async importFile(input: ImportInput): Promise<LocalFileImportResponse> {
    if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize < 0) {
      throw new LocalFileError('INVALID_FILE_SIZE', 'size must be a non-negative safe integer')
    }
    if (input.expectedSize > this.config.maxFileBytes) {
      throw new LocalFileError(
        'FILE_TOO_LARGE',
        `file exceeds the configured ${String(this.config.maxFileBytes)} byte limit`,
        413,
      )
    }
    const workspaceKey = await this.workspaceKey(input.cwd)
    const name = sanitizeFileName(input.name)
    const extension = extname(name).toLowerCase()
    const mediaType = input.mediaType.trim().toLowerCase().split(';', 1)[0] || 'application/octet-stream'
    const bucket = join(this.storageRoot, workspaceKey)
    await mkdir(bucket, { recursive: true, mode: 0o700 })
    const directory = join(bucket, input.id)
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new LocalFileError('FILE_ID_EXISTS', `local file ${input.id} already exists`, 409)
      }
      throw error
    }

    const payloadPath = join(directory, 'payload')
    const payloadPart = `${payloadPath}.part`
    const metadataPath = join(directory, 'meta.json')
    const metadataPart = `${metadataPath}.part`
    const digest = createHash('sha256')
    let bytes = 0
    const sampleParts: Buffer[] = []
    let sampledBytes = 0
    const meter = new Transform({
      transform: (chunk: Buffer | string, encoding, callback) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
        bytes += data.byteLength
        if (bytes > this.config.maxFileBytes) {
          callback(new LocalFileError(
            'FILE_TOO_LARGE',
            `file exceeds the configured ${String(this.config.maxFileBytes)} byte limit`,
            413,
          ))
          return
        }
        digest.update(data)
        if (sampledBytes < MAX_SNIFF_BYTES) {
          const sample = Buffer.from(data.subarray(0, MAX_SNIFF_BYTES - sampledBytes))
          sampleParts.push(sample)
          sampledBytes += sample.byteLength
        }
        callback(null, data)
      },
    })

    try {
      await pipeline(
        input.body,
        meter,
        createWriteStream(payloadPart, { flags: 'wx', mode: 0o600 }),
      )
      if (bytes !== input.expectedSize) {
        throw new LocalFileError(
          'FILE_SIZE_MISMATCH',
          `received ${String(bytes)} bytes, expected ${String(input.expectedSize)}`,
        )
      }
      await rename(payloadPart, payloadPath)
      const metadata: LocalFileMetadata = {
        version: LOCAL_FILE_METADATA_VERSION,
        id: input.id,
        workspaceKey,
        name,
        extension,
        kind: fileKind(extension, mediaType, Buffer.concat(sampleParts, sampledBytes)),
        mediaType,
        size: bytes,
        sha256: digest.digest('hex'),
        importedAt: Date.now(),
      }
      await writeFile(metadataPart, `${JSON.stringify(metadata)}\n`, { flag: 'wx', mode: 0o600 })
      await rename(metadataPart, metadataPath)
      return { id: metadata.id, name, size: bytes, mediaType, kind: metadata.kind }
    } catch (error) {
      await Promise.allSettled([
        unlinkIfPresent(metadataPart),
        unlinkIfPresent(metadataPath),
        unlinkIfPresent(payloadPart),
        unlinkIfPresent(payloadPath),
      ])
      try {
        await rmdir(directory)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') this.ctx.logger.warn(cleanupError)
      }
      throw error
    }
  }

  /**
   * Resolve one file only within the calling session's canonical workspace.
   * @param cwd - calling session's workspace path.
   * @param id - validated local-file identity.
   * @returns immutable metadata and private payload path.
   */
  async get(cwd: string, id: LocalFileId): Promise<LocalFileRecord> {
    const workspaceKey = await this.workspaceKey(cwd)
    if (!WORKSPACE_KEY_PATTERN.test(workspaceKey)) {
      throw new LocalFileError('INVALID_WORKSPACE_KEY', 'workspace key failed validation', 500)
    }
    const directory = join(this.storageRoot, workspaceKey, id)
    const metadataPath = join(directory, 'meta.json')
    let metadataBytes: Buffer
    try {
      const handle = await open(metadataPath, 'r')
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > MAX_METADATA_BYTES) {
          throw new LocalFileError('CORRUPT_METADATA', 'local file metadata has an invalid size', 500)
        }
        metadataBytes = await readFile(handle)
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new LocalFileError('LOCAL_FILE_NOT_FOUND', `local file ${id} was not found`, 404)
      }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(metadataBytes.toString('utf8'))
    } catch {
      throw new LocalFileError('CORRUPT_METADATA', 'local file metadata is not valid JSON', 500)
    }
    const metadata = parseMetadata(parsed, id, workspaceKey)
    const payloadPath = join(directory, 'payload')
    const payloadInfo = await lstat(payloadPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new LocalFileError('LOCAL_FILE_NOT_FOUND', `payload for local file ${id} was not found`, 404)
      }
      throw error
    })
    if (!payloadInfo.isFile() || payloadInfo.isSymbolicLink() || payloadInfo.size !== metadata.size) {
      throw new LocalFileError('CORRUPT_PAYLOAD', `payload for local file ${id} failed validation`, 500)
    }
    return { metadata, payloadPath }
  }

  /**
   * Read a file's complete payload with integrity re-verification.
   * @param cwd - calling session's workspace path.
   * @param id - validated local-file identity.
   * @returns verified full bytes plus stored media type and display name.
   */
  async readWholeBytes(cwd: string, id: LocalFileId): Promise<{ bytes: Buffer; mediaType: string; name: string }> {
    const record = await this.get(cwd, id)
    // TOCTOU 修复:O_NOFOLLOW 打开 → fstat 校验同一文件身份 → 经 fd 读取,
    // 消除 get() 校验与读取之间路径被替换/符号链接互换的窗口。
    const handle = await open(record.payloadPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    let bytes: Buffer
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size !== record.metadata.size) {
        throw new LocalFileError('CORRUPT_PAYLOAD', `payload for local file ${id} failed validation`, 500)
      }
      bytes = await readFile(handle)
    } finally {
      await handle.close()
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength !== record.metadata.size || digest !== record.metadata.sha256) {
      throw new LocalFileError('CORRUPT_PAYLOAD', `payload for local file ${id} failed validation`, 500)
    }
    return { bytes, mediaType: record.metadata.mediaType, name: record.metadata.name }
  }

  private async workspaceKey(cwd: string): Promise<string> {
    if (!isAbsolute(cwd)) throw new LocalFileError('INVALID_WORKSPACE', 'session workspace must be an absolute path')
    let canonical: string
    try {
      canonical = await realpath(cwd)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new LocalFileError('WORKSPACE_NOT_FOUND', `session workspace no longer exists: ${cwd}`, 404)
      }
      throw error
    }
    return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
  }
}
