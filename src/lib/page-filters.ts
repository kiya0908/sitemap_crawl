import { z } from 'zod'
import { validatePathPrefix } from './monitor-path'

const utc = z.string().refine((value) => {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}, 'Use a valid canonical UTC timestamp with milliseconds and Z')

export const pageFiltersSchema = z.object({
  competitorId: z.string().min(1).max(100).optional(),
  pathPrefix: z.string().refine((value) => {
    try { validatePathPrefix(value); return true } catch { return false }
  }, 'Invalid strict path prefix').optional(),
  discoveredFrom: utc.optional(),
  discoveredBefore: utc.optional(),
  pageType: z.string().max(100).optional(),
  searchIntent: z.string().max(100).optional(),
  reviewStatus: z.string().max(100).optional(),
  query: z.string().trim().max(500).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).superRefine((value, ctx) => {
  if ((value.pathPrefix || value.discoveredFrom || value.discoveredBefore) && !value.competitorId) {
    ctx.addIssue({ code: 'custom', message: 'A competitorId is required for a scoped report' })
  }
  if (value.discoveredFrom && value.discoveredBefore && value.discoveredFrom >= value.discoveredBefore) {
    ctx.addIssue({ code: 'custom', message: 'discoveredFrom must be before discoveredBefore' })
  }
})
