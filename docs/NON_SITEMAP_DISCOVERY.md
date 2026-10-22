# Public-page discovery: Media.io and Dreamina

## Verified sources and choice (2026-10-22)

Read-only checks used anonymous requests, no account cookies, no generation or AI calls.

| Source | Evidence / coverage | Stability and limits | Cost / choice |
|---|---|---|---|
| Media.io `/ai/explore/zone` HTML | Redirects to Explore; no usable static zone links | JS application shell | Not selected |
| `https://vapi.media.io/v1/workflow/zone/list` | Public frontend bundle calls this endpoint. Two anonymous requests returned HTTP 200, code 0, 16 zones. English `recommend_data.en[].turn_url` and `extra_Config.en.turn_url` yield 177 unique scoped URLs | Undocumented public frontend API; no published SLA/quota observed. Schema checked; empty, error code or unexpected pagination fails closed | 1 request/run, no API subscription; selected |
| Dreamina `/ai-video` + four categories | Root links and category SSR JSON (`__MODERN_ROUTER_DATA__`) provide article paths, total and pageSize. Categories: productivity (8 pages), ai-trending (21), ai-drama (5), editing-tools (40). Last trending page contains `/create/` articles, deliberately excluded by scope | Public HTML/embedded JSON; no login required. Detects changed schema, short pages, changing totals and repeated pages. All advertised pages enumerated, not just first page | About 75 requests/run, no search API subscription; selected |
| Google `site:` with recent-time filter | Search queries find pages absent from Media's curated list, e.g. `/zone/zombie-love-story-ai-video-generator` and `/zone/hotel-lobby-ai-video-trend` | Not a complete index export; time labels do not establish publication time. Native scraping adds CAPTCHA/HTML dependencies | Not selected as primary source |
| SerpApi Google Search API | Official docs document `start` pagination; FAQ says pagination cannot recover results Google doesn't serve | Requires secret/account; no authenticated trial performed here. Therefore NOT claimed runtime-verified | Each request/page consumes search credit (including empty responses); at 10 pages × 2 targets/day ~600 requests/month. No paid service enabled |

Search references: https://serpapi.com/search-api ; https://serpapi.com/faq/google-search ; https://serpapi.com/faq . Published plan prices were not relied upon. Actual quotas/prices must be checked before adopting a paid provider.

**Coverage is not measurable as a percentage:** neither site exposes a verified complete ground-truth list. Media's curated source demonstrably misses some indexed pages. Dreamina coverage is limited to articles linked in these archives and the root, not orphan/unlisted pages. Neither adapter guarantees every new hotspot. Newly listed old articles are legitimately *first observed*, not proven newly published.

## Semantics and intentional extension of the original PRD

Original Sitemap behavior stays unchanged. New configuration in `page_discovery_configs` opts a competitor into a separate source collector; it bypasses Sitemap discovery entirely.

- A successfully traversed, nonempty **configured public source** establishes a source baseline; not a whole-site baseline. Baseline URLs are not new, do not trigger SEO fetching or AI.
- `source_complete=1` means all configured source responses and pagination were processed; `scan_runs.is_complete=0` and `partial_success` deliberately retain the limited-coverage warning. This differs from a complete Sitemap scan and is not eligible for whole-site “zero new pages” reporting.
- Failed/empty/changed/truncated sources set `source_complete=0`, scan `failed`, and do not establish baseline or apply a diff. Partial URLs are not inserted; the next daily/manual run retries the full source.
- Later completed source traversals reuse URL normalization, retained URL identities, page insertion, events, SEO and OpenRouter pipeline. Missing links never increment missing streak or mark pages missing.
- First discovery method and source URL are saved atomically with the page; historical `first_seen_at` stays unchanged. UTC discovery timestamps are observations, never publication times. No search time or API `created_at` is copied into `sitemap_lastmod`.
- Keyword precedence remains manual → AI → URL slug. Missing AI key/fetch failures do not hide discovered URLs. Slug/AI values are inferred keywords, not ranking data.
- New monitors run at **09:00 Asia/Shanghai** using the existing morning Cron. `cmp_makeviral_templates` stays at **18:20**, unchanged.

## Safety and bounds

Sequential requests with 250ms spacing, 15s header/body limits, 2MB per response, no redirects, 100 source requests, 1,000 in-scope URLs, five-minute traversal budget (checked between requests). Source hosts and paths are fixed; untrusted JSON cannot supply endpoints. Outgoing page URLs reject credentials, ports, foreign hosts and non-HTTP schemes. Existing safe-fetch SSRF checks also apply. Never execute embedded JavaScript; parse only JSON and links. No full HTML/API payloads are saved in D1 or committed as fixtures. HTTP 429 stops the run without a retry storm.

Cloudflare limits reference (checked 2026-10-22): https://developers.cloudflare.com/workers/platform/limits/ .

Dreamina's ~75 external requests exceed Workers Free's usual 50 external-subrequest allowance; use a Workers plan with sufficient subrequest/runtime budget. This implementation does not add Queues or split a baseline over multiple invocations. A limit failure is reported, never treated as a successful scan. New-page SEO/AI adds requests and existing provider costs beyond discovery; baseline does not.

## Deployment and setup

Code alone does not migrate production or enable the monitors. Apply migration **before deploying code** because page reads now use the added columns.

```sh
pnpm run db:migrate:local
pnpm exec wrangler d1 execute sitemap-crawl --local --file scripts/setup-public-monitors.sql
```

After confirming Cloudflare identity and target database:

```sh
pnpm run db:migrate:remote
pnpm exec wrangler d1 execute sitemap-crawl --remote --file scripts/setup-public-monitors.sql
pnpm deploy
```

The setup script is idempotent; it does not reset baselines, modify Makeviral, or switch existing domain monitors automatically. Check both new IDs exist and have a provider. If a same-domain competitor already exists under another ID, setup skips it; explicitly reconcile its configuration/baseline rather than silently changing existing history. To pause, use existing competitor disable controls. To roll back, pause the new monitors and deploy previous code; retain additive schema and history.

Manually scan both once to establish source baselines; later scans detect newly observed links. Verify Cloudflare Access protects **the entire hostname**, including `/api/discovery/pages` and workers.dev. This task does not create credentials or weaken Access.

## Dot bulk reading

Use existing authenticated browser session or an appropriately scoped Cloudflare Access service token, supplied through headers, never query parameters. Both `/pages` and a read-only JSON endpoint expose data:

```
/pages?competitorId=cmp_media_zones
/pages?competitorId=cmp_dreamina_video
/api/discovery/pages?competitorId=cmp_media_zones&pageSize=100&page=1
/api/discovery/pages?competitorId=cmp_dreamina_video&pageSize=100&page=1
```

Optional `discoveredFrom` (inclusive), `discoveredBefore` (exclusive) use canonical UTC ISO timestamps with milliseconds and Z. Follow `nextPage` until null. Each item has `discoveredUrl`, `primaryKeyword`, `keywordSource`, `firstSeenAt`, `discoveredAt`, `discoveryMethod`, `discoverySourceUrl`, fetch/analysis status. Existing CSV export also contains provenance.

Always read `monitor` alongside `items`: baseline, enabled status, latest scan status/times, `source_complete`, and `error_summary`. Even `source_complete=1` means only “no additional links observed in the configured sources” when items are empty. A failed/stale/missing scan must be reported as unavailable/incomplete. `coverage=public_sources_only` and `publicationTimeKnown=false` make this explicit; do not reinterpret `partial_success` as full-site coverage.

## Validation

See `NON_SITEMAP_VALIDATION.md` for exact checks and remaining production gates.
