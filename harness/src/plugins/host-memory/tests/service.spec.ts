import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemoryService } from '../src/service.ts'

async function service(): Promise<{ memory: MemoryService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  const memory = new MemoryService(new Context(), { storageRoot: root })
  return { memory, root }
}

describe('MemoryService', () => {
  it('add writes a file and maintains a single idempotent index line', async () => {
    const { memory } = await service()
    await memory.add('/ws/a', 'deploy', '部署 staging:`pnpm build`')
    await memory.add('/ws/a', 'deploy', '部署 staging:`pnpm build && pnpm deploy`')
    expect((await memory.read('/ws/a', 'deploy'))).toContain('pnpm deploy')
    const index = await memory.read('/ws/a', 'MEMORY')
    expect(index?.split('\n').filter(l => l.startsWith('- [deploy]')).length).toBe(1)
  })

  it('search finds workspace matches (pref.md) without leaking global MEMORY.md ordering', async () => {
    const { memory } = await service()
    await memory.add('/ws/b', 'pref', '用户喜欢中文回答')
    await memory.add(undefined, 'global', '全局:喜欢极短代码')
    const hits = await memory.search('/ws/b', '喜欢')
    const files = hits.map(hit => hit.file)
    expect(files).toContain('pref.md')
    expect(files).toContain('global.md')
  })

  it('read prefers workspace file and rejects invalid or missing names', async () => {
    const { memory } = await service()
    await memory.add('/ws/c', 'fact', '项目用 pnpm workspace')
    expect((await memory.read('/ws/c', 'fact'))).toContain('pnpm')
    expect(await memory.read('/ws/c', '../secret')).toBeNull()
    expect(await memory.read('/ws/c', 'missing')).toBeNull()
  })
})

describe('MemoryService injection cache', () => {
  it('add refreshes the snapshot so a new memory is visible without restart', async () => {
    const { memory } = await service()
    await memory.initialize('/ws/d')
    expect(memory.workspaceIndexSnapshot('/ws/d')).toBe('')
    await memory.add('/ws/d', 'note', '记住:部署后要验证健康检查')
    expect(memory.workspaceIndexSnapshot('/ws/d')).toContain('- [note]')
    await memory.add(undefined, 'pref2', '偏好:中文回答')
    expect(memory.globalIndexSnapshot()).toContain('- [pref2]')
  })
})
