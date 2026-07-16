import { sha256 } from '../../lib/hash'
import { assertAllowedOutboundUrl } from '../security/outbound'
import {
  OutboundRedirectLimitError,
  ResponseBodyTooLargeError,
  fetchAllowedOutbound,
  readResponseTextLimited,
} from '../security/safe-fetch'
import type { SitemapUrlEntry } from '../types'
import { normalizeUrl } from './normalize'
import { parseSitemapXml } from './parse'

export interface SitemapSeed {
  id: string | null
  url: string
}

export interface ProcessedSitemap {
  sourceId: string | null
  url: string
  parentUrl: string | null
  status: 'success' | 'failed' | 'skipped'
  httpStatus: number | null
  contentHash: string | null
  urlCount: number
  errorCode: string | null
  errorMessage: string | null
}

export interface CollectSitemapsResult {
  entries: SitemapUrlEntry[]
  processed: ProcessedSitemap[]
  discoveredChildren: Array<{ url: string; parentUrl: string }>
  isComplete: boolean
}

interface CollectOptions {
  competitorDomain: string
  seeds: SitemapSeed[]
  fetchImpl?: typeof fetch
  maxDepth?: number
  maxSitemaps?: number
  maxUrls?: number
  maxResponseBytes?: number
  timeoutMs?: number
}

export async function collectSitemapEntries(options: CollectOptions): Promise<CollectSitemapsResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxDepth = options.maxDepth ?? 5
  const maxSitemaps = options.maxSitemaps ?? 100
  const maxUrls = options.maxUrls ?? 10_000
  const maxResponseBytes = options.maxResponseBytes ?? 5_000_000
  const timeoutMs = options.timeoutMs ?? 15_000

  const visited = new Set<string>()
  const entries = new Map<string, SitemapUrlEntry>()
  const processed: ProcessedSitemap[] = []
  const discoveredChildren: Array<{ url: string; parentUrl: string }> = []
  let isComplete = true

  const walk = async (seed: SitemapSeed, depth: number, parentUrl: string | null): Promise<void> => {
    if (depth > maxDepth) {
      isComplete = false
      processed.push(failure(seed, parentUrl, 'SITEMAP_DEPTH_LIMIT', `Maximum Sitemap depth ${maxDepth} exceeded`))
      return
    }

    if (visited.size >= maxSitemaps) {
      isComplete = false
      processed.push(failure(seed, parentUrl, 'SITEMAP_COUNT_LIMIT', `Maximum Sitemap count ${maxSitemaps} exceeded`))
      return
    }

    let normalizedSource: string
    try {
      assertAllowedOutboundUrl(seed.url, options.competitorDomain)
      normalizedSource = normalizeUrl(seed.url)
    } catch (error) {
      isComplete = false
      processed.push(failure(seed, parentUrl, 'SITEMAP_URL_REJECTED', errorMessage(error)))
      return
    }

    if (visited.has(normalizedSource)) {
      processed.push({
        sourceId: seed.id,
        url: seed.url,
        parentUrl,
        status: 'skipped',
        httpStatus: null,
        contentHash: null,
        urlCount: 0,
        errorCode: null,
        errorMessage: 'Already processed in this scan',
      })
      return
    }

    visited.add(normalizedSource)

    try {
      const { response, text: xml } = await fetchWithLimits(
        seed.url,
        options.competitorDomain,
        fetchImpl,
        timeoutMs,
        maxResponseBytes,
      )
      if (!response.ok) {
        throw new SitemapFetchError('SITEMAP_HTTP_ERROR', `HTTP ${response.status}`, response.status)
      }

      const document = parseSitemapXml(xml)
      let localCount = 0

      for (const node of document.urls) {
        if (entries.size >= maxUrls) {
          isComplete = false
          throw new SitemapFetchError('SITEMAP_URL_LIMIT', `Maximum URL count ${maxUrls} exceeded`, response.status)
        }

        try {
          assertAllowedOutboundUrl(node.loc, options.competitorDomain)
          const normalizedUrl = normalizeUrl(node.loc)
          if (!entries.has(normalizedUrl)) {
            entries.set(normalizedUrl, {
              url: node.loc,
              normalizedUrl,
              lastmod: node.lastmod,
              sourceUrl: seed.url,
            })
            localCount += 1
          }
        } catch {
          // Individual off-domain or malformed URLs are ignored without invalidating
          // an otherwise complete Sitemap document.
        }
      }

      processed.push({
        sourceId: seed.id,
        url: seed.url,
        parentUrl,
        status: 'success',
        httpStatus: response.status,
        contentHash: await sha256(xml),
        urlCount: localCount,
        errorCode: null,
        errorMessage: null,
      })

      for (const child of document.childSitemaps) {
        try {
          assertAllowedOutboundUrl(child.loc, options.competitorDomain)
          normalizeUrl(child.loc)
          discoveredChildren.push({ url: child.loc, parentUrl: seed.url })
        } catch {
          // walk records the rejected child in the per-Sitemap result without
          // persisting it as a future enabled source.
        }
        await walk({ id: null, url: child.loc }, depth + 1, seed.url)
      }
    } catch (error) {
      isComplete = false
      const typed = error instanceof SitemapFetchError ? error : null
      processed.push({
        sourceId: seed.id,
        url: seed.url,
        parentUrl,
        status: 'failed',
        httpStatus: typed?.httpStatus ?? null,
        contentHash: null,
        urlCount: 0,
        errorCode: typed?.code ?? 'SITEMAP_FETCH_FAILED',
        errorMessage: errorMessage(error),
      })
    }
  }

  for (const seed of options.seeds) {
    await walk(seed, 0, null)
  }

  return {
    entries: [...entries.values()],
    processed,
    discoveredChildren,
    isComplete,
  }
}

async function fetchWithLimits(
  url: string,
  competitorDomain: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<{ response: Response; text: string }> {
  let response: Response | null = null
  try {
    const fetched = await fetchAllowedOutbound({
      url,
      allowedDomain: competitorDomain,
      fetchImpl,
      timeoutMs,
      init: {
        headers: {
          'User-Agent': 'SitemapCrawl/0.1 (+private SEO monitoring tool)',
          Accept: 'application/xml,text/xml,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
        },
      },
    })
    response = fetched.response
    return { response, text: await readResponseTextLimited(response, maxResponseBytes, timeoutMs) }
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      throw new SitemapFetchError('SITEMAP_RESPONSE_TOO_LARGE', error.message, response?.status ?? null)
    }
    if (error instanceof OutboundRedirectLimitError) {
      throw new SitemapFetchError('SITEMAP_REDIRECT_LIMIT', error.message, error.httpStatus)
    }
    throw error
  }
}

function failure(seed: SitemapSeed, parentUrl: string | null, code: string, message: string): ProcessedSitemap {
  return {
    sourceId: seed.id,
    url: seed.url,
    parentUrl,
    status: 'failed',
    httpStatus: null,
    contentHash: null,
    urlCount: 0,
    errorCode: code,
    errorMessage: message,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

class SitemapFetchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number | null,
  ) {
    super(message)
  }
}
