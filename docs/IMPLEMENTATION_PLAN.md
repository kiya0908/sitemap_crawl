# Sitemap Crawl 分阶段实施计划

## 1. 实施原则

- 先验证核心扫描链路，再做后台界面。
- 每个阶段必须有可验证产物和明确验收条件。
- 不提前实现 SaaS、多用户、支付、通知和复杂图表。
- 所有核心业务规则以 `docs/PRD.md` 为准。
- 数据结构以 `docs/ERD.md` 为准。
- 技术实现以 `docs/TECHNICAL_ARCHITECTURE.md` 为准。

## 2. 阶段总览

```text
P0 项目初始化与基础设施
P1 数据库与竞品管理
P2 Sitemap 发现、解析与首次基线
P3 增量扫描与页面生命周期
P4 新页面抓取与 SEO 信息提取
P5 OpenRouter 结构化分析
P6 私有后台与人工复核
P7 Cron、部署、安全与最终验收
```

---

## P0：项目初始化与基础设施

### 目标

建立可运行、可测试、可部署的 TanStack Start + Cloudflare 项目骨架。

### 工作项

- 初始化 TanStack Start、React、TypeScript。
- 配置 Cloudflare Workers 运行环境。
- 配置本地开发、Preview、Production 环境边界。
- 接入 D1 本地绑定与生产绑定占位。
- 配置 Drizzle ORM 或确定的 D1 数据访问层。
- 配置 ESLint、TypeScript、测试框架和格式化规则。
- 建立 `src/server`、`src/db`、`src/routes` 等基础目录。
- 建立环境变量 Schema。
- 添加 `.env.example`，只放占位符。
- 添加基础 README 开发命令。

### 验收标准

- 本地项目可以启动。
- `typecheck`、`lint`、`test`、`build` 均可执行。
- D1 本地数据库可连接。
- 不存在真实 API Key 或生产配置。
- Cloudflare Preview 可完成一次基础部署。

---

## P1：数据库与竞品管理

### 目标

完成 MVP 数据表、迁移和竞品/Sitemap 基础配置能力。

### 工作项

- 根据 ERD 创建版本化 SQL Migration。
- 创建以下核心表：
  - `competitors`
  - `sitemap_sources`
  - `scan_runs`
  - `scan_sitemaps`
  - `pages`
  - `page_sitemap_links`
  - `page_events`
  - `page_seo_data`
  - `fetch_attempts`
  - `page_analyses`
  - `page_review`
- 创建唯一约束和常用索引。
- 实现竞品新增、编辑、暂停和软删除服务。
- 实现 Sitemap 手动配置服务。
- 实现服务端输入校验。
- 增加最小竞品管理页面或临时开发界面。

### 验收标准

- Migration 可在空数据库完整执行。
- 同一域名不能重复创建有效竞品。
- 同一竞品的同一标准化 Sitemap URL 不会重复写入。
- 可新增、编辑、暂停竞品。
- 软删除竞品后不再参与扫描。
- 数据库测试覆盖主要约束。

---

## P2：Sitemap 发现、解析与首次基线

### 目标

输入竞品后能够完整读取 Sitemap，并建立不产生“新增页面”的首次 URL 基线。

### 工作项

- 实现 `robots.txt` Sitemap 声明识别。
- 实现常见 Sitemap 路径探测。
- 实现手动 Sitemap 优先规则。
- 实现 `urlset` 解析。
- 实现 `sitemapindex` 与子 Sitemap 递归解析。
- 实现 visited 集合、最大递归深度和最大响应体限制。
- 实现 XML 安全解析，禁止外部实体。
- 实现 URL 去重与 Sitemap 来源映射。
- 实现扫描完整性判断。
- 实现首次完整基线写入。
- 首次基线不抓取全部页面、不调用 OpenRouter。
- 建立 Sitemap Fixture 和集成测试。

### 验收标准

