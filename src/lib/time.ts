export const BUSINESS_TIME_ZONE = 'Asia/Shanghai'

const CHINA_STANDARD_OFFSET_MS = 8 * 60 * 60 * 1_000

export function shanghaiDayStartUtc(now = new Date()): string {
  const shanghaiTime = new Date(now.getTime() + CHINA_STANDARD_OFFSET_MS)
  shanghaiTime.setUTCHours(0, 0, 0, 0)
  return new Date(shanghaiTime.getTime() - CHINA_STANDARD_OFFSET_MS).toISOString()
}
