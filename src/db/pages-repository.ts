import { csvCell } from '../lib/csv'

export interface PageListFilters {
  competitorId?: string
  pageType?: string
  searchIntent?: string
  reviewStatus?: string
  query?: string
  dateFrom?: string
  dateTo?: string
  page?: number
  pageSize?: number
}

export interface PageListItem {
  id: string
  competitorId: string
  competitorName: string
  url: string
  title: string | null
  firstSeenAt: string
  lifecycleStatus: string
  fetchStatus: string | null
  analysisStatus: string | null
  pageType: string | null
  primaryKeyword: string | null
  searchIntent: string | null
  reviewStatus: string
  isViewed: boolean
  isWorthFollowing: boolean
}

export interface PageDetail {
  id: string
  competitorId: string
  competitorName: string
  originalUrl: string
  normalizedUrl: string
  currentUrl: string
  lifecycleStatus: string
  firstSeenAt: string
  lastSeenAt: string
  sitemapLastmod: string | null
  seo: {
    httpStatus: number | null
    finalUrl: string | null
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
    fetchStatus: string | null
    fetchError: string | null
    fetchedAt: string | null
  }
  analysis: {
    status: string | null
    provider: string | null
    model: string | null
    promptVersion: string | null
    pageType: string | null
    primaryTopic: string | null
    primaryKeyword: string | null
    secondaryKeywords: string[]
    searchIntent: string | null
    productLine: string | null
    summary: string | null
    evidence: string[]
    confidence: number | null
    errorMessage: string | null
    analyzedAt: string | null
  }
  review: {
    reviewStatus: string
    isViewed: boolean
    isWorthFollowing: boolean
    manualPageType: string | null
    manualPrimaryKeyword: string | null
    manualSecondaryKeywords: string[]
    manualSearchIntent: string | null
    notes: string | null
    reviewedAt: string | null
  }
  events: Array<{
    id: string
    eventType: string
    oldValue: unknown
    newValue: unknown
    detectedAt: string
  }>
}

interface ListRow {
  id: string
  competitor_id: string
  competitor_name: string
  current_url: string
  title: string | null
  first_seen_at: string
  lifecycle_status: string
  fetch_status: string | null
  analysis_status: string | null
  ai_page_type: string | null
  ai_primary_keyword: string | null
  ai_search_intent: string | null
  review_status: string | null
  is_viewed: number | null
  is_worth_following: number | null
  manual_page_type: string | null
  manual_primary_keyword: string | null
  manual_search_intent: string | null
}

export class PagesRepository {
  constructor(private readonly db: D1Database) {}

