---
name: shiyawase-e2e
description: Shiyawase 工作室的浏览器端到端测试流程 —— 沙箱里的 Chromium 与代理设置、选择器策略（Flutter web 用 Key 不用 CSS）、fixture 命名与自清理、对抗性断言、构建戳守卫。tester-agent 要跑或写 E2E 时加载。取代了原来的 playwright-tester agent。
---

<!-- studio-skill v1.0.0 · 正本：maverick1014/website:.claude/skills/shiyawase-e2e/SKILL.md · 请勿本地修改 -->

# 端到端测试

> 正本：`maverick1014/website:.claude/skills/shiyawase-e2e/SKILL.md` · v1.0.0
> 各仓库的具体命令在 `docs/PROJECT_PROFILE.md`。

## 心态：多疑、对抗性

**永远不要假设成功。** 断言你期望的**确切**结果 —— 金额、标志位、条数、`is_transfer` ——
不是「没报错就算过」。每个功能都要有 happy path **和** edge / 负面 case：
坏输入、错的人、缺 FK、超支、空值、非本人的资源。

## 沙箱环境

```sh
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export NODE_USE_ENV_PROXY=1
```

- **不要跑 `playwright install`** —— Chromium 已预装。
- 自签证书：`chromium.launch({ args: ['--ignore-certificate-errors'] })` +
  `newContext({ ignoreHTTPSErrors: true })`。
- 项目 pin 了不同的 @playwright/test 版本时，用 `executablePath` 指到预装的 Chromium，不要下载。

## 选择器策略

| 前端 | 怎么定位 | 绝不 |
|---|---|---|
| React / Next.js | `data-testid`，其次是可访问名（role + name） | 不靠视觉样式类名 |
| **Flutter web** | **`Key` + `find.byKey`**（`flutter test` / `integration_test`） | **不要用 CSS 选择器** —— Flutter web 不产生 `<input type=email>` 这类 DOM 属性，CSS 选择器一个都找不到 |

登录检查要**语言无关**：等一个每个已登录页都有、登录页没有的结构元素（如 `.sidebar`），
不要等某个翻译过的标题 —— 用户换个界面语言，整套测试会在第一个检查点死掉，
90 秒重试之后报出来像是登录坏了。

## Fixture 纪律

1. 测试数据一律带固定前缀（`ZZ_UITEST_` / `E2E` / `__test__`），**一眼认得出**。
2. **自清理**：`finally` / `onCleanup` 里删干净；改过的设置（界面语言、模块开关、主题）要还原。
3. 收尾**按前缀全库扫一遍删掉**，不只删本次注册的 fixture —— 上一次崩掉的残留会一直堆积。
4. **残留 = 失败。** 一次跑完还留着数据的运行，不算通过，不管断言说什么。
5. 只在**本次创建的**数据上做破坏性操作。真实业务数据（真实出勤、真实交易）**绝不动**。

## 构建戳守卫

测试打的是**已部署的站点**，不是你的工作区。所以：

- **验证既有行为** → 推之前跑，这是回归门。
- **新页面 / 新交互** → 部署后才看得见。先过静态检查和 build，推上去，再对新构建跑一遍。
- 站点只有一个共享 URL，旧脚本打到新部署会把「选择器搬家了」报成失败。
  脚本支持 `EXPECT_BUILD` 就用它：对不上就 **exit 0 跳过**，不要靠放宽选择器来「修」红灯。

**跑之前确认没有别的运行在跑**（部署 workflow 里的 API E2E 也算）—— 两个运行会抢同一批
线上 fixture。

## Test Report 格式

```
## 环境      （命令、构建戳、跑了哪几层）
## 覆盖      （需求 → 测试 → 结果，一行一条）
## 证据      （真实命令输出，不是转述）
## Bug Report（每条：文件、行、期望、实际、修法建议）
```

最后一行必须是 `✅ ALL TESTS PASSED` 或 `❌ FAILURES FOUND — do not merge, see Bug Report.`
