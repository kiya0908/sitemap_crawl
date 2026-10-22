import { PagesRepository, type PageListFilters } from '../../db/pages-repository'
import { pageFiltersSchema } from '../../lib/page-filters'

// Read-only, same Cloudflare Access protection as /pages. No credentials in URLs.
export async function discoveryFeed(request: Request, db: D1Database): Promise<Response> {
  const headers = { 'Cache-Control': 'private, no-store' }
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET' } })
  const parsed = pageFiltersSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success || !parsed.data.competitorId) return Response.json({ error: 'Valid competitorId and filters required' }, { status: 400, headers })
  try {
    const repository = new PagesRepository(db)
    const monitor = await repository.getMonitorContext(parsed.data.competitorId)
    if (!monitor) return Response.json({ error: 'Monitor not found' }, { status: 404, headers })
    const pages = await repository.listPages(Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined)) as PageListFilters)
    return Response.json({
      ...pages, monitor,
      coverage: monitor.discovery_provider ? 'public_sources_only' : 'sitemap',
      publicationTimeKnown: false,
      interpretation: 'Items are first-observed URLs, not confirmed newly published pages. Empty items do not prove no new pages. Check monitor status, source_complete and scan times.',
      nextPage: pages.page * pages.pageSize < pages.total ? pages.page + 1 : null,
    }, { headers })
  } catch {
    return Response.json({ error: 'Discovery report unavailable' }, { status: 503, headers })
  }
}
