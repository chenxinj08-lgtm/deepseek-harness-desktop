import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalFileId } from '../src/protocol.ts'
import { LocalFileService } from '../src/service.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-file-service-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('local-file service', () => {
  it('commits a streamed payload and workspace-scoped metadata atomically', async () => {
    const root = await temporaryRoot()
    const workspace = join(root, 'workspace')
    const storageRoot = join(root, 'store')
    await mkdir(workspace)
    const service = new LocalFileService(new Context(), {
      storageRoot,
      maxFileBytes: 1024,
    })
    await service.initialize()
    const bytes = Buffer.from('alpha\nbeta\n')
    const id = LocalFileId('11111111-1111-4111-8111-111111111111')

    await expect(service.importFile({
      cwd: workspace,
      id,
      name: '../unsafe/name.txt',
      mediaType: 'text/plain; charset=utf-8',
      expectedSize: bytes.byteLength,
      body: Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]),
    })).resolves.toEqual({
      id,
      name: '.._unsafe_name.txt',
      size: bytes.byteLength,
      mediaType: 'text/plain',
      kind: 'text',
    })

    const stored = await service.get(workspace, id)
    expect(basename(stored.payloadPath)).toBe('payload')
    expect(stored.metadata.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(await readFile(stored.payloadPath)).toEqual(bytes)
    if (process.platform !== 'win32') {
      expect((await stat(stored.payloadPath)).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects mismatched sizes and removes the partial object', async () => {
    const root = await temporaryRoot()
    const workspace = join(root, 'workspace')
    const storageRoot = join(root, 'store')
    await mkdir(workspace)
    const service = new LocalFileService(new Context(), {
      storageRoot,
      maxFileBytes: 1024,
    })
    await service.initialize()
    const id = LocalFileId('22222222-2222-4222-8222-222222222222')

    await expect(service.importFile({
      cwd: workspace,
      id,
      name: 'sample.txt',
      mediaType: 'text/plain',
      expectedSize: 99,
      body: Readable.from(['short']),
    })).rejects.toMatchObject({ code: 'FILE_SIZE_MISMATCH' })
    await expect(service.get(workspace, id)).rejects.toMatchObject({ code: 'LOCAL_FILE_NOT_FOUND' })
  })

  it('accepts unknown and extensionless formats with a binary fallback', async () => {
    const root = await temporaryRoot()
    const workspace = join(root, 'workspace')
    const storageRoot = join(root, 'store')
    await mkdir(workspace)
    const service = new LocalFileService(new Context(), { storageRoot, maxFileBytes: 64 * 1024 })
    await service.initialize()
    const id = LocalFileId('33333333-3333-4333-8333-333333333333')
    const bytes = Buffer.from('%PDF-1.7\nopaque test payload')

    await expect(service.importFile({
      cwd: workspace,
      id,
      name: 'extensionless',
      mediaType: 'application/pdf',
      expectedSize: bytes.byteLength,
      body: Readable.from(bytes),
    })).resolves.toMatchObject({ id, name: 'extensionless', kind: 'binary' })
    await expect(readFile((await service.get(workspace, id)).payloadPath)).resolves.toEqual(bytes)

    const textId = LocalFileId('44444444-4444-4444-8444-444444444444')
    const text = Buffer.concat([Buffer.alloc(16 * 1024 - 1, 0x61), Buffer.from('你')])
    await expect(service.importFile({
      cwd: workspace,
      id: textId,
      name: 'source.custom',
      mediaType: 'application/octet-stream',
      expectedSize: text.byteLength,
      body: Readable.from(text),
    })).resolves.toMatchObject({ id: textId, kind: 'text' })
  })
})
