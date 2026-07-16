import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { csvCell } from '../lib/csv'
import {
  PagesRepository,
  type PageDetail,
  type PageListFilters,
  type PageListItem,
} from '../db/pages-repository'

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

export const getMonitoredPageSerialized = createServerFn({ method: 'GET' })
  .validator(pageIdSchema)
  .handler(async ({ data }) => {
    const detail = await new PagesRepository(env.DB).getPageDetail(data.pageId)
    return detail ? JSON.stringify(detail) : null
  })

export async function getMonitoredPage(input: { data: { pageId: string } }): Promise<PageDetail | null> {
  const serialized = await getMonitoredPageSerialized(input)
  return serialized ? JSON.parse(serialized) as PageDetail : null
}

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
  .handler(async ({ data }) => {
    const filters = cleanFilters(data)
    const repository = new PagesRepository(env.DB)
    const items = await loadAllFilteredPages(repository, filters)
    return {
      filename: `sitemap-crawl-${new Date().toISOString().slice(0, 10)}.csv`,
      csv: buildCsv(items),
    }
  })

async function loadAllFilteredPages(repository: PagesRepository, filters: PageListFilters): Promise<PageListItem[]> {
  const items: PageListItem[] = []
  let page = 1
  let total = 0

  do {
    const result = await repository.listPages({ ...filters, page, pageSize: 100 })
    items.push(...result.items)
    total = result.total
    page += 1
  } while (items.length < total && items.length < 5_000)

  return items
}

function buildCsv(items: PageListItem[]): string {
  const rows = [
    [
      'First Seen',
      'Competitor',
      'URL',
      'Title',
      'Lifecycle Status',
      'Fetch Status',
      'Analysis Status',
      'Page Type',
      'Primary Keyword (Inferred)',
      'Search Intent',
      'Review Status',
      'Worth Following',
    ],
    ...items.map((item) => [
      item.firstSeenAt,
      item.competitorName,
      item.url,
      item.title ?? '',
      item.lifecycleStatus,
      item.fetchStatus ?? '',
      item.analysisStatus ?? '',
      item.pageType ?? '',
      item.primaryKeyword ?? '',
      item.searchIntent ?? '',
      item.reviewStatus,
      item.isWorthFollowing ? 'yes' : 'no',
    ]),
  ]

  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`
}

function emptyToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed ? trimmed : null
}

function cleanFilters(input: z.infer<typeof pageFiltersSchema>): PageListFilters {
  const filters: PageListFilters = {
    page: input.page,
    pageSize: input.pageSize,
  }

  if (input.competitorId) filters.competitorId = input.competitorId
  if (input.pageType) filters.pageType = input.pageType
  if (input.searchIntent) filters.searchIntent = input.searchIntent
  if (input.reviewStatus) filters.reviewStatus = input.reviewStatus
  if (input.query) filters.query = input.query
  if (input.dateFrom) filters.dateFrom = input.dateFrom
  if (input.dateTo) filters.dateTo = input.dateTo

  return filters
}
