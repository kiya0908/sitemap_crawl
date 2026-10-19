-- Additive only. No content is removed by this migration.
ALTER TABLE page_seo_data ADD COLUMN content_fetched_at TEXT;
ALTER TABLE page_seo_data ADD COLUMN expired_at TEXT;
ALTER TABLE page_analyses ADD COLUMN expired_at TEXT;

-- Failed legacy fetches may contain older successful content of unknown age.
-- Leave that age unknown rather than inventing a timestamp.
UPDATE page_seo_data SET content_fetched_at = fetched_at WHERE fetch_status = 'success';

CREATE INDEX idx_fetch_attempts_status ON fetch_attempts(status);
CREATE INDEX idx_scan_sitemaps_finished ON scan_sitemaps(finished_at);
