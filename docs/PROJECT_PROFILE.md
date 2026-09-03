# Project Profile — TOG（主恩堂）

> **Part B。** Part A（通用交付流程）在 `docs/studio/DELIVERY_WORKFLOW.md`（工作室正本）；
> 本仓库的流水线扩展在 `docs/AGENT_WORKFLOW.md`；领域知识在 `docs/MASTER_PROMPT.md`。
> 这份文件只放栈 / 路径 / 命令 / 部署 / 测试分层。

## Identity

- **TOG · 主恩堂（Tabernacle of Grace）** —— 教会管理应用：人、聚会、奉献、培训、门训。
  标志性功能是**四十天一对一守望**与**幸福小组**。
- **界面三语**：English / 简体中文（默认）/ Bahasa Melayu，按登录账号选择。**仅浅色主题，移动优先。**
- **版本源：** `package.json` `version`。

## Stack

| Concern | Choice |
|---|---|
| 前端 | **Next.js 15**（App Router）+ **React 19**，`apps/web/` |
| API | **单一 catch-all route handler**：`apps/web/src/app/api/[...path]/route.ts` |
| 认证 | 签名 HMAC cookie（`apps/web/src/lib/server/auth.ts`），密码 PBKDF2 |
| DB | **Supabase** Postgres，迁移在 `supabase/migrations/NNNN_*.sql` |
| i18n | `apps/web/src/lib/i18n/{en,zh,ms}.ts` —— `en` 是类型基准与回退 |
| 共享包 | `packages/shared`（`OPTIONAL_MODULES`、`THEME_PRESETS`、`ChurchRole`、`isMemberRole` 等） |
| 部署 | **OpenNext → Wrangler → Cloudflare Workers**，Worker 名 **`tog`** |
| 存储桶 | `avatars` · `branding` · `payments` · `photos` |

## 部署与定时任务

| Workflow | 何时跑 |
|---|---|
| `deploy.yml` | **push 到 `main`（即合并）** 或手动 dispatch，**仅此两种**。分支上迭代不是发布 —— 想让某个分支上线，明确 `workflow_dispatch`。门是单元测试 + 部署后冒烟 + API E2E。 |
| `e2e.yml` | API 端到端，打线上 Worker |
| `ui-e2e.yml` | **仅手动 dispatch** —— 每次自动跑要拉 ~300MB Chromium 去重复笔记本就能做的检查 |
| `keepalive.yml` | 每三天中午（马来西亚时间）请求线上 `GET /api/church`。**Supabase 项目约一周无数据库活动就会暂停**，暂停后主机名解析不了、谁都登不进去 —— 2026-08-29 真的发生过一整天。它同时是唯一的 uptime 检查。**这是缓解不是修复**：真正的修复是不会暂停的套餐。 |

## 命令（在 `apps/web`）

```sh
npx tsc --noEmit && npm test && npm run build     # 每次推送前，无例外（金律 G0）
npm run test:api-e2e                              # API 端到端，打线上 Worker
npm run test:ui-e2e                               # 浏览器端到端 —— 改了页面 / 组件 / route.ts 就要跑
npm run ui:shots                                  # 截图巡检，本地看版式用（CI 不跑、不收集）
```

沙箱里跑浏览器套件：

```sh
NODE_USE_ENV_PROXY=1 \
  PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  UI_E2E_PASSWORD=… npm run test:ui-e2e
```

## 测试分层（在 `apps/web`）

| 层 | 命令 | 打什么 | 什么时候必须跑 |
|---|---|---|---|
| 单元（Vitest） | `npm test` | 标签 / 规则 / 权限 / 三语字典 / 主题目录与颜色校验 / 名字显示规则 / 角色漂移守卫 / 导入计划器 | **每次推送前** |
| API E2E | `npm run test:api-e2e` | 线上 Worker：认证、角色矩阵、完整 CRUD、公开表单、导入、group_leader 账号全生命周期 | 部署门的一部分 |
| 浏览器 E2E | `npm run test:ui-e2e` | 真实 Chromium 驱动线上站点 | **改了页面 / 组件 / `route.ts` 就要跑**（金律 G0） |
| 截图巡检 | `npm run ui:shots` | 手机 + 桌面视口截图到 `$OUT` | 本地看版式用；CI 不跑、不收集 |

**每一层具体断言了什么、fixture 怎么清、构建戳守卫怎么用 —— 见 skill `church-testing`。**
两个 e2e 脚本收尾都会按 fixture 前缀（`ZZ_UITEST_` / `E2E`）扫全库删干净，
**残留 = 失败**，不管断言说什么。
## Key paths

| Concern | Path |
|---|---|
| 索引 → 流程 → 领域知识 | `CLAUDE.md` → `docs/studio/DELIVERY_WORKFLOW.md` → `docs/MASTER_PROMPT.md` |
| 金律 | `docs/golden-rules/{backend,ui}.md` + `docs/studio/GOLDEN_RULES_BASE.md` |
| Agent / Skill | `.claude/agents/` · `.claude/skills/` |
| API（唯一入口） | `apps/web/src/app/api/[...path]/route.ts` |
| 共享组件 | `apps/web/src/components/`（`ui.tsx`、`MemberName`、`MemberEditModal`、`Combobox`、`SheetTick*`…） |
| 名字 / 标签 / 时间 / 表格的规则 | `apps/web/src/lib/{names,labels,time,sheet,dashboard,members-import}.ts` |
| i18n 字典 | `apps/web/src/lib/i18n/{en,zh,ms}.ts` |
| 迁移 | `supabase/migrations/` |
| 浏览器 E2E | `apps/web/scripts/ui-e2e.mjs` · API E2E `apps/web/scripts/api-e2e.mjs` |
| 状态 / 变更日志 / 版本 | `docs/PROJECT_STATUS.md`、`CHANGELOG.md`、`docs/versions/` |
| 需求原始文档 | `docs/PROJECT_BRIEF.md`、`docs/REQUIREMENTS.md`、`docs/需求规格说明书.md`、`docs/prototype.html` |

## 部署验证

合并进 `main` 后，确认该 merge commit 的 `deploy.yml` run 是 `success`（含部署后冒烟与 API E2E）
再通知用户。Worker 名 **`tog`**。
