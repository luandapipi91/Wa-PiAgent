# 聊天回复块自动折叠 UX 设计

- **日期：** 2026-07-23
- **状态：** 待实现
- **作者：** brainstorming 协作产出

## 背景与问题

现有 `MessageList.tsx` 已按调用时间线分段渲染 agent 回复（`segmentBlocks()` 把 content 切成 thinking / text / toolCalls / delegate 四种 segment，流式增量实时追加）。流式时间线本身工作正常，**不在本次改动范围**。

真正的问题是四类折叠块（`ThinkingBlock` / `ToolCallGroup` / `ToolCallBlock` / `DelegateCard`）的默认展开/折叠行为反了：

- 现状：默认折叠（`useState(false)`），用户必须手动点开才能看到流式过程中的内容。
- 期望：流式过程中默认展开（内容可见），**完成后自动折叠**成单行 chip，参考用户提供的 UX 设计图。

## 目标

1. 流式中：thinking / 工具调用 / 委托块默认展开，内容可见
2. 块完成后：自动折叠为单行 pill
3. 用户手动展开/折叠过：尊重用户选择，不被自动逻辑覆盖
4. 历史消息（非流式）：块默认折叠（紧凑）
5. 折叠态视觉沿用现有 pill 样式（圆角胶囊），不引入竖条/重写样式

## 非目标（YAGNI）

- 不改 `segmentBlocks` / `mergeStreamingIntoLast`（时间线已正确）
- 不在 store 层加折叠状态（视图偏好，不值得持久化）
- 不重写折叠态视觉（现有 pill 已紧凑，用户已确认沿用）
- 不动 dead code（`blocks/*Panel.tsx` 未被引用，保持原样）
- 不持久化用户的展开偏好（切走再回来按派生默认值重置）

## 视觉规格（已与用户确认）

折叠态统一为**圆角胶囊 pill**，四类块样式如下：

| 块类型 | 折叠态 pill 内容 | 配色 |
|---|---|---|
| 思考 `ThinkingBlock` | `💭 思考过程 已完成 ▸` | 中性灰（`text-tertiary` / `bg-surface-elevated` / `border-hairline`）|
| 工具组 `ToolCallGroup` | `🔧 工具调用记录 (N) · ✓x ✗y ⏳z ▸` | 中性灰 |
| 单个工具 `ToolCallBlock` | `✓ Read (file: …) ▸` 等 | 三态：成功绿 / 失败红 / 待执行中性 |
| 委托 `DelegateCard` | `↪ 委派给 {agent} · ✓ 完成 ▸` | 橙色（`#fab387` 系，沿用现有 DelegateCard 配色）|

**关键变化：DelegateCard 从整块橙色卡片改为单行 pill。** 完成后折叠成 `↪ 委派给 {agent} · ✓ 完成`，失败态 `✗ 失败` 用红色 pill（`text-danger` / `bg-danger-soft`）。展开后内容样式沿用现有（橙色左边框 + 任务 + 子 agent 回复）。

**DelegateCard 展开态渲染规则（新增）：** 子智能体回复内容（`result.content` 里的 text）必须用 `ReactMarkdown` 渲染（与主 agent 正文一致，支持代码块、列表、链接等 markdown 格式），而非纯文字 `whitespace-pre-wrap`。这样委托出去的子 agent 返回的 markdown 回复才能正确格式化显示。

**展开态：** pill 带 spinner（流式中）或状态图标（完成后），下方展开内容。pill 文字与现有完全一致，仅默认 `open` 值由"始终 false"改为"派生"。

## 核心行为规则

四类块的"完成"信号判定：

| 块类型 | 完成信号 `isDone` | 流式中默认 | 完成后默认 |
|---|---|---|---|
| `ThinkingBlock` | `!isStreaming`（整轮流式结束）| 展开 | 折叠 |
| `ToolCallGroup` | `toolCalls.every(tc => results.has(tc.id))` | 展开 | 折叠 |
| `ToolCallBlock` | `!!result` | 展开 | 折叠 |
| `DelegateCard` | `!!result` | 展开 | 折叠 |

