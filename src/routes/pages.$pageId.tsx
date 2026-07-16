import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { BUSINESS_TIME_ZONE } from '../lib/time'
import { getMonitoredPage, updatePageReview } from '../server/pages.functions'

export const Route = createFileRoute('/pages/$pageId')({
  loader: async ({ params }) => {
    const page = await getMonitoredPage({ data: { pageId: params.pageId } })
    if (!page) throw new Error('页面记录不存在')
    return page
  },
  component: PageDetailPage,
})

function PageDetailPage() {
  const page = Route.useLoaderData()
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function handleReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setMessage(null)
    const form = new FormData(event.currentTarget)

    try {
      await updatePageReview({
        data: {
          pageId: page.id,
          reviewStatus: reviewStatusValue(form.get('reviewStatus')),
          isViewed: form.get('isViewed') === 'on',
          isWorthFollowing: form.get('isWorthFollowing') === 'on',
          manualPageType: nullableFormValue(form.get('manualPageType')),
          manualPrimaryKeyword: nullableFormValue(form.get('manualPrimaryKeyword')),
          manualSecondaryKeywords: String(form.get('manualSecondaryKeywords') ?? '')
            .split(/\r?\n|,/)
            .map((value) => value.trim())
            .filter(Boolean),
          manualSearchIntent: nullableFormValue(form.get('manualSearchIntent')),
          notes: nullableFormValue(form.get('notes')),
        },
      })
      setMessage('人工复核结果已保存。')
      await router.invalidate()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="app-shell detail-shell">
      <nav className="breadcrumb-nav" aria-label="主要导航">
        <a href="/">Dashboard</a>
        <span>/</span>
        <a href="/pages">新增页面</a>
        <span>/</span>
        <strong>页面详情</strong>
      </nav>

      <header className="detail-header">
        <div>
          <div className="detail-labels">
            <Status value={page.lifecycleStatus} />
            <Status value={page.seo.fetchStatus ?? 'pending'} />
            <Status value={page.analysis.status ?? 'pending'} />
          </div>
          <h1>{page.seo.title || pathnameLabel(page.currentUrl)}</h1>
          <p className="subtitle">{page.competitorName} · 首次发现于 {formatDate(page.firstSeenAt)}</p>
        </div>
        <a className="button secondary button-link" href={page.currentUrl} target="_blank" rel="noreferrer">
          打开竞品页面
        </a>
      </header>

      {message ? <div className="alert neutral-alert" role="status">{message}</div> : null}

      <div className="detail-grid">
        <div className="detail-main">
          <DetailSection title="页面 SEO 信息">
            <DefinitionGrid items={[
              ['URL', page.currentUrl],
              ['Canonical', page.seo.canonicalUrl],
              ['HTTP 状态', page.seo.httpStatus?.toString() ?? null],
              ['Content-Type', page.seo.contentType],
              ['语言', page.seo.pageLanguage],
              ['Robots Meta', page.seo.robotsMeta],
              ['Sitemap lastmod', page.sitemapLastmod],
              ['最后抓取', page.seo.fetchedAt ? formatDate(page.seo.fetchedAt) : null],
            ]} />
            <ContentField label="Title" value={page.seo.title} />
            <ContentField label="Meta Description" value={page.seo.metaDescription} />
            <ContentField label="H1" value={page.seo.h1} />
            <TagField label="H2" values={page.seo.h2} />
            {page.seo.fetchError ? <div className="inline-error">抓取错误：{page.seo.fetchError}</div> : null}
          </DetailSection>

          <DetailSection title="AI SEO 分析" subtitle="以下关键词为页面目标词推测，不代表真实排名数据。">
            <DefinitionGrid items={[
              ['页面类型', page.analysis.pageType ? formatEnum(page.analysis.pageType) : null],
              ['核心主题', page.analysis.primaryTopic],
              ['推测主关键词', page.analysis.primaryKeyword],
              ['搜索意图', page.analysis.searchIntent ? formatEnum(page.analysis.searchIntent) : null],
              ['产品线 / 主题集群', page.analysis.productLine],
              ['置信度', page.analysis.confidence === null ? null : `${Math.round(page.analysis.confidence * 100)}%`],
              ['模型', page.analysis.model],
              ['提示词版本', page.analysis.promptVersion],
            ]} />
            <TagField label="推测次级关键词" values={page.analysis.secondaryKeywords} />
            <ContentField label="分析摘要" value={page.analysis.summary} />
            <TagField label="判断依据" values={page.analysis.evidence} ordered />
            {page.analysis.errorMessage ? <div className="inline-error">分析错误：{page.analysis.errorMessage}</div> : null}
          </DetailSection>

          <DetailSection title="页面正文摘要">
            <p className="content-excerpt">{page.seo.contentExcerpt || '暂无可用正文摘要。'}</p>
          </DetailSection>

          <DetailSection title="变化时间线">
            <ol className="timeline">
              {page.events.map((event) => (
                <li key={event.id}>
                  <span>{formatDate(event.detectedAt)}</span>
                  <strong>{formatEnum(event.eventType)}</strong>
                  {event.newValue ? <code>{compactJson(event.newValue)}</code> : null}
                </li>
              ))}
            </ol>
          </DetailSection>
        </div>

        <aside className="detail-aside">
          <section className="panel review-panel">
            <h2>人工复核</h2>
            <p>人工结果会优先显示，但不会覆盖 AI 原始记录。</p>
            <form className="form-stack" onSubmit={handleReview}>
              <label>
                复核状态
                <select name="reviewStatus" defaultValue={page.review.reviewStatus}>
                  {REVIEW_STATUSES.map((value) => <option key={value} value={value}>{formatEnum(value)}</option>)}
                </select>
              </label>

              <label className="checkbox-label">
                <input name="isViewed" type="checkbox" defaultChecked={page.review.isViewed} />
                已查看该页面
              </label>
              <label className="checkbox-label">
                <input name="isWorthFollowing" type="checkbox" defaultChecked={page.review.isWorthFollowing} />
                值得跟进
              </label>

              <label>
                人工页面类型
                <select name="manualPageType" defaultValue={page.review.manualPageType ?? ''}>
                  <option value="">沿用 AI 判断</option>
                  {PAGE_TYPES.map((value) => <option key={value} value={value}>{formatEnum(value)}</option>)}
                </select>
              </label>
              <label>
                人工主关键词
                <input
                  name="manualPrimaryKeyword"
                  defaultValue={page.review.manualPrimaryKeyword ?? ''}
                  placeholder={page.analysis.primaryKeyword ?? '输入修订后的主关键词'}
                />
              </label>
              <label>
                人工次级关键词
                <textarea
                  name="manualSecondaryKeywords"
                  rows={5}
                  defaultValue={page.review.manualSecondaryKeywords.join('\n')}
                  placeholder="每行一个关键词"
                />
              </label>
              <label>
                人工搜索意图
                <select name="manualSearchIntent" defaultValue={page.review.manualSearchIntent ?? ''}>
                  <option value="">沿用 AI 判断</option>
                  {SEARCH_INTENTS.map((value) => <option key={value} value={value}>{formatEnum(value)}</option>)}
                </select>
              </label>
              <label>
                个人备注
                <textarea name="notes" rows={8} defaultValue={page.review.notes ?? ''} placeholder="记录页面机会、后续动作或判断依据" />
              </label>
              <button className="button primary" type="submit" disabled={saving}>
                {saving ? '保存中…' : '保存复核'}
              </button>
            </form>
          </section>
        </aside>
      </div>
    </main>
  )
}

