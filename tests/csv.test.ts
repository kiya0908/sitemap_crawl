import { describe, expect, it } from 'vitest'
import { csvCell } from '../src/lib/csv'

describe('csvCell', () => {
  it('neutralizes spreadsheet formulas from competitor-controlled content', () => {
    expect(csvCell('=HYPERLINK("https://attacker.example")'))
      .toBe('"\'=HYPERLINK(""https://attacker.example"")"')
    expect(csvCell('  +SUM(1,1)')).toBe('"\'  +SUM(1,1)"')
  })

  it('keeps ordinary values while escaping quotes', () => {
    expect(csvCell('SEO "keyword"')).toBe('"SEO ""keyword"""')
  })
})