- 普通 Sitemap 可解析。
- Sitemap Index 与子 Sitemap 可递归解析。
- 重复 URL 被正确去重。
- 循环 Sitemap 不会无限递归。
- 任一关键子 Sitemap 失败时扫描标记为不完整。
- 不完整扫描不会建立基线。
- 首次完整扫描后页面状态为 `baseline`。
- 首次扫描不产生 `discovered` 新增事件。
- 再次执行同一基线数据不会重复插入页面。

---

## P3：增量扫描与页面生命周期

### 目标

准确识别新增、缺失和重新出现页面，并保证扫描任务幂等。

### 工作项

- 实现 URL 标准化纯函数。
- 添加 URL 标准化单元测试。
- 实现当前 URL 集合与历史页面对比。
- 实现新增页面写入和 `discovered` 事件。
- 实现完整扫描下的缺失计数。
- 连续两次完整扫描缺失后标记 `missing`。
- 实现 `reappeared` 状态与事件。
- 正常活跃页面的临时状态收敛为 `active`。
- 实现同一竞品扫描互斥。
- 实现重复触发的幂等保护。
- 保存扫描数量汇总和错误摘要。

### 验收标准

使用三轮固定 Fixture 验证：

1. 第一轮建立基线；
2. 第二轮新增 URL A、缺少 URL B；
3. 第三轮 B 继续缺失，A 保持存在；
4. 第四轮 B 再次出现。

期望结果：

- A 只创建一次新增事件。
- B 第二轮不立即标记 missing。
- B 第三轮标记 missing。
- B 第四轮标记 reappeared，而不是 new。
- 不完整扫描不会增加缺失计数。
- 尾斜杠、Fragment 和常见追踪参数差异不会创建重复页面。

---

## P4：新页面抓取与 SEO 信息提取

### 目标

只对新增或需要重试的页面抓取并保存结构化 SEO 信息。

### 工作项

- 实现受限页面请求客户端。
- 实现 SSRF 防护。
- 配置 User-Agent、超时、最大响应体和最大跳转次数。
- 实现 Content-Type 判断。
- 提取 HTTP 状态、最终 URL、Redirect 链。
- 提取 Title、Meta Description、H1、H2、Canonical、Robots Meta、语言。
- 实现正文基础清洗和长度截断。
- 生成内容哈希。
- 保存抓取尝试和当前 SEO 数据。
- 抓取失败时保留历史成功数据。
- 支持手动重新抓取。
- 对 PDF 和非 HTML 内容标记 unsupported，不解析正文。

### 验收标准

- 新增 HTML 页面可保存核心 SEO 字段。
- 基线页面不会被全量抓取。
- 页面失败后可重试。
- 重试失败不会清空上一次有效 SEO 数据。
- Redirect 最终 URL 和链路可查看。
- 不保存完整 HTML。
- 私网、localhost 和非法目标被拒绝。
- 单次新增页面不会因任务重试产生重复抓取事件。

---

## P5：OpenRouter 结构化分析

### 目标

将新页面 SEO 信息转换为可验证的结构化关键词与搜索意图分析。

### 工作项

- 定义 `SeoAnalysisProvider` 接口。
- 实现 OpenRouter Provider。
- 配置以下环境变量：
  - `OPENROUTER_API_KEY`
  - `OPENROUTER_MODEL`
  - `OPENROUTER_SITE_URL`
  - `OPENROUTER_APP_NAME`
  - `AI_PROMPT_VERSION`
- 设计稳定的结构化提示词。
- 定义并实现 Zod 输出 Schema。
- 实现最多 2 次的解析/修复重试。
- 保存模型、提示词版本、状态、错误和结构化结果。
- 支持手动重新分析。
- 人工值与 AI 值分开保存。
- 使用 Mock Provider 完成自动化测试。

### 验收标准

- 合法 JSON 输出可被 Schema 验证并保存。
- 非法输出可重试。
- 两次仍失败时页面保留，分析状态为 failed。
- 页面抓取成功但 AI 失败时仍可在后台查看。
- 模型可通过环境变量更换。
- 业务逻辑不直接依赖 OpenRouter HTTP 实现。
- 测试不会调用真实 OpenRouter API。

