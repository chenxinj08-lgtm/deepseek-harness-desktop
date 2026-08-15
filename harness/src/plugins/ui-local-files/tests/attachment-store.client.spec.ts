/** Independent attachment state: staged cards, no draft placeholder, submit serialization. */
import { describe, expect, it } from 'vitest'
import {
  clearAllRefs, hasStaged, markFailedAndDrop, markReady, refsOf, removeRef, stageRef, takeAllIds,
} from '../src/client/attachment-store.ts'

const SESSION = '11111111-1111-4111-8111-111111111111' as never

function staged(id: string, name: string): Parameters<typeof stageRef>[1] {
  return {
    id,
    name,
    size: 123456,
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    status: 'pending',
    promise: Promise.resolve(id),
    abort: () => {},
  }
}

describe('independent local-file attachment state', () => {
  it('stages uploads as dock cards without touching any draft text', () => {
    clearAllRefs()
    stageRef(SESSION, staged('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '数据.xlsx'))
    const refs = refsOf(SESSION)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.name).toBe('数据.xlsx')
    expect(refs[0]!.status).toBe('pending')
    // The attachment lives in the independent store; the draft never receives
    // a U+FFFC placeholder or a chip token.
    expect(JSON.stringify(refs)).not.toContain('\uFFFC')
    expect(JSON.stringify(refs)).not.toContain('@local-file')
  })

  it('marks an upload ready and emits structured ids at submit', async () => {
    clearAllRefs()
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    stageRef(SESSION, staged(id, '报告.docx'))
    markReady(SESSION, id)
    const refs = refsOf(SESSION)
    expect(refs[0]!.status).toBe('ready')

    // Submit path: collect every staged id as structured blocks; the draft
    // text stays untouched.
    const { ids } = takeAllIds(SESSION)
    const resolved = await ids
    expect(resolved).toEqual([id])
    // The staged set is consumed by the submit, mirroring the send-content-inject hook.
    expect(hasStaged(SESSION)).toBe(false)
    clearAllRefs()
  })

  it('removes a staged card without affecting other attachments', () => {
    clearAllRefs()
    stageRef(SESSION, staged('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'a.csv'))
    stageRef(SESSION, staged('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'b.txt'))
    removeRef(SESSION, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    const refs = refsOf(SESSION)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.name).toBe('b.txt')
    clearAllRefs()
  })

  it('drops failed uploads and notifies via the store transition', () => {
    clearAllRefs()
    const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    stageRef(SESSION, staged(id, 'broken.bin'))
    markFailedAndDrop(SESSION, id)
    expect(hasStaged(SESSION)).toBe(false)
    clearAllRefs()
  })
})
