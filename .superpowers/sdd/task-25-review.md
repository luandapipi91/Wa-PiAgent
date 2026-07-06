# Task 25 Review：SessionView

**Reviewer**：ZCode 自动 review　**Date**：2026-07-06　**Verdict**：✅ **3/3 passed，准予放行**

---

## 双判定核对

### 判定 1：3 passed + 结构正确
| 检查项 | 结果 |
|---|---|
| `SessionView.test.tsx` 3 用例 | ✅ `渲染 header 标题 + 项目目录` / `无活跃 ask 不显示徽标` / `有活跃 ask 显示徽标` |
| 实测复跑 `bun run test` | ✅ `Test Files 15 passed / Tests 32 passed`（SessionView.test.tsx 3） |
| header：emoji + **标题**（"测试"）+ **橙色 intercom 徽标**（`background rgba(250,179,135,0.2)` + `color #fab387`，`data-testid="intercom-badge"`，文案 `● {from}→{to} · ask · {elapsed}s`）+ **项目目录**（`project?.cwd` = `/work/p1`，正则 `getByText(/\/work\/p1/)` 命中）| ✅ |
| 编排画布按钮 `onSwitchToCanvas` | ✅ |
| MessageList + 内联 AskCard + Composer | ✅ |

### 判定 2：占位替换干净
| 检查项 | 结果 |
|---|---|
| `data-testid="session-view"` 保留 | ✅（diff 中占位与实现均带） |
| Props 接口 `{ sessionId: string; onSwitchToCanvas: () => void }` 保留 | ✅ 逐字符一致，App.tsx（Task 21）调用无需改动 |
| 占位注释删除 | ✅ `PLACEHOLDER` 三行注释已移除（新增 57 / 删除 10，整体替换） |

### onMessage 四分支路由（useEffect，依赖 `[sessionId]`，return `off` 解绑）
| 事件 | 条件 | 动作 | 结果 |
|---|---|---|---|
| `agent:message` | `e.sessionId===sessionId` | `useSessionStore.getState().append(e.message)` | ✅ |
| `intercom:ask` | `e.sessionId===sessionId` | `useIntercomStore.getState().addAsk(e.ask)` | ✅ |
| `intercom:reply` | `e.sessionId===sessionId` | `useIntercomStore.getState().resolveAsk(sessionId, e.askMessageId)` | ✅ |
| `agent:state` | 无 sessionId 过滤 | `useAgentsStore.getState().setState(\`${e.projectId}:${e.agentName}\`, e.state)` | ✅ |

四分支与 brief 完全一致，`return off` 保证解绑无泄漏。

---

## 重点核实：`?? []` 无限更新修复

**根因属实**：React 19 `useSyncExternalStore` 要求 selector 返回的 snapshot 引用稳定。brief 原文 `useIntercomStore(s => s.asksBySession[sessionId] ?? [])` 中，当 `asksBySession[sessionId]` 为 `undefined` 时，`?? []` **每次渲染都生成全新数组字面量** → snapshot 引用每次不同 → 无限重渲染（`Maximum update depth exceeded` / `getSnapshot should be cached`）。

**修复正确**：
```ts
// 模块级稳定空引用（SessionView.tsx:37）
const EMPTY_ASKS: never[] = [];
// selector（:44）
const asks = useIntercomStore(s => s.asksBySession[sessionId] ?? EMPTY_ASKS);
```
- 同一 `EMPTY_ASKS` 引用贯穿组件生命周期，snapshot 稳定。
- **一致性核实**：`MessageList.tsx:6` `const EMPTY: ChatMessage[] = []` + `:13` `?? EMPTY` —— 与既有代码库的规避模式**完全一致**，非孤例。
- `never[]` 类型安全：`asksBySession[sessionId]` 的元素类型为 Ask，`never[]` 可赋值给任何数组，TS 不报错。

**结论：修复合理且必要**，非擅自改动，是让测试通过的最小必要修正。

---

## 删除死代码 `messages` 选择器是否合理

**合理。** brief 原文声明 `const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? [])`，但：
1. `messages` 变量在组件 JSX 中**从未引用**（消息渲染委托给 `<MessageList sessionId>`，其内部 `:13` 自行 `useSessionStore` 订阅）。
2. 该选择器的 `?? []` **同样是 React 19 不稳定 snapshot 源**，会贡献 infinite loop。
3. 删除后：消除 loop + 去除死代码。`useSessionStore` import **保留**（effect 内 `useSessionStore.getState().append` 仍用），无悬空 import。

**结论：合理**，与首项修复同源，一并清理得当。

---

## Commit / 元数据
- Hash `a581c0b`，branch `master`（未建新分支）✅
- Parent `1605e46`（Task 24 AskCard）✅
- Message `feat(frontend): SessionView（header 徽标 + 项目目录 + 消息流 + Composer）`✅
- 文件改动：`SessionView.tsx`（+57/-10）、`SessionView.test.tsx`（+39 新建）

## 非阻断 Concerns（沿用报告）
- **徽标计时为静态快照**（无 `setInterval`），测试仅校验存在性，可后续增强。
- 测试输出有一条 `<tbody> cannot contain a nested <button>` 警告 —— 来自 **MessageList**（Task 22，非本次范围），不阻断。
- Windows autocrlf LF→CRLF 警告，与既有文件一致。

## 与 brief 的偏差（必要修正）
1. `asks` 选择器 `?? []` → `?? EMPTY_ASKS`（模块级常量）：修复 React 19 infinite loop，与 MessageList 既有模式一致。✅ 合理
2. 删除未使用的 `messages` 选择器：消除不稳定 snapshot + 死代码。✅ 合理

> 其余（header 结构、徽标、onMessage 四分支、子组件组合、Props 签名、data-testid）与 brief 逐字符一致。

---

**最终结论：Task 25 准予通过。** 3/3 测试通过，占位替换干净，`?? []` 修复核实属实且与代码库既有模式（MessageList EMPTY）一致，死代码清理合理。
