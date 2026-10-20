// Stable application identity created for the template monitor (not a credential).
export const PRE_REPORT_COMPETITOR_ID = 'cmp_makeviral_templates'
export const MORNING_CRON = '0 1 * * *'
export const PRE_REPORT_CRON = '20 10 * * *'

export function competitorScanCron(competitorId: string): string {
  return competitorId === PRE_REPORT_COMPETITOR_ID ? PRE_REPORT_CRON : MORNING_CRON
}
