<!-- studio-standard v1.0.0 · 正本：maverick1014/website:studio/standards/SKILL_CATALOG.md · 请勿本地修改 -->
# Skill 目录 / Skill Catalog

> **正本。** skill 本体在 `website/.claude/skills/`，产品仓库同步副本到自己的 `.claude/skills/`。
> 版本：`v1.0.0` · 源：`maverick1014/website:studio/standards/SKILL_CATALOG.md`

---

## 什么该是 skill，什么不该

| | 该是 **skill** | 该是 **agent** | 该是 **文档** |
|---|---|---|---|
| 本质 | 可反复执行的**流程** | 需要独立判断的**角色** | 需要被查阅的**知识** |
| 例子 | 怎么开 PR、怎么发版、怎么跑 E2E | 要不要这样设计、这个 bug 该怎么修 | 为什么账户的 who 不能用 share_mode 算 |
| 加载时机 | 用到才加载 | spawn 时 | 需要时读 |
| 放哪 | `.claude/skills/<name>/SKILL.md` | `.claude/agents/<name>.md` | `docs/MASTER_PROMPT.md` / `docs/golden-rules/` |

**判据：一段内容如果每次 spawn 都被塞进 prompt、但十次里有九次用不上 —— 它就该是 skill。**
这是把 agent 文件压到 60 行、CLAUDE.md 压到 80 行的唯一办法。

---

## 分类

### A · 交付类（Delivery）—— 改动怎么落地

| Skill | 干什么 | 谁加载 |
|---|---|---|
| `shiyawase-delivery` | 分支命名 → commit 规范 → push 重试 → 开 PR → 等 CI → merge commit 合并 → 验证部署 | Orchestrator |
| `shiyawase-release` | bump 版本 → 写 `docs/versions/vX.Y.Z.md` → 追加 `CHANGELOG.md` → 更新 `PROJECT_STATUS.md` | Orchestrator |

### B · 质量类（Quality）—— 改动怎么被证明是对的

| Skill | 干什么 | 谁加载 |
|---|---|---|
| `shiyawase-e2e` | 浏览器端到端测试：选择器策略、fixture 命名与自清理、沙箱下的 Chromium 与代理、对抗性断言 | `tester-agent` |
| `shiyawase-review` | 最后一道门的检查清单：组件库合规、golden rules、行数预算、金律引用格式 | `code-reviewer-agent` |

### C · 平台类（Platform）—— 四个产品共用的底层

| Skill | 干什么 | 谁加载 |
|---|---|---|
| `shiyawase-supabase` | 迁移文件命名与顺序、RLS 模式、`apply_migration` vs `execute_sql` 的分工、edge function 部署与冒烟 | `architecture-agent` / `programmer-agent` |

---

## 命名规则

- 工作室共通 skill 一律 `shiyawase-` 前缀 —— 一眼看出是同步来的，不是本仓库发明的。
- 产品特有 skill 用产品前缀：`homeblessed-persona-sync`、`church-i18n-dict`。
- **前缀不对 = 来源不明 = 合规检查失败。**

## 同步

共通 skill 的正本只在 `website/.claude/skills/`。副本首行带版本戳：

```markdown
<!-- studio-skill v1.0.0 · 正本：maverick1014/website:.claude/skills/<name>/SKILL.md · 请勿本地修改 -->
```

要改 → 改正本 → bump → 同步进 4 个产品仓。产品仓库需要本地差异 → 另开一个产品前缀的 skill，
不要改共通的那份。
