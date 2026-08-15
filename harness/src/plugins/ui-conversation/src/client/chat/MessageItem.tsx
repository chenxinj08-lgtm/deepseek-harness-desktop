// MessageItem: simple chat nodes — user and consumed-steering bubbles
// (right-aligned, with clock + copy IconActions; branch lives only under
// assistant answers), pending steering (copy only), context injection,
// compaction marker, retry disclosure, and unknown-surface JSON rows.

import { memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type {
  ModelRetryNode, TurnErrorNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { Button, JsonBlock, MessageText, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { closeEdit, editingOf, requestEditSave, subscribeEdit, type MessageEditState } from '../edit-state.ts'
import type { ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import { ImageGallery, ImageLightbox, type ImageLoader } from '@deepseek-ai/dsh-client-ui-attachment'
import type { TurnTailChatData } from '../contract/chat-nodes.ts'
import { messageImageLabels } from '../image-labels.ts'
import { CompactionItem } from './CompactionItem.tsx'
import { ContextInjectionRow } from './ContextInjectionRow.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './MessageItem.module.css'

type UserImage = Extract<UserMessageNode['content'][number], { type: 'image' }>
type UserLocalFile = Extract<UserMessageNode['content'][number], { type: 'local-file' }>

/** Historical `<local_file …/>` tag embedded in a text block (pre-structured
 * sessions). Only the exact legacy shape is parsed; anything else stays text. */
interface LegacyLocalFile { id: string; name: string; sizeBytes: number; kind: UserLocalFile['kind']; mediaType?: string }

const LEGACY_LOCAL_FILE_TAG = /<local_file\s+id="([0-9a-f-]+)"\s+name="([^"]*)"\s+size_bytes="(\d+)"\s+kind="([a-z]+)"\s*\/>/gu

function parseLegacyLocalFiles(text: string): { text: string; files: LegacyLocalFile[] } {
  const files: LegacyLocalFile[] = []
  let cleaned = ''
  let last = 0
  for (const match of text.matchAll(LEGACY_LOCAL_FILE_TAG)) {
    cleaned += text.slice(last, match.index)
    files.push({ id: match[1]!, name: match[2]!, sizeBytes: Number(match[3]!), kind: match[4] as UserLocalFile['kind'] })
    last = match.index! + match[0].length
  }
  cleaned += text.slice(last)
  return { text: cleaned, files }
}

function contentParts(content: readonly unknown[]): {
  text: string
  images: { attachment: UserImage['attachment'] }[]
  localFiles: UserLocalFile[]
  legacyLocalFiles: LegacyLocalFile[]
  rest: unknown[]
} {
  const texts: string[] = []
  const images: { attachment: UserImage['attachment'] }[] = []
  const localFiles: UserLocalFile[] = []
  const legacyLocalFiles: LegacyLocalFile[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') {
      const parsed = parseLegacyLocalFiles(b.text)
      texts.push(parsed.text)
      legacyLocalFiles.push(...parsed.files)
    }
    else if (b.type === 'image' && b.attachment !== undefined) {
      images.push({ attachment: (b as UserImage).attachment })
    }
    else if (b.type === 'local-file') {
      localFiles.push(b as UserLocalFile)
    }
    else rest.push(block)
  }
  return { text: texts.join(''), images, localFiles, legacyLocalFiles, rest }
}

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const LOCAL_FILE_ICON: Record<string, string> = {
  xlsx: '▦', docx: '🖹', csv: '📄', text: '📄',
  binary: '📎', default: '📎',
}

/** Inline local-file card: images open an in-app preview, other files render
 * as a plain card (no download). Local bytes stay in the Harness store. */
function LocalFileRow({ file, sessionId, t }: {
  file: Pick<UserLocalFile, 'id' | 'name' | 'sizeBytes' | 'kind'> & { mediaType?: string }
  sessionId: string
  t: ChatViewSlotProps['t']
}): ReactNode {
  const isImage = file.mediaType?.startsWith('image/') ?? false
  const [open, setOpen] = useState(false)
  if (!isImage) {
    return (
      <div className={css.localFileCard} title="本地文件，点击无下载">
        <span className={css.localFileIcon}>{LOCAL_FILE_ICON[file.kind] ?? LOCAL_FILE_ICON.default}</span>
        <span className={css.localFileName}>{file.name}</span>
        <span className={css.localFileMeta}>{formatBytes(file.sizeBytes)}</span>
      </div>
    )
  }
  const previewUrl = useMemo(() => {
    const url = new URL('/local-files/v1/preview', window.location.origin)
    url.searchParams.set('session_id', sessionId)
    url.searchParams.set('file_id', file.id)
    return url.toString()
  }, [sessionId, file.id])
  return (
    <>
      <button type="button" className={css.localImageCard} title="点击预览图片" onClick={() => { setOpen(true) }}>
        <img className={css.localImage} src={previewUrl} alt={file.name} />
        <span className={css.localImageMeta}>{file.name} · {formatBytes(file.sizeBytes)}</span>
      </button>
      {open && <ImageLightbox src={previewUrl} alt={file.name} labels={messageImageLabels(t).lightbox} onClose={() => { setOpen(false) }} />}
    </>
  )
}

interface RetryCountdown {
  deadline: number
  seconds: number
}

function ModelRetryItem({ node, active, t }: {
  node: ModelRetryNode
  active: boolean
  t: ChatViewSlotProps['t']
}) {
  // Anchor the host-scheduled delay to this browser's first render of the
  // retry node. Host event time and Date.now() may belong to different clocks.
  const deadline = useMemo(() => Date.now() + node.delayMs, [node.delayMs, node.seq])
  const scheduledSeconds = retrySeconds(node.delayMs)
  const maximum = node.mode === 'normal' ? node.maxRetries : '∞'
  const [countdown, setCountdown] = useState<RetryCountdown>(() => ({
    deadline,
    seconds: retrySeconds(deadline - Date.now()),
  }))
  const remainingSeconds = countdown.deadline === deadline
    ? countdown.seconds
    : retrySeconds(deadline - Date.now())

  useEffect(() => {
    if (!active) return
    const updateCountdown = (): number => {
      const next = retrySeconds(deadline - Date.now())
      setCountdown(current => (
        current.deadline === deadline && current.seconds === next
          ? current
          : { deadline, seconds: next }
      ))
      return next
    }
    if (updateCountdown() === 1) return
    const timer = window.setInterval(() => {
      if (updateCountdown() === 1) window.clearInterval(timer)
    }, 250)
    return () => { window.clearInterval(timer) }
  }, [active, deadline])

  const label = active
    ? t('message.retry.active')
    : node.retryState === 'cancelled'
      ? t('message.retry.cancelled')
      : node.retryState === 'started'
        ? t('message.retry.started')
        : t('message.retry.scheduled')
  const seconds = active ? remainingSeconds : scheduledSeconds

  return (
    <details className={css.retryRow} data-active={active || undefined}>
      <summary className={css.retrySummary}>
        <span className={css.retryText} role="status">
          {t('message.retry.status', { label, retry: node.retry, maximum, seconds })}
        </span>
      </summary>
      <div className={css.retryDetails}>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.delay')}</span>
          {Math.round(node.delayMs)}ms
        </div>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.failure')}</span>
          {node.failure.message}
        </div>
      </div>
    </details>
  )
}

/** Persistent, turn-positioned feedback for a terminal failure. */
function TurnErrorItem({ node, t }: {
  node: TurnErrorNode
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="error" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.turnErrorTitle}>{t('message.turnError')}</span>
        <span className={css.turnErrorMessage}>{node.message}</span>
      </div>
      {node.code !== undefined && <code className={css.turnErrorCode}>{node.code}</code>}
    </div>
  )
}

