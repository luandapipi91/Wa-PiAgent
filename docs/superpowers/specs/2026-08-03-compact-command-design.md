# 设计文档：内置命令「压缩上下文」（cmd:compact）+ 压缩后刷新 token

**日期**: 2026-08-03
**状态**: 已批准
**作者**: Alex（产品经理智能体）

## 背景与问题

pi 框架内置 `/compact` 命令可压缩会话上下文释放 token，原生支持 `/compact <自定义压缩指令>`。但 WaPi 前端未暴露该能力：

- `PI_FRAMEWORK_COMMANDS`（ComposerInput.tsx:186-206）中的 `compact` 被注释，GUI 下用户无法通过 `/` 菜单触发上下文压缩；
- 即使能触发，压缩后前端右上角 token 胶囊（`SessionView.tsx` 的「本轮」「累计」）仍显示压缩前的旧累计值，因为 `tokenTotals` 是前端从历史消息 usage 累加的，压缩重写 jsonl 后内存中的旧值不会自动更新。

**用户需求**：

1. 内置命令新增「压缩上下文」命令，支持自定义压缩指令；
2. 压缩后刷新界面右上角的 token 使用数。

## 方案

### 1. 菜单项（ComposerInput.tsx `builtinCommands`）

在 `builtinCommands` 数组新增一条（放在 `cmd:reload` 之后）：

```ts
{ id: "cmd:compact", name: "压缩上下文", description: "压缩会话历史释放 token（可附带自定义压缩指令）",
  source: { type: "builtin", name: "命令" }, disabled: isRunning || isNewSession },
```

- 显示名「压缩上下文」，内部 id `cmd:compact`，来源标记「内置/命令」与其他内置命令一致；
- `disabled: isRunning || isNewSession` 与 reload 一致——生成中或空会话时不可压缩。

### 2. 选中交互（ComposerInput.tsx `handleSelect`）

`cmd:` 分支中，`compact` 不走「执行动作」（dispatch CustomEvent），而是「插入 chip」：

```ts
const cmd = item.id.slice(4); // 去掉 "cmd:" 前缀
if (cmd === "compact") {
  // 清除 / 触发文本，插入 /[compact] chip，用户可继续输入自定义压缩指令
  const token = "/[compact] ";
  if (trigger) {
    const triggerRe = new RegExp(`/${trigger.query.replace(...)}$`);
    setText(text.replace(triggerRe, token));
  } else {
    setText(token);
  }
  return;
}
// 其余 cmd: 命令（settings/agents/skills/reload）保持原逻辑不变
```

### 3. 发送链路（零改动 kernel / pi / App.tsx）

- 用户输入如 `/[compact] 只保留关键决策`，按 Enter 发送；
- `Composer.tsx` 的 `expandTokens` 把 `/[compact]` 展开为 `/compact`（`tokens.ts:66` `COMMAND_TOKEN_RE`），得到 `/compact 只保留关键决策`；
- pi 的 `/compact` handler 原生解析 `text.startsWith("/compact ")` → `customInstructions = "只保留关键决策"` 执行压缩，重写会话 jsonl；
- 不带指令时发送 `/[compact]` → 展开为 `/compact`，走默认压缩。

### 4. 压缩后刷新 token（store/session.ts，两处小改）

**数据源事实**：前端 token 累计值 `tokenTotals` / `lastUsageBySession` 的唯一数据通路是 `GET /api/sessions/:sid/messages`（返回带 `usage` 的历史消息）→ `seedTokenTotal` 重算（SessionView.tsx:79-89 进入会话时即如此）。压缩后 jsonl 被 pi 重写，重新拉一遍即可得到新 token 累计。**后端零改动。**

**改动 A — 新增 store 方法 `refreshTokenTotals(sessionId)`**：

```ts
refreshTokenTotals: async (sessionId) => {
  try {
    const res = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
    const body = res as any;
    useSessionStore.setState((s) => ({
      messagesBySession: { ...s.messagesBySession, [sessionId]: body.messages },
    }));
    useSessionStore.getState().seedTokenTotal(sessionId, body.messages);
  } catch {
    // 刷新失败不影响主流程，静默忽略
  }
},
```

**改动 B — `agent_end` 分支检测压缩回合**（session.ts `handleSDKEvent` 的 `agent_end` case，约 661 行起）：

```ts
case "agent_end": {
  // ...现有逻辑（回 idle、清计时、未读角标、写回 turnElapsedMs）...
  // 压缩回合结束：重拉历史，刷新右上角 token 累计
  const list = useSessionStore.getState().messagesBySession[sessionId] ?? [];
  const lastUser = [...list].reverse().find((m: any) => (m.message as any)?.role === "user");
  const lastUserText = typeof lastUser?.message?.content === "string" ? lastUser.message.content : "";
  if (lastUserText.trim().startsWith("/compact")) {
    void useSessionStore.getState().refreshTokenTotals(sessionId);
  }
  break;
}
```

触发点覆盖三类场景：内置命令 `/compact`、pi 动态命令 `/compact`（若未来启用）、pi 自动压缩（auto-compaction 同样以 `agent_end` 收尾且不产生 user 消息——后者不在本次范围，但检测逻辑对手动 `/compact` 精确生效）。

## 明确不做（Non-Goals）

- 不启用 `PI_FRAMEWORK_COMMANDS` 其他命令（model/export 等保持注释）；
- 不加 kernel RPC、不加新 REST 路由、不加确认弹窗、不改 App.tsx；
- 不处理 pi 自动压缩（auto-compaction）后的 token 刷新——非本次需求，且需新机制感知「自动压缩发生」，超出范围。

## 测试计划（四层）

| 层 | 位置 | 用例 |
| ---- | ------ | ------ |
| 单元 | `packages/frontend/tests/tokens.test.ts` | `expandTokens('/[compact] 只保留关键决策')` → `/compact 只保留关键决策`；`expandTokens('/[compact]')` → `/compact` |
| 单元 | `packages/frontend/tests/store-session.test.ts` | `agent_end` 且最后一条 user 以 `/compact` 开头 → 触发 `refreshTokenTotals`（mock `api.get` 返回新 token 累计，断言 `tokenTotals` 更新）；user 不以 `/compact` 开头 → 不触发 |
| 组件 | `packages/frontend/tests/ComposerInput.test.tsx` | `/` 菜单出现「压缩上下文」；选中后输入框出现 `/[compact]` chip；空会话/运行中该项禁用 |
| E2E | `packages/frontend/e2e/quick-invoke.spec.ts` | 输入 `/` → 选压缩上下文 → 输入自定义指令 → 发送 → 断言请求文本为 `/compact 指令` |

## 影响文件清单

| 文件 | 改动 |
| ------ | ------ |
| `packages/frontend/src/components/ui/ComposerInput.tsx` | builtinCommands 新增 cmd:compact；handleSelect cmd: 分支特判插入 chip |
| `packages/frontend/src/store/session.ts` | 新增 refreshTokenTotals 方法；agent_end 分支检测 /compact 触发刷新 |
| `packages/frontend/tests/tokens.test.ts` | 补 expandTokens 用例 |
| `packages/frontend/tests/store-session.test.ts` | 补 refresh 触发用例 |
| `packages/frontend/tests/ComposerInput.test.tsx` | 补菜单/选中/禁用用例 |
| `packages/frontend/e2e/quick-invoke.spec.ts` | 补 E2E 用例 |
