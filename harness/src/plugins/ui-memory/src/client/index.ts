/**
 * Browser plugin: the memory management settings row. The row reads the
 * model-facing memory store through the host-memory HTTP endpoints (same
 * same-origin fetch posture as ui-local-files), so the settings surface shows
 * exactly what memory_add wrote — no duplicate state, no drift.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { MemoryRow, type MemoryEntry, type MemoryRowInjected } from './MemoryRow.tsx'
import { MEMORY_LIST_PATH, MEMORY_READ_PATH } from './protocol.ts'

/** Required client services: sessions (current id) and the settings slots. */
export const inject = ['slots', 'sessions']

interface MemoryErrorResponse {
  readonly error?: { readonly message?: unknown }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

async function readError(response: Response, body: unknown): Promise<Error> {
  const envelope = body as MemoryErrorResponse | undefined
  const message = typeof envelope?.error?.message === 'string'
    ? envelope.error.message
    : `HTTP ${String(response.status)}`
  return new Error(message)
}

/** Register the memory management row into the General settings section. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'memory',
    order: 5,
    inject: (): MemoryRowInjected => {
      const current = (): string => {
        const id = ctx.sessions.list.getSnapshot().current
        if (id === undefined) throw new Error('没有当前会话')
        return id
      }
      return {
        list: async () => {
          const url = new URL(MEMORY_LIST_PATH, window.location.origin)
          url.searchParams.set('session_id', current())
          const response = await fetch(url, { method: 'GET', credentials: 'same-origin' })
          const body = await responseJson(response)
          if (!response.ok) throw await readError(response, body)
          return body as { global: readonly MemoryEntry[]; workspace: readonly MemoryEntry[] }
        },
        read: async (name) => {
          const url = new URL(MEMORY_READ_PATH, window.location.origin)
          url.searchParams.set('session_id', current())
          url.searchParams.set('name', name)
          const response = await fetch(url, { method: 'GET', credentials: 'same-origin' })
          const body = await responseJson(response)
          if (!response.ok) throw await readError(response, body)
          const parsed = body as { content?: unknown }
          return typeof parsed.content === 'string' ? parsed.content : ''
        },
      }
    },
  }, MemoryRow))
}
