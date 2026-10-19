// Explicit local-only runtime smoke test, separate from the fast SQLite suite.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { getPlatformProxy } from 'wrangler'
import { runRetention } from '../src/db/data-retention.ts'

mkdirSync('.retention-test', { recursive: true })
const directory = mkdtempSync(resolve('.retention-test/d1-'))
const configPath = join(directory, 'wrangler.json')
writeFileSync(configPath, JSON.stringify({
  name: 'retention-local-test', compatibility_date: '2026-07-15',
  d1_databases: [{ binding: 'DB', database_name: 'retention-local-test',
    database_id: '00000000-0000-0000-0000-000000000000', remote: false }],
}))
const proxy = await getPlatformProxy({ configPath, envFiles: [], persist: false, remoteBindings: false })
try {
  const d1 = proxy.env.DB
  const db = {
    query: async (sql, params) => (await d1.prepare(sql).bind(...params).all()).results,
    execute: async (sql, params) => (await d1.prepare(sql).bind(...params).run()).meta.changes,
  }
  for (const file of readdirSync('migrations').filter((file) => file.endsWith('.sql')).sort()) {
    const source = readFileSync(join('migrations', file), 'utf8').replace(/^--.*$/gm, '')
    for (const statement of source.split(';').map((s) => s.trim()).filter(Boolean)) {
      await db.execute(statement, [])
    }
  }
  const old = '2026-09-01T00:00:00.000Z'
  const now = '2026-10-19T12:00:00.000Z'
  await db.execute(`INSERT INTO competitors (id,name,domain,created_at,updated_at) VALUES ('c','Fixture','example.com',?,?)`, [old, old])
  await db.execute(`INSERT INTO scan_runs (id,competitor_id,trigger_type,status,created_at,started_at,finished_at,error_summary)
    VALUES ('r','c','manual','success',?,?,?,'old error')`, [old, old, old])
  await db.execute(`INSERT INTO scan_sitemaps (id,scan_run_id,requested_url,result_status,started_at,finished_at)
    VALUES ('s','r','https://example.com/sitemap.xml','success',?,?)`, [old, old])
  for (const id of ['expired', 'human', 'boundary']) {
    const time = id === 'boundary' ? '2026-10-12T12:00:00.000Z' : old
    const url = `https://example.com/${id}`
    await db.execute(`INSERT INTO pages (id,competitor_id,original_url,normalized_url,current_url,lifecycle_status,
      first_seen_at,last_seen_at,created_at,updated_at,first_scan_run_id) VALUES (?,'c',?,?,?,'active',?,?,?,?,'r')`,
    [id, url, url, url, old, now, old, now])
    await db.execute(`INSERT INTO page_seo_data (page_id,content_excerpt,fetch_status,fetched_at,updated_at,content_fetched_at)
      VALUES (?,'body','success',?,?,?)`, [id, time, time, time])
    await db.execute(`INSERT INTO page_analyses (id,page_id,status,provider,model,prompt_version,summary,created_at,analyzed_at)
      VALUES (?,?,'success','mock','mock','v1','analysis',?,?)`, [id, id, time, time])
    await db.execute(`INSERT INTO fetch_attempts (id,page_id,scan_run_id,trigger_type,attempt_number,status,started_at,finished_at)
      VALUES (?,?,'r','scan',1,'success',?,?)`, [id, id, time, time])
    await db.execute(`INSERT INTO page_events (id,page_id,event_type,new_value_json,created_at,detected_at)
      VALUES (?,?,'discovered','{}',?,?)`, [id, id, time, time])
    await db.execute(`INSERT INTO page_events (id,page_id,event_type,created_at,detected_at)
      VALUES (?,?,'fetch_failed',?,?)`, [`${id}-log`, id, time, time])
  }
  await db.execute(`INSERT INTO page_review (page_id,notes,is_worth_following,created_at,updated_at)
    VALUES ('human','keep',1,?,?)`, [old, old])
  const dry = await runRetention({ ...db, execute: async () => { throw new Error('dry-run wrote') } }, { now })
  assert.equal(dry.preview.tables.find((t) => t.table === 'page_seo_data').candidates, 1)
  const applied = await runRetention(db, { now, apply: true, batchSize: 1 })
  assert.equal(applied.changes.find((t) => t.table === 'page_seo_data').changed, 1)
  assert.equal((await db.query("SELECT content_excerpt FROM page_seo_data WHERE page_id='expired'", []))[0].content_excerpt, null)
  assert.equal((await db.query("SELECT content_excerpt FROM page_seo_data WHERE page_id='human'", []))[0].content_excerpt, 'body')
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM page_events WHERE event_type='discovered'", []))[0].n, 3)
  assert.deepEqual(await db.query('PRAGMA foreign_key_check', []), [])
  const repeat = await runRetention(db, { now, apply: true })
  assert(repeat.changes.every((t) => t.changed === 0))
  console.log(JSON.stringify({ localD1: 'passed', migrations: readdirSync('migrations').filter((f) => f.endsWith('.sql')).length, dryRun: 'no writes',
    boundary: 'retained', manualReview: 'retained', discovered: 3, foreignKeys: 'intact',
    rerun: 'zero changes', changes: applied.changes }, null, 2))
} finally {
  await proxy.dispose()
}
