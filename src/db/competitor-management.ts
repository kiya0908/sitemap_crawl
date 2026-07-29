import { createId } from '../lib/id'
import { normalizeDomain, normalizeUrl } from '../server/sitemap/normalize'
import { CompetitorDomainConflictError } from './errors'

export interface CompetitorConfiguration {
  id: string
  name: string
  domain: string
  isEnabled: boolean
  baselineEstablished: boolean
  manualSitemapUrls: string[]
}

export interface ActiveDashboardMetrics {
  todayNew: number
  lastSevenDaysNew: number
  unreviewed: number
  worthFollowing: number
  recentScans: Array<Record<string, string | number | null>>
}

interface CompetitorConfigRow {
  id: string
  name: string
  domain: string
  is_enabled: number
  baseline_established: number
}

export class CompetitorManagementRepository {
  constructor(private readonly db: D1Database) {}

  async getConfiguration(competitorId: string): Promise<CompetitorConfiguration | null> {
    const competitor = await this.db
      .prepare(`SELECT id, name, domain, is_enabled, baseline_established
                FROM competitors
                WHERE id = ? AND deleted_at IS NULL`)
      .bind(competitorId)
      .first<CompetitorConfigRow>()

    if (!competitor) return null

    const sitemaps = await this.db
      .prepare(`SELECT url FROM sitemap_sources
                WHERE competitor_id = ? AND source_type = 'manual' AND is_enabled = 1
                ORDER BY created_at`)
      .bind(competitorId)
      .all<{ url: string }>()

    return {
      id: competitor.id,
      name: competitor.name,
      domain: competitor.domain,
      isEnabled: competitor.is_enabled === 1,
      baselineEstablished: competitor.baseline_established === 1,
      manualSitemapUrls: sitemaps.results.map((row) => row.url),
    }
  }

  async getActiveDashboardMetrics(): Promise<ActiveDashboardMetrics> {
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    const sevenDays = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const counts = await this.db
      .prepare(`SELECT
        SUM(CASE WHEN p.first_seen_at >= ? AND p.lifecycle_status = 'new' THEN 1 ELSE 0 END) AS today_new,
        SUM(CASE WHEN p.first_seen_at >= ? AND p.lifecycle_status IN ('new', 'active') THEN 1 ELSE 0 END) AS seven_day_new
        FROM pages p
        JOIN competitors c ON c.id = p.competitor_id
        WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL`)
      .bind(today.toISOString(), sevenDays)
      .first<{ today_new: number | null; seven_day_new: number | null }>()

    const reviews = await this.db
      .prepare(`SELECT
        SUM(CASE WHEN pr.review_status = 'unreviewed' THEN 1 ELSE 0 END) AS unreviewed,
        SUM(CASE WHEN pr.is_worth_following = 1 THEN 1 ELSE 0 END) AS worth_following
        FROM page_review pr
        JOIN pages p ON p.id = pr.page_id
        JOIN competitors c ON c.id = p.competitor_id
        WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL`)
      .first<{ unreviewed: number | null; worth_following: number | null }>()

    const recent = await this.db
      .prepare(`SELECT sr.id, c.name AS competitor_name, sr.status, sr.total_url_count,
        sr.new_count, sr.missing_count, sr.reappeared_count, sr.started_at, sr.finished_at
        FROM scan_runs sr
        JOIN competitors c ON c.id = sr.competitor_id
        WHERE c.deleted_at IS NULL
        ORDER BY sr.created_at DESC LIMIT 10`)
      .all<Record<string, string | number | null>>()

    return {
      todayNew: counts?.today_new ?? 0,
      lastSevenDaysNew: counts?.seven_day_new ?? 0,
      unreviewed: reviews?.unreviewed ?? 0,
      worthFollowing: reviews?.worth_following ?? 0,
      recentScans: recent.results,
    }
  }

  async updateCompetitor(input: {
    competitorId: string
    name: string
    domain: string
    isEnabled: boolean
    sitemapUrls: string[]
  }): Promise<void> {
    const existing = await this.getConfiguration(input.competitorId)
    if (!existing) throw new Error('竞品不存在或已经删除。')

    const name = input.name.trim()
    const domain = normalizeDomain(input.domain)
    const domainChanged = domain !== existing.domain

    if (domainChanged && existing.baselineEstablished) {
      throw new Error('该竞品已经建立基线，不能直接修改域名。请删除后重新添加，避免历史页面归属混乱。')
    }

    if (domainChanged) {
      const conflict = await this.db
        .prepare(`SELECT id FROM competitors
                  WHERE domain = ? AND deleted_at IS NULL AND id <> ?
                  LIMIT 1`)
        .bind(domain, input.competitorId)
        .first<{ id: string }>()
      if (conflict) throw new CompetitorDomainConflictError(domain)
    }

    const now = new Date().toISOString()
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(`UPDATE competitors
                  SET name = ?, domain = ?, is_enabled = ?, updated_at = ?
                  WHERE id = ? AND deleted_at IS NULL`)
        .bind(name, domain, input.isEnabled ? 1 : 0, now, input.competitorId),
    ]

    if (domainChanged) {
      statements.push(
        this.db
          .prepare(`UPDATE sitemap_sources
                    SET is_enabled = 0, updated_at = ?
                    WHERE competitor_id = ?`)
          .bind(now, input.competitorId),
      )
    } else {
      statements.push(
        this.db
          .prepare(`UPDATE sitemap_sources
                    SET is_enabled = 0, updated_at = ?
                    WHERE competitor_id = ? AND source_type = 'manual'`)
          .bind(now, input.competitorId),
      )
    }

    for (const sitemapUrl of input.sitemapUrls) {
      const normalizedUrl = normalizeUrl(sitemapUrl)
      statements.push(
        this.db
          .prepare(`INSERT INTO sitemap_sources
            (id, competitor_id, url, normalized_url, source_type, is_enabled, is_discovered, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'manual', 1, 0, ?, ?)
            ON CONFLICT(competitor_id, normalized_url) DO UPDATE SET
              url = excluded.url,
              source_type = 'manual',
              is_enabled = 1,
              is_discovered = 0,
              parent_source_id = NULL,
              last_error = NULL,
              updated_at = excluded.updated_at`)
          .bind(createId('smp'), input.competitorId, sitemapUrl, normalizedUrl, now, now),
      )
    }

    await this.db.batch(statements)
  }

  async softDeleteCompetitor(competitorId: string): Promise<void> {
    const existing = await this.getConfiguration(competitorId)
    if (!existing) throw new Error('竞品不存在或已经删除。')

    const running = await this.db
      .prepare(`SELECT id FROM scan_runs
                WHERE competitor_id = ? AND status = 'running'
                LIMIT 1`)
      .bind(competitorId)
      .first<{ id: string }>()

    if (running) {
      throw new Error('该竞品正在扫描，扫描完成后才能删除。')
    }

    const now = new Date().toISOString()
    await this.db.batch([
      this.db
        .prepare(`UPDATE competitors
                  SET is_enabled = 0, deleted_at = ?, updated_at = ?
                  WHERE id = ? AND deleted_at IS NULL`)
        .bind(now, now, competitorId),
      this.db
        .prepare(`UPDATE sitemap_sources
                  SET is_enabled = 0, updated_at = ?
                  WHERE competitor_id = ?`)
        .bind(now, competitorId),
      this.db
        .prepare(`UPDATE pages
                  SET deleted_at = ?, updated_at = ?
                  WHERE competitor_id = ? AND deleted_at IS NULL`)
        .bind(now, now, competitorId),
    ])
  }
}
