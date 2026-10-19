# 数据保留验证记录

日期：2026-10-19。本机 Windows，Node 24.18.0、pnpm 10.13.1、Wrangler 4.111.0。基于 main `2c4633929b2ce5d8da98eb9cecb6680c7f528849`，分支 `feat/seven-day-data-retention`。

## 已执行

| 检查 | 结果 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | 通过，没有放宽类型配置 |
| `node node_modules/eslint/bin/eslint.js .` | 通过 |
| `node node_modules/vitest/vitest.mjs run --config vitest.config.ts` | 12 个文件、73 项通过（原有 39 项 + 保留测试 34 项） |
| `node node_modules/vite/bin/vite.js build` | 客户端及 SSR 构建通过，退出码 0 |
| `node scripts/test-retention-d1.js` | 实际本地 D1 / workerd 运行时通过，非 SQL 字符串 mock |
| `git diff --check` | 通过 |

以上直接调用的 Node 入口与 package.json 的 lint/typecheck/test/build 指向相同工具。测试使用 SQLite 内置模块、构造域名 `example.com` 和 Mock Provider/HTTP transport，没有调用真实竞品或 OpenRouter。

## 关键证据

- 固定 `now=2026-10-19T12:00:00.000Z` 得到 `cutoff=2026-10-12T12:00:00.000Z`。边界前 1ms 清理，边界和后 1ms 保留；未来/空值/异常时间保守处理。
- dry-run 执行器不允许任何写入，CLI 预览前后 SQLite 文件字节相同；远程预览通过 mock transport 断言只发送 SELECT / PRAGMA 查询。
- 备注、关注、人工关键词/次级关键词/类型/意图、复核状态、已查看均豁免页面重内容；预览后才加入的备注也保护。
- 9 种现有活动状态均阻止清理，包括排队/运行扫描、抓取、SEO、分析和 Sitemap 明细；在预览后、写入前启动任务也不会误清理。
- 清理后，实际 PagesRepository SQL 仍返回页面列表和 CSV；人工记录、Sitemap 关联及外键可用；实际扫描差异函数不将旧 URL 识别为新增。
- 过期内容不进入 AI 输入。失败抓取不恢复过期正文，成功抓取才刷新正文时间并清除过期标记；新分析状态优先于过期存根。
- `batchSize=1,maxBatches=1` 限制生效，续跑后重跑零变更。
- SQLite backup 副本恢复后正文和外键完整；这仅验证本地构造数据备份，不代表生产恢复已验证。
- 独立 D1 runtime smoke test 应用了全部 3 个迁移。7 类动作各处理 1 条候选；人工页面和边界页面未清理；3 条 discovered 标记保留，`PRAGMA foreign_key_check` 为空，再次执行所有动作计数为 0。

## 环境问题与处理

- Git 的本地代理不可连接，命令级绕过后只读核实 main 并克隆到任务目录，没有修改全局代理。
- 官方 npm 源下载锁定 Windows workerd 包持续挂起；最终通过一次性 npm 镜像参数取得同一包，由 pnpm 按锁文件校验，未变更 runtime 依赖版本或全局 registry。新增开发依赖仅 `@types/node`（及其类型依赖），Node 最低版本明确为 22.18。
- 沙箱默认临时目录重命名失败：测试进程的 TEMP/TMP 改为任务内 `.retention-test/tmp`。Wrangler 日志/registry 也重定向至任务内目录，没有修改系统设置。
- 本地 D1 模拟器的 `127.0.0.1` 连接被沙箱权限限制，随后在自动审批允许的本机权限下完成该隔离测试；不是换用其他电脑或远程运行。
- 最终构建仍提示缺少 `OPENROUTER_API_KEY`，符合本轮不配置 Secrets、不调用真实 AI 的范围。构建成功不代表生产 OpenRouter、Cron 或 Access 已验证。

可在受限 Windows 环境复现的进程级设置：

```powershell
New-Item -ItemType Directory -Force .retention-test/tmp, .retention-test/registry | Out-Null
$env:TEMP = (Resolve-Path .retention-test/tmp).Path
$env:TMP = $env:TEMP
$env:WRANGLER_LOG_PATH = (Resolve-Path .retention-test).Path
$env:WRANGLER_REGISTRY_PATH = (Resolve-Path .retention-test/registry).Path
$env:WRANGLER_SEND_METRICS = 'false'
```

## 未执行与生产启用前置条件

没有 push、PR、部署、合并或修改 main；没有生产 D1 读取/写入/清理、Secrets/Access 修改、通知或日报启用。Cron 配置和扫描编排未改动。

真实远程 D1 API 执行、生产迁移、导出、Time Travel、生产恢复尚未验证；未来启用前必须单独审核、授权并在备份后验证。当前无未解决的本地开发工具阻塞。操作与回退限制见 [DATA_RETENTION.md](DATA_RETENTION.md)。