/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
function TurnMaxTokensItem({ t }: {
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="warning" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.maxTokensTitle}>{t('message.maxTokens')}</span>
        <span className={css.turnErrorMessage}>{t('message.maxTokens.hint')}</span>
      </div>
    </div>
  )
}

/**
 * Display projection of reference forms in a user bubble (free geometry — no
 * textarea alignment constraint here); everything else stays plain text. The
 * logged model text remains the single truth; this is presentation only.
 * Plain-text `/name` / `@name` word-boundary tokens decorate (the sent text
 * IS the reference — the bubble uses the same plainest token
 * scan as the composer, minus the lexicon: sent tokens were validated at
 * compose time, so shape alone decorates).
 */
function projectUserText(text: string): ReactNode {
  const re = /(^|\s)([/@][\w-]+)(?=\s|$)/g
  const parts: ReactNode[] = []
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + (m[1]?.length ?? 0)
    const label = m[2] ?? ''
    if (tokenStart > cursor) parts.push(<MessageText key={cursor} text={text.slice(cursor, tokenStart)} />)
    parts.push(
      <span key={tokenStart} className={css.refChip} data-ref-chip={label.startsWith('@') ? 'subagent' : 'skill'}>
        {label}
      </span>,
    )
    cursor = tokenStart + label.length
  }
  if (parts.length === 0) return <MessageText text={text} />
  if (cursor < text.length) parts.push(<MessageText key={cursor} text={text.slice(cursor)} />)
  return <>{parts}</>
}

