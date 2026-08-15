/** Model-facing inspect, paged record/byte read, and bounded search consumers. */
import { open } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LocalFileRecord } from './protocol.ts'
import { iterateLocalFile, listWorkbookSheets, type LocalFileTextRecord } from './readers.ts'
import { LocalFileService } from './service.ts'

/** Model-facing output caps after config defaults are applied. */
export interface LocalFileToolCaps {
  readonly maxReadRecords: number
  readonly maxReadBytes: number
  readonly maxBinaryReadBytes: number
  readonly maxRecordChars: number
  readonly maxSearchMatches: number
  readonly maxSearchExcerptChars: number
}

function positiveInteger(value: number | undefined, fallback: number, name: string, max: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`)
  if (resolved > max) throw new Error(`${name} must be less than or equal to ${String(max)}`)
  return resolved
}

function nonEmpty(value: string, name: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error(`${name} must be non-empty`)
  return trimmed
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function callingWorkspace(exec: { agent?: { session: { header: { cwd?: string } } } }): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) throw new Error('local-file tools require an agent session with a workspace')
  return cwd
}

async function resolveRecord(
  files: LocalFileService,
  fileId: string,
  exec: { agent?: { session: { header: { cwd?: string } } } },
): Promise<LocalFileRecord> {
  return await files.get(callingWorkspace(exec), files.parseId(fileId))
}

function truncateChars(value: string, max: number): { text: string; truncated: boolean } {
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
    item => item.segment,
  )
  if (graphemes.length <= max) return { text: value, truncated: false }
  return { text: `${graphemes.slice(0, max).join('')} … [record truncated]`, truncated: true }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

function recordLabel(record: LocalFileTextRecord): string {
  return record.sheet === undefined ? String(record.index) : `${record.sheet}!${String(record.index)}`
}

function renderInspect(value: {
  file_id: string
  name: string
  kind: string
  size_bytes: number
  media_type: string
  sha256: string
  readable: boolean
  sheets?: readonly string[]
}): string {
  return [
    `<local_file id="${value.file_id}">`,
    `name: ${value.name}`,
    `kind: ${value.kind}`,
    `size_bytes: ${String(value.size_bytes)}`,
    `media_type: ${value.media_type}`,
    `sha256: ${value.sha256}`,
    `text_reader: ${String(value.readable)}`,
    ...(value.sheets === undefined ? [] : [`sheets: ${value.sheets.join(', ')}`]),
    '</local_file>',
  ].join('\n')
}

/**
 * Register bounded local-file inspection, record, byte, and search tools.
 * @param ctx - plugin context owning tool and prompt registrations.
 * @param files - workspace-scoped local-file service.
 * @param caps - validated model-facing result limits.
 */
export function applyLocalFileTools(ctx: Context, files: LocalFileService, caps: LocalFileToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:local-files',
    order: 103,
    text: 'A user message may contain <local_file> references. Use local_file_inspect first. Use local_file_read or local_file_search for supported text, CSV, XLSX, and DOCX content; use local_file_read_bytes only for a bounded byte window of other formats. Continue with next_start or next_offset when more data is needed. Do not claim to have reviewed the complete file unless the paged operation reached its end marker.',
  })

  ctx.tools.register(defineTool({
    name: 'local_file_inspect',
    description: 'Inspect one locally imported file without placing its complete contents in model context.',
    parameters: {
      file_id: { type: 'string', required: true, description: 'UUID from a <local_file> reference.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: ['text', 'csv', 'xlsx', 'docx', 'binary'] },
          size_bytes: { type: 'integer', required: true },
          media_type: { type: 'string', required: true },
          sha256: { type: 'string', required: true },
          readable: { type: 'boolean', required: true },
          sheets: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderInspect(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const record = await resolveRecord(files, args.file_id, exec)
      const sheets = record.metadata.kind === 'xlsx'
        ? await listWorkbookSheets(record, exec.signal)
        : undefined
      return {
        file_id: record.metadata.id,
        name: record.metadata.name,
        kind: record.metadata.kind,
        size_bytes: record.metadata.size,
        media_type: record.metadata.mediaType,
        sha256: record.metadata.sha256,
        readable: record.metadata.kind !== 'binary',
        ...sheets === undefined ? {} : { sheets },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'local_file_read',
    description: 'Read a bounded, paginated record window from a local XLSX, DOCX, CSV, TSV, or text file.',
    parameters: {
      file_id: { type: 'string', required: true, description: 'UUID from a <local_file> reference.' },
      sheet: { type: 'string', description: 'Exact XLSX sheet name. Omit to read sheets in workbook order.' },
      start: { type: 'number', description: '1-based logical record position. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum records. Defaults to and cannot exceed ${String(caps.maxReadRecords)}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: ['text', 'csv', 'xlsx', 'docx', 'binary'] },
          sheet: { type: 'string' },
          start: { type: 'integer', required: true },
          count: { type: 'integer', required: true },
          next_start: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          truncated: { type: 'boolean', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const header = `<local_file id="${value.file_id}" name="${value.name}" start="${String(value.start)}" next_start="${String(value.next_start)}">\n`
        const footer = '\n</local_file>'
        const bodyBudget = Math.max(0, caps.maxReadBytes - Buffer.byteLength(header + footer, 'utf8'))
        return [{ type: 'text', text: `${header}${truncateUtf8(value.content, bodyBudget)}${footer}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const start = positiveInteger(args.start, 1, 'start', Number.MAX_SAFE_INTEGER)
      const limit = positiveInteger(args.limit, caps.maxReadRecords, 'limit', caps.maxReadRecords)
      const sheet = args.sheet === undefined ? undefined : nonEmpty(args.sheet, 'sheet')
      const record = await resolveRecord(files, args.file_id, exec)
      if (record.metadata.kind === 'binary') {
        throw new Error('this format has no text reader; use local_file_read_bytes for a bounded byte window')
      }
      if (sheet !== undefined && record.metadata.kind !== 'xlsx') {
        throw new Error('sheet is valid only for XLSX files')
      }
      const lines: string[] = []
      let bytesUsed = 0
      let ordinal = 0
      let nextStart: number | null = null
      let truncated = false
      let sawRequestedSheet = sheet === undefined
      for await (const item of iterateLocalFile(record, {
        signal: exec.signal,
        ...sheet === undefined ? {} : { sheet },
        onSheet: (name) => { if (name === sheet) sawRequestedSheet = true },
      })) {
        ordinal += 1
        if (ordinal < start) continue
        if (lines.length >= limit) {
          nextStart = ordinal
          truncated = true
          break
        }
        const shortened = truncateChars(item.text, caps.maxRecordChars)
        const rendered = `${recordLabel(item)}: ${shortened.text}`
        const renderedBytes = Buffer.byteLength(rendered, 'utf8')
        if (bytesUsed + renderedBytes > caps.maxReadBytes) {
          if (lines.length === 0) {
            lines.push(truncateUtf8(rendered, caps.maxReadBytes))
            nextStart = ordinal + 1
          } else {
            nextStart = ordinal
          }
          truncated = true
          break
        }
        lines.push(rendered)
        bytesUsed += renderedBytes
        truncated ||= shortened.truncated
      }
      if (!sawRequestedSheet) throw new Error(`XLSX sheet was not found: ${sheet ?? ''}`)
      if (ordinal < start && nextStart === null) throw new Error(`start ${String(start)} is past the end of the local file`)
      return {
        file_id: record.metadata.id,
        name: record.metadata.name,
        kind: record.metadata.kind,
        ...sheet === undefined ? {} : { sheet },
        start,
        count: lines.length,
        next_start: nextStart,
        truncated,
        content: lines.join('\n'),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'local_file_read_bytes',
    description: 'Read a bounded raw byte window from any locally imported file as Base64 or hexadecimal.',
    parameters: {
      file_id: { type: 'string', required: true, description: 'UUID from a <local_file> reference.' },
      offset: { type: 'number', description: 'Zero-based byte offset. Defaults to 0.' },
      length: { type: 'number', description: `Maximum raw bytes. Defaults to and cannot exceed ${String(caps.maxBinaryReadBytes)}.` },
      encoding: { type: 'string', enum: ['base64', 'hex'], description: 'Output encoding. Defaults to base64.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          bytes_read: { type: 'integer', required: true },
          next_offset: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          encoding: { type: 'string', required: true, enum: ['base64', 'hex'] },
          data: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `<local_file_bytes id="${value.file_id}" name="${value.name}" offset="${String(value.offset)}" bytes_read="${String(value.bytes_read)}" next_offset="${String(value.next_offset)}" encoding="${value.encoding}">`,
          value.data,
          '</local_file_bytes>',
        ].join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const offset = args.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
      const length = positiveInteger(args.length, caps.maxBinaryReadBytes, 'length', caps.maxBinaryReadBytes)
      const encoding = args.encoding ?? 'base64'
      const record = await resolveRecord(files, args.file_id, exec)
      if (offset > record.metadata.size) throw new Error(`offset ${String(offset)} is past the end of the local file`)
      throwIfAborted(exec.signal)
      const handle = await open(record.payloadPath, 'r')
      try {
        const buffer = Buffer.allocUnsafe(Math.min(length, record.metadata.size - offset))
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset)
        throwIfAborted(exec.signal)
        const next = offset + bytesRead
        return {
          file_id: record.metadata.id,
          name: record.metadata.name,
          offset,
          bytes_read: bytesRead,
          next_offset: next < record.metadata.size ? next : null,
          encoding,
          data: buffer.subarray(0, bytesRead).toString(encoding),
        }
      } finally {
        await handle.close()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'local_file_search',
    description: 'Search a large local XLSX, DOCX, CSV, TSV, or text file without loading it into model context.',
    parameters: {
      file_id: { type: 'string', required: true, description: 'UUID from a <local_file> reference.' },
      query: { type: 'string', required: true, description: 'Literal text to find.' },
      sheet: { type: 'string', description: 'Exact XLSX sheet name. Omit to search every sheet.' },
      case_sensitive: { type: 'boolean', description: 'Use case-sensitive matching. Defaults to false.' },
      max_matches: { type: 'number', description: `Maximum matches. Defaults to and cannot exceed ${String(caps.maxSearchMatches)}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          query: { type: 'string', required: true },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                sheet: { type: 'string' },
                excerpt: { type: 'string', required: true },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `<local_file_search id="${value.file_id}" name="${value.name}" query="${value.query}">`,
          ...value.matches.map(match => `${match.sheet === undefined ? '' : `${match.sheet}!`}${String(match.index)}: ${match.excerpt}`),
          value.truncated ? '(match limit reached; narrow the query or search another sheet)' : '(end of file)',
          '</local_file_search>',
        ].join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = nonEmpty(args.query, 'query')
      const sheet = args.sheet === undefined ? undefined : nonEmpty(args.sheet, 'sheet')
      const maxMatches = positiveInteger(args.max_matches, caps.maxSearchMatches, 'max_matches', caps.maxSearchMatches)
      const caseSensitive = args.case_sensitive ?? false
      const needle = caseSensitive ? query : query.toLocaleLowerCase()
      const record = await resolveRecord(files, args.file_id, exec)
      if (record.metadata.kind === 'binary') {
        throw new Error('this format has no text reader; use local_file_read_bytes for a bounded byte window')
      }
      if (sheet !== undefined && record.metadata.kind !== 'xlsx') {
        throw new Error('sheet is valid only for XLSX files')
      }
      const matches: { index: number; sheet?: string; excerpt: string }[] = []
      let truncated = false
      let sawRequestedSheet = sheet === undefined
      for await (const item of iterateLocalFile(record, {
        signal: exec.signal,
        ...sheet === undefined ? {} : { sheet },
        onSheet: (name) => { if (name === sheet) sawRequestedSheet = true },
      })) {
        const haystack = caseSensitive ? item.text : item.text.toLocaleLowerCase()
        const at = haystack.indexOf(needle)
        if (at < 0) continue
        if (matches.length >= maxMatches) {
          truncated = true
          break
        }
        const half = Math.floor(caps.maxSearchExcerptChars / 2)
        const from = Math.max(0, at - half)
        const to = Math.min(item.text.length, at + query.length + half)
        matches.push({
          index: item.index,
          ...item.sheet === undefined ? {} : { sheet: item.sheet },
          excerpt: `${from > 0 ? '…' : ''}${item.text.slice(from, to)}${to < item.text.length ? '…' : ''}`,
        })
      }
      if (!sawRequestedSheet) throw new Error(`XLSX sheet was not found: ${sheet ?? ''}`)
      return {
        file_id: record.metadata.id,
        name: record.metadata.name,
        query,
        matches,
        truncated,
      }
    },
  }))
}
