-- Apply once AFTER 0005, against the intended DB. Re-running never resets a baseline.
-- Existing monitors with the same domain are deliberately not modified.
INSERT OR IGNORE INTO competitors (id,name,domain,is_enabled,baseline_established,created_at,updated_at)
VALUES ('cmp_media_zones','Media.io Zone public links','media.io',1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO competitors (id,name,domain,is_enabled,baseline_established,created_at,updated_at)
VALUES ('cmp_dreamina_video','Dreamina AI Video archives','dreamina.capcut.com',1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO page_discovery_configs (competitor_id,provider)
SELECT id,'media_zones' FROM competitors WHERE id='cmp_media_zones' AND domain='media.io';
INSERT OR IGNORE INTO page_discovery_configs (competitor_id,provider)
SELECT id,'dreamina_archive' FROM competitors WHERE id='cmp_dreamina_video' AND domain='dreamina.capcut.com';
INSERT OR IGNORE INTO competitor_monitor_rules (competitor_id,path_prefix,created_at)
SELECT competitor_id,CASE provider WHEN 'media_zones' THEN '/ai/explore/zone/' ELSE '/ai-video/' END,strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM page_discovery_configs;
