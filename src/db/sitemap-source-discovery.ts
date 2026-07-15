import { createId } from '../lib/id'
import type { DiscoveredRootSitemap } from '../server/sitemap/discover'
import { normalizeUrl } from '../server/sitemap/normalize'

export async function persistDiscoveredRoots(
  db: D1Database,
  competitorId: string,
  roots: DiscoveredRootSitemap[],
): Promise<void> {
  if (roots.length === 0) return
  const now = new Date().toISOString()
  const statements = roots.map((root) =>
    db.prepare(`INSERT OR IGNORE INTO sitemap_sources
      (id, competitor_id, url, normalized_url, source_type, is_enabled, is_discovered, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`)
      .bind(createId('smp'), competitorId, root.url, normalizeUrl(root.url), root.sourceType, now, now),
  )
  await db.batch(statements)
}
