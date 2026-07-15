import { sameRegistrableHost } from '../sitemap/normalize'

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain'])

export function assertAllowedOutboundUrl(input: string, allowedDomain: string): URL {
  const url = new URL(input)

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS outbound requests are allowed')
  }

  if (url.username || url.password) {
    throw new Error('Credential-bearing URLs are not allowed')
  }

  const hostname = url.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error('Localhost targets are not allowed')
  }

  if (isBlockedIpLiteral(hostname)) {
    throw new Error('Private, loopback, or metadata IP targets are not allowed')
  }

  if (!sameRegistrableHost(url.toString(), allowedDomain)) {
    throw new Error(`Outbound host ${hostname} is outside competitor domain ${allowedDomain}`)
  }

  return url
}

function isBlockedIpLiteral(hostname: string): boolean {
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number)
    if (octets.some((value) => value < 0 || value > 255)) return true

    const [a = 0, b = 0] = octets
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    )
  }

  const value = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (value.includes(':')) {
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
  }

  return false
}
