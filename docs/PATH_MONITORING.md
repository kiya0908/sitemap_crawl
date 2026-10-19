# 路径监测与每日新增读取

新增能力仅为可配置的路径范围与现有页面列表读取。每日扫描仍为 UTC 01:00（北京时间 09:00）；消息自动化由调用方独立配置，例如北京时间 18:30 读取当天结果。本应用不新增提醒、发送队列、自动清理或 HTTP 管理接口。

## 配置与基线

先应用非破坏性的 `0004_monitor_path_rules.sql`，再发布代码。该迁移创建 `competitor_monitor_rules` 与发现事件查询索引，不写入任何真实竞品配置。

通过已有可信运维 D1 连接为指定竞品配置一条规则：`competitor_id`、`path_prefix`（例如 `/templates/`）及 UTC `created_at`。规则是字面量、区分大小写、以 `/` 开始和结束的路径段，不允许通配符、查询串或 `..`。只有 pathname 以该前缀开始且后续非空的 URL 才匹配；目录自身（含目录尾斜杠）不匹配。查询参数不能使其他路由匹配。无规则的竞品保持全站行为。

过滤在 Sitemap URL 入集合、首次基线和增量 diff 之前执行；Sitemap Index 子文件仍完整读取，不按模板路径过滤 XML 文件地址。历史非目标页面不会被标记缺失。首次完整扫描写入 baseline_added，不写 discovered，不抓取正文、不调用 AI。失败或部分扫描不建立基线。不要随意改变已建立基线的范围：扩展范围需要另外规划基线，不能将原有存量当新增。

## 稳定只读页面

复用 `/pages` 的 GET/服务端渲染，可被云端读取，不依赖本机程序、前端交互或不稳定的 server-function 哈希 URL：

```text
/pages?competitorId=<id>&pathPrefix=%2Ftemplates%2F&discoveredFrom=2026-10-19T00%3A00%3A00.000Z&discoveredBefore=2026-10-20T00%3A00%3A00.000Z&page=1&pageSize=100
```

- `competitorId` 是目标精确 ID。带路径/时间范围必须带 ID；不存在或已删除目标返回错误，不伪装为零新增。
- `pathPrefix` 按**发现网址的规范化 pathname**精确过滤；返回完整发现 URL，同时 CSV 保留当前 URL（可能重定向）。
- `discoveredFrom` 包含、`discoveredBefore` 不包含；必须是完整 UTC 毫秒 ISO（如 `2026-10-19T00:00:00.000Z`）。非法日期/反向窗口拒绝，不能静默放宽。
- 使用第一次 discovered 事件的 detected_at，而非 sitemap lastmod、页面当前 lifecycle 或最后出现时间。基线不含 discovered，重复扫描变 active、missing 后恢复都不会再次成为新增。
- `page` 从 1 起；`pageSize` 为 1–100。按 discovered_at DESC、id DESC 确定顺序。逐页读取到显示的总页数，保持相同窗口，禁止只读第一页。选择已结束的窗口可避免边翻页边出现新记录。
- 日报可使用北京时间前一日 18:30 到当日 18:30 的窗口（UTC 前一日10:30到当日10:30）；18:30之后发现的数据留给次日。发生漏发应补读漏掉的时间窗口并按 URL 去重。
- 页面显示目标域名、规则、基线/启用状态、最近扫描 ID、status、is_complete、开始/完成 UTC、最近完整扫描时间、抓取/分析失败数。先检查目标、路径、基线和扫描状态，判断新鲜度；最近扫描失败、部分、运行中、过旧或无法读取均应报告监测异常，不能称零新增。列表中已发现的网址仍应报告。
- AI/抓取失败不隐藏 URL。优先人工关键词、其次可用 AI 关键词；没有关键词时从 URL slug 推断并明确标注“低置信度”。这不是排名词。分析 failed/skipped、抓取阻塞和内容过期均有明确状态。不会重新抓取或重新分析全部基线。
- CSV 导出按钮复用相同筛选与既有分页导出；包含发现时间、完整发现 URL、当前 URL、关键词来源及状态。

## 权限与部署

沿用现有站点访问边界，没有新增匿名管理或写入路由。若云端读取被 Access 阻止，调用方必须报告权限阻塞，不能关闭 Access 或把长期凭据写入 URL。配置持续访问身份须单独授权。

本次发现既有 Worker OpenRouter 调用将运行时 fetch 当作 provider 成员调用，可能出现 Illegal invocation；已将默认 fetch 绑定 globalThis，并以模拟 Workers 上下文的测试覆盖。真实凭据/余额/模型可用性仍需部署时独立核查，成功构建不等于 AI 成功。

部署必须保留已有变量及密钥；例如官方 `wrangler deploy --keep-vars`。不得因为本地缺少密钥而覆盖或创建生产凭据。数据库规则与运维快照不进入 Git。生产建立基线后验证路径计数、discovered=0、无批量抓取/分析，并比对其他竞品记录不变。