  async listPages(filters: PageListFilters): Promise<{ items: PageListItem[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, filters.page ?? 1)
    const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 20))
    const where: string[] = [
      `p.deleted_at IS NULL`,
      `EXISTS (SELECT 1 FROM page_events discovered_event
               WHERE discovered_event.page_id = p.id AND discovered_event.event_type = 'discovered')`,
    ]
    const values: Array<string | number> = []

    if (filters.competitorId) {
      where.push('p.competitor_id = ?')
      values.push(filters.competitorId)
    }
    if (filters.pageType) {
      where.push(`COALESCE(NULLIF(pr.manual_page_type, ''), pa.page_type) = ?`)
      values.push(filters.pageType)
    }
    if (filters.searchIntent) {
      where.push(`COALESCE(NULLIF(pr.manual_search_intent, ''), pa.search_intent) = ?`)
      values.push(filters.searchIntent)
    }
    if (filters.reviewStatus) {
      where.push(`COALESCE(pr.review_status, 'unreviewed') = ?`)
      values.push(filters.reviewStatus)
    }
    if (filters.dateFrom) {
      where.push('p.first_seen_at >= ?')
      values.push(filters.dateFrom)
    }
    if (filters.dateTo) {
      where.push('p.first_seen_at <= ?')
      values.push(filters.dateTo)
    }
    if (filters.query) {
      const query = `%${filters.query.trim()}%`
      where.push(`(
        p.current_url LIKE ? OR seo.title LIKE ? OR
        COALESCE(NULLIF(pr.manual_primary_keyword, ''), pa.primary_keyword, '') LIKE ?
      )`)
      values.push(query, query, query)
    }

    const joins = `
      FROM pages p
      JOIN competitors c ON c.id = p.competitor_id
      LEFT JOIN page_seo_data seo ON seo.page_id = p.id
      LEFT JOIN page_review pr ON pr.page_id = p.id
      LEFT JOIN page_analyses pa ON pa.id = (
        SELECT latest.id FROM page_analyses latest
        WHERE latest.page_id = p.id
        ORDER BY CASE WHEN latest.status = 'success' THEN 0 ELSE 1 END,
                 COALESCE(latest.analyzed_at, latest.created_at) DESC
        LIMIT 1
      )
    `
    const whereSql = `WHERE ${where.join(' AND ')}`
    const count = await this.db
      .prepare(`SELECT COUNT(*) AS total ${joins} ${whereSql}`)
      .bind(...values)
      .first<{ total: number }>()

    const rows = await this.db
      .prepare(`SELECT
        p.id, p.competitor_id, c.name AS competitor_name, p.current_url, seo.title,
        p.first_seen_at, p.lifecycle_status, seo.fetch_status,
        pa.status AS analysis_status, pa.page_type AS ai_page_type,
        pa.primary_keyword AS ai_primary_keyword, pa.search_intent AS ai_search_intent,
        pr.review_status, pr.is_viewed, pr.is_worth_following,
        pr.manual_page_type, pr.manual_primary_keyword, pr.manual_search_intent
        ${joins} ${whereSql}
        ORDER BY p.first_seen_at DESC, p.id DESC
        LIMIT ? OFFSET ?`)
      .bind(...values, pageSize, (page - 1) * pageSize)
      .all<ListRow>()

    return {
      items: rows.results.map(mapListRow),
      total: count?.total ?? 0,
      page,
      pageSize,
    }
  }

  async getPageDetail(pageId: string): Promise<PageDetail | null> {
    const row = await this.db.prepare(`SELECT
      p.id, p.competitor_id, c.name AS competitor_name, p.original_url, p.normalized_url,
      p.current_url, p.lifecycle_status, p.first_seen_at, p.last_seen_at, p.sitemap_lastmod,
      seo.http_status, seo.final_url, seo.redirect_chain_json, seo.content_type, seo.title,
      seo.meta_description, seo.h1, seo.h2_json, seo.canonical_url, seo.robots_meta,
      seo.page_language, seo.content_excerpt, seo.fetch_status, seo.fetch_error, seo.fetched_at,
      pa.status AS analysis_status, pa.provider, pa.model, pa.prompt_version, pa.page_type,
      pa.primary_topic, pa.primary_keyword, pa.secondary_keywords_json, pa.search_intent,
      pa.product_line, pa.summary, pa.evidence_json, pa.confidence, pa.error_message,
      pa.analyzed_at,
      pr.review_status, pr.is_viewed, pr.is_worth_following, pr.manual_page_type,
      pr.manual_primary_keyword, pr.manual_secondary_keywords_json, pr.manual_search_intent,
      pr.notes, pr.reviewed_at
      FROM pages p
      JOIN competitors c ON c.id = p.competitor_id
      LEFT JOIN page_seo_data seo ON seo.page_id = p.id
      LEFT JOIN page_review pr ON pr.page_id = p.id
      LEFT JOIN page_analyses pa ON pa.id = (
        SELECT latest.id FROM page_analyses latest
        WHERE latest.page_id = p.id
        ORDER BY CASE WHEN latest.status = 'success' THEN 0 ELSE 1 END,
                 COALESCE(latest.analyzed_at, latest.created_at) DESC
        LIMIT 1
      )
      WHERE p.id = ? AND p.deleted_at IS NULL`)
      .bind(pageId)
      .first<Record<string, string | number | null>>()

    if (!row) return null

    const eventRows = await this.db.prepare(`SELECT id, event_type, old_value_json, new_value_json, detected_at
      FROM page_events WHERE page_id = ? ORDER BY detected_at DESC LIMIT 100`)
      .bind(pageId)
      .all<{ id: string; event_type: string; old_value_json: string | null; new_value_json: string | null; detected_at: string }>()

    return {
      id: stringValue(row.id),
      competitorId: stringValue(row.competitor_id),
      competitorName: stringValue(row.competitor_name),
      originalUrl: stringValue(row.original_url),
      normalizedUrl: stringValue(row.normalized_url),
      currentUrl: stringValue(row.current_url),
      lifecycleStatus: stringValue(row.lifecycle_status),
      firstSeenAt: stringValue(row.first_seen_at),
      lastSeenAt: stringValue(row.last_seen_at),
      sitemapLastmod: nullableString(row.sitemap_lastmod),
      seo: {
        httpStatus: nullableNumber(row.http_status),
        finalUrl: nullableString(row.final_url),
        redirectChain: parseStringArray(nullableString(row.redirect_chain_json)),
        contentType: nullableString(row.content_type),
        title: nullableString(row.title),
        metaDescription: nullableString(row.meta_description),
        h1: nullableString(row.h1),
        h2: parseStringArray(nullableString(row.h2_json)),
        canonicalUrl: nullableString(row.canonical_url),
        robotsMeta: nullableString(row.robots_meta),
        pageLanguage: nullableString(row.page_language),
        contentExcerpt: nullableString(row.content_excerpt),
        fetchStatus: nullableString(row.fetch_status),
        fetchError: nullableString(row.fetch_error),
        fetchedAt: nullableString(row.fetched_at),
      },
      analysis: {
        status: nullableString(row.analysis_status),
        provider: nullableString(row.provider),
        model: nullableString(row.model),
        promptVersion: nullableString(row.prompt_version),
        pageType: nullableString(row.page_type),
        primaryTopic: nullableString(row.primary_topic),
        primaryKeyword: nullableString(row.primary_keyword),
        secondaryKeywords: parseStringArray(nullableString(row.secondary_keywords_json)),
        searchIntent: nullableString(row.search_intent),
        productLine: nullableString(row.product_line),
        summary: nullableString(row.summary),
        evidence: parseStringArray(nullableString(row.evidence_json)),
        confidence: nullableNumber(row.confidence),
        errorMessage: nullableString(row.error_message),
        analyzedAt: nullableString(row.analyzed_at),
      },
      review: {
        reviewStatus: nullableString(row.review_status) ?? 'unreviewed',
        isViewed: row.is_viewed === 1,
        isWorthFollowing: row.is_worth_following === 1,
        manualPageType: nullableString(row.manual_page_type),
        manualPrimaryKeyword: nullableString(row.manual_primary_keyword),
        manualSecondaryKeywords: parseStringArray(nullableString(row.manual_secondary_keywords_json)),
        manualSearchIntent: nullableString(row.manual_search_intent),
        notes: nullableString(row.notes),
        reviewedAt: nullableString(row.reviewed_at),
      },
      events: eventRows.results.map((event) => ({
        id: event.id,
        eventType: event.event_type,
        oldValue: parseJson(event.old_value_json),
        newValue: parseJson(event.new_value_json),
        detectedAt: event.detected_at,
      })),
    }
  }

  async updateReview(input: {
    pageId: string
    reviewStatus: 'unreviewed' | 'reviewed' | 'worth_following' | 'not_relevant'
    isViewed: boolean
    isWorthFollowing: boolean
    manualPageType: string | null
    manualPrimaryKeyword: string | null
    manualSecondaryKeywords: string[]
    manualSearchIntent: string | null
    notes: string | null
  }): Promise<void> {
    const now = new Date().toISOString()
    await this.db.prepare(`INSERT INTO page_review
      (page_id, review_status, is_viewed, is_worth_following, manual_page_type,
       manual_primary_keyword, manual_secondary_keywords_json, manual_search_intent,
       notes, reviewed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(page_id) DO UPDATE SET
        review_status = excluded.review_status,
        is_viewed = excluded.is_viewed,
        is_worth_following = excluded.is_worth_following,
        manual_page_type = excluded.manual_page_type,
        manual_primary_keyword = excluded.manual_primary_keyword,
        manual_secondary_keywords_json = excluded.manual_secondary_keywords_json,
        manual_search_intent = excluded.manual_search_intent,
        notes = excluded.notes,
        reviewed_at = excluded.reviewed_at,
        updated_at = excluded.updated_at`)
      .bind(
        input.pageId,
        input.reviewStatus,
        input.isViewed ? 1 : 0,
        input.isWorthFollowing ? 1 : 0,
        input.manualPageType,
        input.manualPrimaryKeyword,
        JSON.stringify(input.manualSecondaryKeywords),
        input.manualSearchIntent,
        input.notes,
        now,
        now,
        now,
      )
      .run()
  }

  async exportCsv(filters: PageListFilters): Promise<string> {
    const result = await this.listPages({ ...filters, page: 1, pageSize: 100 })
    const rows = [
      [
        'First Seen',
        'Competitor',
        'URL',
        'Title',
        'Lifecycle Status',
        'Fetch Status',
        'Analysis Status',
        'Page Type',
        'Primary Keyword (Inferred)',
        'Search Intent',
        'Review Status',
        'Worth Following',
      ],
      ...result.items.map((item) => [
        item.firstSeenAt,
        item.competitorName,
        item.url,
        item.title ?? '',
        item.lifecycleStatus,
        item.fetchStatus ?? '',
        item.analysisStatus ?? '',
        item.pageType ?? '',
        item.primaryKeyword ?? '',
        item.searchIntent ?? '',
        item.reviewStatus,
        item.isWorthFollowing ? 'yes' : 'no',
      ]),
    ]

    return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`
  }
}

function mapListRow(row: ListRow): PageListItem {
  return {
    id: row.id,
    competitorId: row.competitor_id,
    competitorName: row.competitor_name,
    url: row.current_url,
    title: row.title,
    firstSeenAt: row.first_seen_at,
    lifecycleStatus: row.lifecycle_status,
    fetchStatus: row.fetch_status,
    analysisStatus: row.analysis_status,
    pageType: row.manual_page_type || row.ai_page_type,
    primaryKeyword: row.manual_primary_keyword || row.ai_primary_keyword,
    searchIntent: row.manual_search_intent || row.ai_search_intent,
    reviewStatus: row.review_status ?? 'unreviewed',
    isViewed: row.is_viewed === 1,
    isWorthFollowing: row.is_worth_following === 1,
  }
}

function parseStringArray(value: string | null): string[] {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
}

function parseJson(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function nullableString(value: string | number | null | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function stringValue(value: string | number | null | undefined): string {
  return typeof value === 'string' ? value : ''
}

function nullableNumber(value: string | number | null | undefined): number | null {
  return typeof value === 'number' ? value : null
}
