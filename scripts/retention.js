import { parseArgs } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import { runRetention, retentionConfig } from '../src/db/data-retention.ts'

const { values } = parseArgs({ options: {
  database: { type: 'string' }, remote: { type: 'boolean', default: false },
  'database-id': { type: 'string' }, 'account-id': { type: 'string' },
  'confirm-database': { type: 'string' }, apply: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false }, days: { type: 'string' },
  now: { type: 'string' }, 'batch-size': { type: 'string' }, 'max-batches': { type: 'string' },
  help: { type: 'boolean', default: false },
}, strict: true, allowPositionals: false })

if (values.help) {
  console.log(`Usage (Node >=22.18):
  node scripts/retention.js --database <existing-local.sqlite> [--days 7] [--now <UTC ISO>] [--apply]
  node scripts/retention.js --remote --account-id <id> --database-id <id> [--apply --confirm-database <id>]
Default: dry-run, 100 rows/batch, at most 100 batches/rule. No migration is applied automatically.
Remote access requires CLOUDFLARE_API_TOKEN. Remote writes additionally require RETENTION_ALLOW_REMOTE_DELETE=true.
See docs/DATA_RETENTION.md before enabling writes.`)
  process.exit(0)
}

let sqlite
try {
  if (values.apply && values['dry-run']) throw new Error('--apply conflicts with --dry-run')
  const options = retentionConfig({
    ...(values.now ? { now: values.now } : {}),
    ...(values.days ? { days: Number(values.days) } : {}),
    ...(values['batch-size'] ? { batchSize: Number(values['batch-size']) } : {}),
    ...(values['max-batches'] ? { maxBatches: Number(values['max-batches']) } : {}),
    apply: values.apply,
  })
  let db
  let target
  if (values.remote) {
    if (values.database) throw new Error('Choose local --database OR --remote')
    const account = values['account-id']
    const id = values['database-id']
    if (!/^[a-f0-9]{32}$/i.test(account ?? '') || !/^[a-f0-9-]{36}$/i.test(id ?? '')) {
      throw new Error('Remote mode requires explicit --account-id and --database-id')
    }
    if (values.apply && (process.env.RETENTION_ALLOW_REMOTE_DELETE !== 'true' || values['confirm-database'] !== id)) {
      throw new Error('Remote writes disabled: require RETENTION_ALLOW_REMOTE_DELETE=true and --confirm-database matching --database-id')
    }
    const token = process.env.CLOUDFLARE_API_TOKEN
    if (!token) throw new Error('Remote mode requires CLOUDFLARE_API_TOKEN; no automatic login')
    const request = async (sql, params) => {
      // One atomic statement per request. Never automatically retry an uncertain write.
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${id}/query`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params: params.map(String) }), signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`D1 request failed (${response.status}); if applying, re-preview before retrying`)
      const body = await response.json()
      const result = body.result?.[0]
      if (!body.success || !result?.success) throw new Error('D1 query failed; no automatic retry; inspect schema and re-preview')
      return result
    }
    db = {
      query: async (sql, params) => (await request(sql, params)).results,
      execute: async (sql, params) => {
        const result = await request(sql, params)
        if (!Number.isSafeInteger(result.meta?.changes)) throw new Error('D1 returned no write count; outcome uncertain, re-preview')
        return result.meta.changes
      },
    }
    target = { remote: true, account, databaseId: id }
  } else {
    if (!values.database || values['account-id'] || values['database-id'] || values['confirm-database']) {
      throw new Error('Local mode requires --database <existing-local.sqlite>; remote flags require --remote')
    }
    const path = realpathSync(values.database) // Never create an empty DB on a typo.
    sqlite = new DatabaseSync(path, { readOnly: !values.apply })
    sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    db = {
      query: async (sql, params) => sqlite.prepare(sql).all(...params),
      execute: async (sql, params) => Number(sqlite.prepare(sql).run(...params).changes),
    }
    target = { remote: false, path }
  }
  // Fail before any cleanup on unmigrated DBs or broken existing relationships.
  await db.query('SELECT content_fetched_at, expired_at FROM page_seo_data LIMIT 0', [])
  await db.query('SELECT expired_at FROM page_analyses LIMIT 0', [])
  if ((await db.query('PRAGMA foreign_key_check', [])).length > 0) throw new Error('Existing foreign key violations; cleanup refused')
  console.log(JSON.stringify({ target, ...await runRetention(db, options) }, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Retention failed')
  console.error('Stopped. Earlier batches may have committed if --apply was used. Re-preview before resuming; do not assume rollback.')
  process.exitCode = 1
} finally {
  sqlite?.close()
}
