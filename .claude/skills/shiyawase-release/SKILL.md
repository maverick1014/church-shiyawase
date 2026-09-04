---
name: shiyawase-release
description: Shiyawase 工作室的发版流程 —— bump 版本号、写 docs/versions/vX.Y.Z.md、追加 CHANGELOG.md、更新 docs/PROJECT_STATUS.md。功能合并进 main 之后加载；要出 Android APK 时也加载（额外步骤见文末）。
---

<!-- studio-skill v1.0.0 · 正本：maverick1014/website:.claude/skills/shiyawase-release/SKILL.md · 请勿本地修改 -->

# 发版 / 版本记录

> 正本：`maverick1014/website:.claude/skills/shiyawase-release/SKILL.md` · v1.0.0

功能合并进 `main` 之后**每次**都做这四步。跳过就等于状态文档开始说谎。

## 1. Bump 版本

| 仓库 | 版本源 |
|---|---|
| work-shiyawase | `package.json` `version` |
| church-shiyawase | `package.json` `version` |
| event-shiyawase | `pubspec.yaml` `version: X.Y.Z+build` |
| home-shiyawase | `flutter_app/pubspec.yaml` `version: X.Y.Z+build` |

语义化：`fix`→ patch，`feat`→ minor，破坏性 → major。

> **home-shiyawase 特例：只发网页版时不要 bump `pubspec.yaml`。**
> deploy job 用 pubspec 版本生成 `version.json`，Android app 拿它比对后弹「有更新」，
> 而 releases 页上根本没有那个版本 —— 一个更新不了、天天弹的提示。
> **版本号只在真的出 APK 那一次才动。**

## 2. 写 `docs/versions/vX.Y.Z.md`

```markdown
# vX.Y.Z — <一句话标题>
> 发布日期：YYYY-MM-DD · PR #NNN

## 改了什么
## 为什么
## 迁移 / 需要人手做的事
（数据库迁移编号、需要手动部署的 edge function、需要加的 secret；没有就写「无」）
## 验证
（tester 报告摘要 + 部署 workflow run 链接）
```

## 3. 追加 `CHANGELOG.md`

倒序，最新在最上。一个版本一节，按 `feat / fix / refactor / docs / chore` 分组。
写**用户看得懂的话**，不是 commit 标题的复制。

## 4. 更新 `docs/PROJECT_STATUS.md`

这是**活的当前状态**，不是流水账：现在能做什么、已知缺什么、下一步是什么。
过时的段落**改掉**，不要往下堆。

---

## Android APK 发版（只有 event / home，且**用户明确要求时才做**）

合并进 `main` 只出网页版，**到此为止**。除非用户明确说要出 APK：

1. 确认 `RELEASE_NOTES.md` 内容是这一版的。
2. bump `pubspec.yaml` 到与 RELEASE_NOTES 标题一致。
3. 合并进 `main`。
4. 手动 `workflow_dispatch` release job（沙箱里推 tag 会被代理 403，用 dispatch）。

**签名铁律：release APK/AAB 必须每次用同一个 keystore 签**，否则 Android 拒绝原地升级，
用户得先卸载再装。keystore 与密码由用户永久保管，仓库里只有 CI secrets，
`key.properties` / `*.jks` / `*.keystore` 在 `.gitignore` 里 —— **绝不入库**。
