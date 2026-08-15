/** Same-origin and DNS-rebinding fence for the memory HTTP endpoints. */
import type { IncomingMessage } from 'node:http'

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function explicitPort(authority: string, parsed: URL): string {
  if (parsed.port !== '') return parsed.port
  return new URL(`https://${authority}`).port
}

function canonicalAuthority(authority: string, parsed: URL): string {
  const port = explicitPort(authority, parsed)
  return port === '' ? parsed.hostname : `${parsed.hostname}:${port}`
}

/**
 * Reject a configured authority that WHATWG parsing would silently rewrite.
 * @param authority - configured bare host or host:port value.
 */
export function assertTrustedAuthority(authority: string): void {
  const parsed = parseAuthority(authority)
  if (parsed !== undefined && canonicalAuthority(authority, parsed) === authority.toLowerCase()) return
  throw new Error(`host-memory: trustedHosts entry ${JSON.stringify(authority)} is not a bare host[:port] authority`)
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

function isLoopbackAddress(remoteAddress: string): boolean {
  if (remoteAddress === '::1' || remoteAddress.startsWith('::ffff:127.')) return true
  return isLoopbackHostname(remoteAddress)
}

function isTrustedAuthority(host: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((authority) => {
    const parsed = parseAuthority(authority)
    if (parsed === undefined) return false
    return explicitPort(authority, parsed) === ''
      ? parsed.hostname === host.hostname
      : parsed.host === host.host
  })
}

/**
 * Permit loopback or configured Host authorities and same-origin browser initiators.
 * @param req - incoming memory request.
 * @param trustedHosts - validated deployment authorities.
 * @returns whether the request passes Host, Fetch Metadata, and Origin checks.
 */
export function isTrustedMemoryRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const hostHeader = req.headers.host
  if (hostHeader === undefined) return false
  const host = parseAuthority(hostHeader)
  if (host === undefined) return false
  // 对等地址围栏:LAN 客户端伪造 Host 头时,非回环 peer 必须命中 trustedHosts。
  const remote = req.socket?.remoteAddress
  if (remote !== undefined && !isLoopbackAddress(remote) && !isTrustedAuthority(host, trustedHosts)) return false
  if (!isLoopbackHostname(host.hostname) && !isTrustedAuthority(host, trustedHosts)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host.host
  } catch {
    return false
  }
}
