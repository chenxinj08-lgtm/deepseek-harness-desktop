/**
 * General Settings row for the persistent memory store: shows how many
 * memories exist and opens a modal listing them (global and the current
 * workspace), plus the workspace's short-term notes. The row talks to the
 * host-memory HTTP endpoints — same same-origin fetch posture as
 * ui-local-files — so the model-facing store and the settings surface share
 * one truth.
 */
import { useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './MemoryRow.module.css'

/** One memory index entry, mirroring the host's MemoryEntry. */
export interface MemoryEntry {
  readonly name: string
  readonly summary: string
}

/** One short-term note, mirroring the host's NoteEntry. */
export interface NoteEntry {
  readonly name: string
  readonly summary: string
  readonly content: string
}

/** The settings row's injected business face (the apply closure owns the HTTP calls). */
export interface MemoryRowInjected {
  /** List all memories (global + current workspace) for the current session. */
  list: () => Promise<{ global: readonly MemoryEntry[]; workspace: readonly MemoryEntry[] }>
  /** Read one memory's full text. */
  read: (name: string) => Promise<string>
  /** List the current workspace's short-term notes. */
  notes: () => Promise<readonly NoteEntry[]>
  /** Permanently delete one long-term memory. */
  remove: (name: string) => Promise<void>
}

/** Full Settings-row props: runtime seat + injected face (the row draws its own copy). */
export type MemoryRowProps = PropsRuntime<'settings.general.item'> & MemoryRowInjected

/** One memory entry: click to read its full text; × deletes it. */
function EntryRow({ entry, read, onRemove }: {
  entry: MemoryEntry
  read: (name: string) => Promise<string>
  onRemove: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const openEntry = (): void => {
    setOpen(true)
    setLoading(true)
    setError(null)
    setContent(null)
    void read(entry.name)
      .then((text) => { setContent(text); setLoading(false) })
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false) })
  }

  return (
    <>
      <div className={css.entryRow}>
        <button type="button" className={css.entry} onClick={openEntry}>
          <span className={css.entryName}>{entry.name}</span>
          <span className={css.entrySummary}>{entry.summary}</span>
        </button>
        <button
          type="button"
          className={css.entryRemove}
          aria-label={`删除 ${entry.name}`}
          title="删除此记忆"
          onClick={(event) => { event.stopPropagation(); onRemove(entry.name) }}
        >
          ×
        </button>
      </div>
      <Modal open={open} onClose={() => { setOpen(false) }} title={entry.name} closeLabel="关闭">
        {loading && <div className={css.bodyText}>读取中…</div>}
        {error !== null && <div className={css.bodyError}>{error}</div>}
        {content !== null && <pre className={css.bodyPre}>{content}</pre>}
      </Modal>
    </>
  )
}

/** One short-term note: click to read its full text. */
function NoteRow({ note, read }: { note: NoteEntry; read: (key: string) => Promise<string> }) {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openNote = (): void => {
    setOpen(true)
    setLoading(true)
    setError(null)
    setContent(null)
    void read(note.name)
      .then((text) => { setContent(text); setLoading(false) })
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false) })
  }

  return (
    <>
      <button type="button" className={css.entry} onClick={openNote}>
        <span className={css.entryName}>{note.name}</span>
        <span className={css.entrySummary}>{note.summary}</span>
      </button>
      <Modal open={open} onClose={() => { setOpen(false) }} title={note.name} closeLabel="关闭">
        {loading && <div className={css.bodyText}>读取中…</div>}
        {error !== null && <div className={css.bodyError}>{error}</div>}
        {content !== null && <pre className={css.bodyPre}>{content}</pre>}
      </Modal>
    </>
  )
}

/**
 * Render the Memory management row.
 * @param props - composed Settings slot props.
 * @returns the row element tree.
 */
export function MemoryRow({ list, read, notes, remove }: MemoryRowProps) {
  const [open, setOpen] = useState(false)
  const [globalMem, setGlobalMem] = useState<readonly MemoryEntry[]>([])
  const [workspaceMem, setWorkspaceMem] = useState<readonly MemoryEntry[]>([])
  const [workspaceNotes, setWorkspaceNotes] = useState<readonly NoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = (): void => {
    setLoading(true)
    setError(null)
    void Promise.all([list(), notes()])
      .then(([memories, notesResult]) => {
        setGlobalMem(memories.global)
        setWorkspaceMem(memories.workspace)
        setWorkspaceNotes(notesResult)
        setLoading(false)
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      })
  }

  const openModal = (): void => {
    setOpen(true)
    refresh()
  }

  const handleRemove = (name: string): void => {
    setError(null)
    void remove(name)
      .then(refresh)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
  }

  const total = globalMem.length + workspaceMem.length

  return (
    <>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>记忆管理</div>
          <div className={css.desc}>查看和管理已保存的记忆(全局 + 当前工作区)</div>
        </div>
        <button type="button" className={css.selector} onClick={openModal}>
          {total > 0 ? `${total} 条` : '查看'}
          <IconChevronDownOutline14 className={css.chevron} />
        </button>
      </div>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title="记忆管理"
        closeLabel="关闭"
        description={total > 0 ? `共 ${total} 条记忆` : '还没有保存任何记忆'}
        contentClassName={css.modalContent ?? ''}
      >        {loading && <div className={css.bodyText}>读取中…</div>}
        {error !== null && <div className={css.bodyError}>{error}</div>}
        {!loading && error === null && (
          <div className={css.sections}>
            {workspaceNotes.length > 0 && (
              <section>
                <h3 className={css.sectionTitle}>工作区便签(短期记忆)</h3>
                {workspaceNotes.map(note => <NoteRow key={note.name} note={note} read={read} />)}
              </section>
            )}
            {workspaceMem.length > 0 && (
              <section>
                <h3 className={css.sectionTitle}>当前工作区</h3>
                {workspaceMem.map(entry => <EntryRow key={entry.name} entry={entry} read={read} onRemove={handleRemove} />)}
              </section>
            )}
            {globalMem.length > 0 && (
              <section>
                <h3 className={css.sectionTitle}>全局</h3>
                {globalMem.map(entry => <EntryRow key={entry.name} entry={entry} read={read} onRemove={handleRemove} />)}
              </section>
            )}
            {workspaceNotes.length === 0 && workspaceMem.length === 0 && globalMem.length === 0 && (
              <div className={css.bodyText}>还没有保存任何记忆,在对话中让模型用 memory_add 保存即可。</div>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}
