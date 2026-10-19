# 7 天数据保留操作说明

本方案只提供运维 CLI，没有新增 HTTP 删除接口、Cron、通知或日报。部署代码或执行迁移均不会自动清理数据。默认 dry-run，生产写入默认关闭。

代码发布兼容尚未执行 0003 的数据库：列表、详情、CSV 和抓取输入通过只读表结构检测使用已有字段；检测仅缓存于请求内的 repository 实例。后续请求能识别新增字段。清理 CLI 仍要求完整 0003，缺失时拒绝执行。发布代码不代表已授权或执行生产迁移。

2026-10-19 发布前追加验证：75 项测试、类型检查、lint、构建通过，覆盖完整旧结构及部分新增列的查询、CSV、抓取更新和迁移后新请求。生产仅只读确认已应用 0001、0002；0003 尚未执行。生产导出命令提示可能在导出期间暂停服务，因此备份需另行批准适当窗口；不要把 Time Travel 书签等同于已验证的本地备份。

## 决策与旧文档差异

依据 2026-10-19 的需求变更，本说明替代 PRD / ERD / AGENTS / 实施计划中“AI 分析长期保留、失败日志 90 天”的旧保留条款。网址身份、人工信息与发现标记长期保留；正文、分析明细与日志默认 7 天。其余扫描和安全规则不变。`CONTENT_EXCERPT_POLICY.md` 的 8,000 字符上限仍有效。

**保守默认：任何人工参与（备注、关注、复核状态、已查看、人工类型/关键词/意图）都豁免该页面的正文、分析和页面日志。** 当前没有独立标签表，人工次级关键词等现有字段一并保护；不虚构通知/发送队列表。豁免不可通过 CLI 关闭。取消全部人工标记后，重内容将再次按原始时间参与候选计算。

## 逐表行为

| 表 | 清理行为 | 时间依据 / 长期保留内容 |
| --- | --- | --- |
| `pages` | 永不删除或软删除 | URL 唯一身份、生命周期、首次发现；不使用 `sitemap_lastmod` 或最近看见时间延长重内容保留 |
| `page_review` | 永不修改 | 全部人工值、备注、标记 |
| `page_sitemap_links` | 永不修改 | 页面与来源关系 |
| `competitors`, `sitemap_sources` | 永不修改 | 配置、基线、来源关系；来源上的最近错误属于当前配置诊断，暂不清理 |
| `page_seo_data` | 清空正文、Title/Meta/H1/H2、canonical/robots、跳转链、错误、历史 hash；写 `expired_at` | `content_fetched_at`、`fetched_at`、`updated_at` 均早于 cutoff；保留一页一行的轻量状态/时间/最终 URL |
| `page_analyses` | 清空分析结果、关键词、证据、原始摘要、错误；写 `expired_at` | 成功使用 `analyzed_at` 与 `created_at`；失败/跳过且无分析时间时按完成插入的 `created_at`；保留每次分析的轻量状态、模型、时间记录 |
| `fetch_attempts` | 删除完成的旧尝试 | `started_at`、`finished_at` 均早于 cutoff；人工页面豁免 |
| `scan_sitemaps` | 删除完成的旧明细 | `started_at`、`finished_at` 均早于 cutoff |
| `scan_runs` | 清空旧 `error_summary` | `created_at`、`started_at`、`finished_at` 均早于 cutoff；保留状态、计数和 ID，避免损害页面/事件的运行关联 |
| `page_events.discovered` | 仅清空旧 JSON 负载 | 保留 ID、页面、发现时间与运行关联，列表、Dashboard 和 CSV 继续可见 |
| 其他 `page_events` | 删除已知的自动事件日志 | `detected_at`、`created_at` 均早于 cutoff；人工页面、手工/未知事件类型始终保护 |

这会降低重内容占用，不承诺数据库行数或物理文件大小立即下降。URL 身份、分析状态存根和扫描汇总仍可能逐渐增长。没有 VACUUM 或额外清理生产数据的操作。

## 时间、任务和并发

- 默认 `days=7`；一次运行固定 `now`，`cutoff = now - days × 86,400,000 ms`，滚动 UTC 168 小时，不按上海自然日截断。
- 严格 `< cutoff`，恰好在边界的记录保留。CLI 可传 `--now 2026-10-19T12:00:00.000Z` 重现结果。
- 只接受项目实际写入的 `YYYY-MM-DDTHH:mm:ss.sssZ`。NULL、空值、不可能日期、缺毫秒、偏移量、未来时间等均保守保留/不参与清理，不猜测其年龄。
- 迁移只为旧 `success` SEO 回填 `content_fetched_at=fetched_at`。旧失败记录可能仍含更早的成功正文，其实际年龄未知，保留待人工核实。新成功抓取记录真实正文获取时间；失败尝试不会伪造正文时间。
- 任意 `queued/running` 扫描、`pending/running` 抓取、`pending/fetching` SEO、`pending/analyzing` 分析或 `pending` Sitemap 明细都会暂停全部清理。既保护任务，也保护任务需要的输入。清理器不以超时为由擅自解锁；长期卡住的任务需另行核查。
- 每一条写语句内部重新检查保护条件和当前候选，再用主键子查询限制数量。SQLite/D1 单条语句原子执行，与任务登记写入串行，不依赖预览候选 ID。不在网络请求期间持锁。
- 默认每类每批 100 行，最多 100 批；可配置 `--batch-size`（1–500）和 `--max-batches`（1–1000）。达到上限可再次预览并续跑。已清空/删除的数据不会再次写入。
- 整次运行不是一个大事务；失败时先前批次可能已提交。远程超时结果可能不明，不自动重试，先重新预览。预览各表计数是只读采样，不保证跨表同一快照；真实写入始终重新判断。

