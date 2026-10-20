import { pageFiltersSchema } from '../lib/page-filters'
import { Outlet, createFileRoute, useLocation } from '@tanstack/react-router'
import { useState } from 'react'
import { BUSINESS_TIME_ZONE } from '../lib/time'
import { getDashboardData } from '../server/dashboard.functions'
import { exportMonitoredPages, listMonitoredPages } from '../server/pages.functions'

interface PageSearch {
  competitorId?: string | undefined
  pathPrefix?: string | undefined
  discoveredFrom?: string | undefined
  discoveredBefore?: string | undefined
  scanNotBefore?: string | undefined
  scanBefore?: string | undefined
  pageSize: number
  pageType?: string | undefined
  searchIntent?: string | undefined
  reviewStatus?: string | undefined
  query?: string | undefined
  page: number
}

export const Route = createFileRoute('/pages')({
  validateSearch: (search: Record<string, unknown>): PageSearch => pageFiltersSchema.parse(
    Object.fromEntries(Object.entries(search).filter(([, value]) => value !== '')),
  ),
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
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
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

      {pages.monitor ? (
        <section className="panel" aria-label="监测状态">
          <h2>{pages.monitor.name} 扫描状态</h2>
          <p>日报就绪状态：{pages.reportReadiness}；扫描窗口 UTC：[ {search.scanNotBefore ?? '未指定'}，{search.scanBefore ?? '未指定'} )</p>
          {pages.reportReadiness !== 'ready' && pages.reportReadiness !== 'not_requested' ? <p role="alert">本次推送前扫描未就绪，不能借用旧结果或报告无新增。</p> : null}
          <p>触发方式：{pages.monitor.trigger_type ?? '—'}</p>
          <p>目标：{pages.monitor.domain}；路径：{pages.monitor.path_prefix ?? '全部'}；基线：{pages.monitor.baseline_established ? '已建立' : '尚未建立'}；启用：{pages.monitor.is_enabled ? '是' : '否'}</p>
          <p>最近扫描：{pages.monitor.status ?? '未运行'}；完整：{pages.monitor.is_complete === 1 ? '是' : '否'}；扫描 ID：{pages.monitor.scan_id ?? '无'}</p>
          <p>开始 UTC：{pages.monitor.started_at ?? '无'}；完成 UTC：{pages.monitor.finished_at ?? '无'}；最近完整扫描 UTC：{pages.monitor.latest_complete_at ?? '无'}</p>
          <p>最近扫描抓取失败：{pages.monitor.fetch_failed_count ?? 0}；分析失败：{pages.monitor.analysis_failed_count ?? 0}</p>
          {pages.monitor.status !== 'success' || pages.monitor.is_complete !== 1 || !pages.monitor.baseline_established ? <p role="status">扫描尚未完整成功，不能将空列表解释为零新增。</p> : null}
          <p>发现时间窗口 UTC：[ {search.discoveredFrom ?? '不限'}，{search.discoveredBefore ?? '不限'} )；按发现事件筛选，不按生命周期状态。</p>
        </section>
      ) : null}
      <section className="panel filters-panel">
        <form className="filter-grid" method="get" action="/pages">
          <input type="hidden" name="pageSize" value={search.pageSize} />
          <input type="hidden" name="scanNotBefore" value={search.scanNotBefore ?? ''} />
          <input type="hidden" name="scanBefore" value={search.scanBefore ?? ''} />
          <label>严格路径前缀<input name="pathPrefix" defaultValue={search.pathPrefix ?? ''} placeholder="/templates/" /></label>
          <label>发现时间起点（UTC，含）<input name="discoveredFrom" defaultValue={search.discoveredFrom ?? ''} placeholder="YYYY-MM-DDTHH:mm:ss.sssZ" /></label>
          <label>发现时间终点（UTC，不含）<input name="discoveredBefore" defaultValue={search.discoveredBefore ?? ''} placeholder="YYYY-MM-DDTHH:mm:ss.sssZ" /></label>
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
                  <td><time dateTime={item.discoveredAt}>{formatDate(item.discoveredAt)}</time><small>{item.discoveredAt}</small></td>
                  <td>{item.competitorName}</td>
                  <td className="page-cell">
                    <a className="table-link" href={`/pages/${encodeURIComponent(item.id)}`}>
                      {item.title || pathnameLabel(item.url)}
                    </a>
                    <span title={item.discoveredUrl}>{item.discoveredUrl}</span>
                  </td>
                  <td>{item.pageType ? formatEnum(item.pageType) : '—'}</td>
                  <td>{item.primaryKeyword ?? '—'}<small>{item.keywordSource === 'slug' ? 'URL slug 推断 · 低置信度' : item.keywordSource === 'manual' ? '人工关键词' : item.keywordSource === 'ai' ? 'AI 推测，非排名词' : '关键词不可用'}</small></td>
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
    ...optionalObjectValue('pathPrefix', search.pathPrefix),
    ...optionalObjectValue('discoveredFrom', search.discoveredFrom),
    ...optionalObjectValue('discoveredBefore', search.discoveredBefore),
    ...optionalObjectValue('scanNotBefore', search.scanNotBefore),
    ...optionalObjectValue('scanBefore', search.scanBefore),
    ...optionalObjectValue('pageType', search.pageType),
    ...optionalObjectValue('searchIntent', search.searchIntent),
    ...optionalObjectValue('reviewStatus', search.reviewStatus),
    ...optionalObjectValue('query', search.query),
    page: search.page,
    pageSize: search.pageSize,
  }
}

function pageHref(search: PageSearch, page: number): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({ ...search, page })) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  return `/pages?${params.toString()}`
}

function optionalObjectValue<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value ? { [key]: value } as Record<Key, string> : {}
}

function formatEnum(value: string): string {
  if (value === 'blocked_fetch') return '抓取失败，分析未运行'
  if (value === 'failed') return '失败（仍保留网址）'
  if (value === 'skipped') return '分析未配置/已跳过'
  return value === 'expired' ? '已过期（保留策略）' : value.replaceAll('_', ' ')
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
    timeZone: BUSINESS_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

const PAGE_TYPES = ['product', 'product_category', 'solution', 'industry', 'blog', 'guide', 'case_study', 'landing_page', 'other']
const SEARCH_INTENTS = ['informational', 'commercial', 'transactional', 'navigational', 'mixed']
const REVIEW_STATUSES = ['unreviewed', 'reviewed', 'worth_following', 'not_relevant']
