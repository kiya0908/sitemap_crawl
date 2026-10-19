import { afterEach, describe, expect, it } from 'vitest'
/// <reference types="node" />
import { DatabaseSync, backup } from 'node:sqlite'
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { retentionConfig, runRetention, type RetentionDatabase } from '../src/db/data-retention'
import { PagesRepository } from '../src/db/pages-repository'
import { SitemapRepository } from '../src/db/repository'
import { PagePipelineRepository } from '../src/db/page-pipeline-repository'
import { calculateScanDiff } from '../src/server/scans/diff'
import type { PageSeoResult } from '../src/server/page-fetch/fetch-page'

const now = '2026-10-19T12:00:00.000Z'
const cutoff = '2026-10-12T12:00:00.000Z'
const old = '2026-09-01T00:00:00.000Z'
const connections: DatabaseSync[] = []
afterEach(() => { for (const db of connections.splice(0)) db.close() })

function fixture(path = ':memory:') {
  const sql = new DatabaseSync(path)
  connections.push(sql)
  sql.exec('PRAGMA foreign_keys = ON')
  for (const file of readdirSync('migrations').filter((file) => file.endsWith('.sql')).sort()) {
    sql.exec(readFileSync(join('migrations', file), 'utf8'))
  }
  sql.prepare(`INSERT INTO competitors (id,name,domain,baseline_established,created_at,updated_at)
    VALUES ('c','Example','example.com',1,?,?)`).run(old, old)
  sql.prepare(`INSERT INTO sitemap_sources (id,competitor_id,url,normalized_url,source_type,created_at,updated_at)
    VALUES ('s','c','https://example.com/sitemap.xml','https://example.com/sitemap.xml','manual',?,?)`).run(old, old)
  sql.prepare(`INSERT INTO scan_runs (id,competitor_id,trigger_type,status,started_at,finished_at,created_at,error_summary)
    VALUES ('run','c','manual','success',?,?,?,'old error')`).run(old, old, old)
  sql.prepare(`INSERT INTO scan_sitemaps (id,scan_run_id,sitemap_source_id,requested_url,result_status,started_at,finished_at)
    VALUES ('ss','run','s','https://example.com/sitemap.xml','success',?,?)`).run(old, old)
  const db: RetentionDatabase = {
    query: async <T extends Record<string, unknown>>(query: string, params: Array<string | number>) => sql.prepare(query).all(...params) as T[],
    execute: async (query, params) => Number(sql.prepare(query).run(...params).changes),
  }
  function page(id: string, time: string | null = old) {
    const url = `https://example.com/${id}`
    sql.prepare(`INSERT INTO pages (id,competitor_id,original_url,normalized_url,current_url,lifecycle_status,
      first_seen_at,last_seen_at,created_at,updated_at,first_scan_run_id,last_scan_run_id,sitemap_lastmod)
      VALUES (?,'c',?,?,?,'active',?,?,?,?,'run','run','2099-01-01')`).run(id, url, url, url, old, now, old, now)
    sql.prepare(`INSERT INTO page_sitemap_links (page_id,sitemap_source_id,first_seen_at,last_seen_at) VALUES (?,'s',?,?)`).run(id, old, now)
    sql.prepare(`INSERT INTO page_events (id,page_id,scan_run_id,event_type,new_value_json,detected_at,created_at)
      VALUES (?,?,'run','discovered','{"source":"fixture"}',?,?)`).run(`${id}-discovered`, id, old, old)
    sql.prepare(`INSERT INTO page_events (id,page_id,scan_run_id,event_type,new_value_json,detected_at,created_at)
      VALUES (?,?,'run','fetch_failed','{"error":"fixture"}',?,?)`).run(`${id}-error`, id, old, old)
    sql.prepare(`INSERT INTO page_seo_data (page_id,title,content_excerpt,fetch_status,fetched_at,updated_at,content_fetched_at)
      VALUES (?,'old title','old body','success',?,?,?)`).run(id, time, time ?? old, time)
    sql.prepare(`INSERT INTO page_analyses (id,page_id,status,provider,model,prompt_version,summary,raw_response_excerpt,analyzed_at,created_at)
      VALUES (?,?,'success','mock','mock','v1','old analysis','raw',?,?)`).run(`${id}-analysis`, id, time, time ?? old)
    sql.prepare(`INSERT INTO fetch_attempts (id,page_id,scan_run_id,trigger_type,attempt_number,status,started_at,finished_at)
      VALUES (?,?,'run','scan',1,'success',?,?)`).run(`${id}-fetch`, id, time, time)
    return url
  }
  // Real SQLite SQL/constraints underneath the D1-shaped repository test adapter.
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
  const d1 = { prepare, batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
    sql.exec('BEGIN')
    try { const result = []; for (const statement of statements) result.push(await statement.run()); sql.exec('COMMIT'); return result }
    catch (error) { sql.exec('ROLLBACK'); throw error }
  } } as unknown as D1Database
  return { sql, db, page, d1 }
}

