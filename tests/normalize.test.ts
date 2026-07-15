import { describe, expect, it } from 'vitest'
import { assertAllowedOutboundUrl } from '../src/server/security/outbound'
import { normalizeDomain, normalizeUrl } from '../src/server/sitemap/normalize'

describe('normalizeUrl', () => {
  it('normalizes case, default ports, fragments, trailing slashes, and tracking params', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/products/item/?utm_source=x&b=2&a=1#details'))
      .toBe('https://example.com/products/item?a=1&b=2')
  })

  it('keeps business query parameters and sorts duplicate values', () => {
    expect(normalizeUrl('https://example.com/search?size=large&q=mixer&size=small'))
      .toBe('https://example.com/search?q=mixer&size=large&size=small')
  })

  it('keeps the root slash', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/')
  })
})

describe('normalizeDomain', () => {
  it('accepts a bare domain and removes www', () => {
    expect(normalizeDomain('WWW.Example.com')).toBe('example.com')
  })
})

describe('outbound request guard', () => {
  it('allows the competitor domain and subdomains', () => {
    expect(assertAllowedOutboundUrl('https://www.example.com/sitemap.xml', 'example.com').hostname)
      .toBe('www.example.com')
  })

  it('rejects localhost, private IPs, and unrelated domains', () => {
    expect(() => assertAllowedOutboundUrl('http://localhost/sitemap.xml', 'example.com')).toThrow()
    expect(() => assertAllowedOutboundUrl('http://169.254.169.254/latest/meta-data', 'example.com')).toThrow()
    expect(() => assertAllowedOutboundUrl('https://attacker.example/sitemap.xml', 'example.com')).toThrow()
  })
})
