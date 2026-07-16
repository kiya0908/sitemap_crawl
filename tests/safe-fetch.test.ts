import { describe, expect, it } from 'vitest'
import {
  ResponseBodyTimeoutError,
  ResponseBodyTooLargeError,
  fetchAllowedOutbound,
  readResponseTextLimited,
} from '../src/server/security/safe-fetch'

describe('safe outbound fetch', () => {
  it('rejects an off-domain redirect before issuing the redirected request', async () => {
    const requested: string[] = []
    const fetchMock = (async (input: string | URL | Request) => {
      requested.push(String(input))
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data' },
      })
    }) as typeof fetch

    await expect(fetchAllowedOutbound({
      url: 'https://example.com/sitemap.xml',
      allowedDomain: 'example.com',
      fetchImpl: fetchMock,
    })).rejects.toThrow('Private, loopback, or metadata IP')
    expect(requested).toEqual(['https://example.com/sitemap.xml'])
  })

  it('follows and records a validated same-domain redirect', async () => {
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input)
      return url.endsWith('/old.xml')
        ? new Response(null, { status: 301, headers: { Location: '/new.xml' } })
        : new Response('<urlset />', { status: 200 })
    }) as typeof fetch

    const result = await fetchAllowedOutbound({
      url: 'https://example.com/old.xml',
      allowedDomain: 'example.com',
      fetchImpl: fetchMock,
    })

    expect(result.finalUrl).toBe('https://example.com/new.xml')
    expect(result.redirectChain).toEqual(['https://example.com/new.xml'])
  })
})

describe('readResponseTextLimited', () => {
  it('rejects a chunked response as soon as it exceeds the byte limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('1234'))
        controller.enqueue(new TextEncoder().encode('5678'))
        controller.close()
      },
    })

    await expect(readResponseTextLimited(new Response(body), 6))
      .rejects.toBeInstanceOf(ResponseBodyTooLargeError)
  })

  it('decodes a response that stays within the byte limit', async () => {
    await expect(readResponseTextLimited(new Response('中文 SEO'), 32)).resolves.toBe('中文 SEO')
  })

  it('cancels a response body that does not finish before the deadline', async () => {
    let canceled = false
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined)
      },
      cancel() {
        canceled = true
      },
    })

    await expect(readResponseTextLimited(new Response(body), 32, 10))
      .rejects.toBeInstanceOf(ResponseBodyTimeoutError)
    expect(canceled).toBe(true)
  })
})
