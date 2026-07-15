import { createId } from '../lib/id'
import type { SeoAnalysisResult } from '../server/ai/schemas'
import type { PageSeoResult } from '../server/page-fetch/fetch-page'

export interface PagePipelineTarget {
  pageId: string
  url: string
  competitorDomain: string
}

export class PagePipelineRepository {
  constructor(private readonly db: D1Database) {}

  async getTargets(pageIds: string[]): Promise<PagePipelineTarget[]> {
    if (pageIds.length === 0) return []
    const placeholders = pageIds.map(() => '?').join(',')
    const result = await this.db
      .prepare(`SELECT p.id AS page_id, p.current_url, c.domain
                FROM pages p JOIN competitors c ON c.id = p.competitor_id
                WHERE p.id IN (${placeholders})`)
      .bind(...pageIds)
      .all<{ page_id: string; current_url: string; domain: string }>()

    return result.results.map((row) => ({
      pageId: row.page_id,
      url: row.current_url,
      competitorDomain: row.domain,
    }))
  }

  async createFetchAttempt(pageId: string, scanRunId: string, attemptNumber: number): Promise<string> {
    const id = createId('fetch')
    const now = new Date().toISOString()
    await this.db.prepare(`INSERT INTO fetch_attempts
      (id, page_id, scan_run_id, trigger_type, attempt_number, status, started_at)
      VALUES (?, ?, ?, 'scan', ?, 'running', ?)`)
      .bind(id, pageId, scanRunId, attemptNumber, now).run()
    await this.db.prepare(`UPDATE page_seo_data SET fetch_status = 'fetching', updated_at = ? WHERE page_id = ?`)
      .bind(now, pageId).run()
    return id
  }

