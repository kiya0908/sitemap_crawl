import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { matchesMonitorPath, validatePathPrefix } from '../src/lib/monitor-path'
import { pageFiltersSchema } from '../src/lib/page-filters'
import { SitemapRepository } from '../src/db/repository'
import { PagesRepository } from '../src/db/pages-repository'
import { runCompetitorScan, runScheduledCompetitors } from '../src/server/scans/orchestrator'
import { reportReadiness } from '../src/lib/report-readiness'
import { PRE_REPORT_COMPETITOR_ID } from '../src/lib/scan-schedule'

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

describe('strict monitor scope', () => {
  it('separates morning/evening targets and claims each scheduled slot once', async () => {
    const f = fixture(); const repo = new SitemapRepository(f.db)
    const morning = await repo.createCompetitor({ name: 'Morning', domain: 'morning.example', sitemapUrls: ['https://morning.example/sitemap.xml'] })
    const evening = PRE_REPORT_COMPETITOR_ID
    f.sql.prepare('INSERT INTO competitors (id,name,domain,is_enabled,baseline_established,created_at,updated_at) VALUES (?,?,?,1,0,?,?)').run(evening, 'Evening', 'evening.example', new Date().toISOString(), new Date().toISOString())
    f.sql.prepare("INSERT INTO sitemap_sources (id,competitor_id,url,normalized_url,source_type,created_at,updated_at) VALUES (?,?,?,?,'manual',?,?)").run('evening_source', evening, 'https://evening.example/sitemap.xml', 'https://evening.example/sitemap.xml', new Date().toISOString(), new Date().toISOString())
    const disabled = await repo.createCompetitor({ name: 'Disabled', domain: 'disabled.example', sitemapUrls: [] })
    const deleted = await repo.createCompetitor({ name: 'Deleted', domain: 'deleted.example', sitemapUrls: [] })
    f.sql.prepare('UPDATE competitors SET is_enabled=0 WHERE id=?').run(disabled)
    f.sql.prepare('UPDATE competitors SET deleted_at=? WHERE id=?').run(new Date().toISOString(), deleted)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(`<urlset><url><loc>${new URL(String(input)).origin}/templates/old</loc></url></urlset>`))
    vi.stubGlobal('fetch', fetchMock)
    const am = Date.parse('2026-10-20T01:00:00.000Z'); const pm = Date.parse('2026-10-20T10:20:00.000Z')
    expect((await runScheduledCompetitors(f.env, '0 1 * * *', am)).map(x => x.competitorId)).toEqual([morning])
    expect((await repo.getCompetitor(evening))?.baselineEstablished).toBe(false)
    expect((await runScheduledCompetitors(f.env, '20 10 * * *', pm)).map(x => x.competitorId)).toEqual([evening])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await runScheduledCompetitors(f.env, '20 10 * * *', pm)).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const slot = '2026-10-21T10:20:00.000Z'
    const claims = await Promise.allSettled([repo.createScanRun(evening, 'cron', slot), repo.createScanRun(evening, 'cron', slot)])
    expect(claims.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    f.sql.prepare("UPDATE scan_runs SET status='failed' WHERE id=?").run(`scan_cron:${evening}:${slot}`)
    await expect(repo.createScanRun(evening, 'cron', slot)).rejects.toThrow('already been claimed')
    expect(await runScheduledCompetitors(f.env, '20 10 * * *', Date.parse(slot))).toEqual([])
    await expect(runScheduledCompetitors(f.env, '* * * * *', pm)).rejects.toThrow('Unsupported')
    await expect(runScheduledCompetitors(f.env, '20 10 * * *', am)).rejects.toThrow('Unsupported')
    expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('accepts only the latest complete success in the report window and at most 20 minutes old', () => {
    const from = '2026-10-20T10:20:00.000Z', before = '2026-10-20T10:30:00.000Z'
    const now = Date.parse(before)
    const good = { is_enabled: 1, baseline_established: 1, status: 'success', is_complete: 1, started_at: from, finished_at: before }
    expect(reportReadiness(good, from, before, now)).toBe('ready')
    expect(reportReadiness({ ...good, started_at: '2026-10-20T01:00:00.000Z' }, from, before, now)).toBe('stale_or_outside_window')
    for (const status of ['running', 'failed', 'partial_success']) expect(reportReadiness({ ...good, status }, from, before, now)).toBe(status)
    expect(reportReadiness({ ...good, is_complete: 0 }, from, before, now)).toBe('incomplete')
    expect(reportReadiness({ ...good, finished_at: null }, from, before, now)).toBe('invalid_time')
    expect(reportReadiness(good, from, before, now + 600_000)).toBe('ready')
    expect(reportReadiness(good, from, before, now + 600_001)).toBe('stale_or_outside_window')
    expect(reportReadiness({ ...good, started_at: before }, from, before, now)).toBe('stale_or_outside_window')
    expect(pageFiltersSchema.safeParse({ competitorId: 'a', scanNotBefore: from }).success).toBe(false)
    expect(pageFiltersSchema.safeParse({ competitorId: 'a', scanNotBefore: before, scanBefore: from }).success).toBe(false)
  })

  it.each(['/templates/a', '/templates/a/b', '/templates/a?x=1'])( 'accepts %s', (path) => {
    expect(matchesMonitorPath(`https://example.com${path}`, '/templates/')).toBe(true)
  })
  it.each(['/templates', '/templates/', '/templates?x=/templates/a', '/templates-extra/a', '/Templates/a', '/blog/templates/a', '/templates/../blog/a', '/%74emplates/a'])( 'excludes %s', (path) => {
    expect(matchesMonitorPath(`https://example.com${path}`, '/templates/')).toBe(false)
  })
  it('rejects wildcard, ambiguous or malformed rules instead of scanning everything', () => {
    for (const rule of ['/', '/templates', '/templates/*', '/a//', '/a/../', '/a/?x=1']) expect(() => validatePathPrefix(rule)).toThrow()
    expect(matchesMonitorPath('https://example.com/blog/a', null)).toBe(true)
    expect(pageFiltersSchema.safeParse({ pathPrefix: '/templates/' }).success).toBe(false)
    expect(pageFiltersSchema.safeParse({ competitorId: 'c', discoveredFrom: '2026-02-30T00:00:00.000Z' }).success).toBe(false)
    expect(pageFiltersSchema.safeParse({ competitorId: 'c', discoveredFrom: '2026-10-20T00:00:00.000Z', discoveredBefore: '2026-10-19T00:00:00.000Z' }).success).toBe(false)
  })

  it('filters before baseline/diff, never re-discovers old or recovered URLs, keeps failures and paginates by discovery time', async () => {
    const f = fixture(); const repository = new SitemapRepository(f.db); const pages = new PagesRepository(f.db)
    const id = await repository.createCompetitor({ name: 'Target', domain: 'example.com', sitemapUrls: ['https://example.com/sitemap.xml'] })
    const other = await repository.createCompetitor({ name: 'Unchanged', domain: 'other.example', sitemapUrls: ['https://other.example/sitemap.xml'] })
    f.sql.prepare('INSERT INTO competitor_monitor_rules VALUES (?, ?, ?)').run(id, '/templates/', '2026-10-19T00:00:00.000Z')
    let paths = ['/templates/old', '/templates', '/templates/', '/blog/a', '/templates-other/b']
    let failSitemap = false
    const requested: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input); requested.push(url)
      if (url.endsWith('/sitemap.xml')) return failSitemap ? new Response('unavailable', { status: 503 }) : new Response(`<urlset>${paths.map((p) => `<url><loc>https://example.com${p}</loc><lastmod>2099-01-01</lastmod></url>`).join('')}</urlset>`)
      return new Response('fetch failed', { status: 503 })
    })
    const beforeOther = f.sql.prepare('SELECT * FROM competitors WHERE id=?').get(other)
    const baseline = await runCompetitorScan(f.env, id, 'manual')
    expect(baseline).toMatchObject({ totalUrlCount: 1, newCount: 0, isComplete: true })
    expect(requested).toEqual(['https://example.com/sitemap.xml'])
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM page_analyses').get()?.n).toBe(0)
    expect((await pages.listPages({ competitorId: id })).total).toBe(0)
    paths.push('/templates/new-video', '/templates/new-photo', '/templates/new-video?utm_source=test')
    expect((await runCompetitorScan(f.env, id, 'manual')).newCount).toBe(2)
    expect((await runCompetitorScan(f.env, id, 'manual')).newCount).toBe(0)
    const list = await pages.listPages({ competitorId: id, pathPrefix: '/templates/', pageSize: 1 })
    const second = await pages.listPages({ competitorId: id, pathPrefix: '/templates/', pageSize: 1, page: 2 })
    expect(list.total).toBe(2); expect(second.items[0]?.id).not.toBe(list.items[0]?.id)
    expect(list.items[0]).toMatchObject({ keywordSource: 'slug', analysisStatus: 'blocked_fetch', lifecycleStatus: 'active' })
    expect(list.items[0]?.primaryKeyword).toMatch(/^new (video|photo)$/)
    f.sql.exec("UPDATE page_events SET detected_at='2026-10-19T01:00:00.000Z' WHERE event_type='discovered'")
    const filters = { competitorId: id, pathPrefix: '/templates/', discoveredFrom: '2026-10-19T01:00:00.000Z', discoveredBefore: '2026-10-20T01:00:00.000Z' }
    expect((await pages.listPages(filters)).total).toBe(2)
    expect((await pages.listPages({ ...filters, discoveredFrom: '2026-10-18T01:00:00.000Z', discoveredBefore: filters.discoveredFrom })).total).toBe(0)
    paths = paths.filter((p) => !p.includes('new-photo'))
    await runCompetitorScan(f.env, id, 'manual'); await runCompetitorScan(f.env, id, 'manual')
    paths.push('/templates/new-photo')
    expect(await runCompetitorScan(f.env, id, 'manual')).toMatchObject({ newCount: 0, reappearedCount: 1 })
    expect((await pages.listPages(filters)).total).toBe(2)
    failSitemap = true
    const failed = await runCompetitorScan(f.env, id, 'manual')
    f.sql.prepare("UPDATE scan_runs SET created_at='2099-01-01T00:00:00.000Z' WHERE id=?").run(failed.scanRunId)
    expect(failed.isComplete).toBe(false)
    expect(await pages.getMonitorContext(id)).toMatchObject({ is_complete: 0, status: 'partial_success' })
    expect(f.sql.prepare('SELECT * FROM competitors WHERE id=?').get(other)).toEqual(beforeOther)
    expect(await repository.getMonitorPathPrefix(other)).toBeNull()
    expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('keeps an incomplete initial scan unbaselined and preserves an unconfigured full-site scope', async () => {
    const f = fixture(); const repository = new SitemapRepository(f.db)
    const id = await repository.createCompetitor({ name: 'Full site', domain: 'example.com', sitemapUrls: ['https://example.com/sitemap.xml'] })
    vi.stubGlobal('fetch', async () => new Response('failed', { status: 503 }))
    expect((await runCompetitorScan(f.env, id, 'manual')).isComplete).toBe(false)
    expect((await repository.getCompetitor(id))?.baselineEstablished).toBe(false)
    vi.stubGlobal('fetch', async () => new Response('<urlset><url><loc>https://example.com/blog/a</loc></url><url><loc>https://example.com/templates/a</loc></url></urlset>'))
    expect(await runCompetitorScan(f.env, id, 'manual')).toMatchObject({ totalUrlCount: 2, newCount: 0 })
  })

  it('applies exact pathname boundaries in SQL and preserves manual keyword precedence', async () => {
    const f = fixture(); const repo = new SitemapRepository(f.db); const pages = new PagesRepository(f.db)
    const id = await repo.createCompetitor({ name: 'Queries', domain: 'example.com', sitemapUrls: [] })
    const scan = await repo.createScanRun(id, 'manual')
    const paths = ['/templates/a', '/templates-extra/a', '/blog/templates/a', '/templates?next=/templates/a', '/Templates/a', '/templates/a?business=1']
    await repo.applyDiff(id, scan, { newEntries: paths.map((path) => ({ url: `https://example.com${path}`, normalizedUrl: `https://example.com${path}`, lastmod: null, sourceUrl: 'https://example.com/sitemap.xml' })), presentEntries: [], firstMissing: [], confirmedMissing: [], reappeared: [] })
    const result = await pages.listPages({ competitorId: id, pathPrefix: '/templates/' })
    expect(result.total).toBe(2)
    expect(result.items.every((p) => new URL(p.discoveredUrl).pathname === '/templates/a')).toBe(true)
    f.sql.prepare("UPDATE page_review SET manual_primary_keyword='reviewed keyword' WHERE page_id=?").run(result.items[0]!.id)
    expect((await pages.listPages({ competitorId: id, pathPrefix: '/templates/' })).items[0]).toMatchObject({ keywordSource: 'manual', primaryKeyword: 'reviewed keyword' })
  })
})
