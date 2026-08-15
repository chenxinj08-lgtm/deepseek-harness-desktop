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

describe('MemoryService ephemeral notes', () => {
  it('noteSet upserts by key, noteClear removes, and the snapshot refreshes', async () => {
    const { memory } = await service()
    await memory.initialize('/ws/n')
    await memory.noteSet('/ws/n', 'task', '当前任务:记忆分层')
    await memory.noteSet('/ws/n', 'task', '当前任务:记忆分层实现')
    await memory.noteSet('/ws/n', 'decision', '采用 Hermes 双文件')
    const notes = await memory.listNotes('/ws/n')
    expect(notes).toHaveLength(2)
    expect(notes.find(note => note.name === 'task')?.content).toBe('当前任务:记忆分层实现')
    expect(memory.workspaceNotesSnapshot('/ws/n')).toContain('## decision')
    await memory.noteClear('/ws/n', 'decision')
    expect(await memory.listNotes('/ws/n')).toHaveLength(1)
    expect(memory.workspaceNotesSnapshot('/ws/n')).not.toContain('decision')
  })

  it('noteSet bounds the store (8 entries, 1 KiB each) and keeps the newest', async () => {
    const { memory } = await service()
    await memory.initialize('/ws/n2')
    for (let i = 0; i < 12; i++) await memory.noteSet('/ws/n2', `k${i}`, `v${i}`)
    const notes = await memory.listNotes('/ws/n2')
    expect(notes).toHaveLength(8)
    expect(notes[0]?.name).toBe('k4')
    expect(notes[7]?.name).toBe('k11')
    await expect(memory.noteSet('/ws/n2', 'big', 'x'.repeat(2048))).rejects.toThrow(/exceeds/)
  })

  it('notes never enter the long-term index', async () => {
    const { memory } = await service()
    await memory.initialize('/ws/n3')
    await memory.noteSet('/ws/n3', 'todo', '重构抽帧方案')
    expect((await memory.list('/ws/n3')).workspace).toHaveLength(0)
    expect(memory.workspaceIndexSnapshot('/ws/n3')).toBe('')
  })
})

describe('MemoryService delete', () => {
  it('remove deletes the file and its index line for workspace and global memories', async () => {
    const { memory } = await service()
    await memory.add('/ws/e', 'dep', '删除测试')
    await memory.add(undefined, 'gdep', '全局删除测试')
    await memory.remove('/ws/e', 'dep')
    expect(await memory.read('/ws/e', 'dep')).toBeNull()
    expect((await memory.read('/ws/e', 'MEMORY'))).not.toContain('- [dep]')
    await memory.remove('/ws/e', 'gdep')
    expect(await memory.read('/ws/e', 'gdep')).toBeNull()
    expect(memory.globalIndexSnapshot()).not.toContain('- [gdep]')
    await expect(memory.remove('/ws/e', 'missing')).rejects.toThrow(/not found/)
  })
})
