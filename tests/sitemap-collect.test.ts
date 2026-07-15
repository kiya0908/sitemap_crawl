import { describe, expect, it } from 'vitest'
import { collectSitemapEntries } from '../src/server/sitemap/collect'

describe('collectSitemapEntries', () => {
  it('recursively collects and deduplicates URLs from child Sitemaps', async () => {
    const responses: Record<string, string> = {
      'https://example.com/sitemap.xml': `
        <sitemapindex>
          <sitemap><loc>https://example.com/products.xml</loc></sitemap>
          <sitemap><loc>https://example.com/blog.xml</loc></sitemap>
        </sitemapindex>`,
      'https://example.com/products.xml': `
        <urlset>
          <url><loc>https://example.com/a?utm_source=test</loc></url>
          <url><loc>https://example.com/b</loc></url>
        </urlset>`,
      'https://example.com/blog.xml': `
        <urlset>
          <url><loc>https://example.com/a</loc></url>
          <url><loc>https://example.com/c</loc></url>
        </urlset>`,
    }
    const mockFetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const body = responses[url]
      return body
        ? new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } })
        : new Response('not found', { status: 404 })
    }

    const result = await collectSitemapEntries({
      competitorDomain: 'example.com',
      seeds: [{ id: 'root', url: 'https://example.com/sitemap.xml' }],
      fetchImpl: mockFetch as typeof fetch,
    })

    expect(result.isComplete).toBe(true)
    expect(result.entries.map((item) => item.normalizedUrl).sort()).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ])
    expect(result.discoveredChildren).toHaveLength(2)
  })

  it('marks the scan incomplete when a child Sitemap fails', async () => {
    const mockFetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/sitemap.xml')) {
        return new Response('<sitemapindex><sitemap><loc>https://example.com/missing.xml</loc></sitemap></sitemapindex>')
      }
      return new Response('missing', { status: 503 })
    }

    const result = await collectSitemapEntries({
      competitorDomain: 'example.com',
      seeds: [{ id: 'root', url: 'https://example.com/sitemap.xml' }],
      fetchImpl: mockFetch as typeof fetch,
    })

    expect(result.isComplete).toBe(false)
    expect(result.processed.some((item) => item.status === 'failed')).toBe(true)
  })
})
