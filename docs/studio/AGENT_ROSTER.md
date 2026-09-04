<!-- studio-standard v1.0.0 · 正本：maverick1014/website:studio/standards/AGENT_ROSTER.md · 请勿本地修改 -->
# Agent 名单标准 / Agent Roster

> **正本。** 产品仓库同步副本到 `docs/studio/AGENT_ROSTER.md`。
> 版本：`v1.0.0` · 源：`maverick1014/website:studio/standards/AGENT_ROSTER.md`

一个角色一个名字，全工作室通用。以前同一个角色在三个仓库有三个名字（`feature-builder` /
`programmer-agent`、`playwright-tester` / `tester-agent`、`code-reviewer` / `code-reviewer-agent`），
换个仓库就 spawn 错人 —— `SD-002` 把它钉死了。

---

## 核心 7 人（每个产品仓库都必须有，名字一字不差）

| # | `subagent_type` | 角色 | 产出 | 签核语 |
|---|---|---|---|---|
| 1 | `ba-agent` | 需求与边界条件 | 需求文档：问题、用户故事、规则、edge case、不做什么 | `BA: SIGNED OFF` |
| 2 | `architecture-agent` | 后端 · schema · 迁移 | 后端设计 + 迁移；**拥有 `golden-rules/backend.md`** | `ARCHITECTURE: SIGNED OFF` |
| 3 | `ui-designer-agent` | 组件树规格（不写代码） | 精确到组件的布局规格；**拥有 `golden-rules/ui.md`** | `UI: SIGNED OFF` |
| 4 | `programmer-agent` | 实现 | 真实可跑的代码，本地静态检查通过，在功能分支上 commit（**从不 push**） | `PROGRAMMER: SIGNED OFF` |
| 5 | `tester-agent` | 验证 | 跑完测试金字塔，结构化 Test Report | `✅ ALL TESTS PASSED` / `❌ FAILURES FOUND` |
| 6 | `code-reviewer-agent` | 标准执行（最后一道门） | 组件库合规 + golden rules + 行数预算 | `REVIEW: SIGNED OFF` |
| 7 | `bug-fix-agent` | 只修 bug | 先写复现测试再最小化修复；之后必须过 tester + reviewer | `BUGFIX: SIGNED OFF` |

**统一后缀 `-agent`。** 没有例外。

## 可选扩展（按项目复杂度启用，不强制）

| `subagent_type` | 何时值得有 | 现在谁有 |
|---|---|---|
| `requirements-agent` | 需求量大到需要一个常驻登记册 + 澄清门 | work-shiyawase |
| `simulation-agent` | 需要长期 dogfooding，跑一个活的合成租户 | work-shiyawase |
| `ceo-agent` | **只在 `website` 仓库**（`SD-004`）—— CEO 管整个工作室，不是单个产品 | website |

产品仓库需要工作室级决策时，不要在本地复制一个 CEO：去 `website` 仓库 spawn `ceo-agent`。

## 不再是 agent 的（已降级为 skill）

| 原 agent | 现在是 | 为什么 |
|---|---|---|
| `playwright-tester` | skill `shiyawase-e2e` | 它是一套**可反复执行的流程**，不是一个需要独立判断的角色。`tester-agent` 需要时加载它。（`SD-005`） |
| `code-reviewer` 的检查清单部分 | skill `shiyawase-review` | 同上：清单是流程，判断才是角色。 |

见 [`SKILL_CATALOG.md`](SKILL_CATALOG.md)。

## Agent 文件怎么写（≤ 60 行）

```markdown
---
name: <标准名>
description: <一句话：做什么、什么时候 spawn>
tools: <最小必要集>
---

## 你的职责            （3–5 行，一件事）
## 每次必读            （文件清单，含 docs/studio/DELIVERY_WORKFLOW.md）
## 需要加载的 skill    （有就列，没有就删掉这节）
## 输入                （上游 agent 的完整产出）
## 产出格式            （固定骨架）
## 你不做什么          （边界，防越权）
## 结束时输出          （签核语，一字不差）
```

**流程不写进 agent 文件。** 「怎么开 PR、怎么发版、怎么跑 E2E」全在 skill 里 ——
写进 agent 就是每次 spawn 都付一遍长 prompt 的钱，而且四个仓库各自漂移。
