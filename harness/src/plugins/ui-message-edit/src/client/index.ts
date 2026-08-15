/**
 * Browser plugin: edit an already-sent user message, Codex-style. The pencil
 * button in the user message's action strip turns the message into an inline
 * editor (the bubble is replaced in place); saving forks a new session
 * anchored at the END of the previous turn (so the edited text replaces the
 * original message rather than appending), re-sends the message's attachments
 * with the edited text, and opens the child session. The original session
 * stays untouched — in-window edit semantics with the branch safety of
 * Claude.ai's "different version of the conversation". Attachment-only
 * messages have no plain text to edit and hide the pencil.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { MessageEditAction, type MessageEditInjected } from './MessageEditAction.tsx'

/** Required client services: slots (action strip), sessions (fork/open/binding). */
export const inject = ['slots', 'sessions']

/** Browser-safe base64 for re-sent image bytes (chunked to avoid stack limits). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Register the edit entry and the save flow. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.chat.user-actions', () => ctx.slots.register({
    name: 'conversation.chat.user-actions',
    id: 'message-edit',
    order: 10,
    inject: (sessionId: SessionId): MessageEditInjected => ({
      openEdit: (messageSeq, text, content, isFirst) => {
        ;(ctx.emit as (name: string, ...args: unknown[]) => void)(
          'conversation/edit-message', sessionId, messageSeq, text, content, isFirst,
        )
      },
    }),
  }, MessageEditAction))

  // Save: re-read image bytes through the source session (the fork shares the
  // same log events and attachment store), re-reference local-file ids, then
  // either fork at the pre-message anchor (non-first messages: the child ends
  // before this message, so the edited text replaces it) or create a blank
  // session in the same workspace (first message: nothing to fork before), and
  // send text + kept attachments into the child.
  ;(ctx.on as (name: string, listener: (
    sourceSessionId: SessionId, seq: number, text: string, content: readonly unknown[], isFirst: boolean,
  ) => unknown) => () => void)('conversation/edit-message-save', async (sourceSessionId, seq, text, content, isFirst) => {
    const source = ctx.sessions.binding(sourceSessionId)?.session
    const parts: unknown[] = []
    for (const block of content) {
      const b = block as {
        type?: string
        attachment?: { attachmentId: string; mediaType: string; name?: string }
        id?: string
      }
      if (b.type === 'image' && b.attachment !== undefined && source !== undefined) {
        const res = await source.readAttachment(
          b.attachment.attachmentId as Parameters<typeof source.readAttachment>[0],
        )
        if (res.ok) {
          parts.push({
            type: 'image',
            mediaType: b.attachment.mediaType,
            data: bytesToBase64(res.value.data),
            ...(b.attachment.name === undefined ? {} : { name: b.attachment.name }),
          })
        }
      } else if (b.type === 'local-file' && typeof b.id === 'string') {
        parts.push({ type: 'local-file', id: b.id })
      }
    }
    parts.push({ type: 'text', text })
    // ISessions' public contract declares fork only; create exists at runtime
    // (the sessions service) but is type-hidden, so it is reached via a
    // narrow cast — first-message edits have no forkable boundary, so a blank
    // session in the same workspace is the only way the edited text replaces
    // the original first message instead of appending.
    const childId = isFirst
      ? await (ctx.sessions as unknown as { create: (opts: { cwd?: string }) => Promise<SessionId> }).create(
          (() => {
            const cwd = ctx.sessions.list.getSnapshot().byId[sourceSessionId]?.cwd
            return cwd === undefined ? {} : { cwd }
          })(),
        )
      : await ctx.sessions.fork({ sessionId: sourceSessionId, atSeq: seq, increaseTitle: true })
    ctx.sessions.open(childId)
    const child = ctx.sessions.binding(childId)?.session
    if (child === undefined) throw new Error('编辑后的会话尚未就绪,请重试')
    await child.prompt(parts as Parameters<typeof child.prompt>[0], 'queue')
  })
}
