/** Pure presentation components for picker, global drop target, and attachment cards. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DraftRef } from './attachment-store.ts'
import { refsOf, removeRef, subscribe } from './attachment-store.ts'
import css from './LocalFiles.module.css'

/** Async upload face injected from the apply closure. */
export interface LocalFileUploadInjected {
  readonly uploadFiles: (files: readonly File[]) => Promise<void>
  readonly notifyError: (message: string) => void
}

type PickerProps = PropsRuntime<'conversation.input.left'> & LocalFileUploadInjected
type DropProps = PropsRuntime<'conversation.input.overlay'> & LocalFileUploadInjected
type DockProps = PropsRuntime<'conversation.input.dock'>

function PaperclipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5.1 8.9 9.8 4.2a2.1 2.1 0 0 1 3 3L7.1 12.9a3.5 3.5 0 0 1-5-5l5.5-5.5.9.9L3 8.8a2.2 2.2 0 1 0 3.2 3.2l5.7-5.7a.8.8 0 1 0-1.2-1.2L6 9.8a.6.6 0 0 0 .9.9l4.4-4.4.9.9-4.4 4.4a1.9 1.9 0 0 1-2.7-2.7Z" fill="currentColor" />
    </svg>
  )
}

const KIND_ICON: Record<string, string> = {
  xlsx: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor"/><path d="M4 5h8M4 8h8M4 11h5" stroke="currentColor" stroke-linecap="round"/></svg>',
  docx: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none"><path d="M3 1.5h7l3 3v10H3z" stroke="currentColor" stroke-linejoin="round"/><path d="M10 1.5v3h3M5.5 8h5M5.5 11h5" stroke="currentColor" stroke-linecap="round"/></svg>',
  csv: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor"/><path d="M4.5 5h7M4.5 8h7M4.5 11h7" stroke="currentColor" stroke-linecap="round"/></svg>',
  text: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none"><path d="M3 2h10v3H3zM3 7h10M3 10h10M3 13h10" stroke="currentColor" stroke-linecap="round"/></svg>',
  binary: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor"/><path d="M5.5 4.5v7M10.5 4.5v7M4 9.5h3M8.5 9.5h3" stroke="currentColor" stroke-linecap="round"/></svg>',
}

function fileKindIcon(mediaType: string, name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.xlsx')) return KIND_ICON.xlsx ?? KIND_ICON.binary!
  if (lower.endsWith('.docx')) return KIND_ICON.docx!
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return KIND_ICON.csv!
  if (mediaType.startsWith('text/') || /\.(txt|md|json|jsonl|log|xml|yaml|yml)$/u.test(lower)) return KIND_ICON.text!
  return KIND_ICON.binary!
}

/** Compact file-picker control inside the composer tool row. */
export function LocalFilePicker({ uploadFiles }: PickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const choose = useCallback(async (files: readonly File[]) => {
    if (files.length === 0 || busy) return
    setBusy(true)
    try {
      await uploadFiles(files)
    } finally {
      setBusy(false)
    }
  }, [busy, uploadFiles])

  return (
    <>
      <button
        type="button"
        className={css.picker}
        aria-label={busy ? '正在导入本地文件' : '添加本地文件'}
        title={busy ? '正在导入本地文件' : '添加表格、Word 或文本文件'}
        disabled={busy}
        onClick={() => { inputRef.current?.click() }}
      >
        <PaperclipIcon />
      </button>
      <input
        ref={inputRef}
        className={css.hiddenInput}
        type="file"
        multiple
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])]
          event.currentTarget.value = ''
          void choose(files)
        }}
      />
    </>
  )
}

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false
}

/** Page-level drop/paste listener; the visible overlay appears only during a file drag. */
export function LocalFileDropOverlay({ uploadFiles }: DropProps) {
  const depth = useRef(0)
  const [active, setActive] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleFiles = useCallback((files: readonly File[]) => {
    if (files.length === 0) return
    void uploadFiles(files)
  }, [uploadFiles])

  useEffect(() => {
    // Capture-phase stopPropagation keeps file paste away from the official
    // composer's synthetic onPaste, which would toast "仅支持 PNG、JPG…" for
    // every non-image file; text paste passes through untouched.
    const onPaste = (event: ClipboardEvent): void => {
      if (event.target instanceof HTMLElement && event.target.closest('[data-input-scroll]') === null) return
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())
        .filter((file): file is File => file !== null)
      if (files.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      handleFiles(files)
    }
    window.addEventListener('paste', onPaste, true)
    return () => { window.removeEventListener('paste', onPaste, true) }
  }, [handleFiles])

  useEffect(() => {
    // The official InputBar registers document-level drag listeners (bubble
    // phase) that route every file drop into the image rail and announce
    // "仅支持 PNG…" for non-images. Capture-phase listeners on window run
    // first and stop propagation, so file drags never reach that toast while
    // non-file drags (text into textarea) stay on the native path.
    const onEnter = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      depth.current += 1
      setActive(true)
    }
    const onOver = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      event.stopPropagation()
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setActive(false)
    }
    const onDrop = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      depth.current = 0
      setActive(false)
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length === 0) return
      setBusy(true)
      void Promise.resolve(handleFiles(files)).finally(() => { setBusy(false) })
    }
    window.addEventListener('dragenter', onEnter, true)
    window.addEventListener('dragover', onOver, true)
    window.addEventListener('dragleave', onLeave, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragenter', onEnter, true)
      window.removeEventListener('dragover', onOver, true)
      window.removeEventListener('dragleave', onLeave, true)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [handleFiles])

  if (!active && !busy) return null
  return (
    <output className={css.dropOverlay} aria-live="polite">
      <div className={css.dropCard}>
        <PaperclipIcon />
        <span>{busy ? '正在导入到 Harness 本机…' : '松开即可添加本地文件'}</span>
      </div>
    </output>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function statusLabel(status: DraftRef['status']): string {
  if (status === 'pending') return '导入中…'
  if (status === 'failed') return '导入失败'
  return ''
}

/** Attachment cards above the composer, rendered from the independent store. */
export function LocalFileDock({ session }: DockProps) {
  const sessionId = session.sessionId
  const refs = useSyncExternalStore(
    subscribe,
    () => refsOf(sessionId),
    () => refsOf(sessionId),
  )
  if (refs.length === 0) return null
  const hasImage = refs.some(file => file.mediaType.startsWith('image/'))
  return (
    <div className={css.dock} aria-label="已添加的本地文件">
      {hasImage && <div className={css.note}>图片将发送到第三方视觉服务分析，仅用于本次会话</div>}
      {refs.map((file) => (
        <div key={file.id} className={css.chip} data-status={file.status}>
          {file.previewUrl !== undefined
            ? <img className={css.chipThumb} src={file.previewUrl} alt="" />
            : <span className={css.chipIcon} dangerouslySetInnerHTML={{ __html: fileKindIcon(file.mediaType, file.name) }} />}
          <span className={css.chipText}>
            <span className={css.chipName}>{file.name}</span>
            <span className={css.chipSize}>
              {formatBytes(file.size)}
              {statusLabel(file.status) !== '' && ` · ${statusLabel(file.status)}`}
            </span>
          </span>
          <button
            type="button"
            className={css.remove}
            aria-label={`移除 ${file.name}`}
            onClick={() => { removeRef(sessionId, file.id) }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
