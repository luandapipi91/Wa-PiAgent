# 内置 pi-cache-optimizer + 聊天头部 Token/缓存显示

**日期**：2026-07-27
**状态**：设计中

---

## 需求概述

1. 将 `pi-cache-optimizer` 作为内置插件，用户无需手动安装
2. 聊天会话界面右上角显示 token 消耗和缓存命中率

---

## 方案选择

**方案 C（混合方案）**：token 消耗从 Pi SDK 原生 `usage` 字段取，缓存命中率从 `cacheRead/(cacheRead+input)` 计算。同时内置 `pi-cache-optimizer` 提供提示词重排和 cache key 补全优化。

- **token 数据**：精确到每轮消息，主/子 agent 可区分
- **缓存优化**：pi-cache-optimizer 静默优化，不依赖其 stats 文件
- **两者解耦**：内置插件和 token 显示互不依赖

### 为什么不读 pi-cache-optimizer stats 文件

- Pi SDK 的 `AssistantMessage.usage` 已包含 `cacheRead`/`cacheWrite`，数据就在手边
- stats 文件是 provider/model 级别聚合，缺乏 per-session/per-message 粒度
- 不需要额外 HTTP 轮询 stats 文件

---

## 数据流

```
Pi 子进程                     WaPi Kernel                   Frontend
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│ pi-cache-optimizer│         │                  │         │                  │
│  · 提示词重排      │         │                  │         │                  │
│  · cache key 补全  │         │                  │         │                  │
│  · stats 写入      │         │                  │         │                  │
│    (自动用         │         │                  │         │                  │
│     WA_PI_DIR)   │         │                  │         │                  │
│                    │         │                  │         │                  │
│ message_end ───────┼─usage──▶│ 透传 usage ───────┼─WS─────▶│ SessionView      │
│  · usage.input     │         │ 到前端消息         │         │  · 胶囊标签组     │
│  · usage.output    │         │                    │         │  · 入/出/累计 tok  │
│  · usage.cacheRead │         │                    │         │  · 缓存命中率     │
└──────────────────┘         └──────────────────┘         └──────────────────┘
```

### 数据来源

Pi SDK 的 `AssistantMessage.usage` 类型：

```typescript
interface Usage {
  input: number;        // prompt tokens
  output: number;       // completion tokens
  cacheRead: number;    // 从缓存读取的 tokens
  cacheWrite: number;   // 新写入缓存的 tokens
  totalTokens: number;  // 总计
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; };
}
```

### stats 文件存储位置

> 备注：pi-cache-optimizer 的 stats 文件自动写入 `~/.wa-pi/`（Pi 子进程已设 `PI_CODING_AGENT_DIR`），但 UI 不读该文件——token 和缓存数据直接来自 `message_end.usage`。

---

## 改动清单

### 1. Kernel · 内置插件

**文件**：`packages/kernel/src/extensions.ts`、`packages/kernel/package.json`、`packages/desktop/resources/kernel/package.json`

沿用 `PKG_EXTENSIONS` 机制（`extensions.ts:70`），三处一行改动：

1. `PKG_EXTENSIONS` 数组追加 `"pi-cache-optimizer"`
2. `packages/kernel/package.json` 的 `dependencies` 加 `"pi-cache-optimizer": "^2.6.24"`
3. `packages/desktop/resources/kernel/package.json` 的 `dependencies` 加同上（桌面端 seed）

版本策略：dev 和 desktop seed 统一 `^2.6.24`，与 kernel 对齐。遵循现有 pi-mcp-adapter 等包的模式。

不需要新写 `seedBuiltinExtensions()`。`PKG_EXTENSIONS` 已内置了 `pi-open-agents`、`pi-web-access`、`pi-mcp-adapter`，加第四个遵循同一模式。

**验证**：npm 上 `pi-cache-optimizer@2.6.24` 已声明 `pi.extensions: ["./index.ts"]`，能过 `readPiExtensionsDeclaration` gate。

### 2. Kernel · usage 透传

**文件**：`packages/shared/src/types.ts`、`packages/kernel/src/agent-manager.ts`

- `AssistantMessage` 新增 `usage` 字段（可选，兼容旧消息）
- 同步更新 types.ts:126 注释：去掉「忽略 usage」，改为说明 usage 来自 Pi SDK 透传
- `message_end` 事件处理中透传 Pi 的 `usage` 对象到前端（RpcEvent 的 `[k: string]: any` 已支持，无需改代码）
- 不做计算，仅透传原始数据

### 3. Frontend · 头部 UI

**文件**：`packages/frontend/src/components/SessionView.tsx`、`packages/frontend/src/store/session.ts`

