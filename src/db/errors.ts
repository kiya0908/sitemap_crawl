export class CompetitorDomainConflictError extends Error {
  readonly code = 'COMPETITOR_DOMAIN_CONFLICT'

  constructor(readonly domain: string) {
    super(`域名 ${domain} 已经存在，请直接使用竞品列表中的现有记录。`)
    this.name = 'CompetitorDomainConflictError'
  }
}