/** Right-aligned bubble shared by user and steering rows. */
function UserStyleBubble({
  content, imageLoader, sessionId, actions, pending = false, t,
}: {
  content: readonly unknown[]
  imageLoader: ImageLoader
  sessionId: string
  /** Optional IconActions (or similar) below the bubble; receives the joined text. */
  actions?: (text: string) => ReactNode
  /** Whether this is the Host-authoritative pre-admission steering projection. */
  pending?: boolean
  t: ChatViewSlotProps['t']
}): ReactNode {
  const { text, images, localFiles, legacyLocalFiles, rest } = contentParts(content)
  const truncated = (total: number): string => t('json.truncated', { total })
  const showBubble = text !== '' || rest.length > 0
  return (
    <div className={css.userRow} data-pending-steering={pending || undefined} data-time-hover-root>
      <div className={css.userStack}>
        <ImageGallery images={images} load={imageLoader} align="end" labels={messageImageLabels(t)} />
        {localFiles.length > 0 && (
          <div className={css.localFiles}>
            {localFiles.map(file => <LocalFileRow key={file.id} file={file} sessionId={sessionId} t={t} />)}
          </div>
        )}
        {legacyLocalFiles.length > 0 && (
          <div className={css.localFiles}>
            {legacyLocalFiles.map(file => <LocalFileRow key={file.id} file={file} sessionId={sessionId} t={t} />)}
          </div>
        )}
        {showBubble && <div className={css.bubble}>
          {projectUserText(text)}
          {rest.map((block, i) => <JsonBlock key={i} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />)}
        </div>}
      </div>
      {actions?.(text)}
    </div>
  )
}

/**
 * Codex-style inline editor replacing a user message while it is being
 * edited: a textarea pre-filled with the original text, the message's
 * attachments listed as removable chips (each can be toggled off so it is not
 * re-sent), and Save/Cancel. Saving emits the edit-message-save event with
 * the kept attachments; the ui-message-edit plugin forks a new session
 * anchored before this message and re-sends text + kept attachments there.
 */
function InlineEditor({
  sessionId, seq, state, t,
}: {
  sessionId: SessionId
  seq: number
  state: MessageEditState
  t: ChatViewSlotProps['t']
}) {
  const [draft, setDraft] = useState(state.text)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Which attachment content indices the user has toggled OFF (not re-sent).
  const [removed, setRemoved] = useState<ReadonlySet<number>>(new Set())
  const attachments = useMemo(() => {
    const list: { index: number; label: string }[] = []
    state.content.forEach((block, index) => {
      const b = block as { type?: string; name?: string }
      if (b.type === 'image' && typeof b.name === 'string') list.push({ index, label: b.name })
      else if (b.type === 'local-file' && typeof b.name === 'string') list.push({ index, label: b.name })
    })
    return list
  }, [state.content])

  const toggleAttachment = (index: number): void => {
    setRemoved(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const save = async (): Promise<void> => {
    const next = draft.trim()
    if (next === '' || saving) return
    // Re-send only the attachments the user kept.
    const keptContent = state.content.filter((_, index) => !removed.has(index))
    setSaving(true)
    setError(null)
    try {
      await requestEditSave(sessionId, seq, next, keptContent, state.isFirst)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSaving(false)
      return
    }
    setSaving(false)
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeEdit(sessionId, seq)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [sessionId, seq])

  return (
    <div className={css.inlineEdit}>
      <textarea
        className={css.inlineEditor}
        value={draft}
        onChange={event => { setDraft(event.target.value) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void save()
          }
        }}
        autoFocus
        rows={Math.max(2, Math.min(8, draft.split('\n').length))}
        placeholder="编辑消息…"
      />
      {attachments.length > 0 && (
        <div className={css.inlineAttachments}>
          {attachments.map(({ index, label }) => {
            const off = removed.has(index)
            return (
              <Pill key={index} onClick={() => { toggleAttachment(index) }} className={`${css.inlineAttachChip}${off ? ` ${css.inlineAttachChipOff}` : ''}`}>
                {label}
                <span className={css.inlineAttachRemove} aria-hidden>{off ? '↩' : '×'}</span>
              </Pill>
            )
          })}
          <span className={css.inlineAttachHint}>× 可移除附件,保存时不再发送</span>
        </div>
      )}
      {error !== null && <div className={css.inlineError}>{error}</div>}
      <div className={css.inlineFooter}>
        <span className={css.inlineHint}>⌘/Ctrl+Enter 发送</span>
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => { closeEdit(sessionId, seq) }}>
          {t('cancel')}
        </Button>
        <Button variant="primary" size="sm" disabled={saving || draft.trim() === ''} onClick={() => { void save() }}>
          {saving ? '发送中…' : '发送'}
        </Button>
      </div>
    </div>
  )
}

/**
 * Render one Host-authoritative pending steering item with the same visual
 * language as its eventual durable transcript node.
 * @returns the pending steering bubble.
 */