- `SessionView` 的 `<header>` 右侧新增三个胶囊标签（↑↓ 箭头风格）
- session store 维护会话累计 token 计数（`sessionTokens` map）
### 「↑/↓」的语义

工具循环中一轮对话可能产生多次 API 调用，每次调用对应一个带 `usage` 的 `message_end`。

- **「↑X/↓Y」**：显示最近一次 `message_end` 的 `usage.output` / `usage.input`
- **「累计 Z」**：会话累计总 token，每次 `message_end` 到达时累加 `input + output`
- **「缓存 X%」**：基于最近一次调用的 usage 计算 `cacheRead / (input + cacheRead + cacheWrite)`

不做 agent_start→agent_settled 窗口聚合——避免引入复杂的生命周期管理。

---

## UI 设计

采用**↑↓ 箭头 + K/M 缩写**（单胶囊 + 累计 + 缓存）：

```
┌──────────────────────────────────────────────────────────────┐
│ 会话标题                        [↑1.1k/↓3.2k] [累计 8.5k] [缓存 40%] │
│ ● /Users/.../WaPi · 空闲                                  │
└──────────────────────────────────────────────────────────────┘
```

- 「↑X/↓Y」：↑ 输出 tokens（completion）/ ↓ 输入 tokens（prompt），灰色胶囊
- 「累计 Z」：会话累计总 token（含历史 seed），灰色胶囊
- 「缓存 X%」：缓存命中率，绿色胶囊（`#ecfdf5` 底 + `#059669` 字）
- 仅当有 usage 数据时显示（初始状态不显示）
- 每次 `message_end` 事件到达时自动刷新
- 数字格式化：&lt;1000 显示原始值，≥1000 显示 K（如 1.2k），≥1M 显示 M（如 1.5M）。无小数时省略小数位（55K 而非 55.0K）

---

## 注意事项

1. **子 agent 的 token**：子 agent 运行在独立 Pi 进程中（`subagent-runner.ts:141-171`），其 `message_end` 事件不进父会话的 `sdk:event` 广播。**第一版不做子 agent token 统计**——仅统计当前会话直接 API 调用的 usage。后续可补 delegate 结果回填管道。
2. **Usage 归一化**：Pi SDK 的 `input` 字段**不含缓存 token**（apiNormalizeUsage 已扣除）。因此 prompt 总量 = `input + cacheRead + cacheWrite`。缓存命中率 = `cacheRead / (input + cacheRead + cacheWrite)`，分母全 0 时不显示。
3. **历史会话的初始累计**：重新打开历史会话时，从会话文件中读取历史消息的 usage，一次性 seed 初始累计计数。避免从 0 开始导致严重低估。
4. **pi-cache-optimizer footer**：在 WaPi UI 中不可见（不做适配），仅享受其提示词优化
5. **旧消息兼容**：`usage` 字段设为可选，历史消息（无 usage）不影响渲染

---

## 验收标准

### 内置插件
- [ ] `PKG_EXTENSIONS` 数组包含 `"pi-cache-optimizer"`
- [ ] `packages/kernel/package.json` 和 desktop seed package.json 含 `pi-cache-optimizer` 依赖
- [ ] Pi 子进程启动时加载了 `pi-cache-optimizer` 扩展（`-e` 参数包含其入口）

### Token 显示
- [ ] 消息返回后，header 右侧出现「↑X/↓Y」「累计 Z」「缓存 X%」三个胶囊
- [ ] 多次对话后，累计数字递增
- [ ] 切换会话后，累计数字切换为该会话的计数
- [ ] 重新打开历史会话时，累计数字从历史消息 usage seed（不从 0 开始）
- [ ] 支持缓存命中率的模型显示绿色「缓存命中」标签
- [ ] 缓存命中率 = `cacheRead / (input + cacheRead + cacheWrite)`
- [ ] 不支持缓存的模型（cacheRead=0 且 cacheWrite=0）不显示缓存命中率标签

### 兼容性
- [ ] 历史消息（无 usage 字段）不报错
- [ ] 现有测试全部通过

### 测试分层（四层）
- [ ] **单元测试**：session store 的 `addTokens`/`seedTokenTotal` 累计逻辑、`fmtTok` 格式化纯函数
- [ ] **组件测试**：SessionView 的 token 胶囊渲染（有/无 usage、缓存命中率为 0 时不显示）
- [ ] **API 接口测试**：`message_end` 事件携带 usage 字段经 kernel 透传到前端
- [ ] **E2E**：完整对话流程后 header 出现 token 胶囊、累计递增、切换会话计数独立
