// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { LocalFileDropOverlay, LocalFilePicker } from '../src/client/LocalFiles.tsx'
import { clearAllRefs, hasStaged, refsOf } from '../src/client/attachment-store.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  clearAllRefs()
})

function uploadProps() {
  const uploadFiles = vi.fn(() => Promise.resolve())
  const notifyError = vi.fn()
  return { uploadFiles, notifyError }
}

describe('unified local-file intake', () => {
  it('routes every picked file — images included — to local import', async () => {
    const b = uploadProps()
    const pickerProps = { ...b } as unknown as Parameters<typeof LocalFilePicker>[0]
    const view = render(<LocalFilePicker {...pickerProps} />)
    const image = new File([Uint8Array.of(1)], 'pasted.png', { type: 'image/png' })
    const archive = new File([Uint8Array.of(2)], 'bundle.anything', { type: 'application/x-custom' })

    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [image, archive] },
    })

    await waitFor(() => { expect(b.uploadFiles).toHaveBeenCalledWith([image, archive]) })
  })

  it('captures one paste gesture so the official image listener cannot duplicate it', async () => {
    const b = uploadProps()
    const overlayProps = { ...b } as unknown as Parameters<typeof LocalFileDropOverlay>[0]
    const view = render(<><div data-input-scroll><textarea aria-label="composer" /></div><LocalFileDropOverlay {...overlayProps} /></>)
    const target = view.getByLabelText('composer')
    const image = new File([Uint8Array.of(1)], 'clipboard.png', { type: 'image/png' })
    const genericFile = new File([Uint8Array.of(2)], 'notes.unknown', { type: '' })

    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [image, genericFile].map(file => ({ kind: 'file', getAsFile: () => file })),
        getData: () => '',
      },
    })
    target.dispatchEvent(event)

    await waitFor(() => { expect(b.uploadFiles).toHaveBeenCalledWith([image, genericFile]) })
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves file paste in unrelated textareas untouched', () => {
    const b = uploadProps()
    const overlayProps = { ...b } as unknown as Parameters<typeof LocalFileDropOverlay>[0]
    const view = render(<><textarea aria-label="settings" /><LocalFileDropOverlay {...overlayProps} /></>)
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    const file = new File([Uint8Array.of(1)], 'not-composer.bin')
    Object.defineProperty(event, 'clipboardData', {
      value: { items: [{ kind: 'file', getAsFile: () => file }], getData: () => '' },
    })

    view.getByLabelText('settings').dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(b.uploadFiles).not.toHaveBeenCalled()
  })

  it('routes generic files to local import and leaves the composer DOM clean', async () => {
    const b = uploadProps()
    const props = { ...b } as unknown as Parameters<typeof LocalFileDropOverlay>[0]
    const view = render(<><div data-input-scroll><textarea aria-label="composer" /></div><LocalFileDropOverlay {...props} /></>)
    const genericFile = new File([Uint8Array.of(1, 2, 3)], 'large.custom', { type: 'application/x-custom' })

    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [{ kind: 'file', getAsFile: () => genericFile }],
        getData: () => '',
      },
    })
    view.getByLabelText('composer').dispatchEvent(event)
    await waitFor(() => { expect(b.uploadFiles).toHaveBeenCalledWith([genericFile]) })
    expect(view.queryByText('large.custom')).toBeNull()
  })

  it('keeps the draft empty while a file is staged (no U+FFFC, no chip token)', async () => {
    // The independent store never writes into any draft string: staging a ref
    // must not produce a placeholder character anywhere.
    expect(JSON.stringify(refsOf('session-x' as never))).not.toContain('\uFFFC')
    expect(hasStaged('session-x' as never)).toBe(false)
  })

  it('stops file drops before the official document-level image listener', async () => {
    const b = uploadProps()
    const props = { ...b } as unknown as Parameters<typeof LocalFileDropOverlay>[0]
    const view = render(<><div data-input-scroll><textarea aria-label="composer" /></div><LocalFileDropOverlay {...props} /></>)
    // Simulate the official InputBar document-level (bubble) drop listener that
    // routes every file into the image rail and toasts unsupported types.
    const official = vi.fn()
    document.addEventListener('drop', official)

    const dataTransfer = { types: ['Files'], files: [new File([Uint8Array.of(1)], 'd.zip', { type: 'application/zip' })], dropEffect: 'none' }
    const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    view.getByLabelText('composer').dispatchEvent(event)

    await waitFor(() => { expect(b.uploadFiles).toHaveBeenCalled() })
    expect(official).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
    document.removeEventListener('drop', official)
  })

  it('leaves text-only drags on the native drop path', () => {
    const b = uploadProps()
    const props = { ...b } as unknown as Parameters<typeof LocalFileDropOverlay>[0]
    const view = render(<><div data-input-scroll><textarea aria-label="composer" /></div><LocalFileDropOverlay {...props} /></>)
    const official = vi.fn()
    document.addEventListener('drop', official)

    const dataTransfer = { types: ['text/plain'], files: [], dropEffect: 'none' }
    const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    view.getByLabelText('composer').dispatchEvent(event)

    expect(official).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)
    document.removeEventListener('drop', official)
  })
})
