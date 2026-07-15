import type { SeoAnalysisInput, SeoAnalysisResult } from './schemas'

export interface SeoAnalysisProvider {
  readonly providerName: string
  readonly model: string
  analyze(input: SeoAnalysisInput): Promise<{
    result: SeoAnalysisResult
    rawResponseExcerpt: string
  }>
}
