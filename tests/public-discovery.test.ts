import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { collectPublicPages, parseMediaZones, parseDreaminaArchive, MEDIA_INDEX, DREAMINA_ROOT } from '../src/server/discovery/collect'
import { runCompetitorScan } from '../src/server/scans/orchestrator'
import { discoveryFeed } from '../src/server/discovery/feed'
import { competitorScanCron } from '../src/lib/scan-schedule'

const connections: DatabaseSync[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const sql of connections.splice(0)) sql.close() })

function fixture() {
  const sql = new DatabaseSync(':memory:'); connections.push(sql)
  sql.exec('PRAGMA foreign_keys = ON')
  for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) sql.exec(readFileSync(`migrations/${file}`, 'utf8'))
  const prepare = (query: string) => {
    let params: Array<string | number | null> = []
    const statement = {
      bind: (...values: Array<string | number | null>) => { params = values; return statement },
      all: async () => ({ results: sql.prepare(query).all(...params) }),
      first: async () => sql.prepare(query).get(...params) ?? null,
      run: async () => sql.prepare(query).run(...params),
    }
    return statement
  }
  const db = { prepare, batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
    sql.exec('BEGIN')
    try { const rows = []; for (const s of statements) rows.push(await s.run()); sql.exec('COMMIT'); return rows }
    catch (error) { sql.exec('ROLLBACK'); throw error }
  } } as unknown as D1Database
  return { sql, db, env: { DB: db, OPENROUTER_API_KEY: '', OPENROUTER_MODEL: 'mock', OPENROUTER_SITE_URL: '', OPENROUTER_APP_NAME: 'test', AI_PROMPT_VERSION: 'test' } as unknown as Env }
}

const zoneUrl = (slug: string) => `https://www.media.io/ai/explore/zone/${slug}`
const media = (slugs: string[]) => JSON.stringify({ code: 0, data: { paginate: { total: 0 }, list: [{ recommend_data: { en: slugs.map(slug => ({ turn_url: zoneUrl(slug) })) } }] } })
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } })
const json = (body: string) => new Response(body, { headers: { 'content-type': 'application/json' } })

function archive(path: string, items: string[], total = items.length, pageSize = items.length) {
  return `<script type="application/json" id="__MODERN_ROUTER_DATA__">${JSON.stringify({loaderData: {$: {article: { path, schema: {blocks: [{type: 'default:seo:article-list', data: {pageSize, total, items: items.map(path => ({path}))}}]}}}}})}</script>`
}

describe('public discovery sources', () => {
  it('uses explicit link fields, scopes URLs and preserves business parameters', () => {
    const data = JSON.parse(media(['new?utm_source=x', 'new#section', 'new?variant=2']))
    data.data.list[0].recommend_data.en.push({ turn_url: 'https://evil.example/ai/explore/zone/x' }, { turn_url: 'http://127.0.0.1/x' }, { turn_url: 'https://www.media.io/ai/explore/zone/' })
    const items = parseMediaZones(JSON.stringify(data))
    expect(items.map(x => x.normalizedUrl)).toEqual([zoneUrl('new'), zoneUrl('new?variant=2')])
    expect(items.every(x => x.lastmod === null && x.sourceUrl === MEDIA_INDEX)).toBe(true)
    expect(() => parseMediaZones(media([]))).toThrow('SOURCE_EMPTY')
    data.data.paginate.total = 10
    expect(() => parseMediaZones(JSON.stringify(data))).toThrow('SOURCE_PAGINATION_CHANGED')
    expect(() => parseMediaZones('{"code":1}')).toThrow()
  })

  it('enumerates ellipsis pagination and excludes categories, locales and external links', () => {
    const path = '/ai-video/ai-trending'
    const parsed = parseDreaminaArchive(archive(path, ['/ai-video/hello?utm_source=x', '/ai-video/hello#top', '/ai-video/ai-trending', 'https://evil.example/ai-video/no', '/zh-tw/ai-video/no'], 20), DREAMINA_ROOT + '/ai-trending')
    expect(parsed.entries.map(x => x.normalizedUrl)).toEqual([`${DREAMINA_ROOT}/hello`])
    expect(parsed.pagination).toHaveLength(3)
    expect(parsed.pagination[2]).toBe(`${DREAMINA_ROOT}/ai-trending?pageNo=4`)
    const last = parseDreaminaArchive(archive(path, ['/create/old'], 2, 1), DREAMINA_ROOT + '/ai-trending?pageNo=2')
    expect(last.entries).toHaveLength(0) // valid archive page, zero in-scope articles
  })

  it('collects every advertised page and deduplicates across categories', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const parsed = new URL(url)
      if (parsed.pathname === '/ai-video') return html("<a href='/ai-video/old'>old</a>")
      const slug = parsed.search ? 'new' : 'old'
      return html(archive(parsed.pathname, [`/ai-video/${slug}`], parsed.pathname.endsWith('ai-trending') ? 2 : 1))
    })
    const result = await collectPublicPages('dreamina_archive', fetcher)
    expect(result.sourceComplete).toBe(true)
    expect(result.requests).toBe(6)
    expect(result.entries).toHaveLength(2)
    expect(result.errors[0]).toContain('LIMITED_COVERAGE')
  })

  it('fails on repeated pagination, empty HTML, rate limits and unsafe redirects', async () => {
    const repeated = await collectPublicPages('dreamina_archive', async input => { const path = new URL(String(input)).pathname; return path === '/ai-video' ? html("<a href='/ai-video/old'>old</a>") : html(archive(path, ['/ai-video/old'], 2)) })
    expect(repeated.sourceComplete).toBe(false)
    expect(repeated.errors).toContain('SOURCE_REPEATED_PAGE')
    for (const response of [html('<html>challenge</html>'), new Response('limited', { status: 429 }), new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })]) {
      const fetcher = vi.fn(async () => response)
      const result = await collectPublicPages('dreamina_archive', fetcher)
      expect(result.sourceComplete).toBe(false)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it('rejects oversized sources and abnormal pagination', async () => {
    const result = await collectPublicPages('media_zones', async () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '3000000' } }))
    expect(result.sourceComplete).toBe(false)
    expect(result.errors[0]).toContain('exceeds')
    expect(() => parseDreaminaArchive(archive('/ai-video/ai-trending', ['/ai-video/a'], 101, 1), `${DREAMINA_ROOT}/ai-trending`)).toThrow('SOURCE_PAGINATION_LIMIT')
  })
})

