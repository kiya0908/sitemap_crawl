PRAGMA foreign_keys = ON;

CREATE TABLE competitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  baseline_established INTEGER NOT NULL DEFAULT 0 CHECK (baseline_established IN (0, 1)),
  last_scan_status TEXT,
  last_scanned_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX idx_competitors_domain_active
  ON competitors(domain)
  WHERE deleted_at IS NULL;

CREATE TABLE sitemap_sources (
  id TEXT PRIMARY KEY,
  competitor_id TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'robots', 'common_path', 'sitemap_index_child')),
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  is_discovered INTEGER NOT NULL DEFAULT 0 CHECK (is_discovered IN (0, 1)),
  parent_source_id TEXT REFERENCES sitemap_sources(id) ON DELETE SET NULL,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (competitor_id, normalized_url)
);

CREATE INDEX idx_sitemap_sources_competitor_enabled
  ON sitemap_sources(competitor_id, is_enabled);

CREATE TABLE scan_runs (
  id TEXT PRIMARY KEY,
  competitor_id TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('cron', 'manual', 'retry')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'partial_success', 'failed')),
  is_complete INTEGER NOT NULL DEFAULT 0 CHECK (is_complete IN (0, 1)),
  sitemap_count INTEGER NOT NULL DEFAULT 0,
  total_url_count INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  missing_count INTEGER NOT NULL DEFAULT 0,
  reappeared_count INTEGER NOT NULL DEFAULT 0,
  fetch_success_count INTEGER NOT NULL DEFAULT 0,
  fetch_failed_count INTEGER NOT NULL DEFAULT 0,
  analysis_success_count INTEGER NOT NULL DEFAULT 0,
  analysis_failed_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_scan_runs_competitor_started
  ON scan_runs(competitor_id, started_at DESC);
CREATE INDEX idx_scan_runs_status_started
  ON scan_runs(status, started_at DESC);

CREATE TABLE scan_sitemaps (
  id TEXT PRIMARY KEY,
  scan_run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  sitemap_source_id TEXT REFERENCES sitemap_sources(id) ON DELETE SET NULL,
  requested_url TEXT NOT NULL,
  http_status INTEGER,
  result_status TEXT NOT NULL CHECK (result_status IN ('pending', 'success', 'failed', 'skipped')),
  content_hash TEXT,
  url_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX idx_scan_sitemaps_run
  ON scan_sitemaps(scan_run_id);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  competitor_id TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  original_url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  current_url TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('baseline', 'active', 'new', 'missing', 'reappeared')),
  missing_streak INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  sitemap_lastmod TEXT,
  first_scan_run_id TEXT REFERENCES scan_runs(id) ON DELETE SET NULL,
  last_scan_run_id TEXT REFERENCES scan_runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (competitor_id, normalized_url)
);

CREATE INDEX idx_pages_first_seen
  ON pages(first_seen_at DESC);
CREATE INDEX idx_pages_lifecycle_status
  ON pages(lifecycle_status, last_seen_at DESC);
CREATE INDEX idx_pages_competitor_status
  ON pages(competitor_id, lifecycle_status);

CREATE TABLE page_sitemap_links (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  sitemap_source_id TEXT NOT NULL REFERENCES sitemap_sources(id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  sitemap_lastmod TEXT,
  PRIMARY KEY (page_id, sitemap_source_id)
);

CREATE INDEX idx_page_sitemap_links_source_current
  ON page_sitemap_links(sitemap_source_id, is_current);

CREATE TABLE page_events (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  scan_run_id TEXT REFERENCES scan_runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  old_value_json TEXT,
  new_value_json TEXT,
  detected_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_page_events_page_detected
  ON page_events(page_id, detected_at DESC);
CREATE INDEX idx_page_events_type_detected
  ON page_events(event_type, detected_at DESC);

CREATE TABLE page_seo_data (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  http_status INTEGER,
  final_url TEXT,
  redirect_chain_json TEXT,
  content_type TEXT,
  title TEXT,
  meta_description TEXT,
  h1 TEXT,
  h2_json TEXT,
  canonical_url TEXT,
  robots_meta TEXT,
  page_language TEXT,
  content_excerpt TEXT,
  content_hash TEXT,
  fetch_status TEXT NOT NULL CHECK (fetch_status IN ('pending', 'fetching', 'success', 'failed', 'unsupported')),
  fetch_error TEXT,
  fetched_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_page_seo_fetch_status
  ON page_seo_data(fetch_status, fetched_at DESC);

CREATE TABLE fetch_attempts (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  scan_run_id TEXT REFERENCES scan_runs(id) ON DELETE SET NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scan', 'manual', 'retry', 'reappeared')),
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed', 'unsupported')),
  http_status INTEGER,
  error_code TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX idx_fetch_attempts_page_started
  ON fetch_attempts(page_id, started_at DESC);
CREATE INDEX idx_fetch_attempts_finished
  ON fetch_attempts(finished_at DESC);

CREATE TABLE page_analyses (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'analyzing', 'success', 'failed', 'skipped')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  page_type TEXT,
  primary_topic TEXT,
  primary_keyword TEXT,
  secondary_keywords_json TEXT,
  search_intent TEXT,
  product_line TEXT,
  summary TEXT,
  evidence_json TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  raw_response_excerpt TEXT,
  error_code TEXT,
  error_message TEXT,
  analyzed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_page_analyses_page_analyzed
  ON page_analyses(page_id, analyzed_at DESC);
CREATE INDEX idx_page_analyses_status
  ON page_analyses(status, analyzed_at DESC);

CREATE TABLE page_review (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'reviewed', 'worth_following', 'not_relevant')),
  is_viewed INTEGER NOT NULL DEFAULT 0 CHECK (is_viewed IN (0, 1)),
  is_worth_following INTEGER NOT NULL DEFAULT 0 CHECK (is_worth_following IN (0, 1)),
  manual_page_type TEXT,
  manual_primary_keyword TEXT,
  manual_secondary_keywords_json TEXT,
  manual_search_intent TEXT,
  notes TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_page_review_status
  ON page_review(review_status, updated_at DESC);
