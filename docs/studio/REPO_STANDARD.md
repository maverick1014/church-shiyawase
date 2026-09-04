<!-- studio-standard v1.0.0 · 正本：maverick1014/website:studio/standards/REPO_STANDARD.md · 请勿本地修改 -->
# 仓库标准布局 / Repo Standard

> **正本。** 产品仓库同步副本到 `docs/studio/REPO_STANDARD.md`，不在本地改。
> 版本：`v1.0.0` · 源：`maverick1014/website:studio/standards/REPO_STANDARD.md`

每个 Shiyawase 产品仓库必须长成同一个样子。目的不是整齐，是**任何一个 agent 走进任何一个仓库，
都知道去哪里读、写哪里、上限多少行**。

---

## 1. 必备文件

```
<repo>/
  CLAUDE.md                        ≤ 80 行 · 索引，不是手册
  README.md                        给人看的：这是什么、怎么跑起来
  CHANGELOG.md                     每次发版追加
  docs/
    PROJECT_PROFILE.md             ≤ 90 行 · 栈 / 路径 / 命令 / 部署
    PROJECT_STATUS.md              活的当前状态
    MASTER_PROMPT.md               领域叙事、长文都放这里（无行数上限）
    golden-rules/
      backend.md                   编号规则，评审可引用
      ui.md                        编号规则，评审可引用
    versions/vX.Y.Z.md             每个版本一份发版记录
    studio/                        ← 从大脑同步来的副本，本地只读
      REPO_STANDARD.md
      DELIVERY_WORKFLOW.md
      AGENT_ROSTER.md
      GOLDEN_RULES_BASE.md
  .claude/
    agents/*.md                    每个 ≤ 60 行
    skills/<name>/SKILL.md         从大脑同步的共通 skill + 本仓库特有 skill
```

## 2. 行数预算（硬上限，评审会查）

| 文件 | 上限 | 装什么 | 不装什么 |
|---|---|---|---|
| `CLAUDE.md` | **80 行** | 这是什么产品、去哪找东西、≤3 条硬规矩、agent 名单表 | 领域叙事、流程步骤、编号规则 |
| `docs/PROJECT_PROFILE.md` | **90 行** | 栈表、关键路径表、命令、部署与验证 | 为什么这样设计 |
| `.claude/agents/*.md` | **60 行** | 职责、必读、输入、产出、签核语 | 流程步骤（→ skill）、领域知识（→ MASTER_PROMPT） |
| `.claude/skills/*/SKILL.md` | **120 行** | 一个可反复执行的流程 | 只用一次的东西 |
| `docs/MASTER_PROMPT.md` | 无 | 领域叙事、口径、历史踩坑记录 | — |

**超预算怎么办：不是删知识，是搬家。** 叙事搬 `MASTER_PROMPT.md`，规则搬 `golden-rules/`，
步骤搬 skill。删掉来之不易的领域知识是本标准最不能接受的违规。

## 3. CLAUDE.md 的固定骨架

```markdown
# <产品名> — Claude 指令

> 流程见 `docs/studio/DELIVERY_WORKFLOW.md`（工作室标准，正本在 website 仓库）。
> 本仓库特有的一切在 `docs/PROJECT_PROFILE.md` 与 `docs/MASTER_PROMPT.md`。

## 这是什么          （3–6 行）
## 三条硬规矩        （本产品最容易踩、踩了就出事的，最多 3 条）
## 命令              （dev / test / build / deploy）
## 去哪找            （表格：想找 X → 路径 Y）
## Agent 与 Skill    （表格：角色 → 文件；何时触发全流程）
```

## 4. 同步机制

标准文件正本只在 `website:studio/standards/`。产品仓库的副本**首行必须带版本戳**：

```markdown
<!-- studio-standard v1.0.0 · 正本：maverick1014/website:studio/standards/<file> · 请勿本地修改 -->
```

- 要改标准 → 改 website 仓库的正本，bump 版本，再把副本同步进 4 个产品仓（各一个 PR）。
- 产品仓库发现标准不适用自己 → **不要本地改**，在 `STUDIO_MEMORY.md` 记一条例外，或改正本。
- 版本戳对不上 = 合规检查失败，见 [`../COMPLIANCE.md`](../COMPLIANCE.md)。

## 5. 合规检查（每次改动前自查）

- [ ] `CLAUDE.md` ≤ 80 行且是索引，不是手册
- [ ] 每个 agent 文件 ≤ 60 行，名字在 [`AGENT_ROSTER.md`](AGENT_ROSTER.md) 的标准名单里
- [ ] `docs/studio/*` 版本戳与大脑一致，且本地无改动
- [ ] 分支是 `claude/<feature>-<hash>`，不在 `main` 上
- [ ] 合并用 merge commit，不 squash
