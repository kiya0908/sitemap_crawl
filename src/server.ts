import handler from '@tanstack/react-start/server-entry'
import { runAllEnabledCompetitors } from './server/scans/orchestrator'

export default {
  fetch: handler.fetch,
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
