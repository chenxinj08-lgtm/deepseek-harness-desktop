import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOCAL_FILE_METADATA_VERSION, LocalFileId, type LocalFileKind, type LocalFileRecord,
} from '../src/protocol.ts'
import { iterateLocalFile, listWorkbookSheets } from '../src/readers.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-file-reader-'))
  roots.push(root)
  return root
}

function record(path: string, kind: LocalFileKind, extension: string): LocalFileRecord {
  return {
    payloadPath: path,
    metadata: {
      version: LOCAL_FILE_METADATA_VERSION,
      id: LocalFileId('11111111-1111-4111-8111-111111111111'),
      workspaceKey: '0'.repeat(32),
      name: `sample${extension}`,
      extension,
      kind,
      mediaType: 'application/octet-stream',
      size: 0,
      sha256: '0'.repeat(64),
      importedAt: 0,
    },
  }
}

async function collect(file: LocalFileRecord, sheet?: string) {
  const values = []
  for await (const value of iterateLocalFile(file, {
    signal: new AbortController().signal,
    ...sheet === undefined ? {} : { sheet },
  })) values.push(value)
  return values
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('streaming local-file readers', () => {
  it('reads BOM text and quoted CSV as logical records', async () => {
    const root = await temporaryRoot()
    const textPath = join(root, 'sample.txt')
    const csvPath = join(root, 'sample.csv')
    await writeFile(textPath, '\uFEFFalpha\nbeta\n')
    await writeFile(csvPath, 'name,note\nAda,"line one\nline two"\n')

    await expect(collect(record(textPath, 'text', '.txt'))).resolves.toEqual([
      { index: 1, text: 'alpha' },
      { index: 2, text: 'beta' },
    ])
    await expect(collect(record(csvPath, 'csv', '.csv'))).resolves.toEqual([
      { index: 1, text: 'name\tnote' },
      { index: 2, text: 'Ada\tline one\nline two' },
    ])
  })

  it('streams XLSX rows and exposes exact sheet names', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'sample.xlsx')
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Summary').addRows([['name', 'value'], ['alpha', 42]])
    workbook.addWorksheet('明细').addRow(['beta', 7])
    await workbook.xlsx.writeFile(path)
    const file = record(path, 'xlsx', '.xlsx')

    await expect(listWorkbookSheets(file, new AbortController().signal)).resolves.toEqual(['Summary', '明细'])
    await expect(collect(file, 'Summary')).resolves.toEqual([
      { index: 1, sheet: 'Summary', text: 'name\tvalue' },
      { index: 2, sheet: 'Summary', text: 'alpha\t42' },
    ])
  })

  it('streams visible DOCX paragraphs without materializing the archive', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'sample.docx')
    const zip = new JSZip()
    zip.file('word/document.xml', [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      '<w:body><w:p><w:r><w:t>A &amp; B</w:t></w:r><w:tab/><w:r><w:t>C</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>next</w:t><w:br/><w:t>line</w:t></w:r></w:p></w:body></w:document>',
    ].join(''))
    await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))

    await expect(collect(record(path, 'docx', '.docx'))).resolves.toEqual([
      { index: 1, text: 'A & B\tC' },
      { index: 2, text: 'next\nline' },
    ])
  })

  it('refuses to interpret the binary fallback as UTF-8 records', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'sample.bin')
    await writeFile(path, Uint8Array.of(0, 1, 2, 3))
    await expect(collect(record(path, 'binary', '.bin'))).rejects.toThrow(/local_file_read_bytes/u)
  })
})
