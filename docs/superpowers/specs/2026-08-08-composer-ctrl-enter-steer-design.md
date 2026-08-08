# 设计：输入框 Ctrl+Enter 引导发送

**日期**: 2026-08-08
**状态**: 已批准（用户确认方案 A）
**改动范围**: `packages/frontend/src/components/Composer.tsx`、`packages/frontend/src/components/ui/ComposerInput.tsx`、`packages/frontend/tests/Composer.test.tsx`

---

## 1. 问题陈述

回复过程中（agent 运行中），按回车发送内容会进入 followUp 排队队列。用户希望增加一个快捷键：`Ctrl+Enter` 直接把输入框内容作为**引导（steering）消息**发送；`Enter` 行为保持不变（仍进排队队列）。

## 2. 现状（已核实）

- 键盘链路：`ComposerTextarea`（contenteditable）→ `onKeyDown` → `ComposerInput.handleKeyDown`（`ComposerInput.tsx` 646-686 行）→ `onSend` → `Composer.handleSend` → `doSend`（`Composer.tsx` 97-154 行）
- 按键模型：`Enter` = 发送（运行中进 followUp 队列）；`Shift+Enter` = 换行；**无专门的 Ctrl/Cmd+Enter 分支**——但 Ctrl+Enter 满足普通 Enter 分支条件（`key==='Enter' && !shiftKey`）实际也触发发送；Ctrl+Shift+Enter 因 `shiftKey` 为 true 不触发发送（走浏览器默认）
- IME 保护：`ComposerInput.tsx` 652-653 行 `isComposing`/`keyCode===229` 时提前 return
- QuickInvoke 面板打开时 `Enter` 优先选中菜单项（666-673 行）
- steering 路径：前端 `SessionView.handlePromote` → `POST /api/sessions/:sessionId/steer` → kernel `steer:message` → `agent-manager.steerMessage()`（1231-1253 行）：
  - 空闲时 `_sendPromptNow` 直接发送
  - 运行中 `steerList.push(text)` + `client.steer()` 双保险
- **`/steer` 不触发 `session:echo_user`**（echo 只发生在 `agent:prompt` 处理链路），因此 steer 发送无需 optimisticEcho 标记（与 `handlePromote` 模式一致）

## 3. 目标与非目标

### 目标

- `Ctrl+Enter`（Windows）或 `Cmd+Enter`（macOS）在输入框内：
  - agent 运行中 → 把输入框文本作为引导消息发送（steering）
  - agent 空闲 → 等同普通发送
- `Enter` 行为完全不变
- `Shift+Enter` 换行行为完全不变
- 输入框发送后清空文本（与 `doSend` 一致）

### 非目标

- 不改发送按钮行为（仍等同 `Enter`）
- 不改队列面板"引导/立即"按钮
- 不做 UI 快捷键提示文案（可选增强，暂不做）
- 引导消息不支持附件（`/steer` 接口只接受 text）

## 4. 方案选择

| 方案 | 做法 | 结论 |
| ------ | ------ | ------ |
| A（选定） | `Composer` 新增 `handleSendSteer`，`ComposerInput` 新增 `onSendSteer` prop + Ctrl/Cmd+Enter 分支 | 职责清晰，UI 组件只透传按键 |
| B | 复用 `onSend` 传参数区分 | API 语义不清，被否 |
| C | `ComposerInput` 内部直接调 `/steer` | 污染纯 UI 组件，被否 |

## 5. 详细设计

### 5.1 `ComposerInput.tsx`

- Props 新增：`onSendSteer?: () => void`
- `handleKeyDown` 新增分支（放在 QuickInvoke 面板导航之后、普通 Enter 之前）：

```tsx
// Ctrl/Cmd+Enter：引导发送（运行中走 steering，空闲等同普通发送）
if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    if (canSend) onSendSteer?.();
    return;
}
// 正常 Enter 发送
if (e.key === "Enter" && !e.shiftKey) { ... }
```

- IME 组词中的 Ctrl+Enter 仍被 652-653 行提前 return 拦截
- 面板打开时 Ctrl+Enter 仍走菜单导航分支（代码顺序在菜单拦截之后，互不影响——面板打开时 Enter 系按键先被菜单分支消费）

### 5.2 `Composer.tsx`

新增 `handleSendSteer`（传给 `ComposerInput` 的 `onSendSteer`）：

```tsx
const handleSendSteer = () => {
    if (disabled) return;
    const expandedText = expandTokens(text);
    if (!expandedText.trim() || !isModelAvailable(model, providers) || sendingRef.current || !projectId) return;
    if (!isRunning) {
        // 空闲：等同普通发送（走 doSend 完整清理逻辑）
        doSend(agentName, expandedText);
        return;
    }
    // 运行中：乐观加入 steering 队列 + 调 /steer（复刻 handlePromote 模式，不设 optimisticEcho）
    useSessionStore.setState(s => {
        const cur = s.queueBySession[sessionId];
        return {
            queueBySession: {
                ...s.queueBySession,
                [sessionId]: {
                    steering: cur?.steering?.includes(expandedText) ? cur.steering : [...(cur?.steering ?? []), expandedText],
                    followUp: cur?.followUp ?? [],
                },
            },
        };
    });
    api.post(`/api/sessions/${encodeURIComponent(sessionId)}/steer`, { text: expandedText })
        .catch(err => console.error("[composer] 引导发送失败:", err));
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    setText("");
    setSessionPrefs(sessionId, { text: "" });
};
```

### 5.3 设计决策与取舍

| 决策 | 取舍 |
| ------ | ------ |
| 运行中 Ctrl+Enter 只清空文本、**保留附件** | `/steer` 只接受 text；保留附件可防止用户误操作丢失附件 |
| 运行中不设 optimisticEcho | `/steer` 不触发 echo_user，与 `handlePromote` 一致 |
| 空闲时走 `doSend` 而非 `/steer` | 前端语义清晰（等同普通发送），且 `doSend` 完整处理附件/扩展命令/乐观 UI |
| 不拦截面板打开时的 Ctrl+Enter | 面板导航优先，符合现有交互 |

## 6. 测试计划

### 单元/组件测试（`Composer.test.tsx` 追加）

1. **运行中 Ctrl+Enter → 引导发送**：`isRunning` 渲染，输入文本后 fireEvent.keyDown 带 `ctrlKey: true`：
   - 断言调用了 `/api/sessions/s1/steer`（body `{ text }`）
   - 断言未调用 `/prompt`
   - 断言 `queueBySession.s1.steering` 包含文本，`followUp` 不包含
   - 断言输入框清空
2. **空闲 Ctrl+Enter → 等同普通发送**：断言调用了 `/prompt`（等同回车）
3. **IME 组词中 Ctrl+Enter 不触发**：`isComposing: true` 时无请求

## 7. 风险与兼容性

- 现有测试 `Composer.test.tsx` 127-156 行断言"运行中发送进 followUp 队列"——针对的是 `Enter`/发送按钮，不受影响
- kernel 侧无改动，`/steer` 路由已存在且验证过
- macOS `Cmd+Enter` 与 Windows `Ctrl+Enter` 统一处理（`e.metaKey`/`e.ctrlKey`）
- **NewSessionPane（未传 `onSendSteer`）回归**：改动前其 Ctrl+Enter 落入普通 Enter 分支（`key==='Enter' && !shiftKey`）会发送；改动后新分支拦截 Ctrl+Enter，若直接 `onSendSteer?.()` 则变为无动作。修复为回退 `onSendSteer ? onSendSteer() : onSend()`，未传 `onSendSteer` 时保持"Ctrl+Enter = 发送"的改动前行为不变
