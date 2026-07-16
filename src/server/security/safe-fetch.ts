import { assertAllowedOutboundUrl } from './outbound'

interface FetchAllowedOutboundOptions {
  url: string
  allowedDomain: string
  fetchImpl?: typeof fetch
  init?: Omit<RequestInit, 'redirect' | 'signal'>
  timeoutMs?: number
  maxRedirects?: number
}

export interface AllowedOutboundResponse {
  response: Response
  finalUrl: string
  redirectChain: string[]
}

export class OutboundRedirectLimitError extends Error {
  readonly code = 'OUTBOUND_REDIRECT_LIMIT'

  constructor(readonly maxRedirects: number, readonly httpStatus: number) {
    super(`More than ${maxRedirects} redirects`)
    this.name = 'OutboundRedirectLimitError'
  }
}

export class ResponseBodyTooLargeError extends Error {
  readonly code = 'RESPONSE_BODY_TOO_LARGE'

  constructor(readonly maxBytes: number) {
    super(`Response exceeds ${maxBytes} bytes`)
    this.name = 'ResponseBodyTooLargeError'
  }
}

export class ResponseBodyTimeoutError extends Error {
  readonly code = 'RESPONSE_BODY_TIMEOUT'

  constructor(readonly timeoutMs: number) {
    super(`Response body was not received within ${timeoutMs}ms`)
    this.name = 'ResponseBodyTimeoutError'
  }
}

export async function fetchAllowedOutbound(
  options: FetchAllowedOutboundOptions,
): Promise<AllowedOutboundResponse> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxRedirects = options.maxRedirects ?? 5
  const redirectChain: string[] = []
  let currentUrl = options.url

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    assertAllowedOutboundUrl(currentUrl, options.allowedDomain)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
      response = await fetchImpl(currentUrl, {
        ...options.init,
        redirect: 'manual',
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    const location = response.headers.get('location')
    if (!isRedirect(response.status) || !location) {
      return { response, finalUrl: currentUrl, redirectChain }
    }

    if (response.body) await response.body.cancel()
    if (redirectCount === maxRedirects) {
      throw new OutboundRedirectLimitError(maxRedirects, response.status)
    }

    const nextUrl = new URL(location, currentUrl).toString()
    assertAllowedOutboundUrl(nextUrl, options.allowedDomain)
    redirectChain.push(nextUrl)
    currentUrl = nextUrl
  }

  throw new OutboundRedirectLimitError(maxRedirects, 0)
}

export async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
  timeoutMs = 15_000,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ResponseBodyTooLargeError(maxBytes)
  }

  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const timeoutError = new ResponseBodyTimeoutError(timeoutMs)
  let rejectOnTimeout: ((reason: ResponseBodyTimeoutError) => void) | null = null
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectOnTimeout = reject
  })
  const handleTimeout = () => rejectOnTimeout?.(timeoutError)
  timeoutSignal.addEventListener('abort', handleTimeout, { once: true })

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeoutPromise])
      if (done) break
      if (!value) continue

      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel(new ResponseBodyTooLargeError(maxBytes))
        throw new ResponseBodyTooLargeError(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    timeoutSignal.removeEventListener('abort', handleTimeout)
    if (timeoutSignal.aborted) {
      try {
        await reader.cancel(timeoutError)
      } catch {
        // The underlying stream may already be errored or canceled.
      }
    }
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status)
}
