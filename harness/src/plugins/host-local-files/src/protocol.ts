/** Host-side wire and storage vocabulary for local files. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity carried by a composer reference and model tools. */
export type LocalFileId = Branded<'LocalFileId'>

/**
 * Brand a validated UUID as a local-file identity.
 * @param value - UUID already validated at its trust boundary.
 * @returns branded local-file identity.
 */
export function LocalFileId(value: string): LocalFileId {
  return value as LocalFileId
}

/** Raw-body import endpoint owned by this plugin. */
export const LOCAL_FILE_IMPORT_PATH = '/local-files/v1/import'
/** Same-origin download endpoint (GET) for a stored local file. */
export const LOCAL_FILE_DOWNLOAD_PATH = '/local-files/v1/download'
/** Same-origin preview endpoint (GET) returning `inline` disposition for thumbnails. */
export const LOCAL_FILE_PREVIEW_PATH = '/local-files/v1/preview'

/** Storage metadata format. */
export const LOCAL_FILE_METADATA_VERSION = 2

/** File families with bounded model-facing readers; binary is the safe fallback. */
export type LocalFileKind = 'text' | 'csv' | 'xlsx' | 'docx' | 'binary'

/** Durable metadata written only after the payload commit succeeds. */
export interface LocalFileMetadata {
  readonly version: typeof LOCAL_FILE_METADATA_VERSION
  readonly id: LocalFileId
  readonly workspaceKey: string
  readonly name: string
  readonly extension: string
  readonly kind: LocalFileKind
  readonly mediaType: string
  readonly size: number
  readonly sha256: string
  readonly importedAt: number
}

/** Resolved immutable payload within the configured local store. */
export interface LocalFileRecord {
  readonly metadata: LocalFileMetadata
  readonly payloadPath: string
}

/** Successful response returned to the browser after an atomic import. */
export interface LocalFileImportResponse {
  readonly id: LocalFileId
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly kind: LocalFileKind
}

/** Stable error returned by the raw-body endpoint. */
export interface LocalFileErrorResponse {
  readonly error: {
    readonly code: string
    readonly message: string
  }
}
