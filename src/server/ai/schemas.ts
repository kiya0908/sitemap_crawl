import { z } from 'zod'

export const seoAnalysisSchema = z.object({
  pageType: z.enum(['product', 'product_category', 'solution', 'industry', 'blog', 'guide', 'case_study', 'landing_page', 'other']),
  primaryTopic: z.string().min(1).max(200),
  primaryKeyword: z.string().min(1).max(200),
  secondaryKeywords: z.array(z.string().min(1).max(200)).max(15),
  searchIntent: z.enum(['informational', 'commercial', 'transactional', 'navigational', 'mixed']),
  productLine: z.string().max(200).nullable(),
  summary: z.string().min(1).max(1000),
  reasoningEvidence: z.array(z.string().min(1).max(500)).min(1).max(8),
  confidence: z.number().min(0).max(1),
})

export type SeoAnalysisResult = z.infer<typeof seoAnalysisSchema>

export interface SeoAnalysisInput {
  url: string
  title: string | null
  metaDescription: string | null
  h1: string | null
  h2: string[]
  pageLanguage: string | null
  contentExcerpt: string | null
}

export const seoAnalysisJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pageType: {
      type: 'string',
      enum: ['product', 'product_category', 'solution', 'industry', 'blog', 'guide', 'case_study', 'landing_page', 'other'],
    },
    primaryTopic: { type: 'string' },
    primaryKeyword: { type: 'string' },
    secondaryKeywords: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 15,
    },
    searchIntent: {
      type: 'string',
      enum: ['informational', 'commercial', 'transactional', 'navigational', 'mixed'],
    },
    productLine: { type: ['string', 'null'] },
    summary: { type: 'string' },
    reasoningEvidence: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 8,
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: [
    'pageType',
    'primaryTopic',
    'primaryKeyword',
    'secondaryKeywords',
    'searchIntent',
    'productLine',
    'summary',
    'reasoningEvidence',
    'confidence',
  ],
} as const
