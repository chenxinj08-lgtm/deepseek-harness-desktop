/** Independent per-session local-file attachment store (never mirrored into the draft). */
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** One staged local file as seen by the dock cards. */
export interface DraftRef {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly status: 'pending' | 'ready' | 'failed'
  /** Browser object URL for image thumbnails; revoked on remove/clear. */
  readonly previewUrl?: string
}

interface InternalRef extends DraftRef {
  status: 'pending' | 'ready' | 'failed'
  previewUrl?: string
  /** Resolves when the import settles; resolves to the local-file id. */
  promise: Promise<string>
  abort: () => void
}

const drafts = new Map<SessionId, Map<string, InternalRef>>()
// Stable per-session snapshots: useSyncExternalStore's getSnapshot must return
// the same reference until the store actually changes, or React re-renders in
// an infinite loop. Every mutation refreshes the snapshot to a NEW array so
// subscribers see the change exactly once.
const EMPTY_REFS: readonly DraftRef[] = []
const snapshots = new Map<SessionId, readonly DraftRef[]>()

const listeners = new Set<() => void>()
export const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function refresh(sessionId: SessionId): void {
  const store = drafts.get(sessionId)
  snapshots.set(
    sessionId,
    store === undefined || store.size === 0 ? EMPTY_REFS : [...store.values()],
  )
  for (const listener of [...listeners]) listener()
}

function revoke(entry: InternalRef): void {
  if (entry.previewUrl !== undefined) URL.revokeObjectURL(entry.previewUrl)
}

export function refsOf(sessionId: SessionId): readonly DraftRef[] {
  return snapshots.get(sessionId) ?? EMPTY_REFS
}

export function removeRef(sessionId: SessionId, id: string): void {
  const refs = drafts.get(sessionId)
  if (refs === undefined) return
  const entry = refs.get(id)
  if (entry === undefined) return
  if (entry.status === 'pending') entry.abort()
  revoke(entry)
  refs.delete(id)
  if (refs.size === 0) drafts.delete(sessionId)
  refresh(sessionId)
}

export function clearRefs(sessionId: SessionId): void {
  const refs = drafts.get(sessionId)
  if (refs === undefined) return
  for (const entry of refs.values()) {
    entry.abort()
    revoke(entry)
  }
  drafts.delete(sessionId)
  refresh(sessionId)
}

export function stageRef(
  sessionId: SessionId,
  entry: InternalRef,
): void {
  let store = drafts.get(sessionId)
  if (store === undefined) {
    store = new Map()
    drafts.set(sessionId, store)
  }
  store.set(entry.id, entry)
  refresh(sessionId)
}

export function markReady(sessionId: SessionId, id: string): void {
  const store = drafts.get(sessionId)
  const entry = store?.get(id)
  if (entry === undefined) return
  entry.status = 'ready'
  entry.promise = Promise.resolve(id)
  refresh(sessionId)
}

export function markFailedAndDrop(sessionId: SessionId, id: string): void {
  const store = drafts.get(sessionId)
  if (store === undefined) return
  const entry = store.get(id)
  if (entry === undefined) return
  entry.status = 'failed'
  revoke(entry)
  store.delete(id)
  if (store.size === 0) drafts.delete(sessionId)
  refresh(sessionId)
}

/** Consume every staged attachment: wait for imports, return their ids, clear state. */
export function takeAllIds(sessionId: SessionId): { ids: Promise<string[]> } {
  const store = drafts.get(sessionId)
  if (store === undefined) return { ids: Promise.resolve([]) }
  const ids = Promise.all([...store.values()].map(entry => entry.promise))
  drafts.delete(sessionId)
  refresh(sessionId)
  return { ids }
}

export function hasStaged(sessionId: SessionId): boolean {
  const store = drafts.get(sessionId)
  return store !== undefined && store.size > 0
}

/** Whether any session currently has staged local files (composer send enablement). */
export function hasStagedAny(): boolean {
  for (const store of drafts.values()) {
    if (store.size > 0) return true
  }
  return false
}

/** Abort and drop every session's staged attachments (plugin teardown). */
export function clearAllRefs(): void {
  for (const store of drafts.values()) {
    for (const entry of store.values()) {
      entry.abort()
      revoke(entry)
    }
  }
  drafts.clear()
  snapshots.clear()
  for (const listener of [...listeners]) listener()
}
