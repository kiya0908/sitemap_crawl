# Sitemap Crawl 技术架构文档

## 1. 架构目标

本项目是一个部署在 Cloudflare 上、仅供个人使用的竞品 Sitemap 增量监控后台。

架构优先级：

1. 可靠识别新增 URL；
2. 控制数据库和 AI 调用成本；
3. 保证扫描任务可重试、可排错；
4. 尽量减少不必要的基础设施；
5. 适配 Cloudflare Workers 与 D1 的运行限制；
6. 为后续更换 OpenRouter 模型或 AI Provider 保留扩展能力。

## 2. 总体架构

```text
Cloudflare Access
        ↓
TanStack Start 管理后台
        ↓
Cloudflare Worker
        ├── 页面与 API 请求
        ├── 手动扫描入口
        ├── CSV 导出
        └── Cron Trigger 入口
                ↓
        扫描编排服务
        ├── Sitemap 发现与解析
        ├── URL 标准化与增量对比
        ├── 页面抓取与 SEO 信息提取
        └── OpenRouter 分析
                ↓
             D1 Database
```

MVP 不使用：

- Redis；
- KV；
- R2；
- Cloudflare Queues；
- Better Auth；
- 支付系统；
- 多租户权限系统。

在当前 3–5 个竞品、单站不超过 1,000 个 URL 的规模下，单 Worker + D1 足够。

## 3. 推荐技术栈

### 3.1 应用框架

- TanStack Start
- React
- TypeScript
- Vite
- Cloudflare Workers Adapter

要求：

- 服务端代码不能依赖 Node.js 专属 API，除非 Cloudflare 运行时明确支持；
- 浏览器端不得直接访问 D1 或 OpenRouter；
- 所有敏感操作必须在服务端执行。

### 3.2 数据访问

推荐使用 Drizzle ORM + D1，也可以使用经过验证的轻量 D1 查询层。

要求：

- 数据表由版本化 SQL Migration 创建；
- 不允许应用启动时自动修改生产表结构；
- 所有时间以 UTC ISO 8601 写入数据库；
- 页面展示时转换为 `Asia/Tokyo`。

### 3.3 数据校验

推荐使用 Zod 或同等运行时 Schema 工具校验：

- 后台表单；
- Sitemap 配置；
- URL；
- OpenRouter 结构化输出；
- API 请求参数；
- 环境变量。

## 4. 应用模块划分

建议目录结构：

```text
src/
├── routes/
│   ├── index.tsx
│   ├── competitors/
│   ├── pages/
│   ├── scans/
│   └── api/
├── server/
│   ├── competitors/
│   ├── sitemap/
│   │   ├── discover.ts
│   │   ├── fetch.ts
│   │   ├── parse.ts
│   │   └── normalize.ts
│   ├── scans/
│   │   ├── orchestrator.ts
│   │   ├── baseline.ts
│   │   ├── diff.ts
│   │   └── status.ts
│   ├── page-fetch/
│   │   ├── fetch-page.ts
│   │   ├── extract-seo.ts
│   │   └── clean-content.ts
│   ├── ai/
│   │   ├── provider.ts
│   │   ├── openrouter.ts
│   │   ├── schemas.ts
│   │   └── prompts.ts
│   ├── reviews/
│   ├── exports/
│   └── security/
├── db/
│   ├── schema.ts
│   ├── client.ts
│   ├── repositories/
│   └── migrations/
├── lib/
│   ├── env.ts
│   ├── logger.ts
│   ├── errors.ts
│   └── time.ts
└── components/
```

业务逻辑不得全部堆在路由文件或 React 组件内。

## 5. Sitemap 发现与解析

### 5.1 发现顺序

1. 使用用户手动配置的 Sitemap；
2. 读取竞品 `robots.txt` 中的 `Sitemap:` 声明；
3. 检查常见路径：
   - `/sitemap.xml`
   - `/sitemap_index.xml`
   - `/wp-sitemap.xml`

手动配置的地址始终优先，自动发现结果需要在后台可见。

### 5.2 解析要求

支持：

- `urlset`；
- `sitemapindex`；
- gzip Sitemap（仅在 Cloudflare 运行时实现可靠时启用）；
- 一个竞品多个 Sitemap；
- 子 Sitemap 递归解析。

安全限制：

