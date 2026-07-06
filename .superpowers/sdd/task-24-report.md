# Task 24 报告：AskCard（委派内联卡片 + 🙋 我来回答 干预）

## 状态
✅ 完成

## Commit
- Hash：`1605e46`
- Message：`feat(frontend): AskCard（委派内联卡片 + 🙋 我来回答 干预）`
- Branch：`master`（未建新分支）
- Parent：`5f44f09`（Task 23 Composer）

## 交付物
- **新建** `packages/frontend/src/components/AskCard.tsx` — 委派内联卡片，未解决橙色显示「↗ 委派给 {emoji} · ask · 阻塞中 Ns」+ 🙋 我来回答按钮，点击展开输入框提交 `intercom:inject-reply`；解决后变绿「✓ 已回复」。
- **新建** `packages/frontend/tests/AskCard.test.tsx` — 3 用例（阻塞计时 / 展开输入 / 提交 inject-reply）。

## 关键约束遵守情况
| 约束 | 落实 |
|---|---|
| 工作目录 `H:\workspace\hiagent` + Git Bash | ✅ |
| Vitest `cd packages/frontend && bun run test` | ✅ |
| master 提交不建新分支 | ✅ `git branch` = master |
| mock ws-instance send | ✅ `vi.mock("../src/ws-instance", () => ({ send: vi.fn() }))` + `await import` |
| 未解决背景 `rgba(250,179,135,0.1)` + 边框 `rgba(250,179,135,0.3)` | ✅ AskCard.tsx `borderColor`/`bgColor` |
| 解决绿 `#a6e3a1` | ✅ `borderColor="#a6e3a1"`，`bgColor="rgba(166,227,161,0.1)"`，文字色 `#a6e3a1` |
| AskCard.test 3 passed | ✅ |
| 前序 + 本次 = 共 29 passed（26+3） | ✅ `Test Files 14 passed / Tests 29 passed` |

## 实现要点
- **Props**：`interface Props { ask: AskItem }`，消费 `AskItem`（messageId/sessionId/from/to/text/startedAt/resolved）。
- **三态渲染**：
  - `resolved === true` → 绿卡片「✓ 已回复」，无按钮/输入（`{ask.resolved ? null : ...}`）。
  - `resolved === false && !answering` → 🙋 我来回答按钮（`data-testid="ask-answer-btn"`，点击 `setAnswering(true)`）。
  - `resolved === false && answering` → 输入框（`data-testid="ask-input"`）+ 提交按钮。
- **阻塞计时**：`elapsed = Math.floor((Date.now() - ask.startedAt) / 1000)`，显示 `ask · 阻塞中 {elapsed}s`，仅在未解决时渲染。
- **提交载荷**严格匹配 `InjectReplyEvent`（shared/types.ts:88）：`{ type: "intercom:inject-reply", sessionId, askMessageId: ask.messageId, text }`。
- **空文本守卫**：`submit` 内 `if (!text.trim()) return`，提交后清空 + 收起输入。
- **配色**：未解决橙 `#fab387`（文字）/ `rgba(250,179,135,0.2)`（计时徽章背景）；解决绿 `#a6e3a1`；提交按钮绿 `#a6e3a1`；我来回答按钮 `#313244` 底 + 绿字。
- **data-testid**：`ask-{messageId}`（容器）/ `ask-answer-btn` / `ask-input`，便于 Task 25+ 集成。

## 测试摘要
```
Test Files  14 passed (14)
     Tests  29 passed (29)
  ✓ tests/AskCard.test.tsx (3)   ← 本次新增
```
- 前序 26（Task 23 后）+ AskCard 3 = **29 passed**，符合预期。

## 调试记录
| 步骤 | 结果 |
|---|---|
| 读 brief + 核对 shared types（AskItem / InjectReplyEvent 字段） | ✅ 字段全匹配 |
| 创建 AskCard.tsx + 测试（严格照 brief） | — |
| 首次跑测试 | 29 passed（一次通过，无返工）|
| 确认 AskCard 3 passed | `✓ tests/AskCard.test.tsx (3 tests) 48ms` |
| 提交 master | `1605e46` ✅ |

## Concerns（非阻断）
- **阻塞计时不实时刷新**：`elapsed` 在渲染时计算，无 `setInterval` 计时器，静态快照。当前测试用 `/阻塞中/` 正则匹配，不校验秒数，符合 brief。如需动态倒计时可在后续 Task 用 `useEffect`+`setInterval` 增强。
- **真实 send 短路**：与 Composer 同，真实 `send` 仅在 ws OPEN 时发，测试已 mock 不受影响。
- **Windows autocrlf**：LF→CRLF 警告，与既有文件一致，不影响功能。
