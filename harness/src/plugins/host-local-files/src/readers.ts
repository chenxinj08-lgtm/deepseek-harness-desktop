/** Constant-memory readers for text, delimited tables, XLSX rows, and DOCX paragraphs. */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { TextDecoder } from 'node:util'
import { parse } from 'csv-parse'
import ExcelJS from 'exceljs'
import { SaxesParser } from 'saxes'
import yauzl from 'yauzl'
import type { Entry, ZipFile } from 'yauzl'
import type { Readable } from 'node:stream'
import type { LocalFileRecord } from './protocol.ts'

/** One semantic record exposed to read/search windowing. */
export interface LocalFileTextRecord {
  readonly index: number
  readonly sheet?: string
  readonly text: string
}

/** Reader controls shared by every file family. */
export interface IterateOptions {
  readonly signal: AbortSignal
  readonly sheet?: string
  readonly onSheet?: (name: string) => void
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}

async function* iterateText(record: LocalFileRecord, signal: AbortSignal): AsyncGenerator<LocalFileTextRecord> {
  const stream = createReadStream(record.payloadPath, { encoding: 'utf8', signal })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let index = 0
  try {
    for await (const raw of lines) {
      throwIfAborted(signal)
      index += 1
      const text = index === 1 ? raw.replace(/^\uFEFF/u, '') : raw
      yield { index, text }
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

async function* iterateDelimited(record: LocalFileRecord, signal: AbortSignal): AsyncGenerator<LocalFileTextRecord> {
  const delimiter = record.metadata.extension === '.tsv' ? '\t' : ','
  const input = createReadStream(record.payloadPath, { signal })
  const parser = input.pipe(parse({
    bom: true,
    delimiter,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
  }))
  let index = 0
  try {
    for await (const value of parser) {
      throwIfAborted(signal)
      index += 1
      const fields = Array.isArray(value) ? value : [value]
      yield { index, text: fields.map(field => String(field)).join('\t') }
    }
  } finally {
    parser.destroy()
    input.destroy()
  }
}

function rowText(row: ExcelJS.Row): string {
  const values: string[] = []
  row.eachCell({ includeEmpty: true }, (cell, column) => {
    values[column - 1] = cell.text
  })
  for (let index = 0; index < values.length; index += 1) values[index] ??= ''
  return values.join('\t')
}

async function* iterateXlsx(record: LocalFileRecord, options: IterateOptions): AsyncGenerator<LocalFileTextRecord> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(record.payloadPath, {
    entries: 'emit',
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    worksheets: 'emit',
  })
  for await (const worksheet of workbook) {
    throwIfAborted(options.signal)
    // ExcelJS exposes this runtime field but omits it from WorksheetReader's declaration.
    const sheetName = (worksheet as ExcelJS.stream.xlsx.WorksheetReader & { name: string }).name
    options.onSheet?.(sheetName)
    const selected = options.sheet === undefined || sheetName === options.sheet
    for await (const row of worksheet) {
      throwIfAborted(options.signal)
      if (selected) yield { index: row.number, sheet: sheetName, text: rowText(row) }
    }
  }
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { autoClose: true, lazyEntries: true }, (error, zip) => {
      if (error !== null) reject(error)
      else resolve(zip)
    })
  })
}

function openEntry(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) reject(error)
      else resolve(stream)
    })
  })
}

async function openDocumentXml(path: string, signal: AbortSignal): Promise<{ zip: ZipFile; stream: Readable }> {
  const zip = await openZip(path)
  return await new Promise((resolve, reject) => {
    const abort = (): void => {
      zip.close()
      reject(abortError(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
    zip.once('error', reject)
    zip.once('end', () => { reject(new Error('DOCX does not contain word/document.xml')) })
    zip.on('entry', (entry: Entry) => {
      if (entry.fileName !== 'word/document.xml') {
        zip.readEntry()
        return
      }
      openEntry(zip, entry).then(
        (stream) => {
          signal.removeEventListener('abort', abort)
          resolve({ zip, stream })
        },
        reject,
      )
    })
    zip.readEntry()
  })
}

async function* iterateDocx(record: LocalFileRecord, signal: AbortSignal): AsyncGenerator<LocalFileTextRecord> {
  const { zip, stream } = await openDocumentXml(record.payloadPath, signal)
  const decoder = new TextDecoder('utf-8')
  const paragraphs: string[] = []
  let paragraph = ''
  let inParagraph = false
  let inText = false
  let index = 0
  const parser = new SaxesParser({ xmlns: false })
  parser.on('opentag', (tag) => {
    if (tag.name === 'w:p') {
      paragraph = ''
      inParagraph = true
    } else if (inParagraph && tag.name === 'w:t') {
      inText = true
    } else if (inParagraph && tag.name === 'w:tab') {
      paragraph += '\t'
    } else if (inParagraph && (tag.name === 'w:br' || tag.name === 'w:cr')) {
      paragraph += '\n'
    }
  })
  parser.on('text', (text) => {
    if (inParagraph && inText) paragraph += text
  })
  parser.on('closetag', (tag) => {
    if (tag.name === 'w:t') inText = false
    if (tag.name === 'w:p') {
      paragraphs.push(paragraph)
      paragraph = ''
      inParagraph = false
      inText = false
    }
  })
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal)
      parser.write(decoder.decode(chunk as Buffer, { stream: true }))
      while (paragraphs.length > 0) {
        const text = paragraphs.shift()
        if (text === undefined) break
        index += 1
        yield { index, text }
      }
    }
    parser.write(decoder.decode())
    parser.close()
    while (paragraphs.length > 0) {
      const text = paragraphs.shift()
      if (text === undefined) break
      index += 1
      yield { index, text }
    }
  } finally {
    stream.destroy()
    zip.close()
  }
}

/**
 * Iterate logical records without materializing the complete file.
 * @param record - resolved immutable local-file payload.
 * @param options - cancellation, sheet selection, and sheet observation.
 * @returns lazy logical-record stream.
 */
export function iterateLocalFile(
  record: LocalFileRecord,
  options: IterateOptions,
): AsyncGenerator<LocalFileTextRecord> {
  switch (record.metadata.kind) {
    case 'text': return iterateText(record, options.signal)
    case 'csv': return iterateDelimited(record, options.signal)
    case 'xlsx': return iterateXlsx(record, options)
    case 'docx': return iterateDocx(record, options.signal)
    case 'binary': throw new Error('binary files do not have logical text records; use local_file_read_bytes')
  }
}

/**
 * Enumerate XLSX sheet names using the same streaming reader.
 * @param record - resolved immutable local-file payload.
 * @param signal - cancellation signal.
 * @returns workbook sheet names in file order, or an empty list for non-XLSX files.
 */
export async function listWorkbookSheets(record: LocalFileRecord, signal: AbortSignal): Promise<string[]> {
  if (record.metadata.kind !== 'xlsx') return []
  const sheets: string[] = []
  for await (const row of iterateXlsx(record, {
    signal,
    sheet: '\u0000',
    onSheet: (name) => { sheets.push(name) },
  })) {
    // No rows are yielded because the impossible sheet name is selected.
    void row
  }
  return sheets
}
