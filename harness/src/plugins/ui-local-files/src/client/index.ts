/**
 * Browser plugin: same-origin import into an independent attachment state.
 *
 * Attachments never enter the composer draft. The picker/drop seats stage files
 * into a per-session store; the dock renders them as cards above the input; and
 * a listener on the official `conversation/send-content-inject` hook submits
 * them as structured `local-file` blocks alongside (never spliced into) the
 * text. The text area therefore stays plain user text — no `<local_file>`, no
 * U+FFFC placeholder, no chip, no cursor drift.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import {
  LocalFileDock, LocalFileDropOverlay, LocalFilePicker, type LocalFileUploadInjected,
} from './LocalFiles.tsx'
import { LOCAL_FILE_IMPORT_PATH, parseLocalFileReference, type LocalFileReference } from './reference.ts'
import {
  clearAllRefs, hasStaged, hasStagedAny, markFailedAndDrop, markReady, stageRef, subscribe, takeAllIds,
} from './attachment-store.ts'

/** Required client services: session addressing, input mutation, and slot composition. */
export const inject = ['slots', 'sessions', 'conversation']

interface ErrorEnvelope {
  readonly error?: { readonly code?: unknown; readonly message?: unknown }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

async function importFile(
  sessionId: SessionId,
  id: string,
  file: File,
  signal: AbortSignal,
): Promise<LocalFileReference> {
  const url = new URL(LOCAL_FILE_IMPORT_PATH, window.location.origin)
  url.searchParams.set('session_id', sessionId)
  url.searchParams.set('file_id', id)
  url.searchParams.set('name', file.name)
  url.searchParams.set('size', String(file.size))
  const response = await fetch(url, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
    signal,
  })
  const body = await responseJson(response)
  if (!response.ok) {
    const envelope = body as ErrorEnvelope | undefined
    const message = typeof envelope?.error?.message === 'string'
      ? envelope.error.message
      : `HTTP ${String(response.status)}`
    throw new Error(message)
  }
  return parseLocalFileReference(body)
}

// Single-batch cap: an accidental mass drop would flood the composer cards and
// the transport in one burst, so a generous fixed batch boundary is safer.
const MAX_FILES_PER_BATCH = 20
// Same-origin fetch shares one connection pool; more concurrent PUTs than this
// only queue behind it and spike memory, so a small fixed limit keeps the
// streamed uploads steady without reducing throughput.
const MAX_CONCURRENT_UPLOADS = 4

/** Upload orchestration over the independent attachment store. */
function uploader(sessionId: SessionId, notifyError: (message: string) => void): LocalFileUploadInjected {
  return {
    notifyError,
    uploadFiles: (files) => {
      const batch = files.slice(0, MAX_FILES_PER_BATCH)
      if (batch.length < files.length) {
        notifyError(`单次最多添加 ${MAX_FILES_PER_BATCH} 个文件，其余 ${files.length - batch.length} 个已忽略`)
      }
      let active = 0
      const waiting: (() => void)[] = []
      const acquire = (): Promise<void> => new Promise((resolve) => {
        if (active < MAX_CONCURRENT_UPLOADS) {
          active += 1
          resolve()
        } else {
          waiting.push(() => { active += 1; resolve() })
        }
      })
      const release = (): void => {
        active -= 1
        waiting.shift()?.()
      }
      for (const file of batch) {
        const id = crypto.randomUUID()
        const controller = new AbortController()
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
        const promise = acquire()
          .then(() => importFile(sessionId, id, file, controller.signal))
          .finally(release)
          .then(() => {
            markReady(sessionId, id)
            return id
          })
        stageRef(sessionId, {
          id,
          name: file.name,
          size: file.size,
          mediaType: file.type || 'application/octet-stream',
          status: 'pending',
          ...(previewUrl === undefined ? {} : { previewUrl }),
          promise,
          abort: () => { controller.abort() },
        })
        promise.catch((error: unknown) => {
          markFailedAndDrop(sessionId, id)
          notifyError(`${file.name}: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      return Promise.resolve()
    },
  }
}

/** Submit hook: wait for staged uploads, emit structured local-file blocks. */
function installSendInject(ctx: ClientContext): () => void {
  return (ctx.on as unknown as (
    name: string, listener: (sessionId: SessionId) => unknown,
  ) => () => void)('conversation/send-content-inject', async (sessionId: SessionId) => {
    if (!hasStaged(sessionId)) return null
    // Await every staged upload; a failure rejects here and blocks the send
    // (the hub restores the draft and the card set stays for a retry).
    const { ids } = takeAllIds(sessionId)
    const resolved = await ids
    return resolved.map(id => ({ type: 'local-file' as const, id }))
  })
}

/** Register the independent attachment pipeline plus additive composer seats. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => installSendInject(ctx), 'ui-local-files: send-inject listener')
  // Broadcast staged-presence so the composer can enable sending with files
  // only (no text): the official InputBar disables Send while the draft is
  // empty and holds no image attachments.
  ctx.effect(() => subscribe(() => {
    if (activeSession !== null) {
      (ctx.emit as (name: string, ...args: unknown[]) => void)('local-files/staged-changed', activeSession, hasStagedAny())
    }
  }), 'ui-local-files: staged-presence broadcast')
  ctx.effect(() => () => { clearAllRefs() }, 'ui-local-files: abort pending imports')

  let activeSession: SessionId | null = null
  const noteSession = (sessionId: SessionId): SessionId => { activeSession = sessionId; return sessionId }

  const notifyFor = (sessionId: SessionId) => (message: string): void => {
    const actx = ctx.sessions.scope(sessionId)
    actx?.conversation.input.for(actx).notify('error', message)
  }

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'local-files-picker',
    order: 30,
    inject: (sessionId): LocalFileUploadInjected => uploader(noteSession(sessionId), notifyFor(sessionId)),
  }, LocalFilePicker))

  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'local-files-drop',
    order: 50,
    inject: (sessionId): LocalFileUploadInjected => uploader(noteSession(sessionId), notifyFor(sessionId)),
  }, LocalFileDropOverlay))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'local-files',
    order: 15,
  }, LocalFileDock))
}