  async saveFetchResult(pageId: string, fetchAttemptId: string, result: PageSeoResult, durationMs: number): Promise<void> {
    const now = new Date().toISOString()
    const status = result.status
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`UPDATE fetch_attempts SET status = ?, http_status = ?, error_code = ?, error_message = ?,
                       duration_ms = ?, finished_at = ? WHERE id = ?`)
        .bind(status, result.httpStatus, result.errorCode, result.errorMessage, durationMs, now, fetchAttemptId),
    ]

    if (status === 'success') {
      statements.push(
        this.db.prepare(`INSERT INTO page_seo_data
          (page_id, http_status, final_url, redirect_chain_json, content_type, title, meta_description,
           h1, h2_json, canonical_url, robots_meta, page_language, content_excerpt, content_hash,
           fetch_status, fetch_error, fetched_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', NULL, ?, ?)
          ON CONFLICT(page_id) DO UPDATE SET
            http_status = excluded.http_status,
            final_url = excluded.final_url,
            redirect_chain_json = excluded.redirect_chain_json,
            content_type = excluded.content_type,
            title = excluded.title,
            meta_description = excluded.meta_description,
            h1 = excluded.h1,
            h2_json = excluded.h2_json,
            canonical_url = excluded.canonical_url,
            robots_meta = excluded.robots_meta,
            page_language = excluded.page_language,
            content_excerpt = excluded.content_excerpt,
            content_hash = excluded.content_hash,
            fetch_status = 'success', fetch_error = NULL,
            fetched_at = excluded.fetched_at, updated_at = excluded.updated_at`)
          .bind(
            pageId,
            result.httpStatus,
            result.finalUrl,
            JSON.stringify(result.redirectChain),
            result.contentType,
            result.title,
            result.metaDescription,
            result.h1,
            JSON.stringify(result.h2),
            result.canonicalUrl,
            result.robotsMeta,
            result.pageLanguage,
            result.contentExcerpt,
            result.contentHash,
            now,
            now,
          ),
      )

      if (result.redirectChain.length > 0) {
        statements.push(
          this.db.prepare(`INSERT INTO page_events
            (id, page_id, event_type, new_value_json, detected_at, created_at)
            VALUES (?, ?, 'redirected', ?, ?, ?)`)
            .bind(createId('evt'), pageId, JSON.stringify({ finalUrl: result.finalUrl, chain: result.redirectChain }), now, now),
          this.db.prepare(`UPDATE pages SET current_url = ?, updated_at = ? WHERE id = ?`)
            .bind(result.finalUrl, now, pageId),
        )
      }
    } else {
      statements.push(
        this.db.prepare(`INSERT INTO page_seo_data
          (page_id, http_status, final_url, redirect_chain_json, content_type, fetch_status, fetch_error, fetched_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(page_id) DO UPDATE SET
            http_status = excluded.http_status,
            final_url = excluded.final_url,
            redirect_chain_json = excluded.redirect_chain_json,
            content_type = excluded.content_type,
            fetch_status = excluded.fetch_status,
            fetch_error = excluded.fetch_error,
            fetched_at = excluded.fetched_at,
            updated_at = excluded.updated_at`)
          .bind(
            pageId,
            result.httpStatus,
            result.finalUrl,
            JSON.stringify(result.redirectChain),
            result.contentType,
            status,
            result.errorMessage,
            now,
            now,
          ),
        this.db.prepare(`INSERT INTO page_events
          (id, page_id, event_type, new_value_json, detected_at, created_at)
          VALUES (?, ?, 'fetch_failed', ?, ?, ?)`)
          .bind(createId('evt'), pageId, JSON.stringify({ code: result.errorCode, message: result.errorMessage }), now, now),
      )
    }

    await this.db.batch(statements)
  }

  async saveAnalysisSuccess(input: {
    pageId: string
    scanRunId: string
    provider: string
    model: string
    promptVersion: string
    result: SeoAnalysisResult
    rawResponseExcerpt: string
  }): Promise<void> {
    const now = new Date().toISOString()
    await this.db.batch([
      this.db.prepare(`INSERT INTO page_analyses
        (id, page_id, status, provider, model, prompt_version, page_type, primary_topic,
         primary_keyword, secondary_keywords_json, search_intent, product_line, summary,
         evidence_json, confidence, raw_response_excerpt, analyzed_at, created_at)
        VALUES (?, ?, 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          createId('analysis'), input.pageId, input.provider, input.model, input.promptVersion,
          input.result.pageType, input.result.primaryTopic, input.result.primaryKeyword,
          JSON.stringify(input.result.secondaryKeywords), input.result.searchIntent,
          input.result.productLine, input.result.summary, JSON.stringify(input.result.reasoningEvidence),
          input.result.confidence, input.rawResponseExcerpt.slice(0, 4_000), now, now,
        ),
      this.db.prepare(`INSERT INTO page_events
        (id, page_id, scan_run_id, event_type, detected_at, created_at)
        VALUES (?, ?, ?, 'analysis_succeeded', ?, ?)`)
        .bind(createId('evt'), input.pageId, input.scanRunId, now, now),
    ])
  }

  async saveAnalysisFailure(input: {
    pageId: string
    scanRunId: string
    provider: string
    model: string
    promptVersion: string
    error: unknown
    skipped?: boolean
  }): Promise<void> {
    const now = new Date().toISOString()
    const message = input.error instanceof Error ? input.error.message : 'Unknown analysis error'
    const status = input.skipped ? 'skipped' : 'failed'
    await this.db.batch([
      this.db.prepare(`INSERT INTO page_analyses
        (id, page_id, status, provider, model, prompt_version, error_code, error_message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(createId('analysis'), input.pageId, status, input.provider, input.model, input.promptVersion,
          input.skipped ? 'AI_NOT_CONFIGURED' : 'AI_REQUEST_FAILED', message.slice(0, 2_000), now),
      this.db.prepare(`INSERT INTO page_events
        (id, page_id, scan_run_id, event_type, new_value_json, detected_at, created_at)
        VALUES (?, ?, ?, 'analysis_failed', ?, ?, ?)`)
        .bind(createId('evt'), input.pageId, input.scanRunId, JSON.stringify({ status, message }), now, now),
    ])
  }

  async updateScanPipelineCounts(scanRunId: string, counts: {
    fetchSuccess: number
    fetchFailed: number
    analysisSuccess: number
    analysisFailed: number
  }): Promise<void> {
    await this.db.prepare(`UPDATE scan_runs SET
      fetch_success_count = ?, fetch_failed_count = ?, analysis_success_count = ?, analysis_failed_count = ?
      WHERE id = ?`)
      .bind(counts.fetchSuccess, counts.fetchFailed, counts.analysisSuccess, counts.analysisFailed, scanRunId)
      .run()
  }

  async getSeoInput(pageId: string): Promise<{
    url: string
    title: string | null
    metaDescription: string | null
    h1: string | null
    h2: string[]
    pageLanguage: string | null
    contentExcerpt: string | null
  } | null> {
    const row = await this.db.prepare(`SELECT p.current_url, s.title, s.meta_description, s.h1, s.h2_json,
      s.page_language, s.content_excerpt FROM pages p JOIN page_seo_data s ON s.page_id = p.id
      WHERE p.id = ? AND s.fetch_status = 'success'`).bind(pageId).first<{
        current_url: string
        title: string | null
        meta_description: string | null
        h1: string | null
        h2_json: string | null
        page_language: string | null
        content_excerpt: string | null
      }>()

    if (!row) return null
    return {
      url: row.current_url,
      title: row.title,
      metaDescription: row.meta_description,
      h1: row.h1,
      h2: parseStringArray(row.h2_json),
      pageLanguage: row.page_language,
      contentExcerpt: row.content_excerpt,
    }
  }
}

function parseStringArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
