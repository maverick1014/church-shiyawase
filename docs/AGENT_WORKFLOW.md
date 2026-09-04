# TOG（主恩堂）— 流水线扩展 / Pipeline Extensions

> **Part A（通用流程）的正本是 [`docs/studio/DELIVERY_WORKFLOW.md`](studio/DELIVERY_WORKFLOW.md)** ——
> 编排铁律、何时触发全流程、tester 回路、PR / 合并 / 部署、分支与 commit 规范，全部以那份为准。
>
> 这份文件只讲 **TOG 特有的东西**。
>
> - Part B（栈 / 路径 / 命令 / 测试分层 / 部署）：[`docs/PROJECT_PROFILE.md`](PROJECT_PROFILE.md)
> - 领域知识：[`docs/MASTER_PROMPT.md`](MASTER_PROMPT.md) · 金律：[`docs/golden-rules/`](golden-rules)
> - 索引：[`CLAUDE.md`](../CLAUDE.md)

---

## 1. 这个仓库 2026-09 才进入本框架

在此之前 TOG 没有 agent 定义、没有流程文档、没有 CHANGELOG / STATUS / versions ——
全部规则（领域叙事 + 金律 G0–G9 + 测试说明，1327 行）挤在一个 `CLAUDE.md` 里。
标准化第一波把它拆开并补齐了缺的部分，**一个字都没删**。

## 2. Agent 阵容：核心 7 人，无可选扩展

`ba-agent` · `architecture-agent` · `ui-designer-agent` · `programmer-agent` ·
`tester-agent` · `code-reviewer-agent` · `bug-fix-agent`（标准名单见 `docs/studio/AGENT_ROSTER.md`）。

**没有 `requirements-agent` / `product-decision-agent` / `simulation-agent`。**
教会的需求来自教会本人的反馈，路径很短 —— 不需要一个模拟决策层。请求含糊时编排者
**直接问用户**（`AskUserQuestion`）。工作室级战略 → `maverick1014/website` 仓库的 `ceo-agent`。

## 3. 本仓库最要紧的两道门

### G0 —— 推之前必须本地验证过（`docs/golden-rules/backend.md`）

浏览器套件**不再自动跑**（`ui-e2e.yml` 只手动 dispatch），所以**挡在坏改动和教会的线上站点之间的，
只有推送的那个人**。每次推送前，在 `apps/web`：

```sh
npx tsc --noEmit && npm test && npm run build     # 永远要跑，无例外
npm run test:ui-e2e                                # 改了页面 / 组件 / route.ts 就要跑
```

最近三次跳过浏览器套件的后果：一个无认证端点丢了长度上限（往线上库写进一行 500 字符）、
一个还在驱动同一个 commit 已改掉的流程的测试、以及一套在第一个检查点就死了两天的测试。
**三个都能在三分钟内本地复现。**

### G2 —— 四个权限维度（`docs/golden-rules/backend.md`）

角色 / 堂会 / 模块开关 / `group_leader` 的组。**先在 `route.ts` 拦，再在 UI 隐藏。**
一个「点了只会返回 403」的按钮是 bug。`architecture-agent` 每次都要逐个回答这四条。

## 4. 部署

`deploy.yml` **只在 push 到 `main`（即合并）或手动 dispatch 时跑**，别无其他。
分支上迭代不是发布 —— 想让某个分支上线，明确 `workflow_dispatch`。
代价是共享 URL 跟着 `main` 走，改动合并前没法在线上看。

合并后**确认该 merge commit 的 `deploy.yml` run 是 `success`**（含部署后冒烟与 API E2E）再通知用户。

## 5. `keepalive.yml` 不能停

Supabase 项目约一周无数据库活动就会暂停，暂停后主机名解析不了、谁都登不进去 ——
2026-08-29 真的发生过一整天。这个 workflow 每三天打一次线上 `GET /api/church`，
同时是唯一的 uptime 检查。**它是缓解不是修复**（Supabase 说了算什么叫活动，
GitHub 也可能延迟或跳过定时任务）。真正的修复是不会暂停的套餐。
