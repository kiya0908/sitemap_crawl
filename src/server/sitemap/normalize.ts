const TRACKING_PARAM_NAMES = new Set(['gclid', 'fbclid', 'msclkid'])

export function normalizeDomain(input: string): string {
  const candidate = input.includes('://') ? input : `https://${input}`
  const url = new URL(candidate)

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS domains are supported')
  }

  return url.hostname.toLowerCase().replace(/^www\./, '')
}

export function normalizeUrl(input: string): string {
  const url = new URL(input)

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported')
  }

  url.protocol = url.protocol.toLowerCase()
  url.hostname = url.hostname.toLowerCase()
  url.hash = ''

  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = ''
  }

  url.pathname = normalizePathname(url.pathname)

  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLowerCase()
    if (normalizedKey.startsWith('utm_') || TRACKING_PARAM_NAMES.has(normalizedKey)) {
      url.searchParams.delete(key)
    }
  }

  const sortedParams = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyOrder = leftKey.localeCompare(rightKey)
    return keyOrder !== 0 ? keyOrder : leftValue.localeCompare(rightValue)
  })

  url.search = ''
  for (const [key, value] of sortedParams) {
    url.searchParams.append(key, value)
  }

  return url.toString()
}

function normalizePathname(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, '/')
  if (collapsed === '/') {
    return '/'
  }

  return collapsed.replace(/\/+$/, '')
}

export function sameRegistrableHost(candidate: string, allowedDomain: string): boolean {
  const hostname = new URL(candidate).hostname.toLowerCase()
  const normalizedAllowed = allowedDomain.toLowerCase().replace(/^www\./, '')
  const normalizedHostname = hostname.replace(/^www\./, '')

  return normalizedHostname === normalizedAllowed || normalizedHostname.endsWith(`.${normalizedAllowed}`)
}
