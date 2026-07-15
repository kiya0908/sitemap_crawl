export type ScanTrigger = 'cron' | 'manual' | 'retry'
export type ScanStatus = 'queued' | 'running' | 'success' | 'partial_success' | 'failed'
export type LifecycleStatus = 'baseline' | 'active' | 'new' | 'missing' | 'reappeared'

export interface CompetitorRecord {
  id: string
  name: string
  domain: string
  isEnabled: boolean
  baselineEstablished: boolean
  lastScanStatus: ScanStatus | null
  lastScannedAt: string | null
}

export interface SitemapSourceRecord {
  id: string
  competitorId: string
  url: string
  normalizedUrl: string
  sourceType: 'manual' | 'robots' | 'common_path' | 'sitemap_index_child'
  isEnabled: boolean
  parentSourceId: string | null
}

export interface SitemapUrlEntry {
  url: string
  normalizedUrl: string
  lastmod: string | null
  sourceUrl: string
}

export interface ExistingPageRecord {
  id: string
  normalizedUrl: string
  currentUrl: string
  lifecycleStatus: LifecycleStatus
  missingStreak: number
  firstSeenAt: string
  lastSeenAt: string
}

export interface ScanDiff {
  newEntries: SitemapUrlEntry[]
  presentEntries: Array<{ page: ExistingPageRecord; entry: SitemapUrlEntry }>
  firstMissing: ExistingPageRecord[]
  confirmedMissing: ExistingPageRecord[]
  reappeared: Array<{ page: ExistingPageRecord; entry: SitemapUrlEntry }>
}

export interface ScanSummary {
  scanRunId: string
  competitorId: string
  status: ScanStatus
  isComplete: boolean
  totalUrlCount: number
  newCount: number
  missingCount: number
  reappearedCount: number
  errors: string[]
}
