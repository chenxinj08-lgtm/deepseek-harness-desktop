import { describe, expect, it } from 'vitest'
import {
  clipboardLocalFileReference, decodeLocalFileReference, serializeLocalFileReference,
} from '../src/client/reference.ts'

describe('local-file composer references', () => {
  const reference = JSON.stringify({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Q&A <2026>.xlsx',
    size: 123456,
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    kind: 'xlsx',
  })

  it('serializes metadata only, XML-escapes, and carries media_type (host-aligned)', () => {
    expect(serializeLocalFileReference(reference)).toBe(
      '<local_file id="11111111-1111-4111-8111-111111111111" media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />',
    )
    expect(serializeLocalFileReference(reference)).not.toContain('name=')
    expect(serializeLocalFileReference(reference)).not.toContain('size_bytes')
  })

  it('provides stable clipboard text and rejects malformed refs', () => {
    expect(clipboardLocalFileReference(reference)).toBe('@local-file(11111111-1111-4111-8111-111111111111)')
    expect(decodeLocalFileReference(reference).name).toBe('Q&A <2026>.xlsx')
    expect(() => decodeLocalFileReference('{"size":-1}')).toThrow(/failed validation/u)
  })

  it('retains the Host reader kind without trusting it in the prompt marker', () => {
    const binary = JSON.stringify({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'archive.unknown',
      size: 42,
      mediaType: 'application/octet-stream',
      kind: 'binary',
    })
    expect(serializeLocalFileReference(binary)).not.toContain('kind=')
    expect(decodeLocalFileReference(binary).kind).toBe('binary')
  })

  it('accepts an immediate browser-staged reference before Host sniffing settles', () => {
    const staged = JSON.stringify({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'large.custom',
      size: 8_000_000_000,
      mediaType: 'application/octet-stream',
    })
    expect(decodeLocalFileReference(staged).kind).toBeUndefined()
    expect(serializeLocalFileReference(staged)).toContain('media_type="application/octet-stream"')
  })
})
