---
name: shiyawase-review
description: Shiyawase 工作室的最后一道评审门检查清单 —— 组件库合规、通用金律 S0-S9、项目金律、文件行数预算、finding 输出格式。code-reviewer-agent 加载；人工 review PR 时也可加载。
---

<!-- studio-skill v1.0.0 · 正本：maverick1014/website:.claude/skills/shiyawase-review/SKILL.md · 请勿本地修改 -->

# 评审检查清单

> 正本：`maverick1014/website:.claude/skills/shiyawase-review/SKILL.md` · v1.0.0
> 规则本体：`docs/studio/GOLDEN_RULES_BASE.md`（通用）+ `docs/golden-rules/{backend,ui}.md`（本项目）

**只读 diff，不读印象。** 每条 finding 必须能指到 `文件:行号`。

## 1. 正确性 / 安全（最高优先级）

- [ ] **S2** 访问控制、租户隔离、角色判断在**服务端**拦了吗？UI 隐藏只是第二层。
- [ ] **S2** 有没有信任客户端传来的 scope 字段（`company_id` / `hall_id` / `owner_id` / `author_id`）？
- [ ] **S3** 每一个删除 / 移除 / 清空，都走了共享确认对话框并说清丢多少吗？
- [ ] **S5** 有没有密钥、token、明文密码进了仓库 / 客户端 bundle / 日志？
- [ ] 可选 join / 数组下标 有没有 guard（`x?.y ?? fallback`）？
- [ ] 时区 / 货币 / 税率 有没有走项目的统一函数，而不是就地算？

## 2. 组件库合规

- [ ] 新 UI 全部由该项目的共享组件构成吗？有现成组件却手搓 = finding，**点名该用哪个**。
- [ ] 颜色来自 token，不是写死的 hex？
- [ ] 间距 / 控件高度用了统一 token，不是 ad-hoc padding？

## 3. 层次与整洁

- [ ] **S4** 有没有重造一个已存在的机制？
- [ ] **S6** 这次改动造成的孤儿 import / 变量清干净了吗？（**既有死代码不要顺手删** —— 说一声就好）
- [ ] **S7** 每一行改动都能追溯到用户的要求吗？有没有「顺便改进」？
- [ ] 同一份数据被 map 了两遍吗（桌面表格 + 手机卡片各写一次逻辑）？

## 4. 行数预算（`docs/studio/REPO_STANDARD.md`）

```sh
wc -l CLAUDE.md docs/PROJECT_PROFILE.md .claude/agents/*.md .claude/skills/*/SKILL.md
```

- [ ] `CLAUDE.md` ≤ 80 · `PROJECT_PROFILE.md` ≤ 90 · 每个 agent ≤ 60 · 每个 skill ≤ 120
- [ ] 超了是**搬家**（→ `MASTER_PROMPT.md` / `golden-rules/` / skill），**不是删知识**（S9）
- [ ] `docs/studio/*` 的版本戳与大脑一致，且本地没被改过

## 5. 文档同步（S8）

- [ ] 改了规则 / 流程 / 口径，`CLAUDE.md`、`golden-rules/`、大脑正本跟上了吗？
- [ ] 用户可见的改名，止步于 API 边界了吗（没有顺手把 DB 列名一起改）？

---

## 输出格式

按严重度排序：**正确性/安全 > 功能完整性 > 整洁/层次**。

```
[S2] apps/web/src/app/api/[...path]/route.ts:412
  失败场景：hall 受限账号发一个带别人 hall_id 的请求，服务端直接采信，读到另一个堂会的名单。
  修法：改用 hallFilter = hallScope ?? q.get('hall_id')，session 的 hall 永远优先。
```

没有 finding 就明说没有。**最后一行必须是** `REVIEW: SIGNED OFF` 或 `REVIEW: CHANGES REQUESTED`。
