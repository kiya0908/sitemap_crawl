import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import {
  createCompetitor,
  getDashboardData,
  triggerCompetitorScan,
} from '../server/dashboard.functions'

export const Route = createFileRoute('/')({
  loader: () => getDashboardData(),
  component: DashboardPage,
})

function DashboardPage() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const form = new FormData(event.currentTarget)
    const sitemapUrls = String(form.get('sitemapUrls') ?? '')
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)

    try {
      await createCompetitor({
        data: {
          name: String(form.get('name') ?? ''),
          domain: String(form.get('domain') ?? ''),
          sitemapUrls,
        },
      })
      event.currentTarget.reset()
      await router.invalidate()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建竞品失败')
    }
  }

  async function handleScan(competitorId: string) {
    setBusyId(competitorId)
    setError(null)
    try {
      await triggerCompetitorScan({ data: { competitorId } })
      await router.invalidate()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '扫描失败')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <main className="app-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">PRIVATE SEO MONITOR</p>
          <h1>Sitemap Crawl</h1>
          <p className="subtitle">监控竞品新增页面，并推测其页面主题、关键词和搜索意图。</p>
        </div>
        <span className="access-badge">Cloudflare Access</span>
      </header>

      {error ? <div className="alert" role="alert">{error}</div> : null}

      <section className="metric-grid" aria-label="监控概览">
        <Metric label="竞品" value={data.competitors.length} />
        <Metric label="今日新增" value={data.todayNew} />
        <Metric label="近 7 天新增" value={data.lastSevenDaysNew} />
        <Metric label="待查看" value={data.unreviewed} />
        <Metric label="值得跟进" value={data.worthFollowing} />
      </section>

      <div className="content-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>竞品管理</h2>
              <p>首次完整扫描只建立基线，不会把存量页面计为新增。</p>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>竞品</th>
                  <th>域名</th>
                  <th>基线</th>
                  <th>最近状态</th>
                  <th>最近扫描</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {data.competitors.length === 0 ? (
                  <tr><td colSpan={6} className="empty">还没有竞品，请先添加。</td></tr>
                ) : data.competitors.map((competitor) => (
                  <tr key={competitor.id}>
                    <td><strong>{competitor.name}</strong></td>
                    <td>{competitor.domain}</td>
                    <td>{competitor.baselineEstablished ? '已建立' : '未建立'}</td>
                    <td><Status value={competitor.lastScanStatus ?? 'not_started'} /></td>
                    <td>{formatDate(competitor.lastScannedAt)}</td>
                    <td className="align-right">
                      <button
                        className="button secondary"
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => handleScan(competitor.id)}
                      >
                        {busyId === competitor.id ? '扫描中…' : '立即扫描'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel compact-panel">
          <h2>添加竞品</h2>
          <form className="form-stack" onSubmit={handleCreate}>
            <label>
              竞品名称
              <input name="name" required maxLength={100} placeholder="例如：Competitor A" />
            </label>
            <label>
              域名
              <input name="domain" required placeholder="example.com" />
            </label>
            <label>
              Sitemap URL
              <textarea
                name="sitemapUrls"
                rows={5}
                placeholder={'https://example.com/sitemap.xml\n每行一个；留空时自动识别'}
              />
            </label>
            <button className="button primary" type="submit">添加竞品</button>
          </form>
        </section>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>最近扫描</h2>
            <p>只有完整扫描才会累计页面缺失次数。</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>竞品</th>
                <th>状态</th>
                <th>URL 总数</th>
                <th>新增</th>
                <th>确认消失</th>
                <th>重新出现</th>
                <th>开始时间</th>
              </tr>
            </thead>
            <tbody>
              {data.recentScans.length === 0 ? (
                <tr><td colSpan={7} className="empty">暂无扫描记录。</td></tr>
              ) : data.recentScans.map((scan) => (
                <tr key={String(scan.id)}>
                  <td>{String(scan.competitor_name ?? '')}</td>
                  <td><Status value={String(scan.status ?? '')} /></td>
                  <td>{Number(scan.total_url_count ?? 0)}</td>
                  <td>{Number(scan.new_count ?? 0)}</td>
                  <td>{Number(scan.missing_count ?? 0)}</td>
                  <td>{Number(scan.reappeared_count ?? 0)}</td>
                  <td>{formatDate(typeof scan.started_at === 'string' ? scan.started_at : null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return <article className="metric"><span>{label}</span><strong>{value}</strong></article>
}

function Status({ value }: { value: string }) {
  return <span className={`status status-${value}`}>{value.replaceAll('_', ' ')}</span>
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