describe('public discovery persistence and reports', () => {
  it('baselines then detects only new URLs, retains missing identities and exposes provenance', async () => {
    const f = fixture()
    f.sql.exec(readFileSync('scripts/setup-public-monitors.sql', 'utf8'))
    f.sql.exec(readFileSync('scripts/setup-public-monitors.sql', 'utf8'))
    expect(f.sql.prepare('SELECT * FROM page_discovery_configs').all()).toHaveLength(2)
    let slugs = ['old', 'other']
    let failure = false
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === MEDIA_INDEX
      ? failure ? new Response('limited', { status: 429 }) : json(media(slugs))
      : html('<html><title>Fresh video</title><h1>Fresh video</h1></html>'))
    vi.stubGlobal('fetch', fetcher)
    const first = await runCompetitorScan(f.env, 'cmp_media_zones', 'manual')
    expect(first.newCount).toBe(0)
    expect(first.isComplete).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1) // no SEO or AI for baseline
    expect(f.sql.prepare('SELECT baseline_established FROM competitors WHERE id=?').get('cmp_media_zones')).toMatchObject({ baseline_established: 1 })
    slugs = ['old', 'fresh?utm_campaign=test', 'fresh#top']
    const second = await runCompetitorScan(f.env, 'cmp_media_zones', 'manual')
    expect(second.newCount).toBe(1)
    const before = f.sql.prepare('SELECT first_seen_at, discovery_source_url, discovery_method FROM pages WHERE normalized_url=?').get(zoneUrl('fresh'))
    expect(before).toMatchObject({ discovery_method: 'media_zones', discovery_source_url: MEDIA_INDEX })
    expect((await runCompetitorScan(f.env, 'cmp_media_zones', 'manual')).newCount).toBe(0)
    expect(f.sql.prepare('SELECT * FROM pages WHERE missing_streak != 0').all()).toHaveLength(0)
    failure = true
    expect((await runCompetitorScan(f.env, 'cmp_media_zones', 'manual')).status).toBe('failed')
    const response = await discoveryFeed(new Request('https://private.example/api/discovery/pages?competitorId=cmp_media_zones&pageSize=100'), f.db)
    const body = await response.json() as { items: Array<{ primaryKeyword: string; keywordSource: string; discoveryMethod: string; firstSeenAt: string }>; monitor: { status: string; source_complete: number }; coverage: string }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ primaryKeyword: 'fresh', keywordSource: 'slug', discoveryMethod: 'media_zones', firstSeenAt: before?.first_seen_at })
    expect(body.monitor).toMatchObject({ status: 'failed', source_complete: 0 })
    expect(body.coverage).toBe('public_sources_only')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(competitorScanCron('cmp_makeviral_templates')).toBe('20 10 * * *')
    expect(competitorScanCron('cmp_media_zones')).toBe('0 1 * * *')
  })

  it('does not baseline empty or failed sources and rejects malformed report requests', async () => {
    const f = fixture(); f.sql.exec(readFileSync('scripts/setup-public-monitors.sql', 'utf8'))
    vi.stubGlobal('fetch', async () => json(media([])))
    expect((await runCompetitorScan(f.env, 'cmp_media_zones', 'manual')).status).toBe('failed')
    expect(f.sql.prepare('SELECT baseline_established FROM competitors WHERE id=?').get('cmp_media_zones')).toMatchObject({ baseline_established: 0 })
    expect(f.sql.prepare('SELECT * FROM pages').all()).toHaveLength(0)
    expect((await discoveryFeed(new Request('https://x/api/discovery/pages'), f.db)).status).toBe(400)
    expect((await discoveryFeed(new Request('https://x/api/discovery/pages?competitorId=x&pageSize=999'), f.db)).status).toBe(400)
    expect((await discoveryFeed(new Request('https://x/api/discovery/pages?competitorId=unknown'), f.db)).status).toBe(404)
    expect((await discoveryFeed(new Request('https://x/api/discovery/pages', { method: 'POST' }), f.db)).status).toBe(405)
  })
})
