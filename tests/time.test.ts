import { describe, expect, it } from 'vitest'
import { tokyoDayStartUtc } from '../src/lib/time'

describe('tokyoDayStartUtc', () => {
  it('uses Tokyo midnight rather than UTC midnight', () => {
    expect(tokyoDayStartUtc(new Date('2026-07-16T14:59:59.000Z')))
      .toBe('2026-07-15T15:00:00.000Z')
    expect(tokyoDayStartUtc(new Date('2026-07-16T15:00:00.000Z')))
      .toBe('2026-07-16T15:00:00.000Z')
  })
})
