# AGENTS.md

本文件是 Codex 和其他代码代理在本仓库内工作的最高优先级项目说明。开始修改代码前必须完整阅读，并同时阅读 `docs/` 下的需求与架构文档。

## 1. 项目定位

Sitemap Crawl 是一个仅供项目所有者个人使用的竞品 Sitemap 增量监控与新增页面 SEO 分析后台。

核心目标：

1. 监控 3–5 个竞品网站；
2. 单个竞品不超过 1,000 个 URL；
3. 首次扫描建立基线，不把已有 URL 计为新增；
4. 从第二次完整扫描开始识别新增、缺失和重新出现页面；
5. 只抓取新增或需要重试的页面；
6. 使用 OpenRouter 推测页面类型、主题、关键词和搜索意图；
7. 通过 Cloudflare Access 保护私有后台；
8. 使用 Cloudflare Workers、D1 和 Cron Trigger 部署运行。

本项目不是公开 SaaS，不需要注册、登录、支付、多租户和营销首页。

## 2. 开工前必读文档

按以下顺序阅读：

1. `README.md`
2. `docs/PRD.md`
3. `docs/ERD.md`
4. `docs/TECHNICAL_ARCHITECTURE.md`
5. `docs/IMPLEMENTATION_PLAN.md`
6. 本文件

若代码与文档冲突：

- 先确认冲突属于历史实现还是需求变化；
- 不得静默改变核心业务规则；
- 若必须偏离文档，在提交说明中明确记录偏离点、原因和影响；
- 未获得新需求时，以 PRD 和 ERD 为准。

## 3. 实施顺序

严格按照 `docs/IMPLEMENTATION_PLAN.md` 的 P0–P7 执行：

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

规则：

- 不要在前置阶段未验收时一次性实现全部功能；
- 每阶段完成后先运行验证，再进入下一阶段；
- 不要为了视觉完整提前制作复杂 Dashboard；
- 优先保证扫描正确性、幂等性和数据一致性。

## 4. 不可变业务规则

以下规则不得擅自修改。

### 4.1 首次扫描

- 第一次完整扫描只建立基线；
- 基线页面不算新增页面；
- 基线阶段不抓取全部网页；
- 基线阶段不调用 OpenRouter；
- 扫描不完整时不得将基线标记为已建立。

### 4.2 新增页面

新增页面必须满足：

- 当前完整扫描中存在；
- 同一竞品历史中从未出现过对应 `normalized_url`。

同一竞品唯一键：

```text
competitor_id + normalized_url
```

### 4.3 消失与重新出现

- 页面第一次在完整扫描中缺失，只增加 `missing_streak`；
- 连续两次完整扫描缺失后才标记为 `missing`；
- 不完整扫描不得增加 `missing_streak`；
- `missing` 页面再次出现时标记为 `reappeared`，不能重新算作首次新增。

### 4.4 数据容量

禁止：

- 保存每日全量 URL 快照；
- 保存完整 Sitemap XML；
- 保存完整网页 HTML；
- 对无变化页面每日重复创建事件；
- 对基线页面批量调用 AI。

必须：

- 同一页面只保留一条主记录；
- 当前状态和历史事件分开保存；
- 正文只保存长度受限的清洗摘要；
- AI 原始响应只保留有限摘要；
- 失败尝试日志支持 90 天清理。

### 4.5 AI 分析

- OpenRouter 必须通过独立 Provider 封装；
- 模型通过环境变量配置；
- 输出必须通过运行时 Schema 校验；
- 最多重试 2 次；
- AI 失败不得删除或隐藏新增页面；
- AI 推测关键词不能展示为真实排名关键词；
- 人工修订结果和 AI 原始结果必须分开保存。

## 5. 技术约束

### 5.1 推荐栈

- TanStack Start
- React
- TypeScript
- Cloudflare Workers
- Cloudflare D1
- Cloudflare Cron Triggers
- Cloudflare Access
- OpenRouter
- Drizzle ORM（若项目采用 ORM）
- Zod 或等效运行时 Schema 工具

不要未经必要性验证引入：

- Next.js；
- Supabase；
- Prisma；
- Redis；
- KV；
- R2；
- Cloudflare Queues；
- Better Auth；
- 支付 SDK；
- 重型爬虫框架。

若确实需要改变技术选型，必须在实现报告中说明原因和迁移影响。

### 5.2 Cloudflare 兼容性

- 服务端代码必须兼容 Workers Runtime；
- 不得默认使用 Node.js 专属 API；
- 使用 Web Standard API 优先；
- 使用第三方包前确认其可在 Workers 环境运行；
- 不得把 D1 查询或 OpenRouter Key 暴露给浏览器。

### 5.3 数据库

- 所有表结构使用版本化 SQL Migration；
- 不允许仅依赖运行时自动建表；
- 所有时间以 UTC 写入，界面按 `Asia/Tokyo` 展示；
- 核心写入使用事务或幂等 Upsert；
- 重复执行扫描不得重复创建页面和事件；
- 竞品删除默认使用软删除；
- 索引设计遵循 `docs/ERD.md`。

### 5.4 URL 与 Sitemap

