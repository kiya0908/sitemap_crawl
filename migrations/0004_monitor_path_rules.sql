-- Optional per-competitor scope; existing competitors have no rule and keep their behavior.
CREATE TABLE competitor_monitor_rules (
  competitor_id TEXT PRIMARY KEY REFERENCES competitors(id) ON DELETE CASCADE,
  path_prefix TEXT NOT NULL CHECK(length(path_prefix) > 1 AND substr(path_prefix, 1, 1) = '/' AND substr(path_prefix, -1) = '/'),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_page_events_discovery_window ON page_events(event_type, detected_at, page_id);
