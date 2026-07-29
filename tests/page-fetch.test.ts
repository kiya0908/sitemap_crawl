import { describe, expect, it } from 'vitest'
import { SEO_CONTENT_EXCERPT_MAX_CHARS } from '../src/lib/seo-content'
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

  it('limits the default cleaned excerpt to 8000 characters without returning a content hash', async () => {
    const fetchMock = htmlFetch(`<html><body>${'a'.repeat(SEO_CONTENT_EXCERPT_MAX_CHARS + 200)}</body></html>`)

    const result = await fetchPageSeo({
      url: 'https://example.com/long-page',
      competitorDomain: 'example.com',
      fetchImpl: fetchMock,
    })

    expect(result.status).toBe('success')
    expect(result.contentExcerpt).toHaveLength(SEO_CONTENT_EXCERPT_MAX_CHARS)
    expect(result).not.toHaveProperty('contentHash')
  })

  it('honors a smaller custom excerpt limit', async () => {
    const fetchMock = htmlFetch(`<html><body>${'b'.repeat(500)}</body></html>`)

    const result = await fetchPageSeo({
      url: 'https://example.com/custom-limit',
      competitorDomain: 'example.com',
      fetchImpl: fetchMock,
      maxExcerptChars: 100,
    })

    expect(result.status).toBe('success')
    expect(result.contentExcerpt).toHaveLength(100)
  })

  it('removes page chrome and non-visible content from the excerpt', async () => {
    const fetchMock = htmlFetch(`
      <html>
        <body>
          <header>Header text</header>
          <nav>Navigation text</nav>
          <main>Main content</main>
          <footer>Footer text</footer>
          <script>Script text</script>
          <style>.hidden { display: none; }</style>
        </body>
      </html>
    `)

    const result = await fetchPageSeo({
      url: 'https://example.com/cleaned',
      competitorDomain: 'example.com',
      fetchImpl: fetchMock,
    })

    expect(result.status).toBe('success')
    expect(result.contentExcerpt).toContain('Main content')
    expect(result.contentExcerpt).not.toContain('Header text')
    expect(result.contentExcerpt).not.toContain('Navigation text')
    expect(result.contentExcerpt).not.toContain('Footer text')
    expect(result.contentExcerpt).not.toContain('Script text')
    expect(result.contentExcerpt).not.toContain('display: none')
  })
})

function htmlFetch(html: string): typeof fetch {
  return (async () => new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })) as typeof fetch
}
