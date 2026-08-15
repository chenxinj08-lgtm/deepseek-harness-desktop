/**
 * node:http ↔ WHATWG fetch bridge for the /api transport (host side of the
 * web carrier; the fetch-shaped handler itself is transport-agnostic).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Default carrier cap for all HTTP RPC bodies: sized for the default
 * aggregate image limit (100 MiB) after base64 expansion plus envelope
 * headroom (~134.3 MiB required), rounded up for slack. The bridge buffers
 * each body in memory, so this cap is also the per-request resident bound. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 160 * 1024 * 1024

/** 全局 in-flight 请求体预算:并发大上传不突破 256 MiB 常驻内存(超限 503)。 */
const GLOBAL_BODY_BUDGET = 256 * 1024 * 1024
let inFlightBodyBytes = 0

/** 透传头白名单:cookie/authorization 等敏感头不出桥;host 是信任检查的输入,必须保留。 */
const FORWARD_HEADERS = new Set(['content-type', 'accept', 'host', 'origin', 'sec-fetch-site'])

/** Transport-independent request handler consumed by the Host HTTP bridge. */
export interface FetchHandler {
  /**
   * Handle one standard Fetch request.
   * @param request - request produced by the active transport bridge.
   * @returns complete or streaming Fetch response.
   */
  fetch(request: Request): Promise<Response>
}

/**
 * Bridge one node:http request to the fetch-shaped handler (client close
 * aborts; SSE bodies stream out chunk by chunk).
 * @param req - incoming node:http request (fully read before dispatch).
 * @param res - node:http response the bridge writes and owns to completion.
 * @param apiHandler - fetch-shaped API carrier the request is dispatched to.
 * @param maxRequestBodyBytes - maximum body bytes buffered before dispatch.
 */
export async function bridge(
  req: IncomingMessage,
  res: ServerResponse,
  apiHandler: FetchHandler,
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<void> {
  const abort = new AbortController()
  // Client-disconnect detection MUST hang off the response, not the request:
  // since Node 16, IncomingMessage 'close' fires as soon as the request body is
  // fully consumed (immediately for a bodyless GET), which would abort every SSE
  // stream right after open. ServerResponse 'close' fires on connection teardown;
  // writableEnded distinguishes a normal end() from the client going away.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined && Number(declaredLength) > maxRequestBodyBytes) {
    res.writeHead(413, { connection: 'close' })
    res.end()
    req.destroy()
    return
  }
  if (inFlightBodyBytes > GLOBAL_BODY_BUDGET) { // 全局预算:并发上传不叠加撑爆内存
    res.writeHead(503, { connection: 'close' })
    res.end()
    req.destroy()
    return
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > maxRequestBodyBytes) {
      res.writeHead(413, { connection: 'close' })
      res.end()
      req.destroy()
      return
    }
    chunks.push(buffer)
  }
  if (inFlightBodyBytes + received > GLOBAL_BODY_BUDGET) { // 严格预算:总量不超过 256 MiB
    res.writeHead(503, { connection: 'close' })
    res.end()
    req.destroy()
    return
  }
  inFlightBodyBytes += received
  try {
    /* v8 ignore next 3 -- `??` arms: node:http always sets url/method on server
    requests; the fields are only optional on the client-side IncomingMessage type */
    const request = new Request(new URL(req.url ?? '/', 'http://dsh.internal'), {
      method: req.method ?? 'GET',
      headers: Object.fromEntries(Object.entries(req.headers)
        .filter(([name, value]) => FORWARD_HEADERS.has(name) && typeof value === 'string') as [string, string][]),
      ...chunks.length > 0 ? { body: Buffer.concat(chunks) } : {},
      signal: abort.signal,
    })
    const response = await apiHandler.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    if (response.body === null) {
      res.end()
      return
    }
    for await (const chunk of response.body) {
      // Backpressure: a false return means the socket buffer is full — wait for drain
      // instead of buffering unboundedly (slow/suspended SSE consumers). 'close' also
      // resolves so a mid-wait disconnect can't park this loop forever; the close
      // handler above aborts the handler stream, which then ends the iteration.
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            res.off('drain', done)
            res.off('close', done)
            resolve()
          }
          res.once('drain', done)
          res.once('close', done)
        })
      }
    }
    res.end()
  } finally {
    inFlightBodyBytes -= received // 无论成败都归还预算
  }
}
