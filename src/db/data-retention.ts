/** No HTTP or scheduled entry point imports this module. All writes are opt-in. */
export interface RetentionDatabase {
  query<T extends Record<string, unknown>>(sql: string, params: Array<string | number>): Promise<T[]>
  execute(sql: string, params: Array<string | number>): Promise<number>
}

export interface RetentionOptions {
  now?: string
  days?: number
  batchSize?: number
  maxBatches?: number
  apply?: boolean
}

export function retentionConfig(options: RetentionOptions = {}) {
  const now = options.now ?? new Date().toISOString()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now)
    || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) {
    throw new Error('now must be a valid canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)')
  }
  const days = options.days ?? 7
  const batchSize = options.batchSize ?? 100
  const maxBatches = options.maxBatches ?? 100
  for (const [name, value, max] of [['days', days, 3650], ['batchSize', batchSize, 500], ['maxBatches', maxBatches, 1000]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer in 1..${max}`)
  }
  return { now, days, batchSize, maxBatches, apply: options.apply === true,
    cutoff: new Date(Date.parse(now) - days * 86_400_000).toISOString() }
}

// The same guard runs INSIDE every mutation, not just in the preview. SQLite/D1
// serializes each statement with task creation. No stale candidate IDs are replayed.
const busy = `EXISTS (SELECT 1 FROM scan_runs WHERE status IN ('queued', 'running'))
 OR EXISTS (SELECT 1 FROM fetch_attempts WHERE status IN ('pending', 'running'))
 OR EXISTS (SELECT 1 FROM page_seo_data WHERE fetch_status IN ('pending', 'fetching'))
 OR EXISTS (SELECT 1 FROM page_analyses WHERE status IN ('pending', 'analyzing'))
 OR EXISTS (SELECT 1 FROM scan_sitemaps WHERE result_status = 'pending')`

const manual = `EXISTS (SELECT 1 FROM page_review r WHERE r.page_id = t.page_id AND (
 r.review_status <> 'unreviewed' OR r.is_viewed = 1 OR r.is_worth_following = 1
 OR COALESCE(r.notes, '') <> '' OR COALESCE(r.manual_page_type, '') <> ''
 OR COALESCE(r.manual_primary_keyword, '') <> '' OR COALESCE(r.manual_search_intent, '') <> ''
 OR COALESCE(r.manual_secondary_keywords_json, '') NOT IN ('', '[]')))`

// Reject NULL, ambiguous offsets, malformed dates and normalized impossible dates.
function validTime(column: string): string {
  return `COALESCE((length(${column}) = 24 AND ${column} GLOB '????-??-??T??:??:??.???Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}, '+0 seconds') = ${column}), 0)`
}

interface Rule {
  name: string
  table: string
  key: string
  payload: string
  timestamps: string[]
  protected: string
  protectionReason: string
  set?: string
}

const rules: Rule[] = [
  { name: 'page_seo_data', table: 'page_seo_data', key: 'page_id', payload: 't.expired_at IS NULL',
    timestamps: ['t.content_fetched_at', 't.fetched_at', 't.updated_at'], protected: manual,
    protectionReason: 'manual_review', set: `title = NULL, meta_description = NULL, h1 = NULL,
      h2_json = NULL, content_excerpt = NULL, content_hash = NULL, redirect_chain_json = NULL,
      fetch_error = NULL, canonical_url = NULL, robots_meta = NULL, expired_at = ?` },
  { name: 'page_analyses', table: 'page_analyses', key: 'id', payload: 't.expired_at IS NULL',
    // Failed/skipped analyses are completed on insertion; successful ones use analyzed_at as well.
    timestamps: ['t.created_at', "CASE WHEN t.status IN ('failed', 'skipped') AND t.analyzed_at IS NULL THEN t.created_at ELSE t.analyzed_at END"],
    protected: manual, protectionReason: 'manual_review',
    set: `page_type = NULL, primary_topic = NULL, primary_keyword = NULL, secondary_keywords_json = NULL,
      search_intent = NULL, product_line = NULL, summary = NULL, evidence_json = NULL, confidence = NULL,
      raw_response_excerpt = NULL, error_code = NULL, error_message = NULL, expired_at = ?` },
  { name: 'fetch_attempts', table: 'fetch_attempts', key: 'id', payload: '1',
    timestamps: ['t.started_at', 't.finished_at'], protected: manual, protectionReason: 'manual_review' },
  { name: 'scan_sitemaps', table: 'scan_sitemaps', key: 'id', payload: '1',
    timestamps: ['t.started_at', 't.finished_at'], protected: '0', protectionReason: 'none' },
  { name: 'scan_runs', table: 'scan_runs', key: 'id', payload: 't.error_summary IS NOT NULL',
    timestamps: ['t.created_at', 't.started_at', 't.finished_at'], protected: '0',
    protectionReason: 'none', set: 'error_summary = NULL' },
  { name: 'page_events.discovered_payload', table: 'page_events', key: 'id',
    payload: "t.event_type = 'discovered' AND (t.old_value_json IS NOT NULL OR t.new_value_json IS NOT NULL)",
    timestamps: ['t.detected_at', 't.created_at'], protected: manual, protectionReason: 'manual_review',
    set: 'old_value_json = NULL, new_value_json = NULL' },
  { name: 'page_events.logs', table: 'page_events', key: 'id', payload: "t.event_type <> 'discovered'",
    timestamps: ['t.detected_at', 't.created_at'],
    protected: `(${manual}) OR t.event_type NOT IN ('baseline_added', 'missing_confirmed', 'reappeared',
      'redirected', 'fetch_failed', 'fetch_recovered', 'analysis_failed', 'analysis_succeeded')`,
    protectionReason: 'manual_review_or_unknown_event' },
]

function reasonSql(rule: Rule): string {
  return `CASE
    WHEN NOT (${rule.payload}) THEN 'already_expired_or_no_payload'
    WHEN (${rule.protected}) THEN '${rule.protectionReason}'
    WHEN NOT (${rule.timestamps.map(validTime).join(' AND ')}) THEN 'unknown_or_invalid_time'
    WHEN NOT (${rule.timestamps.map((t) => `(${t}) < ?`).join(' AND ')}) THEN 'within_retention'
    WHEN (${busy}) THEN 'active_work_global_pause'
    ELSE 'candidate' END`
}

export async function previewRetention(db: RetentionDatabase, options: RetentionOptions = {}) {
  const config = retentionConfig(options)
  const tables = []
  for (const rule of rules) {
    const counts = await db.query<{ reason: string; count: number }>(
      `SELECT ${reasonSql(rule)} AS reason, COUNT(*) AS count FROM ${rule.table} t GROUP BY reason`,
      rule.timestamps.map(() => config.cutoff))
    tables.push({ table: rule.name, action: rule.set ? 'scrub' : 'delete',
      candidates: counts.find((row) => row.reason === 'candidate')?.count ?? 0, counts })
  }
  const retained = []
  for (const [table, reason] of [
    ['pages', 'URL identity and lifecycle; never delete or soft-delete'],
    ['page_review', 'all human values and flags'],
    ['page_sitemap_links', 'source associations'],
    ['competitors', 'configuration and baseline'],
    ['sitemap_sources', 'configuration and source associations'],
  ]) {
    const [row] = await db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`, [])
    retained.push({ table, count: row?.count ?? 0, reason })
  }
  const [activity] = await db.query<{ busy: number }>(`SELECT (${busy}) AS busy`, [])
  return { ...config, busy: activity?.busy === 1, tables, retained,
    note: 'Preview counts are advisory; each bounded write re-evaluates all protections. Scan summaries, expired stubs and discovered identities are retained.' }
}

export async function runRetention(db: RetentionDatabase, options: RetentionOptions = {}) {
  const preview = await previewRetention(db, options)
  const changes: Array<{ table: string; changed: number; batches: number; limitReached: boolean }> = []
  if (!preview.apply || preview.busy) return { preview, changes, paused: preview.busy }
  for (const rule of rules) {
    let changed = 0
    let batches = 0
    let lastChanges = 0
    do {
      const selection = `SELECT t.${rule.key} FROM ${rule.table} t
        WHERE (${reasonSql(rule)}) = 'candidate' ORDER BY t.${rule.key} LIMIT ?`
      const sql = rule.set
        ? `UPDATE ${rule.table} SET ${rule.set} WHERE ${rule.key} IN (${selection})`
        : `DELETE FROM ${rule.table} WHERE ${rule.key} IN (${selection})`
      const params: Array<string | number> = rule.set?.includes('expired_at = ?') ? [preview.now] : []
      params.push(...rule.timestamps.map(() => preview.cutoff), preview.batchSize)
      lastChanges = await db.execute(sql, params)
      changed += lastChanges
      batches += 1
    } while (lastChanges === preview.batchSize && batches < preview.maxBatches)
    changes.push({ table: rule.name, changed, batches,
      limitReached: lastChanges === preview.batchSize && batches === preview.maxBatches })
  }
  const [activity] = await db.query<{ busy: number }>(`SELECT (${busy}) AS busy`, [])
  return { preview, changes, paused: activity?.busy === 1 }
}
