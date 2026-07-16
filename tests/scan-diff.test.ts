import { describe, expect, it } from 'vitest'
import { calculateScanDiff } from '../src/server/scans/diff'
import type { ExistingPageRecord, SitemapUrlEntry } from '../src/server/types'

function page(overrides: Partial<ExistingPageRecord> = {}): ExistingPageRecord {
  return {
    id: 'page-1',
    normalizedUrl: 'https://example.com/a',
    currentUrl: 'https://example.com/a',
    lifecycleStatus: 'active',
    missingStreak: 0,
    firstSeenAt: '2026-07-01T00:00:00.000Z',
    lastSeenAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  }
}

function entry(url: string): SitemapUrlEntry {
  return { url, normalizedUrl: url, lastmod: null, sourceUrl: 'https://example.com/sitemap.xml' }
}

describe('calculateScanDiff', () => {
  it('finds URLs that never appeared before', () => {
    const result = calculateScanDiff(
      [entry('https://example.com/a'), entry('https://example.com/new')],
      [page()],
      true,
    )
    expect(result.newEntries.map((item) => item.url)).toEqual(['https://example.com/new'])
  })

  it('does not change missing counters for incomplete scans', () => {
    const result = calculateScanDiff([], [page()], false)
    expect(result.firstMissing).toHaveLength(0)
    expect(result.confirmedMissing).toHaveLength(0)
  })

  it('does not confirm never-seen URLs as new during an incomplete scan', () => {
    const result = calculateScanDiff(
      [entry('https://example.com/a'), entry('https://example.com/unconfirmed')],
      [page()],
      false,
    )

    expect(result.newEntries).toHaveLength(0)
    expect(result.presentEntries).toHaveLength(1)
  })

  it('uses two complete missing scans before confirmation', () => {
    const first = calculateScanDiff([], [page({ missingStreak: 0 })], true)
    expect(first.firstMissing).toHaveLength(1)
    expect(first.confirmedMissing).toHaveLength(0)

    const second = calculateScanDiff([], [page({ missingStreak: 1 })], true)
    expect(second.firstMissing).toHaveLength(0)
    expect(second.confirmedMissing).toHaveLength(1)
  })

  it('classifies a missing page that returns as reappeared, not new', () => {
    const result = calculateScanDiff(
      [entry('https://example.com/a')],
      [page({ lifecycleStatus: 'missing', missingStreak: 2 })],
      true,
    )
    expect(result.reappeared).toHaveLength(1)
    expect(result.newEntries).toHaveLength(0)
  })
})
