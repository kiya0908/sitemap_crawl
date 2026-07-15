import type { ExistingPageRecord, ScanDiff, SitemapUrlEntry } from '../types'

export function calculateScanDiff(
  currentEntries: SitemapUrlEntry[],
  existingPages: ExistingPageRecord[],
  isComplete: boolean,
): ScanDiff {
  const currentByUrl = new Map(currentEntries.map((entry) => [entry.normalizedUrl, entry]))
  const existingByUrl = new Map(existingPages.map((page) => [page.normalizedUrl, page]))

  const result: ScanDiff = {
    newEntries: [],
    presentEntries: [],
    firstMissing: [],
    confirmedMissing: [],
    reappeared: [],
  }

  for (const entry of currentEntries) {
    const existing = existingByUrl.get(entry.normalizedUrl)
    if (!existing) {
      result.newEntries.push(entry)
      continue
    }

    if (existing.lifecycleStatus === 'missing') {
      result.reappeared.push({ page: existing, entry })
    } else {
      result.presentEntries.push({ page: existing, entry })
    }
  }

  if (!isComplete) {
    return result
  }

  for (const page of existingPages) {
    if (currentByUrl.has(page.normalizedUrl) || page.lifecycleStatus === 'missing') {
      continue
    }

    if (page.missingStreak + 1 >= 2) {
      result.confirmedMissing.push(page)
    } else {
      result.firstMissing.push(page)
    }
  }

  return result
}