**派生默认值（pure function）：**
```
期望展开 = !userToggled && (isStreaming && !isDone)
当前展开 = userToggled ? 用户最后选择 : 期望展开
```

**用户优先规则：** 每个 block 维护 `userToggledRef`。一旦用户点击过展开/折叠，置 `true`，此后自动逻辑不再覆盖。避免"用户正看内容，它突然收起"。

## 架构与组件改动

### 新增共享 hook

抽一个 hook 消除四处重复逻辑。新增文件：

`packages/frontend/src/components/blocks/useAutoCollapse.ts`

```typescript
import { useCallback, useRef, useState } from "react";

/**
 * 自动折叠 hook：流式中默认展开，块完成后自动折叠；用户手动操作后尊重用户选择。
 * - isStreaming: 整轮流式标志
 * - isDone: 该 block 是否完成
 */
export function useAutoCollapse(opts: {
  isStreaming?: boolean;
  isDone: boolean;
}): { open: boolean; toggle: () => void } {
  const userToggled = useRef(false);
  const [userOpen, setUserOpen] = useState(false);
  const expectOpen = !userToggled.current && !!opts.isStreaming && !opts.isDone;
  const open = userToggled.current ? userOpen : expectOpen;
  // 必须基于当前显示的 open 取反：userOpen 初始为 false，
  // 若用 setUserOpen(o => !o)，流式展开时第一次点击会把 userOpen 置 true（仍展开），要点两次才折叠
  const toggle = useCallback(() => {
    userToggled.current = true;
    setUserOpen(!open);
  }, [open]);
  return { open, toggle };
}
```

### 调用点改造

全在 `MessageList.tsx`（4 处中 3 处）+ `DelegateCard.tsx`（1 处）：

1. **`ThinkingBlock`** (L481-504)
   - 删 `const [open, setOpen] = useState(false)`
   - 加 `const { open, toggle } = useAutoCollapse({ isStreaming, isDone: !isStreaming })`
   - thinking 无独立 result，完成信号 = `!isStreaming`（即整轮流式期间 thinking 保持展开，整轮结束才折叠——沿用原 spec 表格的判定，若希望"thinking 段结束即折叠"需另加信号）
   - `onClick={() => setOpen(!open)}` → `onClick={toggle}`

2. **`ToolCallGroup`** (L534-574)
   - `isDone = toolCalls.every(tc => results.has(tc.id))`
   - 用 hook 替换内部 state
   - `onClick` 改 `toggle`
   - **向子组件 `ToolCallBlock` 透传 `isStreaming`**（当前 L568 未传，否则单个工具块流式中永远不会自动展开）

3. **`ToolCallBlock`** (L576-616)
   - Props 增加 `isStreaming?: boolean`
   - `isDone = !!result`
   - 用 hook 替换
   - `onClick` 改 `toggle`

4. **`DelegateCard.tsx`** (L9-45)
   - Props 增加 `isStreaming?: boolean`；**调用点 MessageList.tsx L409 需传入 `isStreaming`**（否则 `expectOpen` 恒 false，流式中不会自动展开）
   - 从整块橙色卡片改为：折叠时单行 pill（`↪ 委派给 {agent} · 状态 ▸`），展开时现橙色内容区
   - `isDone = !!result`
   - 引入 `useAutoCollapse`
   - 流式中：pill 带 spinner + "执行中"，展开显示任务
   - 完成后：pill 显示 `✓ 完成` / `✗ 失败`，默认折叠；展开显示任务 + 子 agent 完整回复
   - **子 agent 回复用 `ReactMarkdown`（+ `remark-gfm`）渲染**，而非纯文字——子 agent 返回的 markdown 格式（代码块/列表/链接）需正确显示。渲染容器加 `data-testid="text-block"` 以复用全局溢出兜底样式
   - 删除内部的"展开完整回复"二级折叠（被统一的 pill 折叠替代，避免双层折叠）

