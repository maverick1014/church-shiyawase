<!-- studio-standard v1.0.0 · 正本：maverick1014/website:studio/standards/DELIVERY_WORKFLOW.md · 请勿本地修改 -->
# 交付流程 / Delivery Workflow

> **正本。** 产品仓库同步副本到 `docs/studio/DELIVERY_WORKFLOW.md`。
> 版本：`v1.0.0` · 源：`maverick1014/website:studio/standards/DELIVERY_WORKFLOW.md`
>
> 这是 **Part A：流程**，四个产品仓库完全一致。
> **Part B：项目特性**（栈、组件库、测试命令、部署目标）在各仓库 `docs/PROJECT_PROFILE.md`。

---

## 1. 编排铁律

**主对话（Orchestrator）自己不干活。** 它只做：spawn 正确的 agent、把上一个 agent 的**完整产出**
传给下一个、卡住签核门、跑 PR → 合并 → 验证部署 → 通知。

- 编排者不写功能代码、不写 schema、不写 UI、不写测试。
- 流程脚手架本身（写这份文档、建 agent 文件）算编排设置，不算「干活」。

## 2. 何时触发全流程

| 任务类型 | agent 链 |
|---|---|
| 新功能 / 可用性重做（UI + 逻辑） | `ba-agent` → `architecture-agent` → `ui-designer-agent` → `programmer-agent` → `tester-agent` → `code-reviewer-agent` |
| 新功能（纯逻辑，无 UI） | `ba-agent` → `architecture-agent` → `programmer-agent` → `tester-agent` → `code-reviewer-agent` |
| 视觉打磨 / 间距修正 | `ui-designer-agent` → `programmer-agent` → `tester-agent` → `code-reviewer-agent` |
| 已知根因的 bug | `bug-fix-agent` → `tester-agent` → `code-reviewer-agent` |
| 单文件、用户已给明确规格 | `programmer-agent` → `tester-agent` → `code-reviewer-agent` |
| 只验证 / 只测试 | `tester-agent` |
| 纯文档 / 纯配置（无源码改动） | 可跳过 tester，**必须在 PR 正文写一行说明为什么** |

触发全流程的词：「加」「改进」「重做」「简化」「更好用」「实现」「建」。

## 3. 编排规则

1. **顺序 spawn，完整交接。** 每个 agent 有独立上下文，记不住上一轮。把上一个 agent 的**完整输出**
   粘进下一个的 prompt —— 不要摘要。
2. **自包含 prompt。** 每次 `Agent` 调用必须含：用户原话、全部上游产出、目标文件路径、功能分支名。
3. **`programmer-agent` 之后一律 spawn `tester-agent`。** 一行的改动也不例外。唯一豁免见上表末行。
4. **信任但核实。** agent 的总结说的是它**打算**做什么。programmer 跑完，**先读真实 diff** 再交给 tester。
5. **独立步骤才并行。** 本流程里几乎没有 —— 只有 `ba-agent` 和纯视觉的 `ui-designer-agent` 算。

## 4. Tester → Programmer 回路

- `✅ ALL TESTS PASSED` → 进 `code-reviewer-agent`。
- `❌ FAILURES FOUND` → 拿 Bug Report spawn **全新的** `programmer-agent`（不要复用上一个的上下文），
  再重跑 `tester-agent`。
- **最多 3 轮。** 3 轮还红 → 停下，把剩余失败告诉用户，**不开 PR**。

## 5. PR / 合并 / 部署

tester 与 code-reviewer 都签核后：

1. push 功能分支：`git push -u origin <branch>`（失败按 2/4/8/16 秒退避重试）。
2. 开 PR（ready，非 draft），目标 `main`。PR 正文写清：改了什么、为什么、tester 报告摘要。
3. **快路径** —— tester 明确记录了 release build 成功且全绿 → 直接合并。
4. **慢路径** —— 每 2 分钟轮询 CI，最多 10 分钟。全绿 → 合并；有红 → 拿失败详情 spawn 一次
   `programmer-agent` 修复，push，重新等。**一次修复机会**，还红就停下报告用户。
5. 合并后**验证部署 workflow 跑成功**，再通知用户。

### 合并策略：merge commit（`SD-003`）

- 用 **merge commit**。**绝不 `--squash`，绝不 `--rebase`。** 阶段性 commit 就是 `main` 上的事实记录。
- 分支上如果有杂乱的 fixup commit，**问用户**要不要先整理，不要偷偷 squash 藏起来。
- 合并后把本地分支重置到最新 `main` 再长下一次改动：`git fetch origin main && git checkout -B <branch> origin/main`。

### 分支

- `claude/<feature>-<hash>`。**绝不直接 commit 到 `main`。**
- Commit 信息：`<type>(<scope>): <desc>` —— `feat | fix | refactor | docs | chore | test | perf`。

## 6. 版本 / 变更日志 / 状态

每次功能合并后，加载 skill `shiyawase-release`：bump 版本 → 写 `docs/versions/vX.Y.Z.md` →
追加 `CHANGELOG.md` → 更新 `docs/PROJECT_STATUS.md`。

## 7. 相关标准

- 该 spawn 谁：[`AGENT_ROSTER.md`](AGENT_ROSTER.md)
- 该加载哪个 skill：[`SKILL_CATALOG.md`](SKILL_CATALOG.md)
- 共通硬规矩：[`GOLDEN_RULES_BASE.md`](GOLDEN_RULES_BASE.md)
- 仓库该长什么样：[`REPO_STANDARD.md`](REPO_STANDARD.md)
