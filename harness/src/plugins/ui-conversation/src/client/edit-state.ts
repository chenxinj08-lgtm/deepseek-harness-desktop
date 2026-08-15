/**
 * Inline edit state for user messages (Codex-style: the message bubble turns
 * into an editor in place). Module-level store shared by the renderer
 * (UserMessageNodeView reads it) and the event bridge; the ui-message-edit
 * plugin drives it through cordis events, so no cross-package value import is
 * needed. The bridge pattern mirrors staged.ts.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Open the inline editor for one user message (carries text + content for attachment re-send). */
    'conversation/edit-message'(sessionId: SessionId, seq: number, text: string, content: readonly unknown[], isFirst: boolean): void
    /** Save the edited text; content re-sends the kept attachments with it. */
    'conversation/edit-message-save'(sessionId: SessionId, seq: number, text: string, content: readonly unknown[], isFirst: boolean): void
  }
}

/** What the inline editor holds for one message. */
export interface MessageEditState {
  readonly text: string
  readonly content: readonly unknown[]
  readonly isFirst: boolean
}

const states = new Map<string, MessageEditState>()
const listeners = new Set<() => void>()
let emitEditSave: ((sessionId: SessionId, seq: number, text: string, content: readonly unknown[], isFirst: boolean) => Promise<void> | void) | undefined

function keyOf(sessionId: SessionId, seq: number): string {
  return `${sessionId}:${seq}`
}

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** Current edit state for one message, or undefined when not editing. */
export function editingOf(sessionId: SessionId, seq: number): MessageEditState | undefined {
  return states.get(keyOf(sessionId, seq))
}

/** Open the editor (the event bridge calls this). */
export function openEdit(sessionId: SessionId, seq: number, text: string, content: readonly unknown[], isFirst: boolean): void {
  states.set(keyOf(sessionId, seq), { text, content, isFirst })
  notify()
}

/** Close the editor. */
export function closeEdit(sessionId: SessionId, seq: number): void {
  if (states.delete(keyOf(sessionId, seq))) notify()
}

/** Publish a save request (the inline editor's Save calls this). */
export function requestEditSave(sessionId: SessionId, seq: number, text: string, content: readonly unknown[], isFirst: boolean): Promise<void> | void {
  return emitEditSave?.(sessionId, seq, text, content, isFirst)
}

/** Subscribe to edit-state changes. */
export function subscribeEdit(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Wire the bridge on a client context: listen for open requests and publish
 * save requests through the same context's emit.
 * @param ctx - the ui-conversation client context.
 * @returns the disposer.
 */
export function installEditBridge(ctx: Context): () => void {
  const offOpen = (ctx.on as (name: string, listener: (sessionId: SessionId, seq: number, text: string, content: readonly unknown[], isFirst: boolean) => void) => () => void)(
    'conversation/edit-message',
    (sessionId, seq, text, content, isFirst) => { openEdit(sessionId, seq, text, content, isFirst) },
  )
  emitEditSave = (sessionId, seq, text, content, isFirst) => (
    (ctx.emit as (name: string, ...args: unknown[]) => void)(
      'conversation/edit-message-save',
      sessionId, seq, text, content, isFirst,
    )
  )
  return () => {
    offOpen()
    emitEditSave = undefined
  }
}
