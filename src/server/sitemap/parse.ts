import { XMLParser } from 'fast-xml-parser'

export interface ParsedUrlNode {
  loc: string
  lastmod: string | null
}

export interface ParsedSitemapDocument {
  type: 'urlset' | 'sitemapindex'
  urls: ParsedUrlNode[]
  childSitemaps: ParsedUrlNode[]
}

const parser = new XMLParser({
  ignoreAttributes: false,
  allowBooleanAttributes: false,
  processEntities: false,
  trimValues: true,
})

export function parseSitemapXml(xml: string): ParsedSitemapDocument {
  const parsed = parser.parse(xml) as Record<string, unknown>

  if (isRecord(parsed.urlset)) {
    return {
      type: 'urlset',
      urls: normalizeNodes(parsed.urlset.url),
      childSitemaps: [],
    }
  }

  if (isRecord(parsed.sitemapindex)) {
    return {
      type: 'sitemapindex',
      urls: [],
      childSitemaps: normalizeNodes(parsed.sitemapindex.sitemap),
    }
  }

  throw new Error('Unsupported Sitemap XML: expected urlset or sitemapindex')
}

function normalizeNodes(input: unknown): ParsedUrlNode[] {
  const nodes = Array.isArray(input) ? input : input ? [input] : []

  return nodes.flatMap((node) => {
    if (!isRecord(node) || typeof node.loc !== 'string') {
      return []
    }

    const loc = node.loc.trim()
    if (!loc) {
      return []
    }

    return [{
      loc,
      lastmod: typeof node.lastmod === 'string' && node.lastmod.trim() ? node.lastmod.trim() : null,
    }]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