- URL 标准化实现为纯函数；
- 必须保留原始 URL；
- 不得直接删除全部查询参数；
- Sitemap Index 必须有最大递归深度和 visited 集合；
- XML 解析必须避免 XXE；
- 响应体必须设置大小限制；
- 单个失败子 Sitemap 必须反映到扫描完整性。

### 5.5 页面抓取安全

必须实现 SSRF 防护：

- 拒绝 localhost；
- 拒绝私网 IP；
- 拒绝云平台 metadata endpoint；
- 限制抓取到已配置竞品域名或显式允许主机；
- 设置超时、最大跳转次数和最大响应体；
- 使用低并发或串行抓取，避免对目标网站造成压力。

## 6. 环境变量与公开仓库安全

本仓库是公开仓库。

禁止提交：

- OpenRouter API Key；
- Cloudflare API Token；
- D1 生产凭证或私密配置；
- Cloudflare Access Token/JWT；
- 真实私密备注；
- 生产数据库导出；
- `.env` 实际文件；
- 包含密钥的日志或截图。

允许提交：

- `.env.example`；
- 环境变量名称；
- 示例域名，如 `example.com`；
- 本地测试 Fixture。

建议环境变量：

```text
OPENROUTER_API_KEY=
OPENROUTER_MODEL=
OPENROUTER_SITE_URL=
OPENROUTER_APP_NAME=
AI_PROMPT_VERSION=
```

`OPENROUTER_API_KEY` 必须通过 Cloudflare Secret 管理。

## 7. 编码规范

- TypeScript 开启严格模式；
- 避免 `any`，确实需要时说明原因；
- 业务逻辑不要堆在 React 组件和路由文件中；
- 服务层、数据库层、外部 Provider 层分开；
- 公共函数使用明确输入输出类型；
- 错误使用可识别错误代码，不依赖字符串模糊判断；
- 不吞掉异常；
- 不在日志中输出敏感值；
- 对外接口统一返回可理解但不过度暴露内部细节的错误。

## 8. 测试要求

任何核心扫描功能没有测试不得视为完成。

### 必须覆盖的单元测试

- URL 标准化；
- 追踪参数移除；
- 查询参数排序；
- 尾斜杠规则；
- 首次基线；
- 新增 URL 判断；
- 连续两次缺失；
- 重新出现；
- OpenRouter 输出 Schema；
- 人工值优先展示。

### 必须覆盖的集成 Fixture

- 普通 `urlset`；
- Sitemap Index；
- 嵌套子 Sitemap；
- 重复 URL；
- 追踪参数 URL；
- 非法 XML；
- 子 Sitemap 超时；
- 多轮扫描新增、缺失、重新出现。

### 测试限制

- 自动化测试不得依赖真实竞品网站；
- 自动化测试不得调用真实 OpenRouter API；
- 使用本地 Fixture 和 Mock Provider；
- 测试不得写入生产 D1。

## 9. 每阶段执行流程

每个阶段按以下顺序工作：

1. 阅读阶段目标与验收标准；
2. 检查现有代码和迁移；
3. 输出简短实施计划；
4. 实现最小必要改动；
5. 添加或更新测试；
6. 运行 lint、typecheck、test 和 build；
7. 修复本阶段引入的问题；
8. 对照验收标准逐项检查；
9. 输出实施结果和剩余风险。

不要把历史 warning 宣称为本阶段通过项，也不要因为 build 通过就推断数据库、Cron、Access 或 OpenRouter 生产链路已经正常。

## 10. 完成报告格式

每个阶段完成后按以下格式报告：

```markdown
## 阶段
P2：Sitemap 发现、解析与首次基线

## 已完成
- ...

## 关键实现
- ...

## 修改文件
- `path/to/file`

## 数据库变更
- Migration：...

## 验证结果
- lint：通过/失败
- typecheck：通过/失败
- test：通过/失败
- build：通过/失败

## 验收标准
- [x] ...
- [ ] ...

## 未完成或风险
- ...

## 下一阶段前置条件
- ...
```

必须如实报告失败、未验证项和外部配置缺口。

## 11. 禁止行为

- 不得将首次基线页面全部标记为新增；
- 不得因扫描失败误判大量页面消失；
- 不得把 `lastmod` 当作可靠发布时间；
- 不得把 AI 推测关键词当作真实排名数据；
- 不得保存完整 HTML 或 Sitemap 快照以图省事；
- 不得跳过 Migration；
- 不得通过关闭 TypeScript、ESLint 或测试来让构建通过；
- 不得把密钥硬编码进代码；
- 不得擅自加入注册、支付、邮件通知等非 MVP 功能；
- 不得在没有证据时宣称生产链路可用。

## 12. MVP 完成条件

仅当以下全部成立时，才可宣称 MVP 完成：

- P0–P7 验收项全部通过；
- 本地与生产 D1 Migration 已验证；
- 首次基线、增量、缺失、重新出现规则通过多轮测试；
- 新页面抓取成功且未保存完整 HTML；
- OpenRouter 生产配置实际验证；
- Cron 实际触发验证；
- Cloudflare Access 实际拦截未授权访问；
- CSV 导出与人工复核可用；
- lint、typecheck、test、build 通过；
- 仓库无敏感信息。
