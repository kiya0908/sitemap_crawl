// Read-only capability detection allows code rollout before the separately approved migration.
// Cache only on the request-scoped repository, never across Worker requests/databases.
export async function retentionSchema(db: D1Database) {
  const [seo, analysis] = await Promise.all([
    db.prepare('PRAGMA table_info(page_seo_data)').all<{ name: string }>(),
    db.prepare('PRAGMA table_info(page_analyses)').all<{ name: string }>(),
  ])
  return {
    seoExpired: seo.results.some((column) => column.name === 'expired_at'),
    contentFetched: seo.results.some((column) => column.name === 'content_fetched_at'),
    analysisExpired: analysis.results.some((column) => column.name === 'expired_at'),
  }
}
