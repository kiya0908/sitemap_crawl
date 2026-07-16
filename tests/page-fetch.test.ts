import { describe, expect, it } from 'vitest'
import { fetchPageSeo } from '../src/server/page-fetch/fetch-page'

describe('fetchPageSeo', () => {
  it('rejects an off-domain redirect without requesting its target', async () => {
    const requested: string[] = []
    const fetchMock = (async (input: string | URL | Request) => {
      requested.push(String(input))
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://attacker.example/page' },
      })
    }) as typeof fetch

    const result = await fetchPageSeo({
      url: 'https://example.com/new-page',
      competitorDomain: 'example.com',
      fetchImpl: fetchMock,
    })

    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('PAGE_FETCH_FAILED')
    expect(requested).toEqual(['https://example.com/new-page'])
  })

  it('rejects chunked HTML before buffering beyond the configured limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html>1234'))
        controller.enqueue(new TextEncoder().encode('5678</html>'))
        controller.close()
      },
    })
    const fetchMock = (async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })) as typeof fetch

    const result = await fetchPageSeo({
      url: 'https://example.com/large',
      competitorDomain: 'example.com',
      fetchImpl: fetchMock,
      maxResponseBytes: 12,
    })

    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('PAGE_RESPONSE_TOO_LARGE')
  })
})
