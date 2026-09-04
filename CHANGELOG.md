# Changelog — TOG（主恩堂）

倒序，最新在最上。发版流程见 skill `shiyawase-release`。

> **本文件从 2026-09 开始记。** 在此之前 TOG 不在工作室交付框架内，没有 CHANGELOG ——
> 那段历史在 git log 与已合并的 PR 里（截至标准化时最后一条是 #45「Keep the database awake」）。
> **没有回填**：凭 commit 标题重构一份变更日志会造出一份看起来权威、实际靠猜的记录。

## [Unreleased]

### docs
- 把仓库对齐到 Shiyawase Studio 标准：`CLAUDE.md` 1327 行拆成索引 + `docs/MASTER_PROMPT.md`
  + `docs/golden-rules/{backend,ui}.md` + `docs/PROJECT_PROFILE.md`（内容一字未删）；
  补上此前完全没有的 `.claude/agents/`（核心 7 人）、`docs/AGENT_WORKFLOW.md`、
  `CHANGELOG.md`、`docs/PROJECT_STATUS.md`、`docs/versions/`；
  从工作室大脑同步 `docs/studio/*` 与共通 skill。