---

## P6：私有后台与人工复核

### 目标

完成日常可用的管理后台。

### 页面

#### Dashboard

- 启用竞品数量；
- 今日新增页面；
- 最近 7 天新增页面；
- 待查看数量；
- 值得跟进数量；
- 最近失败数量；
- 最近扫描活动。

#### 竞品管理

- 新增、编辑、暂停竞品；
- 配置多个 Sitemap；
- 查看最后扫描状态；
- 手动立即扫描；
- 查看扫描历史。

#### 新增页面列表

- 分页；
- 按竞品、时间、页面类型、搜索意图、抓取状态、分析状态、人工状态筛选；
- URL、标题、关键词搜索；
- 排序；
- CSV 导出。

#### 页面详情

- Sitemap 与 URL 信息；
- SEO 字段；
- AI 分析和证据；
- 抓取/分析错误；
- 页面事件时间线；
- 人工复核、备注、重新抓取、重新分析。

### 验收标准

- 后台主要页面在桌面端和移动端均可操作。
- 筛选和分页不会加载全部数据到浏览器。
- CSV 导出遵循当前筛选条件。
- 人工值与 AI 值显示区分清楚。
- “已查看”与“值得跟进”状态互不混淆。
- 所有写操作均在服务端校验。

---

## P7：Cron、部署、安全与最终验收

### 目标

完成生产部署、自动扫描、安全保护和上线前总验收。

### 工作项

- 创建生产 D1 数据库并执行 Migration。
- 配置 Cloudflare Worker 环境绑定。
- 使用 Secret 配置 OpenRouter API Key。
- 配置每天一次的 Cron Trigger。
- 默认东京时间上午 9 点，对应 UTC 00:00。
- 配置 Cloudflare Access，只允许指定账号访问。
- 检查后台 HTTP 入口和 Cron 入口分离。
- 验证生产环境日志不泄露密钥。
- 增加 90 天失败日志清理任务。
- 完成真实竞品小规模冒烟测试。
- 更新 README 部署和运维说明。

### 最终验收清单

#### 构建质量

- `lint` 通过；
- `typecheck` 通过；
- 自动化测试通过；
- 生产构建通过；
- 无跳过 TypeScript/ESLint 的配置；
- 无真实密钥提交。

#### 核心业务

- 首次扫描只建立基线；
- 第二次扫描可识别新增页面；
- 连续两次缺失规则正确；
- 重新出现规则正确；
- 页面抓取与 AI 分析正常；
- 人工复核和 CSV 导出正常；
- 手动扫描与 Cron 扫描均可用。

#### 数据控制

- 页面主表无每日重复数据；
- 未保存完整 Sitemap XML；
- 未保存完整 HTML；
- 内容摘要有长度限制；
- AI 响应有长度限制；
- 失败日志有清理策略。

#### 安全

- Cloudflare Access 生效；
- OpenRouter Key 仅存在于 Secret；
- SSRF 防护测试通过；
- Cron 入口无法被普通公网请求滥用；
- 数据库错误和敏感配置不会返回前端。

## 3. MVP 完成定义

只有 P0–P7 的验收条件全部通过，才可认为 MVP 完成。

“页面能打开”或“构建成功”不等于项目验收完成。至少还必须确认：

- 真实 D1 链路可用；
- Cron 实际触发成功；
- Cloudflare Access 实际拦截未授权访问；
- OpenRouter 生产配置可用；
- 多轮扫描状态变化符合规则。

## 4. 后续迭代顺序建议

MVP 稳定运行一段时间后，再按实际使用频率决定是否开发：

1. 每周摘要；
2. 竞品主题聚类；
3. 自有网站内容缺口对比；
4. 页面内容变化监控；
5. SERP 或第三方关键词数据验证；
6. Cloudflare Queues 异步拆分。
