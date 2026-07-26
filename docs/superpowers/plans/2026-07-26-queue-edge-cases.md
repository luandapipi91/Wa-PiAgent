# 排队系统 — 边缘场景测试计划

> 基于排队系统重构设计（2026-07-26-queue-redesign-design.md），覆盖所有边缘场景

## 测试覆盖矩阵

### 一、基础队列操作

| 场景 | 测试 | 状态 |
|------|------|------|
| prompt 空闲 → 直接发送 | agent-manager.test.ts | ✅ |
| prompt 运行中 → 追加 followUpList | steer-queue-poc.test.ts | ✅ |
| prompt 未选择模型 → 抛错 | agent-manager.test.ts | ✅ |
| prompt 未知会话 → 抛错 | agent-manager.test.ts | ✅ |

### 二、引导（steer）

| 场景 | 测试 | 状态 |
|------|------|------|
| steerMessage 空闲 → 降级 prompt | agent-manager.test.ts | ✅ |
| steerMessage 运行中 → pi steer | steer-queue-poc.test.ts | ✅ |
| steerMessage 连续多条 → 全部调 pi | steer-queue-poc.test.ts | ✅ |
| steerMessage 空文本 → 需补充 | — | ❌ |
| steerMessage 会话不存在 → 静默忽略 | agent-manager.ts:799 | ✅ |

### 三、排队（followUp）

| 场景 | 测试 | 状态 |
|------|------|------|
| agent_settled 逐条 drain | steer-queue-poc.test.ts | ✅ |
| 多条排队消息依次 drain | steer-queue-poc.test.ts | ✅ |
| 空 followUpList 时 agent_settled → no-op | 需补充 | ❌ |
| drain 中 prompt 失败 → 不崩溃 | 需补充 | ❌ |

### 四、中止（abort）

| 场景 | 测试 | 状态 |
|------|------|------|
| abort 清空 followUpList | agent-manager.test.ts | ✅ |
| abort 后 agent_settled 不再 drain | steer-queue-poc.test.ts | ✅ |
| abort 取消 pending ask | agent-manager.test.ts | ✅ |
| abort 前创建中 → pendingAborts | agent-manager.test.ts | ✅ |
| abort 会话不存在 → 静默返回 | agent-manager.ts:828 | ✅ |

### 五、立即执行

| 场景 | 测试 | 状态 |
|------|------|------|
| abort + steerMessage = 立即 | steer-queue-poc.test.ts | ✅ |
| 立即执行清空原有排队 | steer-queue-poc.test.ts | ✅ |

### 六、跨会话

| 场景 | 测试 | 状态 |
|------|------|------|
| A 运行中切到 B，A 结束后 drain | 需补充 E2E | ❌ |
| 多会话各自独立队列 | agent-manager.test.ts（隔离验证） | ✅ |
| 会话销毁 → 清理资源 | agent-manager.test.ts | ✅ |

### 七、异常恢复

| 场景 | 测试 | 状态 |
|------|------|------|
| pi 进程崩溃 → 标记 crashed | agent-manager.test.ts | ✅ |
| 崩溃后重建 → 排队列表不丢 | 需补充 | ❌ |
| abort 过程中进程退出 → 吞错 | agent-manager.ts:834 | ✅ |

### 八、并发边界

| 场景 | 测试 | 状态 |
|------|------|------|
| 连续快速 prompt → 全部入队 | steer-queue-poc.test.ts（3条） | ✅ |
| 提示词重建（dirty）时 busy → 等 idle | agent-manager.test.ts | ✅ |
| 同 sessionId 并发 ensureStarted → 共享创建 | agent-manager.test.ts | ✅ |

### 九、UI 交互

| 场景 | 测试 | 状态 |
|------|------|------|
| 引导按钮乐观更新 | SessionView.test.tsx | ✅ |
| 立即按钮乐观更新 | SessionView.test.tsx | ✅ |
| 清空按钮乐观更新 | SessionView.test.tsx | ✅ |
| 运行中隐藏立即按钮 | SessionView.test.tsx | ✅ |
| 空闲时显示立即按钮 | SessionView.test.tsx | ✅ |

## 待补充的边缘场景

### E1 — steerMessage 空文本
- **场景**：前端传空文本给 steerMessage
- **预期**：不调 pi，静默忽略或抛错
- **优先级**：低（前端校验）

### E2 — 空 followUpList 的 agent_settled
- **场景**：agent_settled 到达时 followUpList 为空
- **预期**：no-op，不发 prompt
- **优先级**：中

### E3 — drain 中 prompt 失败
- **场景**：agent_settled drain 时 prompt() 抛错
- **预期**：不崩溃，下一条排队消息仍可正常 drain
- **优先级**：中

### E4 — pi 进程崩溃后排队列表保留
- **场景**：有排队消息时 pi 崩溃 → 重建 → 排队列表仍在
- **预期**：followUpList 是内存结构，与 pi 进程独立，不受崩溃影响
- **优先级**：低（设计保证）

### E5 — 跨会话 E2E
- **场景**：A 运行中 + 排队 → 切到 B → A 结束后自动 drain
- **预期**：A 的 pi 进程独立运行，agent_settled 触发 drain
- **优先级**：高（需 Playwright/agent-browser）

## 测试分层验收

| 层级 | 工具 | 数量 | 状态 |
|------|------|------|------|
| 单元测试（API 契约） | bun:test | 76 | ✅ 全通过 |
| 路由集成测试 | bun:test + HTTP | 含在 76 中 | ✅ |
| 前端组件测试 | Vitest + RTL | 17 | ✅ 全通过 |
| E2E 跨会话 | Playwright | 需补充 | ❌ |

## 实施记录

- 2026-07-26：基础队列测试、路由测试、前端组件测试已实现
- 2026-07-26：E1-E3 边缘场景测试待补充
- E5 跨会话 E2E 需独立 Playwright 环境