- 最大递归深度建议为 5；
- 单次扫描设置最大 Sitemap 数量；
- visited 集合防止循环引用；
- 仅允许抓取竞品域名、其已配置 Sitemap 主机，或经过显式允许的同组织 CDN 主机；
- 响应体设置最大尺寸；
- XML 解析必须禁用外部实体，防止 XXE。

### 5.3 扫描完整性

扫描完整性不能只看主 Sitemap 请求成功。

只有以下条件均满足时，`scan_runs.is_complete = 1`：

- 所有启用的手动 Sitemap 已处理；
- 所有已发现并纳入本次扫描的子 Sitemap 已处理；
- 无关键解析失败；
- 未超过安全上限导致截断；
- URL 集合已完成去重。

不完整扫描不得增加页面 `missing_streak`。

## 6. URL 标准化

URL 标准化必须是纯函数，并拥有独立单元测试。

默认步骤：

1. 使用标准 URL 解析器解析；
2. 协议和 hostname 小写；
3. 移除 Fragment；
4. 移除默认端口；
5. 规范重复斜杠；
6. 统一尾斜杠策略；
7. 删除常见追踪参数：`utm_*`、`gclid`、`fbclid`；
8. 对剩余查询参数排序；
9. 保留原始 URL。

不得默认删除所有查询参数，因为部分网站用参数区分有效页面。

数据库唯一键：

```text
competitor_id + normalized_url
```

## 7. 扫描编排

### 7.1 触发方式

- Cron Trigger：每天一次；
- 后台手动扫描；
- 失败后的受控重试。

建议 Cron 使用 UTC 配置，并在文档中注明对应东京时间。若目标为东京时间上午 9 点，则 Cron 使用 UTC 00:00。

### 7.2 并发控制

同一竞品同一时间只允许存在一个 `running` 扫描。

手动触发时：

- 若已有运行中的扫描，返回当前扫描状态；
- 不创建重复运行；
- 扫描接口必须具备幂等保护。

### 7.3 首次基线

首次完整扫描：

- 写入现有页面；
- 标记为基线；
- 不抓取全部页面；
- 不调用 OpenRouter；
- 只有完整成功后才将 `baseline_established` 设为 true。

### 7.4 后续增量扫描

每次扫描：

1. 获取完整当前 URL 集合；
2. 批量读取历史页面；
3. 计算新增、存在、缺失和重新出现；
4. 使用 Upsert 写入；
5. 只为真实新增页面创建抓取流程；
6. 完整扫描后更新缺失计数；
7. 写入事件和扫描汇总。

所有步骤必须可重试，不得因同一扫描重复执行而重复创建页面或事件。

## 8. 页面抓取

### 8.1 抓取范围

仅抓取：

- 新增页面；
- 需要重试的失败页面；
- 用户手动重新抓取的页面；
- 必要时重新出现的页面。

### 8.2 请求限制

- 自定义 User-Agent，明确工具名称；
- 单请求超时；
- 最大重定向次数建议 5；
- 响应体最大尺寸；
- 同一竞品低并发或串行抓取；
- 单站请求间隔；
- 拒绝私网 IP、localhost、metadata endpoint 等 SSRF 目标。

### 8.3 内容提取

优先提取：

- HTTP 状态码；
- Content-Type；
- 最终 URL；
- Redirect 链；
- Title；
- Meta Description；
- H1；
- H2；
- Canonical；
- Robots Meta；
- HTML `lang`；
- 主体文本摘要。

正文清洗应去除：

- Script；
- Style；
- 导航和页脚噪声；
- 重复空白；
- 明显 Cookie Banner 文本。

不要求 MVP 实现复杂正文抽取算法，优先保证稳定。

## 9. OpenRouter 集成

### 9.1 Provider 抽象

定义统一接口：

```ts
interface SeoAnalysisProvider {
  analyze(input: SeoAnalysisInput): Promise<SeoAnalysisResult>
}
```

OpenRouter 为第一实现。业务层不得直接拼接 OpenRouter HTTP 请求。

### 9.2 环境变量

建议：

```text
OPENROUTER_API_KEY
OPENROUTER_MODEL
OPENROUTER_SITE_URL
OPENROUTER_APP_NAME
AI_PROMPT_VERSION
```

API Key 必须使用 Cloudflare Secret。

### 9.3 结构化输出

