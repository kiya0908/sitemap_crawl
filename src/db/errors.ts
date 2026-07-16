export class CompetitorDomainConflictError extends Error {
  readonly code = 'COMPETITOR_DOMAIN_CONFLICT'

  constructor(readonly domain: string) {
    super(`域名 ${domain} 已经存在，请直接使用竞品列表中的现有记录。`)
    this.name = 'CompetitorDomainConflictError'
  }
}

export class ScanAlreadyRunningError extends Error {
  readonly code = 'SCAN_ALREADY_RUNNING'

  constructor(readonly competitorId: string, readonly scanRunId: string) {
    super('该竞品已有扫描任务正在运行，请等待完成后再试。')
    this.name = 'ScanAlreadyRunningError'
  }
}
