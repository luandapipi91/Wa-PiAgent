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
Pi 子进程                     HiAgent Kernel                   Frontend
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│ pi-cache-optimizer│         │                  │         │                  │
│  · 提示词重排      │         │                  │         │                  │
│  · cache key 补全  │         │                  │         │                  │
│  · stats 写入      │         │                  │         │                  │
│    (自动用         │         │                  │         │                  │
│     HIAGENT_DIR)   │         │                  │         │                  │
│                    │         │                  │         │                  │
│ message_end ───────┼─usage──▶│ 透传 usage ───────┼─WS─────▶│ SessionView      │
│  · usage.input     │         │ 到前端消息         │         │  · 胶囊标签组     │
│  · usage.output    │         │                    │         │  · 本轮/累计 tok  │
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

`pi-cache-optimizer` 尊重 `PI_CODING_AGENT_DIR` 环境变量。HiAgent 启动 Pi 子进程时已设为 `~/.hiagent`（即 `HIAGENT_DIR`），因此 stats 自动写入 `~/.hiagent/pi-cache-optimizer-stats.json`，不需要额外配置。

---

## 改动清单

### 1. Kernel · 内置插件 seed

**文件**：`packages/kernel/src/extension-manager.ts`、`packages/kernel/src/index.ts`

参照 `config-store.seedDefaults()` 幂等模式：

- 新增 `seedBuiltinExtensions()` 函数
- 读取 `settings.json` 的 `hiagent_packages` 数组
- 若 `"npm:pi-cache-optimizer"` 不存在 → 追加写入
- 已存在 → 跳过（不覆盖用户手动安装的版本）
- 始终启用（不加入 `hiagent_disabledPackages`）

### 2. Kernel · usage 透传

**文件**：`packages/shared/src/types.ts`、`packages/kernel/src/agent-manager.ts`

- `AssistantMessage` 新增 `usage` 字段（可选，兼容旧消息）
- `message_end` 事件处理中透传 Pi 的 `usage` 对象到前端
- 不做计算，仅透传原始数据

### 3. Frontend · 头部 UI

**文件**：`packages/frontend/src/components/SessionView.tsx`、`packages/frontend/src/store/session.ts`

- `SessionView` 的 `<header>` 右侧新增胶囊标签组（方案 C 风格）
- session store 维护会话累计 token 计数（`sessionTokens` map）
- 每个 `message_end` 事件到达时更新：
  - 本轮 token = `usage.input + usage.output`
  - 累计 token = 之前累计 + 本轮 token
  - 缓存命中率 = `usage.cacheRead / (usage.cacheRead + usage.input)` × 100%

---

## UI 设计

采用**方案 C（胶囊标签组）**风格：

```
┌──────────────────────────────────────────────────────────┐
│ 会话标题                    [本轮 1.2k tok] [累计 8.5k tok] [缓存命中 40%] │
│ ● /Users/.../HiAgent · 空闲                              │
└──────────────────────────────────────────────────────────┘
```

- 三个标签水平排列在 header 右侧
- 「本轮」「累计」使用灰色胶囊背景
- 「缓存命中」使用绿色背景（`#ecfdf5` 底 + `#059669` 字）
- 仅当有 usage 数据时显示（初始状态不显示）
- 每次 `message_end` 事件到达时自动刷新

---

## 注意事项

1. **子 agent 的 token**：子 agent 产生独立的 `message_end` 事件，usage 会自然进入当前会话的累计计数
2. **缓存命中率公式**：`cacheRead / (cacheRead + input)`。当 `cacheRead` 和 `input` 都为 0 时不显示
3. **pi-cache-optimizer footer**：在 HiAgent UI 中不可见（不做适配），仅享受其提示词优化
4. **旧消息兼容**：`usage` 字段设为可选，历史消息（无 usage）不影响渲染

---

## 验收标准

### 内置插件
- [ ] kernel 启动后，`~/.hiagent/settings.json` 的 `hiagent_packages` 包含 `"npm:pi-cache-optimizer"`
- [ ] Pi 子进程启动时加载了 `pi-cache-optimizer` 扩展（日志可验证）
- [ ] 重复启动不重复写入，用户手动安装的版本不被覆盖

### Token 显示
- [ ] 消息返回后，header 右侧出现「本轮」和「累计」胶囊标签
- [ ] 多次对话后，累计数字递增
- [ ] 切换会话后，累计数字切换为该会话的计数
- [ ] 支持缓存命中率的模型显示绿色「缓存命中」标签
- [ ] 不支持缓存的模型（cacheRead=0）不显示缓存命中率标签

### 兼容性
- [ ] 历史消息（无 usage 字段）不报错
- [ ] 现有测试全部通过
