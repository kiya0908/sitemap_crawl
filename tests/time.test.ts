import { describe, expect, it } from 'vitest'
import { BUSINESS_TIME_ZONE, shanghaiDayStartUtc } from '../src/lib/time'

describe('shanghaiDayStartUtc', () => {
  it('uses China Standard Time midnight rather than UTC midnight', () => {
    expect(BUSINESS_TIME_ZONE).toBe('Asia/Shanghai')
    expect(shanghaiDayStartUtc(new Date('2026-07-16T15:59:59.000Z')))
      .toBe('2026-07-15T16:00:00.000Z')
    expect(shanghaiDayStartUtc(new Date('2026-07-16T16:00:00.000Z')))
      .toBe('2026-07-16T16:00:00.000Z')
  })
})
