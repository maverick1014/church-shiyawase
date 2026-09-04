---
name: shiyawase-delivery
description: Shiyawase 工作室的改动落地流程 —— 分支命名、commit 规范、push 重试、开 PR、等 CI、merge commit 合并、验证部署。任何 Shiyawase 仓库（work/home/event/church/website）要提交改动、开 PR、合并或发布时加载。
---

<!-- studio-skill v1.0.0 · 正本：maverick1014/website:.claude/skills/shiyawase-delivery/SKILL.md · 请勿本地修改 -->

# 交付流程

> 正本：`maverick1014/website:.claude/skills/shiyawase-delivery/SKILL.md` · v1.0.0
> 完整流程说明见 `docs/studio/DELIVERY_WORKFLOW.md`。这里是可执行步骤。

## 1. 开分支

```sh
git fetch origin main
git checkout -B claude/<feature>-<hash> origin/main
```

`<feature>` 是短横线连接的英文短语，`<hash>` 是 6 位随机串。**绝不在 `main` 上 commit。**

## 2. Commit

```
<type>(<scope>): <描述>
```

`type` ∈ `feat | fix | refactor | docs | chore | test | perf`。描述用祈使句，不加句号。

一个逻辑步骤一个 commit —— 合并用 merge commit，这些 commit 会成为 `main` 上的事实记录。

## 3. 推之前的硬门（S0）

跑该仓库 `docs/PROJECT_PROFILE.md` 「测试」一节列出的**全部**命令，并读输出：

| 仓库 | 最低门 |
|---|---|
| work-shiyawase | `npm run typecheck && npm run build` |
| home-shiyawase | `cd flutter_app && flutter analyze && flutter test`（analyze 必须 0 issue，含 info 级）+ `npm test` |
| event-shiyawase | `flutter analyze && flutter test && flutter build web --release` |
| church-shiyawase | `cd apps/web && npx tsc --noEmit && npm test && npm run build` |
| website | 无构建；改了 CSS 记得 bump `site.css?v=YYYYMMDD` |

## 4. Push

```sh
git push -u origin <branch>
```

失败**只在网络错误时**重试，退避 2s → 4s → 8s → 16s，最多 4 次。

## 5. 开 PR

- 目标 `main`，**ready，不是 draft**。
- 先找仓库里的 PR 模板（`.github/pull_request_template.md` 等），有就照它的小节填。
- 正文写：改了什么、为什么、tester 报告摘要、CEO/用户做过的决定（作为异步否决面）。
- 已推的分支如果还没有 open PR，**一定要开**（已合并/已关闭的不算）。

## 6. 等 CI 并合并

- **快路径** —— tester 明确记录了 release build 成功且全绿 → 直接合并。
- **慢路径** —— 每 2 分钟查一次，最多 10 分钟。
  - 全绿 → 合并。
  - 有红 → 读失败详情，spawn **一次** `programmer-agent` 修复 → push → 重新等。
  - 一次修复后还红 → **停下报告用户**，不要继续试。

**合并方式：merge commit。绝不 `--squash`，绝不 `--rebase`。**（`SD-003`）
分支上有杂乱 fixup commit → **问用户**要不要先整理，不要偷偷 squash 藏起来。

## 7. 合并后

1. **验证部署 workflow 跑成功**，再通知用户。没验证过不算完成。
2. 加载 skill `shiyawase-release` 更新版本 / CHANGELOG / STATUS。
3. 把分支重置到最新 `main`：`git fetch origin main && git checkout -B <branch> origin/main`。

## 8. PR 已被合并后又有新工作

已合并的 PR 是完结的，**不能再往上堆 commit**。从最新 `main` 重开同名分支，
新工作推上去开**新的** PR。