describe('seven-day retention', () => {
  it.each(['legacy', 'partial'])('keeps lists, CSV, detail and fetch/analysis input working on %s schema', async (schema) => {
    const f = fixture(); f.page('legacy')
    f.sql.exec('ALTER TABLE page_seo_data DROP COLUMN expired_at; ALTER TABLE page_analyses DROP COLUMN expired_at;')
    if (schema === 'legacy') f.sql.exec('ALTER TABLE page_seo_data DROP COLUMN content_fetched_at')
    const pages = new PagesRepository(f.d1)
    expect((await pages.listPages({})).items[0]?.analysisStatus).toBe('success')
    expect(await pages.exportCsv({})).toContain('https://example.com/legacy')
    expect((await pages.getPageDetail('legacy'))?.seo.contentExcerpt).toBe('old body')
    const pipeline = new PagePipelineRepository(f.d1)
    const attempt = await pipeline.createFetchAttempt('legacy', 'run', 2)
    const result: PageSeoResult = { status: 'success', httpStatus: 200, finalUrl: 'https://example.com/legacy',
      redirectChain: [], contentType: 'text/html', title: 'new title', metaDescription: null, h1: null, h2: [],
      canonicalUrl: null, robotsMeta: null, pageLanguage: null, contentExcerpt: 'new body', errorCode: null, errorMessage: null }
    await pipeline.saveFetchResult('legacy', attempt, result, 10)
    expect((await pipeline.getSeoInput('legacy'))?.contentExcerpt).toBe('new body')
    expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    // A new request after the separately applied migration detects the new capabilities.
    f.sql.exec('ALTER TABLE page_seo_data ADD COLUMN expired_at TEXT; ALTER TABLE page_analyses ADD COLUMN expired_at TEXT;')
    f.sql.exec("UPDATE page_seo_data SET expired_at = '2026-10-19T12:00:00.000Z'")
    expect((await new PagesRepository(f.d1).getPageDetail('legacy'))?.seo.fetchStatus).toBe('expired')
    expect(await new PagePipelineRepository(f.d1).getSeoInput('legacy')).toBeNull()
  })

  it('computes a deterministic UTC cutoff and rejects ambiguous or impossible inputs', () => {
    expect(retentionConfig({ now }).cutoff).toBe(cutoff)
    expect(retentionConfig({ now: '2026-03-09T00:00:00.000Z', days: 7 }).cutoff).toBe('2026-03-02T00:00:00.000Z')
    for (const input of ['2026-02-30T00:00:00.000Z', '2026-10-19', '2026-10-19T12:00:00+08:00']) {
      expect(() => retentionConfig({ now: input })).toThrow()
    }
    for (const days of [0, -1, 0.5, NaN, Infinity, 3651]) expect(() => retentionConfig({ days })).toThrow()
  })

  it('dry-run executes no writes and reports every table and protections', async () => {
    const f = fixture(); f.page('old')
    const before = f.sql.prepare('SELECT total_changes() AS n').get()
    const report = await runRetention({ ...f.db, execute: async () => { throw new Error('unexpected write') } }, { now })
    expect(f.sql.prepare('SELECT total_changes() AS n').get()).toEqual(before)
    expect(report.changes).toEqual([])
    expect(report.preview.tables.every((t) => t.candidates === 1)).toBe(true)
    expect(report.preview.retained.map((r) => r.table)).toContain('page_review')
  })

  it('expires only strictly older data and ignores sitemap lastmod/last-seen age', async () => {
    const f = fixture()
    f.page('before', '2026-10-12T11:59:59.999Z'); f.page('equal', cutoff)
    f.page('after', '2026-10-12T12:00:00.001Z'); f.page('future', '2027-01-01T00:00:00.000Z')
    await runRetention(f.db, { now, apply: true })
    expect(f.sql.prepare('SELECT page_id FROM page_seo_data WHERE expired_at IS NOT NULL').all()).toEqual([{ page_id: 'before' }])
    expect(f.sql.prepare('SELECT page_id FROM page_analyses WHERE expired_at IS NOT NULL').all()).toEqual([{ page_id: 'before' }])
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM fetch_attempts').get()?.n).toBe(3)
  })

  it.each([null, '', 'yesterday', '2026-02-30T00:00:00.000Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000+00:00'])(
    'keeps unknown or noncanonical timestamp %s', async (time) => {
      const f = fixture(); f.page('unknown', time)
      const report = await runRetention(f.db, { now, apply: true })
      expect(f.sql.prepare('SELECT content_excerpt FROM page_seo_data').get()?.content_excerpt).toBe('old body')
      expect(report.preview.tables.find((t) => t.table === 'page_seo_data')?.counts).toContainEqual({ reason: 'unknown_or_invalid_time', count: 1 })
    })

  it.each([
    "notes = 'remember'", "is_worth_following = 1", "manual_secondary_keywords_json = '[\"tag\"]'",
    "manual_primary_keyword = 'manual'", "manual_page_type = 'guide'", "manual_search_intent = 'commercial'",
    "review_status = 'not_relevant'", 'is_viewed = 1',
  ])('conservatively protects human involvement: %s', async (assignment) => {
    const f = fixture(); f.page('human')
    f.sql.prepare(`INSERT INTO page_review (page_id,created_at,updated_at) VALUES ('human',?,?)`).run(old, old)
    f.sql.exec(`UPDATE page_review SET ${assignment}`)
    const review = f.sql.prepare('SELECT * FROM page_review').all()
    await runRetention(f.db, { now, apply: true })
    expect(f.sql.prepare('SELECT * FROM page_review').all()).toEqual(review)
    expect(f.sql.prepare('SELECT content_excerpt FROM page_seo_data').get()?.content_excerpt).toBe('old body')
    expect(f.sql.prepare('SELECT summary FROM page_analyses').get()?.summary).toBe('old analysis')
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM page_events').get()?.n).toBe(2)
    expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it.each([
    "UPDATE scan_runs SET status = 'queued'", "UPDATE scan_runs SET status = 'running'",
    "UPDATE fetch_attempts SET status = 'pending'", "UPDATE fetch_attempts SET status = 'running'",
    "UPDATE page_seo_data SET fetch_status = 'pending'", "UPDATE page_seo_data SET fetch_status = 'fetching'",
    "UPDATE page_analyses SET status = 'pending'", "UPDATE page_analyses SET status = 'analyzing'",
    "UPDATE scan_sitemaps SET result_status = 'pending'",
  ])('pauses all writes for active work, even if old: %s', async (query) => {
    const f = fixture(); f.page('active'); f.sql.exec(query)
    const report = await runRetention({ ...f.db, execute: async () => { throw new Error('unexpected write') } }, { now, apply: true })
    expect(report.paused).toBe(true)
    expect(report.changes).toEqual([])
  })

  it('rechecks task and human protection inside a write after preview', async () => {
    const f = fixture(); f.page('race')
    let first = true
    const report = await runRetention({ ...f.db, execute: async (query, params) => {
      if (first) { first = false; f.sql.exec("UPDATE scan_runs SET status = 'running'") }
      return f.db.execute(query, params)
    } }, { now, apply: true })
    expect(report.changes.every((r) => r.changed === 0)).toBe(true)
    expect(report.paused).toBe(true)
  })

  it('honors a human note added after preview', async () => {
    const f = fixture(); f.page('late-note')
    let first = true
    await runRetention({ ...f.db, execute: async (query, params) => {
      if (first) {
        first = false
        f.sql.prepare(`INSERT INTO page_review (page_id,notes,created_at,updated_at) VALUES ('late-note','keep',?,?)`).run(now, now)
      }
      return f.db.execute(query, params)
    } }, { now, apply: true })
    expect(f.sql.prepare('SELECT content_excerpt FROM page_seo_data').get()?.content_excerpt).toBe('old body')
    expect(f.sql.prepare('SELECT summary FROM page_analyses').get()?.summary).toBe('old analysis')
  })

  it('bounds batches, resumes idempotently, preserves list/CSV, FKs and URL deduplication', async () => {
    const f = fixture(); const urls = ['a', 'b', 'c'].map((id) => f.page(id))
    const first = await runRetention(f.db, { now, apply: true, batchSize: 1, maxBatches: 1 })
    expect(first.changes.find((r) => r.table === 'page_seo_data')?.changed).toBe(1)
    expect(first.changes.find((r) => r.table === 'page_seo_data')?.limitReached).toBe(true)
    await runRetention(f.db, { now, apply: true, batchSize: 1 })
    const again = await runRetention(f.db, { now, apply: true })
    expect(again.changes.every((r) => r.changed === 0)).toBe(true)
    expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM page_events').get()?.n).toBe(3)
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM scan_runs').get()?.n).toBe(1)
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM page_sitemap_links').get()?.n).toBe(3)
    const repository = new PagesRepository(f.d1)
    const list = await repository.listPages({})
    expect(list.total).toBe(3)
    expect(list.items.every((p) => p.fetchStatus === 'expired' && p.analysisStatus === 'expired')).toBe(true)
    const csv = await repository.exportCsv({})
    for (const url of urls) expect(csv).toContain(url)
    expect(csv).toContain('expired')
    const detail = await repository.getPageDetail('a')
    expect(detail?.seo.contentExcerpt).toBeNull()
    expect(detail?.analysis.summary).toBeNull()
    expect(await new PagePipelineRepository(f.d1).getSeoInput('a')).toBeNull()
    const existing = await new SitemapRepository(f.d1).listPages('c')
    const diff = calculateScanDiff(urls.map((url) => ({ url, normalizedUrl: url, lastmod: null, sourceUrl: 'https://example.com/sitemap.xml' })), existing, true)
    expect(diff.newEntries).toEqual([])
    expect(diff.reappeared).toEqual([])
  })

  it('keeps manual and unknown event kinds', async () => {
    const f = fixture(); f.page('p')
    f.sql.exec("UPDATE page_events SET event_type = 'manual_reanalyze' WHERE event_type = 'fetch_failed'")
    await runRetention(f.db, { now, apply: true })
    expect(f.sql.prepare("SELECT COUNT(*) AS n FROM page_events WHERE event_type = 'manual_reanalyze'").get()?.n).toBe(1)
  })

  it('does not restore expired input on failure; new successful content and analysis become usable', async () => {
    const f = fixture(); f.page('refresh')
    await runRetention(f.db, { now, apply: true })
    const pipeline = new PagePipelineRepository(f.d1)
    const result: PageSeoResult = { status: 'failed', httpStatus: 500, finalUrl: 'https://example.com/refresh',
      redirectChain: [], contentType: 'text/html', title: null, metaDescription: null, h1: null, h2: [],
      canonicalUrl: null, robotsMeta: null, pageLanguage: null, contentExcerpt: null, errorCode: 'HTTP_ERROR', errorMessage: 'test' }
    let attempt = await pipeline.createFetchAttempt('refresh', 'run', 1)
    await pipeline.saveFetchResult('refresh', attempt, result, 10)
    expect(await pipeline.getSeoInput('refresh')).toBeNull()
    attempt = await pipeline.createFetchAttempt('refresh', 'run', 2)
    await pipeline.saveFetchResult('refresh', attempt, { ...result, status: 'success', httpStatus: 200,
      title: 'new title', contentExcerpt: 'new body', errorCode: null, errorMessage: null }, 10)
    expect((await pipeline.getSeoInput('refresh'))?.contentExcerpt).toBe('new body')
    const seo = f.sql.prepare('SELECT expired_at, content_fetched_at, fetched_at FROM page_seo_data').get()
    expect(seo?.expired_at).toBeNull()
    expect(seo?.content_fetched_at).toBe(seo?.fetched_at)
    await pipeline.saveAnalysisFailure({ pageId: 'refresh', scanRunId: 'run', provider: 'mock', model: 'new',
      promptVersion: 'v2', error: new Error('new analysis error') })
    const detail = await new PagesRepository(f.d1).getPageDetail('refresh')
    expect(detail?.analysis.status).toBe('failed')
    expect(detail?.analysis.model).toBe('new')
  })

  it('restores a local SQLite backup with content and intact relationships', async () => {
    const f = fixture(); f.page('restore')
    const path = join(mkdtempSync(join(tmpdir(), 'retention-backup-')), 'backup.sqlite')
    await backup(f.sql, path)
    await runRetention(f.db, { now, apply: true })
    const restored = new DatabaseSync(path, { readOnly: true }); connections.push(restored)
    expect(restored.prepare('SELECT content_excerpt FROM page_seo_data').get()?.content_excerpt).toBe('old body')
    expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(f.sql.prepare('SELECT content_excerpt FROM page_seo_data').get()?.content_excerpt).toBeNull()
  })

  it('uses a read-only local CLI preview and refuses remote writes before credentials/network', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'retention-test-')), 'fixture.sqlite')
    const f = fixture(path); f.page('cli')
    const before = readFileSync(path)
    const preview = spawnSync(process.execPath, ['scripts/retention.js', '--database', path, '--now', now], { encoding: 'utf8' })
    expect(preview.status, preview.stderr).toBe(0)
    expect(JSON.parse(preview.stdout).preview.apply).toBe(false)
    expect(readFileSync(path)).toEqual(before)
    const denied = spawnSync(process.execPath, ['scripts/retention.js', '--remote', '--account-id', 'a'.repeat(32),
      '--database-id', '00000000-0000-0000-0000-000000000000', '--apply'], {
      encoding: 'utf8', env: { ...process.env, RETENTION_ALLOW_REMOTE_DELETE: '', CLOUDFLARE_API_TOKEN: '' },
    })
    expect(denied.status).toBe(1)
    expect(denied.stderr).toContain('Remote writes disabled')
  })

  it('remote preview only sends read queries (mock transport, no network)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'retention-transport-')), 'mock.mjs')
    writeFileSync(path, `globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith('https://api.cloudflare.com/client/v4/accounts/')) throw new Error('unexpected host');
      const {sql, params} = JSON.parse(init.body);
      if (!/^(SELECT|PRAGMA)/.test(sql) || !params.every(p => typeof p === 'string')) throw new Error('unexpected mutation or parameters');
      return Response.json({success:true,result:[{success:true,results:[],meta:{changes:0}}]});
    };`)
    const preview = spawnSync(process.execPath, ['--import', pathToFileURL(path).href, 'scripts/retention.js', '--remote',
      '--account-id', 'a'.repeat(32), '--database-id', '00000000-0000-0000-0000-000000000000'], {
      encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: 'fixture-only', RETENTION_ALLOW_REMOTE_DELETE: '' },
    })
    expect(preview.status, preview.stderr).toBe(0)
    expect(JSON.parse(preview.stdout).changes).toEqual([])
  })
})
