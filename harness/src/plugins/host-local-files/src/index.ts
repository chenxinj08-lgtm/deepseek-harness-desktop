/** Local-file Host plugin: raw streaming ingress, local storage service, and model tools. */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LOCAL_FILE_DOWNLOAD_PATH, LOCAL_FILE_IMPORT_PATH, LOCAL_FILE_PREVIEW_PATH, type LocalFileErrorResponse } from './protocol.ts'
import { LocalFileError, LocalFileService } from './service.ts'
import { applyLocalFileTools } from './tools.ts'
import { assertTrustedAuthority, isTrustedLocalFileRequest } from './trust.ts'

/** Cordis plugin name. */
export const name = 'host-local-files'
/** Host services required by the endpoint and model-facing consumer. */
export const inject = ['webServer', 'sessions', 'tools', 'systemPrompt']

/** Deployment policy for local file import and model-facing output. */
export interface Config {
  /** Absolute host-local staging root. */
  readonly storageRoot: string
  /** Additional authorities allowed to call the loopback import endpoint. */
  readonly trustedHosts?: string[]
  /** Maximum accepted raw file size. */
  readonly maxFileBytes?: number
  /** Maximum structured records returned by one read. */
  readonly maxReadRecords?: number
  /** Maximum UTF-8 payload bytes returned by one structured read. */
  readonly maxReadBytes?: number
  /** Maximum raw bytes returned by one binary-window read. */
  readonly maxBinaryReadBytes?: number
  /** Maximum characters retained for one structured record. */
  readonly maxRecordChars?: number
  /** Maximum matches returned by one search. */
  readonly maxSearchMatches?: number
  /** Maximum characters retained around one search match. */
  readonly maxSearchExcerptChars?: number
}

/** Plugin config schema; the Loader materializes every default before apply. */
export const Config: z<Config> = z.object({
  storageRoot: z.string().required(),
  trustedHosts: z.array(String).default([]),
  maxFileBytes: z.natural().min(1).default(8 * 1024 * 1024 * 1024),
  maxReadRecords: z.natural().min(1).default(200),
  maxReadBytes: z.natural().min(4096).default(64 * 1024),
  maxBinaryReadBytes: z.natural().min(1).default(16 * 1024),
  maxRecordChars: z.natural().min(1).default(8000),
  maxSearchMatches: z.natural().min(1).default(50),
  maxSearchExcerptChars: z.natural().min(32).default(600),
})

type ResolvedConfig = Required<Config>

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(body))
}

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key)
  if (value === null || value === '') throw new LocalFileError('INVALID_REQUEST', `missing query parameter: ${key}`)
  return value
}

async function handleImport(
  ctx: Context,
  files: LocalFileService,
  trustedHosts: readonly string[],
  maxFileBytes: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isTrustedLocalFileRequest(req, trustedHosts)) {
    json(res, 403, { error: { code: 'FORBIDDEN', message: 'forbidden' } } satisfies LocalFileErrorResponse)
    return
  }
  if (req.method !== 'PUT') {
    res.setHeader('allow', 'PUT')
    json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use PUT' } } satisfies LocalFileErrorResponse)
    return
  }
  try {
    const url = new URL(req.url ?? LOCAL_FILE_IMPORT_PATH, 'http://local')
    const sessionId = SessionId(requiredQuery(url, 'session_id'))
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) throw new LocalFileError('SESSION_NOT_FOUND', `session was not found: ${sessionId}`, 404)
    const cwd = session.header.cwd
    if (cwd === undefined) throw new LocalFileError('WORKSPACE_REQUIRED', 'session has no workspace')
    const id = files.parseId(requiredQuery(url, 'file_id'))
    const fileName = requiredQuery(url, 'name')
    const size = Number(requiredQuery(url, 'size'))
    const contentLength = req.headers['content-length']
    if (contentLength !== undefined) {
      const declared = Number(contentLength)
      if (!Number.isSafeInteger(declared) || declared < 0) {
        throw new LocalFileError('INVALID_CONTENT_LENGTH', 'Content-Length must be a non-negative safe integer')
      }
      if (declared > maxFileBytes) {
        throw new LocalFileError('FILE_TOO_LARGE', `file exceeds the configured ${String(maxFileBytes)} byte limit`, 413)
      }
      if (declared !== size) throw new LocalFileError('FILE_SIZE_MISMATCH', 'Content-Length does not match size')
    }
    const imported = await files.importFile({
      cwd,
      id,
      name: fileName,
      expectedSize: size,
      mediaType: req.headers['content-type'] ?? 'application/octet-stream',
      body: req,
    })
    json(res, 201, imported)
  } catch (error) {
    if (error instanceof LocalFileError) {
      json(res, error.status, { error: { code: error.code, message: error.message } } satisfies LocalFileErrorResponse)
      return
    }
    ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    json(res, 500, { error: { code: 'IMPORT_FAILED', message: 'local file import failed' } } satisfies LocalFileErrorResponse)
  }
}

