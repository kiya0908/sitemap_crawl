-- Independent discovery configuration; existing Sitemap targets are unchanged.
CREATE TABLE page_discovery_configs (
  competitor_id TEXT PRIMARY KEY REFERENCES competitors(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('media_zones', 'dreamina_archive'))
);
ALTER TABLE pages ADD COLUMN discovery_method TEXT NOT NULL DEFAULT 'sitemap';
ALTER TABLE pages ADD COLUMN discovery_source_url TEXT;
ALTER TABLE scan_runs ADD COLUMN source_complete INTEGER CHECK(source_complete IN (0, 1));
