# Non-Sitemap discovery validation

Base: latest main `f761c9b9b3beea3d20b57b730f3cc3ff183a89e9` read at implementation start. Branch: `feat/non-sitemap-discovery`.

## Completed

- Final combined suite: **100 tests passed across 14 files**.
- Fixed latest-scan tie ordering: same-millisecond runs use insertion order, preventing an older partial success from hiding the latest failure.
- Existing regression suite: 93 tests passed before adding new tests.
- Seven new fixture/integration tests cover scoped URL parsing, tracking-parameter deduplication, pagination, valid zero-in-scope archive pages, malformed/empty sources, repeated pages, 429, redirect rejection, size limits, baseline, repeat scans, failure retention, inferred keyword fallback, source provenance, read-only API validation, and unchanged morning/evening schedule selection.
- SQLite tests use all migrations with foreign keys enabled, transactional D1 adapter, mocked fetch, no external AI or production writes. Setup SQL executed twice proves idempotence.
- TypeScript strict typecheck: passed.
- ESLint: passed.
- Vite production client + Workers SSR build: passed. Warning: no local OPENROUTER_API_KEY, intentionally not supplied to tests. No claim about production AI configuration.
- Actual Wrangler local D1 migrations 0001–0005: applied successfully. Setup SQL: five commands succeeded locally. No remote D1 migration or cleanup performed.
- Anonymous live Media API response: 16 zones, 177 unique scoped links parsed by the implemented collector, source traversal completed in one request. Second independent endpoint request also returned 200/code 0.
- Anonymous live Dreamina root and four category first pages fetched and parsed by the implemented parser. Pagination totals 8/21/5/40 verified. Trending page 21 fetched and parsed successfully: four `/create/` articles, zero in-scope URLs, correctly accepted as a valid archive page.
- Reviewed diffs for secrets, destructive SQL, scope escape and existing schedule changes. Full source responses used temporarily for inspection were not committed.

## Incomplete / environment limits

- Full 75-request Dreamina live traversal was attempted, but the tool session ended with `network approval was cancelled before a decision was returned`. No completed live full-traversal result exists; do not claim it passed. Fixture traversal tests pass, and actual first/last pages parse, but production must verify the complete run.
- Local browser/HTTP end-to-end check could not start: Cloudflare Vite dev plugin failed at `uv_interface_addresses` / `os.networkInterfaces` in this environment. Read-only endpoint logic and D1 queries are covered by integration tests; deployed HTTP/Access routing remains unverified.
- Host's pnpm 11 install downloaded pinned dependencies but reported ignored esbuild/sharp/workerd build scripts. Validation ran the installed local binaries directly; no dependency/lockfile changes or build-script policy bypass were committed.
- No production deploy, remote migrations, live Cron, Access authentication, or production OpenRouter verification. New monitors require the documented setup and first baseline scans.
- Media curated coverage demonstrably misses some search-indexed pages. Dreamina archives cannot prove absence of orphan pages. No authenticated paid search API trial and no coverage-percentage claim.

## Release gates

1. Apply migration 0005 before new application code; configure monitors using setup SQL.
2. Confirm Workers request/runtime budget, Access coverage, and the production domain.
3. Run each initial scan. Require `source_complete=1`, baseline established, `new_count=0`; expect `partial_success` and `is_complete=0` because website coverage is limited.
4. Complete a full live Dreamina traversal and inspect error_summary if it fails. Do not accept a failed/truncated baseline.
5. Verify JSON pagination and CSV in the authenticated production session. Check the next daily run and retain Makeviral 18:20 verification separately.
