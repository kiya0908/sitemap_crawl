import { describe, expect, it } from 'vitest'
import { OpenRouterSeoProvider } from '../src/server/ai/openrouter'

const validAnalysis = {
  pageType: 'product' as const,
  primaryTopic: 'epoxy mixing',
  primaryKeyword: 'dynamic mixing nozzle for epoxy',
  secondaryKeywords: ['two-part epoxy mixer'],
  searchIntent: 'commercial' as const,
  productLine: 'mixing nozzles',
  summary: '面向双组分环氧胶混合应用的产品页。',
  reasoningEvidence: ['Title 和 H1 均指向 epoxy mixing nozzle。'],
  confidence: 0.95,
}

const input = {
  url: 'https://example.com/dynamic-mixing-nozzle-for-epoxy',
  title: 'Dynamic Mixing Nozzle for Epoxy',
  metaDescription: 'Mixer nozzle for two-part epoxy adhesives.',
  h1: 'Dynamic Mixing Nozzle for Epoxy',
  h2: ['Accurate two-part mixing'],
  pageLanguage: 'en',
  contentExcerpt: 'Industrial product page for epoxy dispensing systems.',
}

describe('OpenRouterSeoProvider', () => {
  it('uses structured output and omits HTTP-Referer when the site URL is empty', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validAnalysis) } }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const provider = new OpenRouterSeoProvider({
      apiKey: 'test-key',
      model: 'deepseek/deepseek-v4-flash',
      siteUrl: '',
      appName: 'Sitemap Crawl',
      fetchImpl: fetchMock,
    })

    const analysis = await provider.analyze(input)
    const headers = new Headers(capturedInit?.headers)
    const body = JSON.parse(String(capturedInit?.body)) as {
      model: string
      provider: { require_parameters: boolean }
      response_format: { type: string; json_schema: { strict: boolean } }
    }

    expect(capturedUrl).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(headers.has('HTTP-Referer')).toBe(false)
    expect(headers.get('X-OpenRouter-Title')).toBe('Sitemap Crawl')
    expect(body.model).toBe('deepseek/deepseek-v4-flash')
    expect(body.provider.require_parameters).toBe(true)
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: true },
    })
    expect(analysis.result).toEqual(validAnalysis)
  })

  it('rejects an oversized API response without buffering it indefinitely', async () => {
    const fetchMock = (async () => new Response('x'.repeat(300_000), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
    const provider = new OpenRouterSeoProvider({
      apiKey: 'test-key',
      model: 'deepseek/deepseek-v4-flash',
      appName: 'Sitemap Crawl',
      fetchImpl: fetchMock,
      maxRetries: 0,
    })

    await expect(provider.analyze(input)).rejects.toThrow('Response exceeds 256000 bytes')
  })
})
