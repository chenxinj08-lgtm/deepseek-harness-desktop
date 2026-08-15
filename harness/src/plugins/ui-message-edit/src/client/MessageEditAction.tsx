/**
 * Edit action for a sent user message (Codex-style): a pencil button in the
 * action strip. Clicking emits the inline-edit open event; the ui-conversation
 * renderer then replaces the message bubble with an in-place editor.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconEditOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './MessageEditAction.module.css'

/** The edit entry's injected business face (the apply closure owns the emit). */
export interface MessageEditInjected {
  /** Open the inline editor for one user message. */
  openEdit: (messageSeq: number, text: string, content: readonly unknown[], isFirst: boolean) => void
}

/** Full props: runtime seat (owner passes messageSeq/text/content) + injected verb. */
export type MessageEditActionProps =
  PropsRuntime<'conversation.chat.user-actions'>
  & MessageEditInjected

/**
 * Render the edit entry.
 * @param props - the addressed message plus the injected open verb.
 * @returns the pencil button; nothing when the message has no plain text to edit.
 */
export function MessageEditAction({ messageSeq, text, content, isFirst, openEdit }: MessageEditActionProps) {
  // Attachment-only messages have no plain text to edit.
  if (text.trim() === '') return null
  return (
    <Tooltip label="编辑这条消息" side="bottom">
      <button
        type="button"
        className={css.action}
        aria-label="编辑这条消息"
        onClick={() => { openEdit(messageSeq, text, content, isFirst) }}
      >
        <IconEditOutline16 />
      </button>
    </Tooltip>
  )
}
