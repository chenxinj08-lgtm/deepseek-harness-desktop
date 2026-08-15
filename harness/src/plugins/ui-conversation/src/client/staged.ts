/**
 * Cross-plugin staged-attachment presence per session. The local-files plugin
 * broadcasts `local-files/staged-changed` (sessionId, has) over the shared
 * event bus (no value import, preserving the client bundle purity gate); the
 * composer reads it here so Send/Enter become available with files but no
 * text.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Staged local-file presence changed for one session. */
    'local-files/staged-changed'(sessionId: SessionId, present: boolean): void
  }
}

const staged = new Map<string, boolean>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** Subscribe to staged-presence changes. */
export function subscribeStaged(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Whether the given session currently has staged local files. */
export function stagedFor(sessionId: string | undefined): boolean {
  return sessionId === undefined ? false : staged.get(sessionId) === true
}

/** Subscribe to the local-files staged-presence broadcast. */
export function installStagedBridge(ctx: Context): () => void {
  const off = ctx.on('local-files/staged-changed', (sessionId: SessionId, has: boolean) => {
    const next = has === true
    if (staged.get(sessionId) === next) return
    if (next) staged.set(sessionId, true)
    else staged.delete(sessionId)
    notify()
  })
  return off
}
