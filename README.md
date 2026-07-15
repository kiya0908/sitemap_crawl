# Sitemap Crawl

一个仅供个人使用的竞品 Sitemap 增量监控与新增页面 SEO 分析后台。

系统定期读取 3–5 个竞品网站的 Sitemap，对比历史 URL，识别新出现、消失和重新出现的页面；随后抓取新增页面的基础 SEO 信息，并通过 OpenRouter 推测页面类型、核心主题、目标关键词和搜索意图。

## 项目目标

- 每天自动扫描竞品 Sitemap，也支持手动立即扫描。
- 第一次扫描只建立 URL 基线，不把存量页面计为新增。
- 从第二次扫描开始识别真正新增的 URL。
- 只抓取新增页面的 SEO 信息，避免重复请求和数据库膨胀。
- 使用 OpenRouter 对新增页面进行结构化 SEO 分析。
- 通过私有管理后台查看、筛选、复核和导出结果。
- 使用 Cloudflare Access 限制后台访问，不在应用内开发用户系统。

## 预期规模

- 竞品数量：3–5 个。
- 单个竞品：不超过 1,000 个 URL。
- 总监控页面：预计不超过 5,000 个。
- 默认扫描频率：每天一次。
- 默认业务时区：Asia/Tokyo。

## 推荐技术方案

- 前端与服务端：TanStack Start + React + TypeScript。
- 部署与运行时：Cloudflare Workers。
- 数据库：Cloudflare D1。
- 定时任务：Cloudflare Cron Triggers。
- AI 分析：OpenRouter，使用可替换 Provider 封装。
- 后台访问保护：Cloudflare Access。

## 文档

- [产品需求文档](docs/PRD.md)
- [数据模型与 ERD](docs/ERD.md)
- [技术架构](docs/TECHNICAL_ARCHITECTURE.md)
- [分阶段实施计划](docs/IMPLEMENTATION_PLAN.md)
- [Codex 开发说明](AGENTS.md)

## MVP 范围

MVP 包含竞品管理、Sitemap 管理、首次基线扫描、增量 URL 对比、新页面抓取、OpenRouter 结构化分析、扫描记录、页面筛选、人工复核、备注和 CSV 导出。

MVP 不包含公开注册登录、支付、邮件通知、排名追踪、Ahrefs/Semrush API、完整 HTML/Sitemap 快照、内容改动监控和自动生成文章。

## 安全说明

仓库为公开仓库。任何 API Key、D1 标识、Cloudflare Access 配置和其他敏感值都必须通过环境变量或 Cloudflare Secrets 管理，不得提交到 Git。