function DetailSection({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="panel detail-section">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
      </div>
      <div className="detail-section-body">{children}</div>
    </section>
  )
}

function DefinitionGrid({ items }: { items: Array<[string, string | null]> }) {
  return (
    <dl className="definition-grid">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value || '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

function ContentField({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="content-field">
      <strong>{label}</strong>
      <p>{value || '—'}</p>
    </div>
  )
}

function TagField({ label, values, ordered = false }: { label: string; values: string[]; ordered?: boolean }) {
  return (
    <div className="content-field">
      <strong>{label}</strong>
      {values.length === 0 ? <p>—</p> : ordered ? (
        <ol className="evidence-list">{values.map((value) => <li key={value}>{value}</li>)}</ol>
      ) : (
        <div className="tag-list">{values.map((value) => <span key={value}>{value}</span>)}</div>
      )}
    </div>
  )
}

function Status({ value }: { value: string }) {
  return <span className={`status status-${value}`}>{formatEnum(value)}</span>
}

function nullableFormValue(value: FormDataEntryValue | null): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || null
}

function reviewStatusValue(value: FormDataEntryValue | null): 'unreviewed' | 'reviewed' | 'worth_following' | 'not_relevant' {
  return REVIEW_STATUSES.includes(String(value))
    ? String(value) as 'unreviewed' | 'reviewed' | 'worth_following' | 'not_relevant'
    : 'unreviewed'
}

function compactJson(value: unknown): string {
  const text = JSON.stringify(value)
  return text.length > 300 ? `${text.slice(0, 297)}…` : text
}

function pathnameLabel(value: string): string {
  try {
    return new URL(value).pathname || value
  } catch {
    return value
  }
}

function formatEnum(value: string): string {
  return value.replaceAll('_', ' ')
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
