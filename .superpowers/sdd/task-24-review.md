# Task 24 Review：AskCard（委派内联卡片 + 🙋 我来回答 干预）

## 判定：✅ PASS（3/3 passed，全部判定项满足）

三方核对源：brief（task-24-brief.md）↔ report（task-24-report.md）↔ diff（5f44f09..1605e46）三者一致。

## 判定项逐条

| # | 判定项 | 结论 | 证据（AskCard.tsx / test） |
|---|---|---|---|
| 1 | **3 passed** | ✅ | diff 含 3 个 test；report `Test Files 14 passed / Tests 29 passed`，AskCard.test.tsx (3)。26(前序)+3=29。 |
| 2 | **未解决橙色卡片** | ✅ | `borderColor="rgba(250,179,135,0.3)"`、`bgColor="rgba(250,179,135,0.1)"`、文字 `#fab387`（Catppuccin peach 橙）。三色与 brief 一致。 |
| 3 | **阻塞计时** | ✅ | `ask · 阻塞中 {elapsed}s`，`elapsed=Math.floor((Date.now()-ask.startedAt)/1000)`，仅在 `{!ask.resolved && ...}` 渲染。 |
| 4 | **🙋 我来回答 → 展开输入** | ✅ | 按钮 `data-testid="ask-answer-btn"` 文案「🙋 我来回答」onClick `setAnswering(true)`；展开 `<input data-testid="ask-input">` + 「提交」按钮。 |
| 5 | **inject-reply 载荷** | ✅ | `send({ type:"intercom:inject-reply", sessionId:ask.sessionId, askMessageId:ask.messageId, text })`，字段与 `InjectReplyEvent` 一致；test #3 `toHaveBeenCalledWith` 严格校验。空文本守卫 `if(!text.trim()) return` 到位。 |
| 6 | **解决后绿 ✓ 已回复** | ✅ | `ask.resolved ? "✓ 已回复" : "↗ 委派给…"`；解决态 `#a6e3a1`（绿）文字 + `borderColor="#a6e3a1"` + `bgColor="rgba(166,227,161,0.1)"`；解决后按钮/输入区返回 `null`。 |
| 7 | **配色正确** | ✅ | 橙 `#fab387`/`rgba(250,179,135,*)`；绿 `#a6e3a1`/`rgba(166,227,161,*)`；徽章背景 `rgba(250,179,135,0.2)`。属 Catppuccin Mocha 调色板，与项目既有组件一致。 |

## 实现与 brief 偏差（均为无害）
- **测试 import 去 `beforeEach`**：brief 模板 `import { test, expect, vi, beforeEach }` 实际写成 `import { test, expect, vi }`。brief 模板本就未使用 `beforeEach`，去除未用 import 是改进，不影响行为。
- **diff 与 brief 代码块逐字符一致**：除上述 import 外，源码与测试均与 brief 完全相同，无擅自改动。

## 非阻断观察（与 report Concerns 吻合）
- **计时为静态快照**：`elapsed` 渲染时计算，无 `setInterval`；测试用 `/阻塞中/` 正则匹配不校验秒数，符合 brief。如需动态倒计时可在后续 Task 用 effect 增强。
- **真实 send 短路**：ws 非 OPEN 时 send 不发，与 Composer 同；测试已 mock，不受影响。
- **Windows autocrlf**：LF→CRLF 警告，与既有文件一致。

## 结论
Task 24 实现忠实于 brief，三态渲染（橙未解决/绿已回复）+ 计时 + 干预流程（回答→输入→inject-reply）全部正确，3 用例通过，与 Task 23 后的 26 测试合计 29 passed。**通过，可进入 Task 25。**
