---
name: shiyawase-supabase
description: Shiyawase 工作室四个产品共用的 Supabase 规范 —— 迁移文件命名与顺序、apply_migration 与 execute_sql 的分工、RLS 与多租户模式、edge function 部署与冒烟测试。architecture-agent 或 programmer-agent 要改 schema、写迁移或动 edge function 时加载。
---

<!-- studio-skill v1.0.0 · 正本：maverick1014/website:.claude/skills/shiyawase-supabase/SKILL.md · 请勿本地修改 -->

# Supabase 规范

> 正本：`maverick1014/website:.claude/skills/shiyawase-supabase/SKILL.md` · v1.0.0
> 各项目的表前缀和租户列在自己的 `docs/golden-rules/backend.md`。

## 1. DDL vs 数据

| 要做的事 | 用什么 | 要不要 PR |
|---|---|---|
| 建表 / 加列 / 改约束 / 加索引 | `apply_migration` **并且**写 `supabase/migrations/NNNN_*.sql` | 要 |
| 改数据（重新归类、修一行、灌 seed） | `execute_sql` | 不要，即时生效 |

**迁移文件和实际执行必须成对。** 只 apply 不写文件 = 下一个人重建环境时缺一块；
只写文件不 apply = 线上没生效而没人发现。

## 2. 迁移命名

`NNNN_<动词>_<对象>.sql`，四位序号**全局递增不重用**：`0031_add_best_role.sql`。

- 一个迁移做一件事。
- **Postgres 拒绝在加了 enum 值的同一个事务里使用它** —— 加值和用值必须拆成两个迁移。
- 迁移必须可重放：用 `if not exists` / `if exists`，不要假设当前状态。
- 破坏性迁移（drop column / drop table）单独一个迁移，PR 正文里明确点名。

## 3. 多租户与 RLS

- 每个业务表都带租户列（work: `company_id`；church: `hall_id`；home: `owner_id`），
  **NOT NULL**，并建索引。
- **RLS 是权限门，不是过滤器。** 服务端**永远不信**客户端传来的租户 id：
  `scope = session.scope ?? request.scope` —— **session 的永远优先**。这条优先级本身就是安全属性。
- 表前缀按项目走（work 只能碰 `hrms_`，home 只能碰 `racc_`）—— **绝不碰别的项目的表**。

## 4. 列的语义要单一

一个列只回答一个问题。踩过的坑：把「谁看得见」（可见性）和「这是谁的钱」（归属）
挤进同一个列，结果把自己的钱包分享给伴侣看，就把自己的钱悄悄记成了家庭的。

新列如果读起来像既有列，**在迁移注释里写清两者的区别**。

## 5. Edge Function

- 部署**独立于 git** —— **commit 不会自动部署**。改完必须 `deploy_edge_function`。
- 部署前自查括号平衡；部署后 `curl` 冒烟（造临时数据测，测完删掉）。
- `verify_jwt: false` 的函数必须**自己在服务端校验** —— 用 `supabase.auth.getUser(token)` 解出
  已验证身份，**绝不信任 body 里的 `author_id` / `user_id`**。
- 函数文件要 commit 入库，保持仓库与线上一致。

## 6. 每次改完的自查

- [ ] 迁移文件写了，并且真的 apply 了
- [ ] 新表 / 新列有租户列 + RLS + 索引
- [ ] 加了 enum 值的话，用它的语句在**另一个**迁移里
- [ ] 改了 AI 能读写的数据形状 → 同步 edge function 的提示 / 工具 / 上下文**并重新部署**
- [ ] 密钥全在 Vault / secret，代码里一个都没有
