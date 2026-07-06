# Task 22 Review：MessageList 组件

## 审查范围
- brief：`task-22-brief.md`
- 报告：`task-22-report.md`
- diff：`review-ab4c82d..872d612.diff`（commit `872d612`，单 commit，2 文件 +63）
- 实测：`bun run test` → **Test Files 12 passed / Tests 25 passed**

## 判定：✅ APPROVE

四项核实全部通过，实现正确、测试有效、决策合理。

## 逐项核实

### 1. 按 sessionId 取消息 ✅
```tsx
const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? EMPTY);
```
- selector 接收 store，按 props `sessionId` 从 `messagesBySession` 取该 session 的消息数组。
- 与 `useSessionStore`（`store/session.ts`，zustand `create`，`messagesBySession: Record<string, ChatMessage[]>`）接口一致。
- 无解构 action，无 stale closure 风险；selector 返回值即渲染所需。

### 2. 2 passed ✅
- `MessageList.test.tsx`：`渲染指定 session 的消息` + `空 session 无消息`，实测 2 passed。
- 前序 23 + 本次 2 = **25 passed**，与报告一致。

### 3. 气泡配色 ✅（严格匹配 brief）
| 维度 | brief 要求 | 实现 | 一致 |
|---|---|---|---|
| user 背景 | `#313244` | `#313244` | ✅ |
| user 圆角 | `4px 12px 12px 12px` | `4px 12px 12px 12px` | ✅ |
| assistant 背景 | `#181825` | `#181825` | ✅ |
| assistant 圆角 | `12px 4px 12px 12px` | `12px 4px 12px 12px` | ✅ |
| 文字色 | `#cdd6f4` | `#cdd6f4` | ✅ |
| whitespace | `whitespace-pre-wrap` | `whitespace-pre-wrap` | ✅ |
- `isUser ? "你" : "agent"` 角色标签与 brief 一致。
- data-testid：容器 `message-list`、消息 `msg-{id}`，便于后续 Task 25 集成。

### 4. `?? []` → 模块级常量修复 ✅ 合理

**根因核实**（属实）：`useSessionStore` 由 zustand `create` 生成，底层走 `useSyncExternalStore`。React 19 对其 getSnapshot 返回值做引用比对。原 brief 写法 `s.messagesBySession[sessionId] ?? []` 在 session 不存在时，每次 render 都返回**新 `[]` 字面量引用** → 快照不稳定 → `Maximum update depth exceeded`。

报告「首个测试（session 存在）通过、第二个（空 session）崩溃」的描述与机制吻合：session 存在时返回 store 内稳定数组引用，不触发循环；空 session 才崩。

**修复合理性**：
```tsx
const EMPTY: ChatMessage[] = [];          // 模块级，全应用单例
const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? EMPTY);
```
- 空 session 始终返回同一 `EMPTY` 引用，快照稳定，循环消除。
- 不改变组件语义/接口/返回类型（仍是 `ChatMessage[]`）。
- 这是 zustand + useSyncExternalStore 在「selector 可能返回新字面量」场景的**标准推荐修复**（zustand 文档明确建议用模块级常量或 `useShallow`）。
- 报告已在注释与「关键决策」中如实记录此偏离与原因，属正当的实现层修正。

## 其它观察（非阻断）
- `gap-3.5` 工具类依赖 Tailwind 支持，与项目既有配置一致，缺则降级，不影响功能/测试。
- SessionRow `<tbody> nested <button>` 警告为 Task 18 遗留，与本任务无关。
- Windows autocrlf 的 LF→CRLF 警告与既有文件一致。

## 结论
Task 22 实现、测试、偏离修复均正确合理。**APPROVE**，无需返工。
