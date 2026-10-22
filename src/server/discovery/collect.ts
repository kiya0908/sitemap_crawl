import { z } from 'zod'
import { fetchAllowedOutbound, readResponseTextLimited } from '../security/safe-fetch'
import { normalizeUrl } from '../sitemap/normalize'
import type { SitemapUrlEntry } from '../types'

export type DiscoveryProvider = 'media_zones' | 'dreamina_archive'
export const MEDIA_INDEX = 'https://vapi.media.io/v1/workflow/zone/list'
export const DREAMINA_ROOT = 'https://dreamina.capcut.com/ai-video'
const CATEGORIES = ['productivity', 'ai-trending', 'ai-drama', 'editing-tools']
const MAX_REQUESTS = 100
const MAX_URLS = 1000
export const COVERAGE_WARNING = 'LIMITED_COVERAGE: Only URLs linked by the monitored public sources are observed. Zero discoveries does not prove no new pages. First seen is not publication time.'

export interface DiscoveryCollection {
  entries: SitemapUrlEntry[]
  sourceComplete: boolean
  requests: number
  errors: string[]
}

const mediaSchema = z.object({
  code: z.literal(0),
  data: z.object({
    paginate: z.object({ total: z.number().int().nonnegative() }),
    list: z.array(z.object({
      recommend_data: z.object({ en: z.array(z.object({ turn_url: z.string().nullish() })).nullish() }).nullish(),
      extra_Config: z.object({ en: z.object({ turn_url: z.string().nullish() }).nullish() }).nullish(),
    })).min(1),
  }),
})

