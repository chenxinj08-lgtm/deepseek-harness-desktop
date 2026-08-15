import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalFileId } from '../src/protocol.ts'
import { LocalFileService } from '../src/service.ts'
import { applyLocalFileTools } from '../src/tools.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('local-file tools', () => {
  it('exposes a bounded byte window for the binary fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-local-file-tools-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const files = new LocalFileService(ctx, { storageRoot: join(root, 'store'), maxFileBytes: 1024 })
    await files.initialize()
    const id = LocalFileId('55555555-5555-4555-8555-555555555555')
    const payload = Buffer.from([0, 1, 2, 3, 4])
    await files.importFile({
      cwd: workspace,
      id,
      name: 'sample.bin',
      mediaType: 'application/octet-stream',
      expectedSize: payload.byteLength,
      body: Readable.from(payload),
    })
    applyLocalFileTools(ctx, files, {
      maxReadRecords: 20,
      maxReadBytes: 4096,
      maxBinaryReadBytes: 3,
      maxRecordChars: 100,
      maxSearchMatches: 10,
      maxSearchExcerptChars: 80,
    })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'call-1' as never,
      name: 'local_file_read_bytes',
      arguments: { file_id: id, offset: 1, length: 3, encoding: 'hex' },
      agent: { session: { header: { cwd: workspace } } } as never,
    })

    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ offset: 1, bytes_read: 3, next_offset: 4, data: '010203' })
    expect(result.content).toHaveLength(1)
    const block = result.content[0]
    expect(block?.type).toBe('text')
    if (block?.type !== 'text') throw new Error('expected a text tool result')
    expect(block.text).toContain('encoding="hex">\n010203\n</local_file_bytes>')
    const prompt = await ctx.systemPrompt.assemble()
    expect(prompt.sections.map(section => section.text).join('\n')).toContain('local_file_read_bytes')
  })
})