async function handleDownload(
  ctx: Context,
  files: LocalFileService,
  trustedHosts: readonly string[],
  req: IncomingMessage,
  res: ServerResponse,
  disposition: 'attachment' | 'inline',
): Promise<void> {
  if (!isTrustedLocalFileRequest(req, trustedHosts)) {
    json(res, 403, { error: { code: 'FORBIDDEN', message: 'forbidden' } } satisfies LocalFileErrorResponse)
    return
  }
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET')
    json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET' } } satisfies LocalFileErrorResponse)
    return
  }
  try {
    const url = new URL(req.url ?? LOCAL_FILE_DOWNLOAD_PATH, 'http://local')
    const sessionId = SessionId(requiredQuery(url, 'session_id'))
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) throw new LocalFileError('SESSION_NOT_FOUND', `session was not found: ${sessionId}`, 404)
    const cwd = session.header.cwd
    if (cwd === undefined) throw new LocalFileError('WORKSPACE_REQUIRED', 'session has no workspace')
    const id = files.parseId(requiredQuery(url, 'file_id'))
    const record = await files.get(cwd, id)
    const info = await stat(record.payloadPath)
    if (!info.isFile() || info.size !== record.metadata.size) {
      throw new LocalFileError('CORRUPT_PAYLOAD', `payload for local file ${id} failed validation`, 500)
    }
    res.writeHead(200, {
      'content-type': record.metadata.mediaType || 'application/octet-stream',
      'content-length': String(record.metadata.size),
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(basename(record.metadata.name))}`,
      'cache-control': 'no-store',
    })
    await pipeline(createReadStream(record.payloadPath), res)
  } catch (error) {
    if (!res.headersSent) {
      if (error instanceof LocalFileError) {
        json(res, error.status, { error: { code: error.code, message: error.message } } satisfies LocalFileErrorResponse)
        return
      }
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      json(res, 500, { error: { code: 'DOWNLOAD_FAILED', message: 'local file download failed' } } satisfies LocalFileErrorResponse)
    }
  }
}

/** Install the local service, endpoint, prompt section, and bounded tools. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as ResolvedConfig
  for (const authority of resolved.trustedHosts) assertTrustedAuthority(authority)
  const files = new LocalFileService(ctx, {
    storageRoot: resolved.storageRoot,
    maxFileBytes: resolved.maxFileBytes,
  })
  await files.initialize()
  const route: WebRoute = {
    kind: 'exact',
    path: LOCAL_FILE_IMPORT_PATH,
    handler: (req, res) => handleImport(
      ctx,
      files,
      resolved.trustedHosts,
      resolved.maxFileBytes,
      req,
      res,
    ),
  }
  ctx.effect(() => ctx.webServer.register(route), 'host-local-files: import route')
  const downloadRoute: WebRoute = {
    kind: 'exact',
    path: LOCAL_FILE_DOWNLOAD_PATH,
    handler: (req, res) => handleDownload(ctx, files, resolved.trustedHosts, req, res, 'attachment'),
  }
  ctx.effect(() => ctx.webServer.register(downloadRoute), 'host-local-files: download route')
  const previewRoute: WebRoute = {
    kind: 'exact',
    path: LOCAL_FILE_PREVIEW_PATH,
    handler: (req, res) => handleDownload(ctx, files, resolved.trustedHosts, req, res, 'inline'),
  }
  ctx.effect(() => ctx.webServer.register(previewRoute), 'host-local-files: preview route')
  applyLocalFileTools(ctx, files, {
    maxReadRecords: resolved.maxReadRecords,
    maxReadBytes: resolved.maxReadBytes,
    maxBinaryReadBytes: resolved.maxBinaryReadBytes,
    maxRecordChars: resolved.maxRecordChars,
    maxSearchMatches: resolved.maxSearchMatches,
    maxSearchExcerptChars: resolved.maxSearchExcerptChars,
  })
}

export { LocalFileService }