## 边界情况

1. **历史消息加载（非流式）：** `isStreaming` 恒 false → 所有块默认折叠。符合预期（历史紧凑）。
2. **切换会话再回来：** 组件 remount，`userToggled` 重置，按派生默认值。用户之前的手动展开状态丢失——可接受（视图偏好不持久化）。
3. **工具组部分完成：** 组内 3 个工具，2 个有 result → `every()` 为 false → 整组仍展开；单个工具块各自独立折叠。
4. **流式中切走翻历史：** `isStreaming` 仍 true，块保持展开。
5. **空 thinking / 空参数：** 现有渲染逻辑不变，不在本次范围。

## 测试策略

遵循 AGENTS.md 四层验收标准。本次是纯前端视图改动，第 3/4 层不涉及新接口/新流程，注明跳过原因。

### 第 1 层 · 单元测试（Vitest + RTL `renderHook`）

`packages/frontend/tests/useAutoCollapse.test.tsx`（前端测试统一放 `tests/` 目录走 Vitest + happy-dom；React hook 测试需 `@testing-library/react` 的 `renderHook`，`bun:test` 无此环境）：
- `isStreaming && !isDone` → open=true
- `isDone` 变 true → open=false（自动折叠）
- **流式展开中（open=true）toggle 一次即折叠为 false**（回归用例：防止 toggle 误从 userOpen 初始值取反导致要点两次）
- toggle 一次后 userToggled 生效，此后 isStreaming/isDone 变化不再覆盖
- userToggled 后 open 跟随用户最后选择

### 第 2 层 · 组件测试（Vitest + RTL）

`packages/frontend/tests/MessageList.test.tsx` 新增：
- 流式中的 thinking 块默认展开（thinking 内容在 DOM）
- 流式中的工具调用块默认展开
- 非流式（历史）块默认折叠（仅 pill 可见，内容不在 DOM）
- 用户点击展开后，即便 isStreaming 变化也保持用户选择

`packages/frontend/tests/DelegateCard.test.tsx`（已存在，更新用例）：
- DelegateCard 折叠态显示单行 pill（`↪ 委派给 …`）
- 流式中（isStreaming=true 且无 result）默认展开
- 完成后默认折叠
- 失败态红色 pill
- 子 agent 回复经 ReactMarkdown 渲染（如代码块/列表标签出现在 DOM）

### 第 3/4 层 · 跳过说明

本次为纯前端视图行为改动，无新增 REST 端点、无新增页面路由。核心契约由第 2 层组件测试覆盖。若后续需要真实流式过程的 E2E 验证，可补 Playwright 用例，但不在本次范围。

## 改动文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `packages/frontend/src/components/blocks/useAutoCollapse.ts` | 新增 | 共享自动折叠 hook |
| `packages/frontend/tests/useAutoCollapse.test.tsx` | 新增 | hook 单测（Vitest + RTL renderHook） |
| `packages/frontend/src/components/MessageList.tsx` | 改 | `ThinkingBlock`/`ToolCallGroup`/`ToolCallBlock` 接入 hook；`ToolCallBlock`、`DelegateCard` 调用点补传 `isStreaming` |
| `packages/frontend/src/components/blocks/DelegateCard.tsx` | 改 | 整块卡片 → pill 折叠 + 接入 hook + 子回复 ReactMarkdown 渲染 |
| `packages/frontend/tests/MessageList.test.tsx` | 改 | 新增自动折叠行为用例 |
| `packages/frontend/tests/DelegateCard.test.tsx` | 改 | 更新为 pill 折叠态/流式展开/失败态/Markdown 渲染用例 |
| `CHANGELOG.md` | 改 | 记录本次变更 |
