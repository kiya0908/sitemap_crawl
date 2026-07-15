import { Outlet, createFileRoute, useLocation } from '@tanstack/react-router'
import { useState } from 'react'
import { getDashboardData } from '../server/dashboard.functions'
import { exportMonitoredPages, listMonitoredPages } from '../server/pages.functions'

interface PageSearch {
  competitorId?: string
  pageType?: string
  searchIntent?: string
  reviewStatus?: string
  query?: string
  page: number
}

export const Route = createFileRoute('/pages')({
  validateSearch: (search: Record<string, unknown>): PageSearch => ({
    ...optionalSearchValue('competitorId', search.competitorId),
    ...optionalSearchValue('pageType', search.pageType),
    ...optionalSearchValue('searchIntent', search.searchIntent),
    ...optionalSearchValue('reviewStatus', search.reviewStatus),
    ...optionalSearchValue('query', search.query),
    page: positiveInteger(search.page, 1),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const filters = toServerFilters(deps)
    const [pages, dashboard] = await Promise.all([
      listMonitoredPages({ data: filters }),
      getDashboardData(),
    ])
    return { pages, competitors: dashboard.competitors }
  },
  component: MonitoredPagesLayout,
})

function MonitoredPagesLayout() {
  const location = useLocation()
  if (location.pathname !== '/pages' && location.pathname !== '/pages/') {
    return <Outlet />
  }

  return <MonitoredPagesPage />
}

function MonitoredPagesPage() {
  const { pages, competitors } = Route.useLoaderData()
  const search = Route.useSearch()
  const [exporting, setExporting] = useState(false)

  async function handleExport() {
    setExporting(true)
    try {
      const result = await exportMonitoredPages({ data: toServerFilters(search) })
      const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.filename
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(pages.total / pages.pageSize))

  return (
    <main className="app-shell">
      <nav className="breadcrumb-nav" aria-label="主要导航">
        <a href="/">Dashboard</a>
        <span>/</span>
        <strong>新增页面</strong>
      </nav>

      <header className="page-header compact-header">
        <div>
          <p className="eyebrow">COMPETITOR CHANGES</p>
          <h1>新增页面</h1>
          <p className="subtitle">关键词均为基于页面元素推测的目标词，不代表真实排名关键词。</p>
        </div>
        <button className="button secondary" type="button" onClick={handleExport} disabled={exporting}>
          {exporting ? '导出中…' : '导出当前结果'}
        </button>
      </header>

      <section className="panel filters-panel">
        <form className="filter-grid" method="get" action="/pages">
          <label>
            竞品
            <select name="competitorId" defaultValue={search.competitorId ?? ''}>
              <option value="">全部竞品</option>
              {competitors.map((competitor) => (
                <option key={competitor.id} value={competitor.id}>{competitor.name}</option>
              ))}
            </select>
          </label>
          <label>
            页面类型
            <select name="pageType" defaultValue={search.pageType ?? ''}>
              <option value="">全部类型</option>
              {PAGE_TYPES.map((value) => <option key={value} value={value}>{formatEnum(value)}</option>)}
            </select>
          </label>
          <label>
            搜索意图
            <select name="searchIntent" defaultValue={search.searchIntent ?? ''}>
              <option value="">全部意图</option>
              {SEARCH_INTENTS.map((value) => <option key={value} value={value}>{formatEnum(value)}</option>)}
            </select>
          </label>
          <label>
            人工状态
            <select name="reviewStatus" defaultValue={search.reviewStatus ?? ''}>
              <option value="">全部状态</option>
              {REVIEW_STATUSES.map((value) => <option key={value} value={value}>{formatEnum(value)}</option>)}
            </select>
          </label>
          <label className="filter-search">
            搜索
            <input name="query" defaultValue={search.query ?? ''} placeholder="URL、标题或关键词" />
          </label>
          <div className="filter-actions">
            <button className="button primary" type="submit">筛选</button>
            <a className="button secondary button-link" href="/pages">清空</a>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>页面记录</h2>
            <p>共 {pages.total} 个竞品新增页面，当前第 {pages.page} / {totalPages} 页。</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>发现时间</th>
                <th>竞品</th>
                <th>页面</th>
                <th>页面类型</th>
                <th>推测主关键词</th>
                <th>搜索意图</th>
                <th>状态</th>
                <th>人工判断</th>
              </tr>
            </thead>
            <tbody>
              {pages.items.length === 0 ? (
                <tr><td colSpan={8} className="empty">当前筛选条件下没有页面。</td></tr>
              ) : pages.items.map((item) => (
                <tr key={item.id}>
                  <td>{formatDate(item.firstSeenAt)}</td>
                  <td>{item.competitorName}</td>
                  <td className="page-cell">
                    <a className="table-link" href={`/pages/${encodeURIComponent(item.id)}`}>
                      {item.title || pathnameLabel(item.url)}
                    </a>
                    <span title={item.url}>{item.url}</span>
                  </td>
                  <td>{item.pageType ? formatEnum(item.pageType) : '—'}</td>
                  <td>{item.primaryKeyword ?? '—'}</td>
                  <td>{item.searchIntent ? formatEnum(item.searchIntent) : '—'}</td>
                  <td>
                    <Status value={item.fetchStatus ?? 'pending'} />
                    <Status value={item.analysisStatus ?? 'pending'} />
                  </td>
                  <td>
                    <Status value={item.reviewStatus} />
                    {item.isWorthFollowing ? <span className="worth-badge">值得跟进</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pagination">
          {pages.page > 1 ? <a className="button secondary button-link" href={pageHref(search, pages.page - 1)}>上一页</a> : <span />}
          {pages.page < totalPages ? <a className="button secondary button-link" href={pageHref(search, pages.page + 1)}>下一页</a> : <span />}
        </div>
      </section>
    </main>
  )
}

function Status({ value }: { value: string }) {
  return <span className={`status status-${value}`}>{formatEnum(value)}</span>
}

function toServerFilters(search: PageSearch) {
  return {
    ...optionalObjectValue('competitorId', search.competitorId),
    ...optionalObjectValue('pageType', search.pageType),
    ...optionalObjectValue('searchIntent', search.searchIntent),
    ...optionalObjectValue('reviewStatus', search.reviewStatus),
    ...optionalObjectValue('query', search.query),
    page: search.page,
    pageSize: 20,
  }
}

function pageHref(search: PageSearch, page: number): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({ ...search, page })) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  return `/pages?${params.toString()}`
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function optionalSearchValue<Key extends keyof PageSearch>(key: Key, value: unknown): Partial<PageSearch> {
  return typeof value === 'string' && value.trim() ? { [key]: value.trim() } as Partial<PageSearch> : {}
}

function optionalObjectValue<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value ? { [key]: value } as Record<Key, string> : {}
}

function formatEnum(value: string): string {
  return value.replaceAll('_', ' ')
}

function pathnameLabel(value: string): string {
  try {
    return new URL(value).pathname || value
  } catch {
    return value
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

const PAGE_TYPES = ['product', 'product_category', 'solution', 'industry', 'blog', 'guide', 'case_study', 'landing_page', 'other']
const SEARCH_INTENTS = ['informational', 'commercial', 'transactional', 'navigational', 'mixed']
const REVIEW_STATUSES = ['unreviewed', 'reviewed', 'worth_following', 'not_relevant']
