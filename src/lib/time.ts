const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1_000

export function tokyoDayStartUtc(now = new Date()): string {
  const tokyoTime = new Date(now.getTime() + TOKYO_OFFSET_MS)
  tokyoTime.setUTCHours(0, 0, 0, 0)
  return new Date(tokyoTime.getTime() - TOKYO_OFFSET_MS).toISOString()
}
