import { describe, expect, it } from 'vitest'
import { parseSitemapXml } from '../src/server/sitemap/parse'

describe('parseSitemapXml', () => {
  it('parses a urlset with lastmod', () => {
    const result = parseSitemapXml(`<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/a</loc><lastmod>2026-07-01</lastmod></url>
        <url><loc>https://example.com/b</loc></url>
      </urlset>`)

    expect(result.type).toBe('urlset')
    expect(result.urls).toEqual([
      { loc: 'https://example.com/a', lastmod: '2026-07-01' },
      { loc: 'https://example.com/b', lastmod: null },
    ])
  })

  it('parses a Sitemap index', () => {
    const result = parseSitemapXml(`
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/products.xml</loc></sitemap>
        <sitemap><loc>https://example.com/blog.xml</loc></sitemap>
      </sitemapindex>`)

    expect(result.type).toBe('sitemapindex')
    expect(result.childSitemaps.map((item) => item.loc)).toEqual([
      'https://example.com/products.xml',
      'https://example.com/blog.xml',
    ])
  })

  it('rejects unsupported XML', () => {
    expect(() => parseSitemapXml('<rss></rss>')).toThrow('expected urlset or sitemapindex')
  })
})
