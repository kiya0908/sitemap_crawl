import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { runAllEnabledCompetitors } from './server/scans/orchestrator'

const server = createServerEntry({
  fetch(request: Request) {
    return handler.fetch(request)
  },
})

export default {
  fetch(request: Request, _env: Env, _ctx: ExecutionContext) {
    return server.fetch(request)
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runAllEnabledCompetitors(env).then((summaries) => {
        console.log('Scheduled Sitemap scans completed', {
          scannedCompetitors: summaries.length,
          newPages: summaries.reduce((total, summary) => total + summary.newCount, 0),
        })
      }),
    )
  },
} satisfies ExportedHandler<Env>
