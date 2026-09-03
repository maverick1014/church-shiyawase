# TOG（主恩堂）— Claude 指令

> 交付流程见 [`docs/studio/DELIVERY_WORKFLOW.md`](docs/studio/DELIVERY_WORKFLOW.md)（工作室标准，正本在 `maverick1014/website`）。
> 本仓库的流水线扩展在 [`docs/AGENT_WORKFLOW.md`](docs/AGENT_WORKFLOW.md)。
> **领域知识全部在 [`docs/MASTER_PROMPT.md`](docs/MASTER_PROMPT.md)** —— 身份模型、点名表、
> 幸福小组、四十天守望、导入与公开表单、每一条口径背后的理由。金律在 [`docs/golden-rules/`](docs/golden-rules)。

## 这是什么

**教会管理应用**：人、聚会、奉献、培训、门训，外加**四十天一对一守望**与**幸福小组**。
Next.js 15（App Router）+ React 19 + Supabase，经 OpenNext 部署到 Cloudflare Worker `tog`。
API 是**唯一一个** catch-all route handler：`apps/web/src/app/api/[...path]/route.ts`；
认证是签名 HMAC cookie（`lib/server/auth.ts`）。

界面三语（English / 简体中文（默认）/ Bahasa Melayu，按账号选）；**仅浅色主题；移动优先。**

## 三条硬规矩

1. **G0 —— 推之前必须本地验证过。** 浏览器套件不再自动跑，挡在坏改动和教会线上站点之间的
   只有你。在 `apps/web`：`npx tsc --noEmit && npm test && npm run build`，**永远要跑**；
   改了页面 / 组件 / `route.ts` 再加 `npm run test:ui-e2e`。
2. **G2 —— 权限先服务端，UI 只是反映。** 四个维度：角色 / 堂会 / 模块开关 / `group_leader` 的组。
   **session 的 scope 永远压过请求里的** —— 这条优先级本身就是安全属性。
   一个「点了只会返回 403」的按钮是 bug。
3. **G8 —— 组件里零字面文案。** 每一句用户可见的话走 `useT()` + 一个**三份字典都有**的 key。
   `lib/labels.ts` 返回 **key** 不是翻译好的字符串；调色板 / 筛选值 / 排序**绝不许用翻译过的标签当 key**。

## 命令（在 `apps/web`）

```sh
npx tsc --noEmit && npm test && npm run build     # 每次推送前，无例外
npm run test:api-e2e                              # API 端到端，打线上 Worker
npm run test:ui-e2e                               # 浏览器端到端 —— 见 skill church-testing
```

## 去哪找

| 想找 | 路径 |
|---|---|
| 工作室标准（流程 / 名单 / 金律 / skill 目录） | `docs/studio/` |
| 领域知识（口径 + 为什么） | `docs/MASTER_PROMPT.md` |
| 金律 G0–G9 | `docs/golden-rules/backend.md`（G0/G2/G6/G6a）· `ui.md`（G1/G3/G4/G5/G7/G7a/G8/G9） |
| 栈 / 路径 / 命令 / 测试分层 / 部署 | `docs/PROJECT_PROFILE.md` |
| 本仓库流水线扩展 | `docs/AGENT_WORKFLOW.md` |
| API（唯一入口） | `apps/web/src/app/api/[...path]/route.ts` |
| 共享组件 | `apps/web/src/components/` |
| 名字 / 标签 / 时间 / 表格 / 导入 的规则 | `apps/web/src/lib/{names,labels,time,sheet,dashboard,members-import}.ts` |
| 三语字典 | `apps/web/src/lib/i18n/{en,zh,ms}.ts` |
| 迁移 | `supabase/migrations/` · E2E `apps/web/scripts/{ui,api}-e2e.mjs` |
| 状态 / 变更日志 / 版本 | `docs/PROJECT_STATUS.md`、`CHANGELOG.md`、`docs/versions/` |
| 需求原始文档 | `docs/PROJECT_BRIEF.md`、`docs/REQUIREMENTS.md`、`docs/需求规格说明书.md` |

## Agent

标准名单见 `docs/studio/AGENT_ROSTER.md`。本仓库启用**核心 7 人**，无可选扩展：

`ba-agent` → `architecture-agent` → `ui-designer-agent` → `programmer-agent` →
`tester-agent` → `code-reviewer-agent`；bug 走 `bug-fix-agent` → tester → reviewer。

工作室级战略 / 新点子去 `maverick1014/website` 仓库 spawn `ceo-agent`。

## Skill

`church-testing`（本仓库特有：三层覆盖面、浏览器套件怎么跑、语言 pin、构建戳守卫、fixture 清扫）
+ 工作室通用五件套 `shiyawase-delivery` / `-release` / `-e2e` / `-review` / `-supabase`。
目录见 `docs/studio/SKILL_CATALOG.md`。
