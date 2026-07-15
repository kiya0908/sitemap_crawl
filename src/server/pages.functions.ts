import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { PagesRepository } from '../db/pages-repository'

const pageFiltersSchema = z.object({
  competitorId: z.string().max(100).optional(),
  pageType: z.string().max(100).optional(),
  searchIntent: z.string().max(100).optional(),
  reviewStatus: z.string().max(100).optional(),
  query: z.string().trim().max(500).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
})

const pageIdSchema = z.object({
  pageId: z.string().min(1).max(100),
})

const updateReviewSchema = z.object({
  pageId: z.string().min(1).max(100),
  reviewStatus: z.enum(['unreviewed', 'reviewed', 'worth_following', 'not_relevant']),
  isViewed: z.boolean(),
  isWorthFollowing: z.boolean(),
  manualPageType: z.string().trim().max(100).nullable(),
  manualPrimaryKeyword: z.string().trim().max(300).nullable(),
  manualSecondaryKeywords: z.array(z.string().trim().min(1).max(300)).max(20),
  manualSearchIntent: z.string().trim().max(100).nullable(),
  notes: z.string().trim().max(5_000).nullable(),
})

export const listMonitoredPages = createServerFn({ method: 'GET' })
  .validator(pageFiltersSchema)
  .handler(async ({ data }) => new PagesRepository(env.DB).listPages(cleanFilters(data)))

export const getMonitoredPage = createServerFn({ method: 'GET' })
  .validator(pageIdSchema)
  .handler(async ({ data }) => new PagesRepository(env.DB).getPageDetail(data.pageId))

export const updatePageReview = createServerFn({ method: 'POST' })
  .validator(updateReviewSchema)
  .handler(async ({ data }) => {
    await new PagesRepository(env.DB).updateReview({
      ...data,
      manualPageType: emptyToNull(data.manualPageType),
      manualPrimaryKeyword: emptyToNull(data.manualPrimaryKeyword),
      manualSearchIntent: emptyToNull(data.manualSearchIntent),
      notes: emptyToNull(data.notes),
    })
    return { success: true }
  })

export const exportMonitoredPages = createServerFn({ method: 'GET' })
  .validator(pageFiltersSchema)
  .handler(async ({ data }) => ({
    filename: `sitemap-crawl-${new Date().toISOString().slice(0, 10)}.csv`,
    csv: await new PagesRepository(env.DB).exportCsv(cleanFilters(data)),
  }))

function emptyToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed ? trimmed : null
}

function cleanFilters(input: z.infer<typeof pageFiltersSchema>) {
  return {
    competitorId: input.competitorId || undefined,
    pageType: input.pageType || undefined,
    searchIntent: input.searchIntent || undefined,
    reviewStatus: input.reviewStatus || undefined,
    query: input.query || undefined,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    page: input.page,
    pageSize: input.pageSize,
  }
}
