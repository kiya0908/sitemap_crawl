import type { SeoAnalysisProvider } from './provider'
import {
  seoAnalysisJsonSchema,
  seoAnalysisSchema,
  type SeoAnalysisInput,
  type SeoAnalysisResult,
} from './schemas'

interface OpenRouterOptions {
  apiKey: string
  model: string
  siteUrl?: string
  appName: string
  fetchImpl?: typeof fetch
  maxRetries?: number
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>
    }
  }>
  error?: {
    message?: string
  }
}

export class OpenRouterSeoProvider implements SeoAnalysisProvider {
  readonly providerName = 'openrouter'
  readonly model: string
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number

  constructor(private readonly options: OpenRouterOptions) {
    if (!options.apiKey) throw new Error('OPENROUTER_API_KEY is not configured')
    this.model = options.model
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxRetries = options.maxRetries ?? 2
  }

  async analyze(input: SeoAnalysisInput): Promise<{ result: SeoAnalysisResult; rawResponseExcerpt: string }> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const raw = await this.request(input, attempt)
        const parsed = seoAnalysisSchema.parse(JSON.parse(raw))
        return {
          result: parsed,
          rawResponseExcerpt: raw.slice(0, 4_000),
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown OpenRouter error')
      }
    }

    throw lastError ?? new Error('OpenRouter analysis failed')
  }

  private async request(input: SeoAnalysisInput, retryNumber: number): Promise<string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      'Content-Type': 'application/json',
      'X-OpenRouter-Title': this.options.appName,
    }
    const siteUrl = this.options.siteUrl?.trim()
    if (siteUrl) headers['HTTP-Referer'] = siteUrl

    const response = await this.fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.options.model,
        provider: {
          require_parameters: true,
        },
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: [
              'You are an SEO competitor research analyst.',
              'Infer the page target keywords from the supplied on-page evidence only.',
              'Do not claim these are verified ranking keywords.',
              'Keep target keywords in the language used by the page.',
              'The summary may be written in concise Chinese.',
              'Return only data matching the supplied JSON schema.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              retryNumber,
              url: input.url,
              title: input.title,
              metaDescription: input.metaDescription,
              h1: input.h1,
              h2: input.h2.slice(0, 20),
              pageLanguage: input.pageLanguage,
              contentExcerpt: input.contentExcerpt?.slice(0, 8_000) ?? null,
            }),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'seo_page_analysis',
            strict: true,
            schema: seoAnalysisJsonSchema,
          },
        },
      }),
    })

    const payload = (await response.json()) as OpenRouterResponse
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `OpenRouter returned HTTP ${response.status}`)
    }

    const content = payload.choices?.[0]?.message?.content
    if (typeof content === 'string' && content.trim()) return content.trim()
    if (Array.isArray(content)) {
      const joined = content.map((part) => part.text ?? '').join('').trim()
      if (joined) return joined
    }

    throw new Error('OpenRouter response did not contain message content')
  }
}