## 界面与分析输入

列表、详情及 CSV 将已清理内容显示为 `expired`（界面中文“已过期（保留策略）”）；详情说明这是保留策略而非抓取故障。已过期正文不会用于 AI 输入。人工值继续优先显示。

扫描仍只处理实际新 URL。过期不会触发旧页面全量重新抓取/分析；如后续由获准的抓取流程成功取得新内容，清除 SEO 过期标记并刷新真实获取时间。失败不会恢复已过期内容。新分析优先于过期存根。

## 本地预览和演练

CLI 需要 Node >=22.18（建议本任务验证使用的 Node 24），使用内置 SQLite；不加载生产 Wrangler 配置、不自动创建数据库、不自动迁移。先在隔离测试库应用所有迁移：

```powershell
node --input-type=module -e 'import {DatabaseSync} from "node:sqlite"; import fs from "node:fs"; fs.mkdirSync(".retention-test",{recursive:true}); const db=new DatabaseSync(".retention-test/demo.sqlite"); for(const f of fs.readdirSync("migrations").sort()) db.exec(fs.readFileSync("migrations/"+f,"utf8")); db.close();'
node scripts/retention.js --database .retention-test/demo.sqlite --now 2026-10-19T12:00:00.000Z
```

正式使用前，应向隔离库导入构造数据，或运行 `pnpm test` 中的保留集成测试。预览输出逐表 `candidates`、清理动作与保护原因计数、长期保留表数量、cutoff、全局任务暂停状态；不会打印正文或备注。文件内容可能仍包含本机路径，应审慎分享报告。

`pnpm run test:retention:d1` 额外在本机 workerd 中验证 D1 SQL；脚本生成独立全零 ID 的测试配置，禁用远程绑定，使用临时不持久化数据库，不加载 `.env`。运行结果见 [验证记录](DATA_RETENTION_VALIDATION.md)。

在已备份的本地测试库明确启用写入：

```powershell
node scripts/retention.js --database .retention-test/demo.sqlite --apply --batch-size 100
node scripts/retention.js --database .retention-test/demo.sqlite
```

默认预览以只读连接打开本地文件。`--dry-run` 可显式传入，与 `--apply` 互斥。路径拼写错误不会创建空数据库。外键已损坏或迁移缺失时停止。

## 未来远程操作门槛（本次不执行）

必须先单独审核/部署兼容代码和 `0003_data_retention.sql`，确认目标账户、数据库、备份与维护时段。此迁移仅增加字段/索引及成功正文时间回填，没有删除。无需更改 Access 或 Worker Secrets。

CLI 远程模式只向 Cloudflare 官方 D1 API 发请求，用本机进程环境中的 `CLOUDFLARE_API_TOKEN`，不自动登录、不写凭证文件。须由操作人提供适当的最小权限凭证；不要在命令行或 Git 中写 token。预览应使用只读权限；具体账户 token 权限实际效果尚未验证。

```powershell
node scripts/retention.js --remote --account-id <账户ID> --database-id <目标D1_ID> --days 7
```

仅 `--apply` 不足以写远端。还必须设置 `RETENTION_ALLOW_REMOTE_DELETE=true`，同时传入 `--confirm-database <与目标D1_ID完全相同>`；对所有远端库都采用这一门槛。项目不会预填账户或自动选中生产库。该开关只是运维防误操作门槛，真正鉴权来自 Cloudflare API Token。**本次没有调用远程预览、迁移或删除，也没有验证生产 API 写入。**

## 备份与恢复

1. 本地演练：关闭数据库连接后复制 SQLite 文件（若有 WAL，先检查点/使用 SQLite backup，不能仅复制主文件）。清理后再打开备份副本，核查正文/人工值、行数、`PRAGMA foreign_key_check`；勿覆盖正在使用的库。
2. 远端执行前：操作人另行确认 D1 export / Time Travel 的可用性、保留窗口、备份时间与恢复目标，下载备份到 Git 之外的受控位置，先在独立库做恢复演练。
3. 恢复不仅回滚代码：清空的正文和分析值无法从 `expired_at` 推导回来。应从备份恢复数据；整库回退可能撤销备份之后的人工备注及新扫描，应先导出这些增量并评估合并。
4. 尚未验证：生产导出、Time Travel、跨库导入、真实生产回滚和远程 API 执行。构造数据的本地副本恢复验证不能替代这些环节。生产启用前必须补齐。

参考：[D1 Query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)、[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)。
