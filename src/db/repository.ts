import { createId } from '../lib/id'
import { shanghaiDayStartUtc } from '../lib/time'
import { CompetitorDomainConflictError, ScanAlreadyRunningError } from './errors'
import { normalizeDomain, normalizeUrl } from '../server/sitemap/normalize'
import type {
  CompetitorRecord,
  ExistingPageRecord,
  ScanDiff,
  ScanStatus,
  ScanTrigger,
  SitemapSourceRecord,
  SitemapUrlEntry,
} from '../server/types'
import type { ProcessedSitemap } from '../server/sitemap/collect'

interface CompetitorRow {
  id: string
  name: string
  domain: string
  is_enabled: number
  baseline_established: number
  last_scan_status: ScanStatus | null
  last_scanned_at: string | null
}

interface SitemapSourceRow {
  id: string
  competitor_id: string
  url: string
  normalized_url: string
  source_type: SitemapSourceRecord['sourceType']
  is_enabled: number
  parent_source_id: string | null
}

interface PageRow {
  id: string
  normalized_url: string
  current_url: string
  lifecycle_status: ExistingPageRecord['lifecycleStatus']
  missing_streak: number
  first_seen_at: string
  last_seen_at: string
}

export class SitemapRepository {
  constructor(private readonly db: D1Database) {}

  async listCompetitors(enabledOnly = false): Promise<CompetitorRecord[]> {
    const query = enabledOnly
      ? `SELECT id, name, domain, is_enabled, baseline_established, last_scan_status, last_scanned_at
         FROM competitors WHERE deleted_at IS NULL AND is_enabled = 1 ORDER BY name`
      : `SELECT id, name, domain, is_enabled, baseline_established, last_scan_status, last_scanned_at
         FROM competitors WHERE deleted_at IS NULL ORDER BY name`
    const result = await this.db.prepare(query).all<CompetitorRow>()
    return result.results.map(mapCompetitor)
  }

  async getCompetitor(id: string): Promise<CompetitorRecord | null> {
    const row = await this.db
      .prepare(`SELECT id, name, domain, is_enabled, baseline_established, last_scan_status, last_scanned_at
                FROM competitors WHERE id = ? AND deleted_at IS NULL`)
      .bind(id)
      .first<CompetitorRow>()
    return row ? mapCompetitor(row) : null
  }

  async createCompetitor(input: { name: string; domain: string; sitemapUrls: string[] }): Promise<string> {
    const now = new Date().toISOString()
    const competitorId = createId('cmp')
    const domain = normalizeDomain(input.domain)
    const existing = await this.findActiveCompetitor(domain)

    if (existing) {
      throw new CompetitorDomainConflictError(domain)
    }

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(`INSERT INTO competitors
          (id, name, domain, is_enabled, baseline_established, created_at, updated_at)
          VALUES (?, ?, ?, 1, 0, ?, ?)`)
        .bind(competitorId, input.name.trim(), domain, now, now),
    ]

    for (const sitemapUrl of input.sitemapUrls) {
      statements.push(
        this.db
          .prepare(`INSERT INTO sitemap_sources
            (id, competitor_id, url, normalized_url, source_type, is_enabled, is_discovered, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'manual', 1, 0, ?, ?)`)
          .bind(createId('smp'), competitorId, sitemapUrl, normalizeUrl(sitemapUrl), now, now),
      )
    }

