import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { SitemapRepository } from '../db/repository'
import { runCompetitorScan } from './scans/orchestrator'
import { normalizeDomain, sameRegistrableHost } from './sitemap/normalize'

const createCompetitorSchema = z.object({
  name: z.string().trim().min(1).max(100),
  domain: z.string().trim().min(1).max(253),
  sitemapUrls: z.array(z.url()).max(10).default([]),
})

const competitorIdSchema = z.object({
  competitorId: z.string().min(1).max(100),
})

export const getDashboardData = createServerFn({ method: 'GET' }).handler(async () => {
  return new SitemapRepository(env.DB).getDashboard()
})

export const createCompetitor = createServerFn({ method: 'POST' })
  .validator(createCompetitorSchema)
  .handler(async ({ data }) => {
    const domain = normalizeDomain(data.domain)
    for (const sitemapUrl of data.sitemapUrls) {
      if (!sameRegistrableHost(sitemapUrl, domain)) {
        throw new Error(`Sitemap URL must use ${domain} or one of its subdomains`)
      }
    }

    const id = await new SitemapRepository(env.DB).createCompetitor({
      name: data.name,
      domain,
      sitemapUrls: data.sitemapUrls,
    })
    return { id }
  })

export const triggerCompetitorScan = createServerFn({ method: 'POST' })
  .validator(competitorIdSchema)
  .handler(async ({ data }) => runCompetitorScan(env, data.competitorId, 'manual'))