export function PendingSteeringBubble({ content, loadImage, sessionId, t }: {
  content: readonly unknown[]
  loadImage?: ImageLoader
  sessionId: string
  t: ChatViewSlotProps['t']
}): ReactNode {
  const imageLoader = loadImage ?? (() => Promise.reject(new Error(t('image.serviceUnavailable'))))
  return (
    <UserStyleBubble
      content={content}
      imageLoader={imageLoader}
      sessionId={sessionId}
      pending
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
}

/** User and admitted-steering keyed Chat renderer. */
export const UserMessageNodeView = memo(function UserMessageNodeView({
  node, loadImage, sessionId, t, renderSlot, useSession,
}: ChatNodeViewProps<'user' | 'steering'> & PropsRenderSlots<'conversation.chat.user-actions'>) {
  const data = node.data
  // Edit anchors on the END of the previous turn (fork boundary = first
  // turn/end at or after it), so the forked session ends before this message
  // and the edited text replaces it — in-window edit semantics, not an
  // append. The session's FIRST message has no previous boundary: the anchor
  // falls back to its own seq and isFirst marks it for the blank-session path.
  const anchorInfo = useSession(snapshot => {
    const turnNum = node.location.kind === 'turn' || node.location.kind === 'step'
      ? node.location.turn.turn
      : undefined
    if (turnNum === undefined || turnNum <= 0) return { seq: data.seq, isFirst: true }
    for (const candidate of snapshot.chat.nodes.values()) {
      if (candidate.kind === 'turn-tail') {
        const tail = candidate.data as TurnTailChatData
        if (tail.turn === turnNum - 1) {
          return { seq: tail.closing?.finalNode?.seq ?? tail.seq, isFirst: false }
        }
      }
    }
    return { seq: data.seq, isFirst: true }
  })
  const plainText = data.content
    .filter((block): block is { type: 'text'; text: string } => {
      const b = block as { type?: string; text?: unknown }
      return b.type === 'text' && typeof b.text === 'string'
    })
    .map(block => block.text)
    .join('')
  const userActions = renderSlot('conversation.chat.user-actions', {
    seq: anchorInfo.seq,
    messageSeq: data.seq,
    text: plainText,
    content: data.content,
    isFirst: anchorInfo.isFirst,
  })
  // Codex-style inline editing: while this message is in edit state the
  // bubble is replaced by an in-place editor pre-filled with the text, with
  // its attachments listed for re-send.
  const editing = useSyncExternalStore(
    subscribeEdit,
    () => editingOf(sessionId, data.seq),
    () => undefined,
  )
  if (editing !== undefined) {
    return <InlineEditor sessionId={sessionId} seq={data.seq} state={editing} t={t} />
  }
  return (
    <UserStyleBubble
      content={data.content}
      imageLoader={loadImage}
      sessionId={sessionId}
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          time={data.time}
          clock="start"
          className={css.actions}
          extraActions={userActions}
          t={t}
        />
      )}
    />
  )
})

/** Injected-context keyed Chat renderer. */
export const ContextMessageNodeView = memo(function ContextMessageNodeView({ node, t }: ChatNodeViewProps<'context'>) {
  const data = node.data
  return (
    <ContextInjectionRow
      content={data.content}
      source={data.source}
      provenance={data.provenance}
      form={data.form}
      t={t}
    />
  )
})

/** Automatic compaction keyed Chat renderer. */
export const CompactionNodeView = memo(function CompactionNodeView({ node, t }: ChatNodeViewProps<'compaction'>) {
  return <CompactionItem node={node.data} t={t} />
})

/** Correlated retry-chain keyed Chat renderer. */
export const RetryNodeView = memo(function RetryNodeView({ node, t }: ChatNodeViewProps<'model-retry'>) {
  const data = node.data
  return <ModelRetryItem node={data.current} active={data.current.retryState === 'scheduled'} t={t} />
})

/** Terminal turn-error keyed Chat renderer. */
export const TurnErrorNodeView = memo(function TurnErrorNodeView({ node, t }: ChatNodeViewProps<'turn-error'>) {
  return <TurnErrorItem node={node.data} t={t} />
})

/** Max-tokens turn-end notice keyed Chat renderer. */
export const TurnMaxTokensNodeView = memo(function TurnMaxTokensNodeView({ t }: ChatNodeViewProps<'turn-max-tokens'>) {
  return <TurnMaxTokensItem t={t} />
})

/** Explicit unknown-surface keyed Chat renderer. */
export const UnknownNodeView = memo(function UnknownNodeView({ node, t }: ChatNodeViewProps<'unknown'>) {
  const data = node.data
  return (
    <div className={css.contextRow}>
      <JsonBlock
        label={t('message.unknownSurface', { type: data.type })}
        payload={data.data}
        truncatedLabel={total => t('json.truncated', { total })}
      />
    </div>
  )
})
