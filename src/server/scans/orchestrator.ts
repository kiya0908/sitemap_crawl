import { PagePipelineRepository } from '../../db/page-pipeline-repository'
import { SitemapRepository } from '../../db/repository'
import { persistDiscoveredRoots } from '../../db/sitemap-source-discovery'
import { OpenRouterSeoProvider } from '../ai/openrouter'
import { fetchPageSeo } from '../page-fetch/fetch-page'
import { collectSitemapEntries } from '../sitemap/collect'
import { discoverRootSitemaps } from '../sitemap/discover'
import type { ScanSummary, ScanTrigger } from '../types'
import { calculateScanDiff } from './diff'

export async function runCompetitorScan(
  env: Env,
  competitorId: string,
  triggerType: ScanTrigger,
): Promise<ScanSummary> {
  const repository = new SitemapRepository(env.DB)
  const pipelineRepository = new PagePipelineRepository(env.DB)
  const competitor = await repository.getCompetitor(competitorId)

  if (!competitor || !competitor.isEnabled) {
    throw new Error(`Enabled competitor ${competitorId} was not found`)
  }

  let sources = await repository.listEnabledSitemaps(competitorId)
  if (sources.length === 0) {
    const discovered = await discoverRootSitemaps(competitor.domain)
    await persistDiscoveredRoots(env.DB, competitorId, discovered)
    sources = await repository.listEnabledSitemaps(competitorId)
  }

  if (sources.length === 0) {
    throw new Error(`No Sitemap could be configured or discovered for ${competitor.domain}`)
  }

  const scanRunId = await repository.createScanRun(competitorId, triggerType)

  try {
    const collection = await collectSitemapEntries({
      competitorDomain: competitor.domain,
      seeds: sources.map((source) => ({ id: source.id, url: source.url })),
    })

    await repository.upsertDiscoveredSitemaps(competitorId, collection.discoveredChildren)
    await repository.recordProcessedSitemaps(scanRunId, collection.processed)

    const errors = collection.processed
      .filter((item) => item.status === 'failed')
      .map((item) => `${item.url}: ${item.errorMessage ?? item.errorCode ?? 'failed'}`)

    if (!competitor.baselineEstablished) {
      if (!collection.isComplete) {
        const summary = buildSummary(scanRunId, competitorId, 'failed', false, collection.entries.length, 0, 0, 0, errors)
        await repository.finishScan({
          scanRunId,
          competitorId,
          status: summary.status,
          isComplete: false,
          sitemapCount: collection.processed.length,
          totalUrlCount: collection.entries.length,
          newCount: 0,
          missingCount: 0,
          reappearedCount: 0,
          errorSummary: errors.join('\n').slice(0, 4_000) || 'Initial baseline scan was incomplete',
        })
        return summary
      }

      await repository.establishBaseline(competitorId, scanRunId, collection.entries)
      const summary = buildSummary(scanRunId, competitorId, 'success', true, collection.entries.length, 0, 0, 0, [])
      await repository.finishScan({
        scanRunId,
        competitorId,
        status: 'success',
        isComplete: true,
        sitemapCount: collection.processed.length,
        totalUrlCount: collection.entries.length,
        newCount: 0,
        missingCount: 0,
        reappearedCount: 0,
        errorSummary: null,
      })
      return summary
    }

    const existingPages = await repository.listPages(competitorId)
    const diff = calculateScanDiff(collection.entries, existingPages, collection.isComplete)
    const newPageIds = await repository.applyDiff(competitorId, scanRunId, diff)
    const pipelineCounts = await processNewPages(env, pipelineRepository, scanRunId, newPageIds)
    await pipelineRepository.updateScanPipelineCounts(scanRunId, pipelineCounts)

    const status = collection.isComplete ? 'success' : 'partial_success'
    const summary = buildSummary(
      scanRunId,
      competitorId,
      status,
      collection.isComplete,
      collection.entries.length,
      diff.newEntries.length,
      diff.confirmedMissing.length,
      diff.reappeared.length,
      errors,
    )

    await repository.finishScan({
      scanRunId,
      competitorId,
      status,
      isComplete: collection.isComplete,
      sitemapCount: collection.processed.length,
      totalUrlCount: collection.entries.length,
      newCount: diff.newEntries.length,
      missingCount: diff.confirmedMissing.length,
      reappearedCount: diff.reappeared.length,
      errorSummary: errors.join('\n').slice(0, 4_000) || null,
    })

    return summary
  } catch (error) {
    await repository.failScan(scanRunId, competitorId, error)
    throw error
  }
}

