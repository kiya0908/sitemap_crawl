import { describe, expect, it } from 'vitest'
import { SitemapRepository } from '../src/db/repository'
import { CompetitorDomainConflictError, ScanAlreadyRunningError } from '../src/db/errors'

describe('SitemapRepository.createCompetitor', () => {
  it('在有效竞品已使用相同域名时返回可识别的业务冲突', async () => {
    let batchCalled = false
    const db = createFakeDb({
      existingCompetitorIds: ['cmp_existing'],
      onBatch: () => {
        batchCalled = true
      },
    })
    const repository = new SitemapRepository(db)

    await expect(repository.createCompetitor({
      name: '重复竞品',
      domain: 'HTTPS://EXAMPLE.COM/',
      sitemapUrls: ['https://example.com/sitemap.xml'],
    })).rejects.toEqual(new CompetitorDomainConflictError('example.com'))
    expect(batchCalled).toBe(false)
  })

  it('没有有效同域名竞品时继续执行原子批量写入', async () => {
    let statementCount = 0
    const db = createFakeDb({
      existingCompetitorIds: [null],
      onBatch: (statements) => {
        statementCount = statements.length
      },
    })
    const repository = new SitemapRepository(db)

    const id = await repository.createCompetitor({
      name: '新竞品',
      domain: 'example.com',
      sitemapUrls: ['https://example.com/sitemap.xml'],
    })

    expect(id).toMatch(/^cmp_/)
    expect(statementCount).toBe(2)
  })

  it('并发创建在唯一索引兜底后仍转换为业务冲突', async () => {
    const db = createFakeDb({
      existingCompetitorIds: [null, 'cmp_concurrent_winner'],
      batchError: new Error('database constraint'),
      onBatch: () => undefined,
    })
    const repository = new SitemapRepository(db)

    await expect(repository.createCompetitor({
      name: '并发竞品',
      domain: 'example.com',
      sitemapUrls: [],
    })).rejects.toEqual(new CompetitorDomainConflictError('example.com'))
  })
})

describe('SitemapRepository.createScanRun', () => {
  it('converts the database scan lock into a recognizable business conflict', async () => {
    const db = createScanLockDb()
    const repository = new SitemapRepository(db)

    await expect(repository.createScanRun('cmp_1', 'manual'))
      .rejects.toEqual(new ScanAlreadyRunningError('cmp_1', 'scan_running'))
  })
})

function createFakeDb(input: {
  existingCompetitorIds: Array<string | null>
  batchError?: Error
  onBatch: (statements: D1PreparedStatement[]) => void
}): D1Database {
  let firstCall = 0
  const preparedStatement = {
    bind: () => preparedStatement,
    first: async () => {
      const id = input.existingCompetitorIds[Math.min(firstCall, input.existingCompetitorIds.length - 1)]
      firstCall += 1
      return id ? { id } : null
    },
  } as unknown as D1PreparedStatement

  return {
    prepare: () => preparedStatement,
    batch: async (statements: D1PreparedStatement[]) => {
      input.onBatch(statements)
      if (input.batchError) throw input.batchError
      return []
    },
  } as unknown as D1Database
}

function createScanLockDb(): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        run: async () => {
          if (sql.includes('INSERT INTO scan_runs')) throw new Error('unique constraint')
          return undefined
        },
        first: async () => ({ id: 'scan_running' }),
      }),
    }),
  } as unknown as D1Database
}
