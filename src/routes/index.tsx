import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useRef, useState, type FormEvent } from 'react'
import {
  createCompetitor,
  deleteCompetitor,
  getCompetitorConfiguration,
  getDashboardData,
  triggerCompetitorScan,
  updateCompetitor,
} from '../server/dashboard.functions'

interface EditingCompetitor {
  id: string
  name: string
  domain: string
  isEnabled: boolean
  baselineEstablished: boolean
  manualSitemapUrls: string[]
}

export const Route = createFileRoute('/')({
  loader: () => getDashboardData(),
  component: DashboardPage,
})

function DashboardPage() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [editing, setEditing] = useState<EditingCompetitor | null>(null)
  const [isSavingEdit, setIsSavingEdit] = useState(false)
  const createInFlight = useRef(false)

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (createInFlight.current) return

    const form = new FormData(event.currentTarget)
    const sitemapUrls = parseSitemapUrls(form.get('sitemapUrls'))

    createInFlight.current = true
    setIsCreating(true)
    setError(null)

    try {
      const result = await createCompetitor({
        data: {
          name: String(form.get('name') ?? ''),
          domain: String(form.get('domain') ?? ''),
          sitemapUrls,
        },
      })
      if (!result.ok) {
        setError(result.message)
        return
      }

      event.currentTarget.reset()
      await router.invalidate()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建竞品失败')
    } finally {
      createInFlight.current = false
      setIsCreating(false)
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

  async function handleStartEdit(competitorId: string) {
    setBusyId(competitorId)
    setError(null)
    try {
      const configuration = await getCompetitorConfiguration({ data: { competitorId } })
      if (!configuration) {
        setError('竞品不存在或已经删除。')
        return
      }
      setEditing(configuration)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加载竞品配置失败')
    } finally {
      setBusyId(null)
    }
  }

  async function handleUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editing || isSavingEdit) return

    const form = new FormData(event.currentTarget)
    setIsSavingEdit(true)
    setError(null)

    try {
      const result = await updateCompetitor({
        data: {
          competitorId: editing.id,
          name: String(form.get('name') ?? ''),
          domain: String(form.get('domain') ?? editing.domain),
          isEnabled: form.get('isEnabled') === 'on',
          sitemapUrls: parseSitemapUrls(form.get('sitemapUrls')),
        },
      })

      if (!result.ok) {
        setError(result.message)
        return
      }

      setEditing(null)
      await router.invalidate()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '修改竞品失败')
    } finally {
      setIsSavingEdit(false)
    }
  }

  async function handleDelete(competitorId: string, competitorName: string) {
    const confirmed = window.confirm(
      `确定删除“${competitorName}”吗？\n\n该竞品将停止监控并从列表中隐藏，历史扫描和页面数据会保留。`,
    )
    if (!confirmed) return

    setBusyId(competitorId)
    setError(null)
    try {
      const result = await deleteCompetitor({ data: { competitorId } })
      if (!result.ok) {
        setError(result.message)
        return
      }
      if (editing?.id === competitorId) setEditing(null)
      await router.invalidate()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '删除竞品失败')
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
                  <th>状态</th>
                  <th>基线</th>
                  <th>最近状态</th>
                  <th>最近扫描</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {data.competitors.length === 0 ? (
                  <tr><td colSpan={7} className="empty">还没有竞品，请先添加。</td></tr>
                ) : data.competitors.map((competitor) => (
                  <tr key={competitor.id}>
                    <td><strong>{competitor.name}</strong></td>
                    <td>{competitor.domain}</td>
                    <td><Status value={competitor.isEnabled ? 'enabled' : 'paused'} /></td>
                    <td>{competitor.baselineEstablished ? '已建立' : '未建立'}</td>
                    <td><Status value={competitor.lastScanStatus ?? 'not_started'} /></td>
                    <td>{formatDate(competitor.lastScannedAt)}</td>
                    <td className="align-right">
                      <div className="row-actions">
                        <button
                          className="button secondary"
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => handleScan(competitor.id)}
                        >
                          {busyId === competitor.id ? '处理中…' : '立即扫描'}
                        </button>
                        <button
                          className="button secondary"
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => handleStartEdit(competitor.id)}
                        >
                          编辑
                        </button>
                        <button
                          className="button danger"
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => handleDelete(competitor.id, competitor.name)}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {editing ? (
          <section className="panel compact-panel" key={editing.id}>
            <div className="side-panel-heading">
              <div>
                <h2>编辑竞品</h2>
                <p>{editing.baselineEstablished ? '已建立基线，域名不可直接修改。' : '尚未建立基线，可以修改域名。'}</p>
              </div>
              <button className="text-button" type="button" onClick={() => setEditing(null)}>取消</button>
            </div>
            <form className="form-stack" onSubmit={handleUpdate}>
              <label>
                竞品名称
                <input name="name" required maxLength={100} defaultValue={editing.name} />
              </label>
              <label>
                域名
                <input
                  name="domain"
                  required
                  readOnly={editing.baselineEstablished}
                  defaultValue={editing.domain}
                  aria-describedby={editing.baselineEstablished ? 'domain-lock-help' : undefined}
                />
                {editing.baselineEstablished ? <small id="domain-lock-help">如需更换网站域名，请删除后重新添加。</small> : null}
              </label>
              <label className="checkbox-label">
                <input name="isEnabled" type="checkbox" defaultChecked={editing.isEnabled} />
                启用自动监控
              </label>
              <label>
                手动 Sitemap URL
                <textarea
                  name="sitemapUrls"
                  rows={6}
                  defaultValue={editing.manualSitemapUrls.join('\n')}
                  placeholder={'https://example.com/sitemap.xml\n每行一个；留空时扫描会尝试自动识别'}
                />
              </label>
              <button className="button primary" type="submit" disabled={isSavingEdit}>
                {isSavingEdit ? '保存中…' : '保存修改'}
              </button>
            </form>
          </section>
        ) : (
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
              <button className="button primary" type="submit" disabled={isCreating}>
                {isCreating ? '添加中…' : '添加竞品'}
              </button>
            </form>
          </section>
        )}
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

function parseSitemapUrls(value: FormDataEntryValue | null): string[] {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
