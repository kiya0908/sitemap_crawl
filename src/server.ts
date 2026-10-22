import { discoveryFeed } from './server/discovery/feed'
import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { runScheduledCompetitors } from './server/scans/orchestrator'

const server = createServerEntry({
  fetch(request: Request) {
    return handler.fetch(request)
  },
})

export default {
  fetch(request: Request, _env: Env, _ctx: ExecutionContext) {
    if (new URL(request.url).pathname === '/api/discovery/pages') return discoveryFeed(request, _env.DB)
    return server.fetch(request)
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScheduledCompetitors(env, event.cron, event.scheduledTime).then((summaries) => {
        console.log(JSON.stringify({
          message: 'Scheduled Sitemap scans completed',
          cron: event.cron,
          scheduledTime: event.scheduledTime,
          scannedCompetitors: summaries.length,
          newPages: summaries.reduce((total, summary) => total + summary.newCount, 0),
        }))
      }),
    )
  },
} satisfies ExportedHandler<Env>