function entry(raw: string, base: string, provider: DiscoveryProvider): SitemapUrlEntry | null {
  try {
    const url = new URL(raw, base)
    const host = provider === 'media_zones' ? 'www.media.io' : 'dreamina.capcut.com'
    const prefix = provider === 'media_zones' ? '/ai/explore/zone/' : '/ai-video/'
    if (url.hostname !== host || url.port || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null
    if (!url.pathname.startsWith(prefix) || !url.pathname.slice(prefix.length).replace(/\/+$/, '')) return null
    url.protocol = 'https:'
    return { url: url.href, normalizedUrl: normalizeUrl(url.href), lastmod: null, sourceUrl: base, discoveryMethod: provider }
  } catch { return null }
}

export function parseMediaZones(text: string): SitemapUrlEntry[] {
  const data = mediaSchema.parse(JSON.parse(text)).data
  // The observed endpoint returns total=0 for its unpaginated list. A future
  // positive total larger than the payload must not silently establish a baseline.
  if (data.paginate.total > data.list.length) throw new Error('SOURCE_PAGINATION_CHANGED')
  const entries = new Map<string, SitemapUrlEntry>()
  for (const zone of data.list) {
    const urls = [zone.extra_Config?.en?.turn_url, ...(zone.recommend_data?.en ?? []).map(card => card.turn_url)]
    for (const url of urls) {
      const candidate = url ? entry(url, MEDIA_INDEX, 'media_zones') : null
      if (candidate) entries.set(candidate.normalizedUrl, candidate)
    }
  }
  if (!entries.size) throw new Error('SOURCE_EMPTY_OR_CHANGED')
  if (entries.size > MAX_URLS) throw new Error('SOURCE_URL_LIMIT')
  return [...entries.values()]
}

const archiveSchema = z.object({ loaderData: z.object({ $: z.object({ article: z.object({
  path: z.string(), schema: z.object({ blocks: z.array(z.object({ type: z.string(), data: z.unknown() })) }),
}) }) }) })
const articleListSchema = z.object({
  pageSize: z.number().int().positive().max(100), total: z.number().int().positive().max(10_000),
  items: z.array(z.object({ path: z.string() })).min(1),
})

export function parseDreaminaArchive(html: string, sourceUrl: string) {
  const entries = new Map<string, SitemapUrlEntry>()
  const pagination: string[] = []
  const source = new URL(sourceUrl)
  const isCategory = CATEGORIES.includes(source.pathname.slice('/ai-video/'.length))
  if (isCategory) {
    const script = html.match(/<script\b[^>]*\bid=["']__MODERN_ROUTER_DATA__["'][^>]*>([\s\S]*?)<\/script\s*>/i)
    if (!script?.[1]) throw new Error('SOURCE_ARCHIVE_SCHEMA_CHANGED')
    const article = archiveSchema.parse(JSON.parse(script[1])).loaderData.$.article
    if (article.path !== source.pathname) throw new Error('SOURCE_ARCHIVE_PATH_MISMATCH')
    const blocks = article.schema.blocks.filter(block => block.type === 'default:seo:article-list')
    if (blocks.length !== 1) throw new Error('SOURCE_ARCHIVE_SCHEMA_CHANGED')
    const list = articleListSchema.parse(blocks[0]!.data)
    const page = Number(source.searchParams.get('pageNo') ?? 1)
    const maxPage = Math.ceil(list.total / list.pageSize)
    if (maxPage > MAX_REQUESTS) throw new Error('SOURCE_PAGINATION_LIMIT')
    if (list.items.length !== Math.min(list.pageSize, list.total - (page - 1) * list.pageSize)) throw new Error('SOURCE_PAGE_TRUNCATED')
    for (const item of list.items) {
      const candidate = entry(item.path, sourceUrl, 'dreamina_archive')
      if (candidate && !CATEGORIES.includes(new URL(candidate.normalizedUrl).pathname.slice('/ai-video/'.length))) entries.set(candidate.normalizedUrl, candidate)
    }
    for (let i = 2; i <= maxPage; i++) pagination.push(`${source.origin}${source.pathname}?pageNo=${i}`)
    // Some older articles are under /create or /resource. They still prove a
    // nonempty archive response but must not enter this monitor's URL scope.
    return { entries: [...entries.values()], pagination, fingerprint: list.items.map(item => item.path).sort().join('\n'), total: list.total }
  }
  const clean = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
  for (const match of clean.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const raw = (match[1] ?? match[2] ?? '').replace(/&amp;|&#38;/g, '&')
    const candidate = entry(raw, sourceUrl, 'dreamina_archive')
    if (candidate && !CATEGORIES.includes(new URL(candidate.normalizedUrl).pathname.slice('/ai-video/'.length))) entries.set(candidate.normalizedUrl, candidate)
  }
  if (!entries.size) throw new Error('SOURCE_EMPTY_OR_CHANGED')
  return { entries: [...entries.values()], pagination, fingerprint: '', total: 0 }
}

export async function collectPublicPages(provider: DiscoveryProvider, fetchImpl: typeof fetch = fetch): Promise<DiscoveryCollection> {
  const result: DiscoveryCollection = { entries: [], sourceComplete: false, requests: 0, errors: [] }
  const entries = new Map<string, SitemapUrlEntry>()
  const queue = provider === 'media_zones' ? [MEDIA_INDEX] : [DREAMINA_ROOT, ...CATEGORIES.map(c => `${DREAMINA_ROOT}/${c}`)]
  const visited = new Set<string>()
  const startedAt = Date.now()
  let lastSource = ''
  const pageFingerprints = new Map<string, Set<string>>()
  const categoryTotals = new Map<string, number>()
  try {
    while (queue.length) {
      const url = queue.shift()!
      if (visited.has(url)) continue
      if (Date.now() - startedAt > 300_000) throw new Error('SOURCE_TIME_BUDGET')
      if (visited.size >= MAX_REQUESTS) throw new Error('SOURCE_REQUEST_LIMIT')
      visited.add(url)
      lastSource = url
      if (result.requests) await new Promise(resolve => setTimeout(resolve, 250))
      result.requests++
      const { response, finalUrl } = await fetchAllowedOutbound({
        url, allowedDomain: new URL(url).hostname, fetchImpl, maxRedirects: 0,
        init: { headers: { 'User-Agent': 'SitemapCrawl/0.1 (+public-page-monitor)', Accept: provider === 'media_zones' ? 'application/json' : 'text/html' } },
      })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`SOURCE_HTTP_${response.status}`) }
      const type = response.headers.get('content-type') ?? ''
      if (!(provider === 'media_zones' ? /application\/json/i : /text\/html/i).test(type)) {
        await response.body?.cancel(); throw new Error('SOURCE_CONTENT_TYPE')
      }
      const text = await readResponseTextLimited(response, 2_000_000)
      const parsed = provider === 'media_zones' ? { entries: parseMediaZones(text), pagination: [], fingerprint: '', total: 0 } : parseDreaminaArchive(text, finalUrl)
      // Catch sites ignoring pageNo and returning page 1 for every page.
      if (provider === 'dreamina_archive' && new URL(url).pathname !== '/ai-video') {
        const path = new URL(url).pathname
        const fingerprint = parsed.fingerprint
        if (categoryTotals.has(path) && categoryTotals.get(path) !== parsed.total) throw new Error('SOURCE_CHANGED_DURING_SCAN')
        categoryTotals.set(path, parsed.total)
        const seen = pageFingerprints.get(path) ?? new Set<string>()
        if (seen.has(fingerprint)) throw new Error('SOURCE_REPEATED_PAGE')
        seen.add(fingerprint); pageFingerprints.set(path, seen)
      }
      for (const item of parsed.entries) entries.set(item.normalizedUrl, item)
      if (entries.size > MAX_URLS) throw new Error('SOURCE_URL_LIMIT')
      for (const next of parsed.pagination) if (!visited.has(next) && !queue.includes(next)) queue.push(next)
    }
    result.sourceComplete = true
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message.slice(0, 500) : 'SOURCE_FAILED')
    if (lastSource) result.errors.push(`SOURCE_URL: ${lastSource}`)
  }
  result.entries = [...entries.values()].slice(0, MAX_URLS)
  result.errors.push(COVERAGE_WARNING)
  return result
}
