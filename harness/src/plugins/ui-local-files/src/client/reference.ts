/** Browser-local reference codec and import response validation. */

/** Source name stored on input-machine occurrences. */
export const LOCAL_FILE_SOURCE = 'local-files'
/** Host endpoint; same-origin fetch keeps bytes on the Harness host transport. */
export const LOCAL_FILE_IMPORT_PATH = '/local-files/v1/import'
/** Same-origin download endpoint (GET) for a stored local file. */
export const LOCAL_FILE_DOWNLOAD_PATH = '/local-files/v1/download'

/** Minimal composer reference retained until submit serialization. */
export interface LocalFileReference {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  /** Present after Host sniffing; omitted by an immediately staged browser reference. */
  readonly kind?: 'text' | 'csv' | 'xlsx' | 'docx' | 'binary'
}

function isKind(value: unknown): value is LocalFileReference['kind'] {
  return value === 'text' || value === 'csv' || value === 'xlsx' || value === 'docx' || value === 'binary'
}

/**
 * Validate an untrusted JSON response or occurrence payload.
 * @param value - parsed wire or occurrence value.
 * @returns validated local-file reference.
 */
export function parseLocalFileReference(value: unknown): LocalFileReference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('local file reference is not an object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string'
    || typeof record.name !== 'string'
    || typeof record.size !== 'number'
    || !Number.isSafeInteger(record.size)
    || record.size < 0
    || typeof record.mediaType !== 'string'
    || (record.kind !== undefined && !isKind(record.kind))) {
    throw new Error('local file reference failed validation')
  }
  return record as unknown as LocalFileReference
}

/**
 * Parse one opaque input-machine ref string.
 * @param ref - serialized occurrence reference.
 * @returns validated local-file reference.
 */
export function decodeLocalFileReference(ref: string): LocalFileReference {
  return parseLocalFileReference(JSON.parse(ref))
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Serialize only small metadata; file bytes never enter the prompt.
 * 与宿主 llm/content.ts 的 serializeLocalFileBlock 对齐:标记只带 id 与 media_type,
 * 文件名/大小不经模型上下文(防注入,防格式漂移)。
 * @param ref - serialized occurrence reference.
 * @returns model-facing local-file marker.
 */
export function serializeLocalFileReference(ref: string): string {
  const file = decodeLocalFileReference(ref)
  return `<local_file id="${xml(file.id)}" media_type="${xml(file.mediaType)}" />`
}

/**
 * Produce the human-readable copy projection for one file chip.
 * @param ref - serialized occurrence reference.
 * @returns clipboard-safe identifier text.
 */
export function clipboardLocalFileReference(ref: string): string {
  return `@local-file(${decodeLocalFileReference(ref).id})`
}
