import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { CompetitorManagementRepository } from '../db/competitor-management'
import { CompetitorDomainConflictError } from '../db/errors'
import { SitemapRepository } from '../db/repository'
import { runCompetitorScan } from './scans/orchestrator'
import { normalizeDomain, sameRegistrableHost } from './sitemap/normalize'

const createCompetitorSchema = z.object({
  name: z.string().trim().min(1).max(100),
  domain: z.string().trim().min(1).max(253),
  sitemapUrls: z.array(z.string().url()).max(10).default([]),
})

const competitorIdSchema = z.object({
  competitorId: z.string().min(1).max(100),
})

const updateCompetitorSchema = createCompetitorSchema.extend({
  competitorId: z.string().min(1).max(100),
  isEnabled: z.boolean(),
})

export const getDashboardData = createServerFn({ method: 'GET' }).handler(async () => {
  return new SitemapRepository(env.DB).getDashboard()
})

export const getCompetitorConfiguration = createServerFn({ method: 'GET' })
  .validator(competitorIdSchema)
  .handler(async ({ data }) => new CompetitorManagementRepository(env.DB).getConfiguration(data.competitorId))

export const createCompetitor = createServerFn({ method: 'POST' })
  .validator(createCompetitorSchema)
  .handler(async ({ data }) => {
    const domain = normalizeDomain(data.domain)
    validateSitemapHosts(data.sitemapUrls, domain)

    try {
      const id = await new SitemapRepository(env.DB).createCompetitor({
        name: data.name,
        domain,
        sitemapUrls: data.sitemapUrls,
      })
      return { ok: true as const, id }
    } catch (error) {
      if (error instanceof CompetitorDomainConflictError) {
        return {
          ok: false as const,
          code: error.code,
          message: error.message,
        }
      }

      console.error('Failed to create competitor', error)
      throw new Error('创建竞品失败，请稍后重试。')
    }
  })

export const updateCompetitor = createServerFn({ method: 'POST' })
  .validator(updateCompetitorSchema)
  .handler(async ({ data }) => {
    const domain = normalizeDomain(data.domain)
    validateSitemapHosts(data.sitemapUrls, domain)

    try {
      await new CompetitorManagementRepository(env.DB).updateCompetitor({
        competitorId: data.competitorId,
        name: data.name,
        domain,
        isEnabled: data.isEnabled,
        sitemapUrls: data.sitemapUrls,
      })
      return { ok: true as const }
    } catch (error) {
      if (error instanceof CompetitorDomainConflictError) {
        return {
          ok: false as const,
          code: error.code,
          message: error.message,
        }
      }

      const message = error instanceof Error ? error.message : '修改竞品失败，请稍后重试。'
      return { ok: false as const, code: 'COMPETITOR_UPDATE_FAILED', message }
    }
  })

export const deleteCompetitor = createServerFn({ method: 'POST' })
  .validator(competitorIdSchema)
  .handler(async ({ data }) => {
    try {
      await new CompetitorManagementRepository(env.DB).softDeleteCompetitor(data.competitorId)
      return { ok: true as const }
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除竞品失败，请稍后重试。'
      return { ok: false as const, code: 'COMPETITOR_DELETE_FAILED', message }
    }
  })

export const triggerCompetitorScan = createServerFn({ method: 'POST' })
  .validator(competitorIdSchema)
  .handler(async ({ data }) => runCompetitorScan(env, data.competitorId, 'manual'))

function validateSitemapHosts(sitemapUrls: string[], domain: string): void {
  for (const sitemapUrl of sitemapUrls) {
    if (!sameRegistrableHost(sitemapUrl, domain)) {
      throw new Error(`Sitemap URL 必须使用 ${domain} 或它的子域名。`)
    }
  }
}