export async function runAllEnabledCompetitors(env: Env): Promise<ScanSummary[]> {
  const repository = new SitemapRepository(env.DB)
  const competitors = await repository.listCompetitors(true)
  const results: ScanSummary[] = []

  for (const competitor of competitors) {
    try {
      results.push(await runCompetitorScan(env, competitor.id, 'cron'))
    } catch (error) {
      console.error('Scheduled competitor scan failed', {
        competitorId: competitor.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  return results
}

async function processNewPages(
  env: Env,
  repository: PagePipelineRepository,
  scanRunId: string,
  pageIds: string[],
): Promise<{ fetchSuccess: number; fetchFailed: number; analysisSuccess: number; analysisFailed: number }> {
  const counts = { fetchSuccess: 0, fetchFailed: 0, analysisSuccess: 0, analysisFailed: 0 }
  const targets = await repository.getTargets(pageIds)
  const provider = env.OPENROUTER_API_KEY
    ? new OpenRouterSeoProvider({
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL,
        siteUrl: env.OPENROUTER_SITE_URL,
        appName: env.OPENROUTER_APP_NAME,
      })
    : null

  for (const target of targets) {
    const attemptId = await repository.createFetchAttempt(target.pageId, scanRunId, 1)
    const started = Date.now()
    const fetchResult = await fetchPageSeo({
      url: target.url,
      competitorDomain: target.competitorDomain,
    })
    await repository.saveFetchResult(target.pageId, attemptId, fetchResult, Date.now() - started)

    if (fetchResult.status !== 'success') {
      counts.fetchFailed += 1
      continue
    }
    counts.fetchSuccess += 1

    const seoInput = await repository.getSeoInput(target.pageId)
    if (!seoInput) {
      counts.analysisFailed += 1
      continue
    }

    if (!provider) {
      await repository.saveAnalysisFailure({
        pageId: target.pageId,
        scanRunId,
        provider: 'openrouter',
        model: env.OPENROUTER_MODEL,
        promptVersion: env.AI_PROMPT_VERSION,
        error: new Error('OPENROUTER_API_KEY is not configured'),
        skipped: true,
      })
      counts.analysisFailed += 1
      continue
    }

    try {
      const analysis = await provider.analyze(seoInput)
      await repository.saveAnalysisSuccess({
        pageId: target.pageId,
        scanRunId,
        provider: provider.providerName,
        model: provider.model,
        promptVersion: env.AI_PROMPT_VERSION,
        result: analysis.result,
        rawResponseExcerpt: analysis.rawResponseExcerpt,
      })
      counts.analysisSuccess += 1
    } catch (error) {
      await repository.saveAnalysisFailure({
        pageId: target.pageId,
        scanRunId,
        provider: provider.providerName,
        model: provider.model,
        promptVersion: env.AI_PROMPT_VERSION,
        error,
      })
      counts.analysisFailed += 1
    }
  }

  return counts
}

function buildSummary(
  scanRunId: string,
  competitorId: string,
  status: ScanSummary['status'],
  isComplete: boolean,
  totalUrlCount: number,
  newCount: number,
  missingCount: number,
  reappearedCount: number,
  errors: string[],
): ScanSummary {
  return {
    scanRunId,
    competitorId,
    status,
    isComplete,
    totalUrlCount,
    newCount,
    missingCount,
    reappearedCount,
    errors,
  }
}
