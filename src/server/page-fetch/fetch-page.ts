import { sha256 } from '../../lib/hash'
import { assertAllowedOutboundUrl } from '../security/outbound'

export interface PageSeoResult {
  status: 'success' | 'failed' | 'unsupported'
  httpStatus: number | null
  finalUrl: string
  redirectChain: string[]
  contentType: string | null
  title: string | null
  metaDescription: string | null
  h1: string | null
  h2: string[]
  canonicalUrl: string | null
  robotsMeta: string | null
  pageLanguage: string | null
  contentExcerpt: string | null
  contentHash: string | null
  errorCode: string | null
  errorMessage: string | null
}

interface FetchPageOptions {
  url: string
  competitorDomain: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
  maxRedirects?: number
  maxExcerptChars?: number
}

export async function fetchPageSeo(options: FetchPageOptions): Promise<PageSeoResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxResponseBytes = options.maxResponseBytes ?? 1_500_000
  const maxRedirects = options.maxRedirects ?? 5
  const maxExcerptChars = options.maxExcerptChars ?? 10_000
  const redirectChain: string[] = []
  let currentUrl = options.url

  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      assertAllowedOutboundUrl(currentUrl, options.competitorDomain)
      const response = await fetchWithTimeout(currentUrl, fetchImpl, timeoutMs)
      const location = response.headers.get('location')

      if (isRedirect(response.status) && location) {
        if (redirectCount === maxRedirects) {
          throw new PageFetchError('PAGE_REDIRECT_LIMIT', `More than ${maxRedirects} redirects`, response.status)
        }
        const nextUrl = new URL(location, currentUrl).toString()
        assertAllowedOutboundUrl(nextUrl, options.competitorDomain)
        redirectChain.push(nextUrl)
        currentUrl = nextUrl
        continue
      }

      const contentType = response.headers.get('content-type')
      if (!response.ok) {
        throw new PageFetchError('PAGE_HTTP_ERROR', `HTTP ${response.status}`, response.status)
      }

      if (!contentType?.toLowerCase().includes('text/html')) {
        return emptyResult({
          status: 'unsupported',
          httpStatus: response.status,
          finalUrl: currentUrl,
          redirectChain,
          contentType,
          errorCode: 'PAGE_UNSUPPORTED_CONTENT_TYPE',
          errorMessage: contentType ? `Unsupported content type: ${contentType}` : 'Missing content type',
        })
      }

      const declaredLength = Number(response.headers.get('content-length') ?? 0)
      if (declaredLength > maxResponseBytes) {
        throw new PageFetchError('PAGE_RESPONSE_TOO_LARGE', `Page exceeds ${maxResponseBytes} bytes`, response.status)
      }

      const html = await response.text()
      const actualBytes = new TextEncoder().encode(html).byteLength
      if (actualBytes > maxResponseBytes) {
        throw new PageFetchError('PAGE_RESPONSE_TOO_LARGE', `Page exceeds ${maxResponseBytes} bytes`, response.status)
      }

      const extracted = extractSeo(html, currentUrl, maxExcerptChars)
      return {
        status: 'success',
        httpStatus: response.status,
        finalUrl: currentUrl,
        redirectChain,
        contentType,
        ...extracted,
        contentHash: await sha256(extracted.contentExcerpt ?? ''),
        errorCode: null,
        errorMessage: null,
      }
    }
  } catch (error) {
    const typed = error instanceof PageFetchError ? error : null
    return emptyResult({
      status: 'failed',
      httpStatus: typed?.httpStatus ?? null,
      finalUrl: currentUrl,
      redirectChain,
      contentType: null,
      errorCode: typed?.code ?? (error instanceof DOMException && error.name === 'AbortError' ? 'PAGE_FETCH_TIMEOUT' : 'PAGE_FETCH_FAILED'),
      errorMessage: error instanceof Error ? error.message : 'Unknown page fetch error',
    })
  }

  return emptyResult({
    status: 'failed',
    httpStatus: null,
    finalUrl: currentUrl,
    redirectChain,
    contentType: null,
    errorCode: 'PAGE_FETCH_FAILED',
    errorMessage: 'Unexpected page fetch state',
  })
}

function extractSeo(html: string, baseUrl: string, maxExcerptChars: number): Omit<PageSeoResult,
  'status' | 'httpStatus' | 'finalUrl' | 'redirectChain' | 'contentType' | 'contentHash' | 'errorCode' | 'errorMessage'> {
  const title = firstTagText(html, 'title')
  const h1 = firstTagText(html, 'h1')
  const h2 = allTagText(html, 'h2').slice(0, 30)
  const metaDescription = metaContent(html, 'description')
  const robotsMeta = metaContent(html, 'robots')
  const canonical = linkHref(html, 'canonical')
  const languageMatch = html.match(/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i)
  const pageLanguage = languageMatch?.[1]?.trim() || null
  const contentExcerpt = cleanVisibleText(html).slice(0, maxExcerptChars) || null

  return {
    title,
    metaDescription,
    h1,
    h2,
    canonicalUrl: canonical ? new URL(canonical, baseUrl).toString() : null,
    robotsMeta,
    pageLanguage,
    contentExcerpt,
  }
}

function firstTagText(html: string, tag: string): string | null {
  return allTagText(html, tag)[0] ?? null
}

function allTagText(html: string, tag: string): string[] {
  const matches = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))]
  return matches
    .map((match) => normalizeText(stripTags(match[1] ?? '')))
    .filter(Boolean)
}

function metaContent(html: string, name: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    const tagName = attribute(tag, 'name')?.toLowerCase()
    if (tagName === name.toLowerCase()) return attribute(tag, 'content')
  }
  return null
}

function linkHref(html: string, rel: string): string | null {
  const tags = html.match(/<link\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    const relation = attribute(tag, 'rel')?.toLowerCase().split(/\s+/) ?? []
    if (relation.includes(rel.toLowerCase())) return attribute(tag, 'href')
  }
  return null
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, 'i'))
  return decodeEntities((match?.[1] ?? match?.[2] ?? '').trim()) || null
}

function cleanVisibleText(html: string): string {
  return normalizeText(
    stripTags(
      html
        .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<(nav|footer|header)\b[\s\S]*?<\/\1>/gi, ' '),
    ),
  )
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ')
}

function normalizeText(value: string): string {
  return decodeEntities(value).replace(/\s+/g, ' ').trim()
}

function decodeEntities(value: string): string {
  const entities: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  }
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return entities[entity.toLowerCase()] ?? `&${entity};`
  })
}

async function fetchWithTimeout(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': 'SitemapCrawl/0.1 (+private SEO monitoring tool)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      },
    })
  } finally {
    clearTimeout(timeout)
  }
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status)
}

function emptyResult(input: Pick<PageSeoResult,
  'status' | 'httpStatus' | 'finalUrl' | 'redirectChain' | 'contentType' | 'errorCode' | 'errorMessage'>): PageSeoResult {
  return {
    ...input,
    title: null,
    metaDescription: null,
    h1: null,
    h2: [],
    canonicalUrl: null,
    robotsMeta: null,
    pageLanguage: null,
    contentExcerpt: null,
    contentHash: null,
  }
}

class PageFetchError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus: number | null) {
    super(message)
  }
}