    try {
      await this.db.batch(statements)
    } catch (error) {
      // 预检查和写入之间仍可能有另一请求抢先成功，由数据库唯一索引最终裁决。
      const concurrentWinner = await this.findActiveCompetitor(domain)
      if (concurrentWinner) {
        throw new CompetitorDomainConflictError(domain)
      }
      throw error
    }
    return competitorId
  }

  async listEnabledSitemaps(competitorId: string): Promise<SitemapSourceRecord[]> {
    const result = await this.db
      .prepare(`SELECT id, competitor_id, url, normalized_url, source_type, is_enabled, parent_source_id
                FROM sitemap_sources
                WHERE competitor_id = ? AND is_enabled = 1 ORDER BY source_type, created_at`)
      .bind(competitorId)
      .all<SitemapSourceRow>()

    return result.results.map((row) => ({
      id: row.id,
      competitorId: row.competitor_id,
      url: row.url,
      normalizedUrl: row.normalized_url,
      sourceType: row.source_type,
      isEnabled: row.is_enabled === 1,
      parentSourceId: row.parent_source_id,
    }))
  }

  async createScanRun(competitorId: string, triggerType: ScanTrigger): Promise<string> {
    const id = createId('scan')
    const now = new Date().toISOString()
    const staleBefore = new Date(Date.now() - 6 * 60 * 60 * 1_000).toISOString()

    await this.db.prepare(`UPDATE scan_runs
      SET status = 'failed', is_complete = 0, finished_at = ?,
          error_summary = COALESCE(error_summary, 'Recovered stale running scan')
      WHERE competitor_id = ? AND status = 'running' AND started_at < ?`)
      .bind(now, competitorId, staleBefore)
      .run()

    try {
      await this.db
        .prepare(`INSERT INTO scan_runs
          (id, competitor_id, trigger_type, status, is_complete, started_at, created_at)
          VALUES (?, ?, ?, 'running', 0, ?, ?)`)
        .bind(id, competitorId, triggerType, now, now)
        .run()
    } catch (error) {
      const running = await this.db
        .prepare(`SELECT id FROM scan_runs WHERE competitor_id = ? AND status = 'running' LIMIT 1`)
        .bind(competitorId)
        .first<{ id: string }>()
      if (running) throw new ScanAlreadyRunningError(competitorId, running.id)
      throw error
    }
    return id
  }

  async upsertDiscoveredSitemaps(
    competitorId: string,
    discovered: Array<{ url: string; parentUrl: string }>,
  ): Promise<void> {
    if (discovered.length === 0) return

    const now = new Date().toISOString()
    const existing = await this.listEnabledSitemaps(competitorId)
    const existingByUrl = new Map(existing.map((source) => [source.normalizedUrl, source]))
    const statements: D1PreparedStatement[] = []

    for (const child of discovered) {
      const normalized = normalizeUrl(child.url)
      if (existingByUrl.has(normalized)) continue
      const parent = existingByUrl.get(normalizeUrl(child.parentUrl))
      const id = createId('smp')
      statements.push(
        this.db
          .prepare(`INSERT OR IGNORE INTO sitemap_sources
            (id, competitor_id, url, normalized_url, source_type, is_enabled, is_discovered, parent_source_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'sitemap_index_child', 1, 1, ?, ?, ?)`)
          .bind(id, competitorId, child.url, normalized, parent?.id ?? null, now, now),
      )
      existingByUrl.set(normalized, {
        id,
        competitorId,
        url: child.url,
        normalizedUrl: normalized,
        sourceType: 'sitemap_index_child',
        isEnabled: true,
        parentSourceId: parent?.id ?? null,
      })
    }

    await executeInChunks(this.db, statements)
  }

  async recordProcessedSitemaps(scanRunId: string, processed: ProcessedSitemap[]): Promise<void> {
    const sourceByNormalized = new Map<string, string>()
    const sources = await this.db
      .prepare(`SELECT id, normalized_url FROM sitemap_sources WHERE competitor_id =
                (SELECT competitor_id FROM scan_runs WHERE id = ?)`)
      .bind(scanRunId)
      .all<{ id: string; normalized_url: string }>()
    for (const source of sources.results) sourceByNormalized.set(source.normalized_url, source.id)

    const statements = processed.map((item) =>
      this.db
        .prepare(`INSERT INTO scan_sitemaps
          (id, scan_run_id, sitemap_source_id, requested_url, http_status, result_status,
           content_hash, url_count, error_code, error_message, started_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          createId('ssm'),
          scanRunId,
          item.sourceId ?? sourceByNormalized.get(safeNormalize(item.url)) ?? null,
          item.url,
          item.httpStatus,
          item.status,
          item.contentHash,
          item.urlCount,
          item.errorCode,
          item.errorMessage,
          new Date().toISOString(),
          new Date().toISOString(),
        ),
    )
    await executeInChunks(this.db, statements)
  }

  async listPages(competitorId: string): Promise<ExistingPageRecord[]> {
    const result = await this.db
      .prepare(`SELECT id, normalized_url, current_url, lifecycle_status, missing_streak, first_seen_at, last_seen_at
                FROM pages WHERE competitor_id = ? AND deleted_at IS NULL`)
      .bind(competitorId)
      .all<PageRow>()

    return result.results.map((row) => ({
      id: row.id,
      normalizedUrl: row.normalized_url,
      currentUrl: row.current_url,
      lifecycleStatus: row.lifecycle_status,
      missingStreak: row.missing_streak,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    }))
  }

  async establishBaseline(
    competitorId: string,
    scanRunId: string,
    entries: SitemapUrlEntry[],
  ): Promise<void> {
    const now = new Date().toISOString()
    const sourceMap = await this.getSourceMap(competitorId)
    const statements: D1PreparedStatement[] = []

    for (const entry of entries) {
      const pageId = createId('page')
      statements.push(
        this.db
          .prepare(`INSERT OR IGNORE INTO pages
            (id, competitor_id, original_url, normalized_url, current_url, lifecycle_status,
             missing_streak, first_seen_at, last_seen_at, sitemap_lastmod,
             first_scan_run_id, last_scan_run_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'baseline', 0, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(pageId, competitorId, entry.url, entry.normalizedUrl, entry.url, now, now, entry.lastmod, scanRunId, scanRunId, now, now),
        this.db
          .prepare(`INSERT OR IGNORE INTO page_events
            (id, page_id, scan_run_id, event_type, detected_at, created_at)
            SELECT ?, p.id, ?, 'baseline_added', ?, ? FROM pages p
            WHERE p.competitor_id = ? AND p.normalized_url = ?
              AND NOT EXISTS (
                SELECT 1 FROM page_events existing_event
                WHERE existing_event.page_id = p.id AND existing_event.event_type = 'baseline_added'
              )`)
          .bind(createId('evt'), scanRunId, now, now, competitorId, entry.normalizedUrl),
      )
      const sourceId = sourceMap.get(safeNormalize(entry.sourceUrl))
      if (sourceId) {
        statements.push(this.upsertPageSitemapLink(competitorId, entry.normalizedUrl, sourceId, entry.lastmod, now))
      }
    }

    await executeInChunks(this.db, statements)
    await this.db
      .prepare(`UPDATE competitors SET baseline_established = 1, updated_at = ? WHERE id = ?`)
      .bind(now, competitorId)
      .run()
  }

  async applyDiff(
    competitorId: string,
    scanRunId: string,
    diff: ScanDiff,
  ): Promise<string[]> {
    const now = new Date().toISOString()
    const sourceMap = await this.getSourceMap(competitorId)
    const newPageIds: string[] = []
    const statements: D1PreparedStatement[] = []

    for (const entry of diff.newEntries) {
      const pageId = createId('page')
      newPageIds.push(pageId)
      statements.push(
        this.db
          .prepare(`INSERT OR IGNORE INTO pages
            (id, competitor_id, original_url, normalized_url, current_url, lifecycle_status,
             missing_streak, first_seen_at, last_seen_at, sitemap_lastmod,
             first_scan_run_id, last_scan_run_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'new', 0, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(pageId, competitorId, entry.url, entry.normalizedUrl, entry.url, now, now, entry.lastmod, scanRunId, scanRunId, now, now),
        this.db
          .prepare(`INSERT INTO page_events
            (id, page_id, scan_run_id, event_type, new_value_json, detected_at, created_at)
            VALUES (?, ?, ?, 'discovered', ?, ?, ?)`)
          .bind(createId('evt'), pageId, scanRunId, JSON.stringify({ url: entry.url }), now, now),
        this.db
          .prepare(`INSERT OR IGNORE INTO page_review
            (page_id, review_status, is_viewed, is_worth_following, created_at, updated_at)
            VALUES (?, 'unreviewed', 0, 0, ?, ?)`)
          .bind(pageId, now, now),
        this.db
          .prepare(`INSERT OR IGNORE INTO page_seo_data
            (page_id, fetch_status, updated_at) VALUES (?, 'pending', ?)`)
          .bind(pageId, now),
      )
      const sourceId = sourceMap.get(safeNormalize(entry.sourceUrl))
      if (sourceId) statements.push(this.upsertPageSitemapLink(competitorId, entry.normalizedUrl, sourceId, entry.lastmod, now))
    }

    for (const { page, entry } of diff.presentEntries) {
      statements.push(
        this.db
          .prepare(`UPDATE pages SET current_url = ?, lifecycle_status = 'active', missing_streak = 0,
                    last_seen_at = ?, sitemap_lastmod = ?, last_scan_run_id = ?, updated_at = ?
                    WHERE id = ?`)
          .bind(entry.url, now, entry.lastmod, scanRunId, now, page.id),
      )
    }

    for (const page of diff.firstMissing) {
      statements.push(
        this.db.prepare(`UPDATE pages SET missing_streak = missing_streak + 1, last_scan_run_id = ?, updated_at = ? WHERE id = ?`)
          .bind(scanRunId, now, page.id),
      )
    }

    for (const page of diff.confirmedMissing) {
      statements.push(
        this.db.prepare(`UPDATE pages SET lifecycle_status = 'missing', missing_streak = missing_streak + 1,
                         last_scan_run_id = ?, updated_at = ? WHERE id = ?`)
          .bind(scanRunId, now, page.id),
        this.db.prepare(`INSERT INTO page_events
          (id, page_id, scan_run_id, event_type, detected_at, created_at)
          VALUES (?, ?, ?, 'missing_confirmed', ?, ?)`)
          .bind(createId('evt'), page.id, scanRunId, now, now),
      )
    }

    for (const { page, entry } of diff.reappeared) {
      statements.push(
        this.db.prepare(`UPDATE pages SET current_url = ?, lifecycle_status = 'reappeared', missing_streak = 0,
                         last_seen_at = ?, sitemap_lastmod = ?, last_scan_run_id = ?, updated_at = ? WHERE id = ?`)
          .bind(entry.url, now, entry.lastmod, scanRunId, now, page.id),
        this.db.prepare(`INSERT INTO page_events
          (id, page_id, scan_run_id, event_type, new_value_json, detected_at, created_at)
          VALUES (?, ?, ?, 'reappeared', ?, ?, ?)`)
          .bind(createId('evt'), page.id, scanRunId, JSON.stringify({ url: entry.url }), now, now),
      )
    }

    await executeInChunks(this.db, statements)
    return newPageIds
  }

  async finishScan(input: {
    scanRunId: string
    competitorId: string
    status: ScanStatus
    isComplete: boolean
    sitemapCount: number
    totalUrlCount: number
    newCount: number
    missingCount: number
    reappearedCount: number
    errorSummary: string | null
  }): Promise<void> {
    const now = new Date().toISOString()
    await this.db.batch([
      this.db.prepare(`UPDATE scan_runs SET status = ?, is_complete = ?, sitemap_count = ?, total_url_count = ?,
                       new_count = ?, missing_count = ?, reappeared_count = ?, error_summary = ?, finished_at = ?
                       WHERE id = ?`)
        .bind(input.status, input.isComplete ? 1 : 0, input.sitemapCount, input.totalUrlCount,
          input.newCount, input.missingCount, input.reappearedCount, input.errorSummary, now, input.scanRunId),
      this.db.prepare(`UPDATE competitors SET last_scan_status = ?, last_scanned_at = ?, updated_at = ? WHERE id = ?`)
        .bind(input.status, now, now, input.competitorId),
    ])
  }

  async failScan(scanRunId: string, competitorId: string, error: unknown): Promise<void> {
    await this.finishScan({
      scanRunId,
      competitorId,
      status: 'failed',
      isComplete: false,
      sitemapCount: 0,
      totalUrlCount: 0,
      newCount: 0,
      missingCount: 0,
      reappearedCount: 0,
      errorSummary: error instanceof Error ? error.message : 'Unknown scan error',
    })
  }

  async getDashboard(): Promise<{
    competitors: CompetitorRecord[]
    todayNew: number
    lastSevenDaysNew: number
    unreviewed: number
    worthFollowing: number
    recentScans: Array<Record<string, string | number | null>>
  }> {
    const competitors = await this.listCompetitors()
    const today = shanghaiDayStartUtc()
    const sevenDays = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const counts = await this.db.prepare(`SELECT
      SUM(CASE WHEN detected_at >= ? THEN 1 ELSE 0 END) AS today_new,
      SUM(CASE WHEN detected_at >= ? THEN 1 ELSE 0 END) AS seven_day_new
      FROM page_events
      WHERE event_type = 'discovered'`).bind(today, sevenDays).first<{ today_new: number | null; seven_day_new: number | null }>()
    const reviews = await this.db.prepare(`SELECT
      SUM(CASE WHEN review_status = 'unreviewed' THEN 1 ELSE 0 END) AS unreviewed,
      SUM(CASE WHEN is_worth_following = 1 THEN 1 ELSE 0 END) AS worth_following
      FROM page_review`).first<{ unreviewed: number | null; worth_following: number | null }>()
    const recent = await this.db.prepare(`SELECT sr.id, c.name AS competitor_name, sr.status, sr.total_url_count,
      sr.new_count, sr.missing_count, sr.reappeared_count, sr.started_at, sr.finished_at
      FROM scan_runs sr JOIN competitors c ON c.id = sr.competitor_id
      ORDER BY sr.created_at DESC LIMIT 10`).all<Record<string, string | number | null>>()

    return {
      competitors,
      todayNew: counts?.today_new ?? 0,
      lastSevenDaysNew: counts?.seven_day_new ?? 0,
      unreviewed: reviews?.unreviewed ?? 0,
      worthFollowing: reviews?.worth_following ?? 0,
      recentScans: recent.results,
    }
  }

  private async getSourceMap(competitorId: string): Promise<Map<string, string>> {
    const result = await this.db.prepare(`SELECT id, normalized_url FROM sitemap_sources WHERE competitor_id = ?`)
      .bind(competitorId).all<{ id: string; normalized_url: string }>()
    return new Map(result.results.map((row) => [row.normalized_url, row.id]))
  }

  private findActiveCompetitor(domain: string): Promise<{ id: string } | null> {
    return this.db
      .prepare(`SELECT id FROM competitors
                WHERE domain = ? AND deleted_at IS NULL
                LIMIT 1`)
      .bind(domain)
      .first<{ id: string }>()
  }

  private upsertPageSitemapLink(
    competitorId: string,
    normalizedPageUrl: string,
    sourceId: string,
    lastmod: string | null,
    now: string,
  ): D1PreparedStatement {
    return this.db.prepare(`INSERT INTO page_sitemap_links
      (page_id, sitemap_source_id, first_seen_at, last_seen_at, is_current, sitemap_lastmod)
      SELECT id, ?, ?, ?, 1, ? FROM pages WHERE competitor_id = ? AND normalized_url = ?
      ON CONFLICT(page_id, sitemap_source_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at, is_current = 1, sitemap_lastmod = excluded.sitemap_lastmod`)
      .bind(sourceId, now, now, lastmod, competitorId, normalizedPageUrl)
  }
}

function mapCompetitor(row: CompetitorRow): CompetitorRecord {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    isEnabled: row.is_enabled === 1,
    baselineEstablished: row.baseline_established === 1,
    lastScanStatus: row.last_scan_status,
    lastScannedAt: row.last_scanned_at,
  }
}

function safeNormalize(url: string): string {
  try {
    return normalizeUrl(url)
  } catch {
    return url
  }
}

async function executeInChunks(db: D1Database, statements: D1PreparedStatement[], size = 75): Promise<void> {
  for (let index = 0; index < statements.length; index += size) {
    await db.batch(statements.slice(index, index + size))
  }
}
