# 页面正文摘要存储策略

## 当前决策

`page_seo_data.content_excerpt` 保留，用于 OpenRouter 页面分析、后台人工复核和后续重新分析。

新抓取页面的正文摘要统一限制为最多 8,000 个字符。抓取过程会先清理脚本、样式、模板、页头、导航和页脚，再截取可见文本。项目不保存完整 HTML，也不保存正文历史快照。

## `content_hash` 兼容策略

`page_seo_data.content_hash` 列暂时保留，以避免对现有 Cloudflare D1 数据库执行删列或重建表迁移。

MVP 当前不再：

- 根据页面正文摘要计算 `content_hash`；
- 在抓取成功时写入或更新 `page_seo_data.content_hash`；
- 使用该字段判断页面正文变化。

历史记录中的旧值可以继续保留。后续如果新增正文变化监控，应重新设计为对完整清洗正文计算哈希，而不是对截断摘要计算哈希。

## 数据处理链路

```text
抓取 HTML
→ 清理不可见内容和页面公共区域
→ 截取前 8,000 个字符
→ 保存 content_excerpt
→ OpenRouter 调用前再次防御性截断至 8,000 个字符
```

## 数据库影响

本次不新增 migration，不修改 `page_seo_data` 表结构，不自动清理远程 D1 数据。

现有超过 8,000 字符的旧记录可以在后续重新抓取时自然覆盖。如需提前清理，可人工执行：

```sql
UPDATE page_seo_data
SET content_excerpt = substr(content_excerpt, 1, 8000)
WHERE content_excerpt IS NOT NULL
  AND length(content_excerpt) > 8000;
```

该 SQL 不应自动加入部署或启动流程。