- 提示词要求只返回 JSON；
- 服务端使用 Schema 验证；
- 第一次解析失败可进行修复提示重试；
- 最多 2 次重试；
- 失败后记录状态，不阻塞页面进入后台；
- 保存 provider、model、prompt version 和置信度。

### 9.4 成本控制

- 只分析新增页面；
- 限制正文摘要长度；
- 不发送完整 HTML；
- 手动重新分析前显示明确操作；
- 支持通过环境变量切换较低成本模型；
- Dashboard 可显示最近分析数量，便于人工估算成本。

## 10. Cloudflare Access

Cloudflare Access 保护整个管理后台域名。

应用内部不实现用户系统，但仍需注意：

- 所有写接口只能在服务端；
- 不应仅依赖前端隐藏按钮；
- 生产环境可校验 Access 注入的身份头或 JWT；
- Cron 入口必须与后台 HTTP 入口分离；
- 不在日志中输出 Access Token 或用户敏感信息。

## 11. API 设计建议

建议服务端接口：

```text
GET    /api/dashboard
GET    /api/competitors
POST   /api/competitors
PATCH  /api/competitors/:id
POST   /api/competitors/:id/scan
GET    /api/competitors/:id/scans
GET    /api/pages
GET    /api/pages/:id
PATCH  /api/pages/:id/review
POST   /api/pages/:id/refetch
POST   /api/pages/:id/reanalyze
GET    /api/export/pages.csv
```

所有接口：

- 使用 Schema 校验输入；
- 返回统一错误格式；
- 不暴露数据库错误详情；
- 对列表接口实现分页和最大 page size；
- 写操作记录必要日志。

## 12. 错误处理与日志

错误分类建议：

- `SITEMAP_DISCOVERY_FAILED`
- `SITEMAP_FETCH_FAILED`
- `SITEMAP_PARSE_FAILED`
- `SCAN_INCOMPLETE`
- `PAGE_FETCH_TIMEOUT`
- `PAGE_UNSUPPORTED_CONTENT_TYPE`
- `PAGE_PARSE_FAILED`
- `AI_REQUEST_FAILED`
- `AI_SCHEMA_INVALID`
- `DATABASE_WRITE_FAILED`

日志至少包含：

- scan run id；
- competitor id；
- page id（适用时）；
- 阶段；
- 错误代码；
- 可读错误摘要。

不得记录：

- OpenRouter API Key；
- 完整 Access Token；
- 完整网页 HTML；
- 大段 AI 请求正文。

## 13. 测试策略

### 13.1 单元测试

必须覆盖：

- URL 标准化；
- Sitemap Index 递归解析；
- 重复 URL 去重；
- 首次基线规则；
- 新增 URL 判断；
- 连续两次缺失规则；
- 重新出现规则；
- OpenRouter Schema 校验；
- 人工值优先于 AI 值的展示逻辑。

### 13.2 集成测试

使用固定 Fixture：

- 普通 `urlset`；
- Sitemap Index；
- 嵌套子 Sitemap；
- 重复 URL；
- 追踪参数 URL；
- 解析失败 XML；
- 部分 Sitemap 超时；
- 新增、缺失、重新出现的多轮扫描。

测试不得依赖真实竞品网站和真实 OpenRouter API。

### 13.3 端到端测试

至少覆盖：

1. 添加竞品；
2. 首次建立基线；
3. 第二次扫描发现新增页面；
4. 页面抓取成功；
5. AI 结果显示；
6. 人工标记值得跟进；
7. CSV 导出。

## 14. 部署配置

Cloudflare 资源：

- Worker / TanStack Start 应用；
- D1 数据库；
- Cron Trigger；
- Cloudflare Access 应用与策略。

环境建议：

- 本地开发环境；
- Preview 环境；
- Production 环境。

至少区分本地 D1 与生产 D1。不得让测试直接写入生产数据库。

## 15. 扩展触发条件

当前架构不需要队列。出现以下情况时再评估 Cloudflare Queues：

- 单次新增页面数量显著增加；
- Worker 单次执行时间经常接近限制；
- OpenRouter 分析需要异步拆分；
- 抓取失败重试量明显增大；
- 监控规模超过当前 3–5 个竞品和 5,000 URL 的边界。

需要保存原始文件或较大页面快照时再引入 R2；不要提前增加基础设施。
