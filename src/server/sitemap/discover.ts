import { assertAllowedOutboundUrl } from '../security/outbound'
import { fetchAllowedOutbound, readResponseTextLimited } from '../security/safe-fetch'
import { normalizeUrl } from './normalize'

export interface DiscoveredRootSitemap {
  url: string
  sourceType: 'robots' | 'common_path'
}

export async function discoverRootSitemaps(
  domain: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredRootSitemap[]> {
  const candidates = new Map<string, DiscoveredRootSitemap>()
  const base = `https://${domain}`

  try {
    const robotsUrl = `${base}/robots.txt`
    assertAllowedOutboundUrl(robotsUrl, domain)
    const { response } = await fetchAllowedOutbound({
      url: robotsUrl,
      allowedDomain: domain,
      fetchImpl,
      timeoutMs: 10_000,
      init: { headers: { 'User-Agent': 'SitemapCrawl/0.1 (+private SEO monitoring tool)' } },
    })
    if (response.ok) {
      const text = await readResponseTextLimited(response, 250_000, 10_000)
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*Sitemap\s*:\s*(\S+)\s*$/i)
        if (!match?.[1]) continue
        try {
          assertAllowedOutboundUrl(match[1], domain)
          candidates.set(normalizeUrl(match[1]), { url: match[1], sourceType: 'robots' })
        } catch {
          // Ignore malformed or off-domain declarations.
        }
      }
    }
  } catch {
    // Common paths remain available as fallback.
  }

  for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml']) {
    const url = `${base}${path}`
    try {
      const { response } = await fetchAllowedOutbound({
        url,
        allowedDomain: domain,
        fetchImpl,
        timeoutMs: 10_000,
        init: {
          method: 'GET',
          headers: {
            'User-Agent': 'SitemapCrawl/0.1 (+private SEO monitoring tool)',
            Range: 'bytes=0-4095',
          },
        },
      })
      if (!response.ok) continue
      const preview = await readResponseTextLimited(response, 4_096, 10_000)
      if (!/<(?:urlset|sitemapindex)\b/i.test(preview)) continue
      const normalized = normalizeUrl(url)
      if (!candidates.has(normalized)) candidates.set(normalized, { url, sourceType: 'common_path' })
    } catch {
      // A failed common path is not an overall discovery failure.
    }
  }

  return [...candidates.values()]
}
