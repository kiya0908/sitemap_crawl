import { describe, expect, it } from 'vitest'
import { SitemapRepository } from '../src/db/repository'

describe('SitemapRepository.getDashboard', () => {
  it('counts new pages from immutable discovered events instead of lifecycle status', async () => {
    const seenSql: string[] = []
    const db = {
      prepare: (sql: string) => {
        seenSql.push(sql)
        return {
          bind: () => ({
            first: async () => ({ today_new: 2, seven_day_new: 5 }),
          }),
          all: async () => ({ results: [] }),
          first: async () => ({ unreviewed: 0, worth_following: 0 }),
        }
      },
    } as unknown as D1Database

    const dashboard = await new SitemapRepository(db).getDashboard()

    expect(dashboard.todayNew).toBe(2)
    expect(dashboard.lastSevenDaysNew).toBe(5)
    expect(seenSql.some((sql) => sql.includes("FROM page_events") && sql.includes("event_type = 'discovered'")))
      .toBe(true)
  })
})
