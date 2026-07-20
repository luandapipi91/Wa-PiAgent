# Pi Goal Mode 调研报告

> 调研日期：2026-07-20
> 调研目标：评估使用 Pi 框架实现 Goal Mode（目标驱动自主执行模式）的可行性与方案

## 一、Goal Mode 定义

Goal Mode 是一种让 AI Agent 围绕明确目标**自主执行**的工作模式，核心特征：

1. **目标驱动**：用户给定目标，Agent 自主规划并执行，不等待每步确认
2. **持续循环**：思考 → 行动 → 观察，直到目标完成
3. **状态标记**：`[goal:continue]` / `[goal:complete]` / `[goal:blocked]`
4. **暂停条件明确**：只在不可逆操作、需要用户输入等关键节点暂停
5. **上下文合约**：遵守给定的 Context、Output format、Constraints

## 二、Pi 现有能力评估

### Pi 的核心理念

Pi 是极简终端编码 Agent 框架，哲学是 **"原语而非特性"（Primitives, not features）**。它不内置 sub-agents、plan mode、permission popups、to-dos 等功能，而是通过 **TypeScript Extensions** 让用户自己构建。

### Pi 提供的构建原语

| Goal Mode 需求 | Pi 对应 API | 说明 |
|---|---|---|
| Agent 自主循环 | `pi.sendMessage({ triggerTurn: true })` + `agent_end` 事件 | 在 agent 完成一轮后自动触发下一轮 |
| 上下文注入 | `pi.on("before_agent_start")` → `{ systemPrompt / message }` | 每轮开始前注入 Goal Mode 规则和当前状态 |
| 工具控制 | `pi.setActiveTools()` / `pi.getActiveTools()` | 在不同阶段控制 agent 可用工具 |
| 进度追踪 | `ctx.ui.setStatus()` / `ctx.ui.setWidget()` | 终端 UI 中显示进度 |
| 状态持久化 | `pi.appendEntry("custom-type", data)` + `session_start` 恢复 | 会话恢复后不丢失 Goal Mode 状态 |
| 命令注册 | `pi.registerCommand()` / `pi.registerFlag()` / `pi.registerShortcut()` | `/goal` 命令、`--goal` flag、快捷键 |
| 子进程隔离 | `spawn("pi", ["--mode", "json", "-p", ...])` | 参考 subagent 扩展，隔离上下文 |
| 工具拦截 | `pi.on("tool_call")` → `{ block: true, reason }` | 阻止危险操作 |

### 关键参考实现

| 扩展 | 路径 | 关联度 | 核心价值 |
|---|---|---|---|
| **plan-mode** | `examples/extensions/plan-mode/` | ⭐⭐⭐⭐⭐ | mode toggle + context injection + progress tracking + `triggerTurn` 循环 |
| **subagent** | `examples/extensions/subagent/` | ⭐⭐⭐⭐ | 子进程 spawn + 隔离上下文 + parallel/chain 模式 |
| **preset** | `examples/extensions/preset.ts` | ⭐⭐⭐ | 模式切换 + instructions 注入 + CLI flag |

## 三、实现方案

### 方案 A：直接使用 pi-task（推荐）

**[@mjasnikovs/pi-task](https://github.com/mjasnikovs/pi-task)** 是 Pi 生态中最成熟的 goal/task 编排框架。

```bash
pi install npm:@mjasnikovs/pi-task
```

**核心特性：**

- **5 阶段确定性管道**：refine → research → grill → compose → critique
- **Crash-safe**：状态持久化到 `.pi-tasks/TASK_NNNN.md`，支持 `/task-resume`
- **并行子代理研究**：4 个内置 worker（pi-worker / pi-worker-search / pi-worker-fetch / pi-worker-docs）
- **验证与执行**：真实验证 spec 的 VERIFY 块 + enforce guidelines
- **远程控制**：手机 Web 视图 + Push 通知
- **本地 LLM 优化**：循环检测、失败分类、流看门狗
- **无人值守**：YOLO 模式自动接受推荐选项
- **多任务编排**：`/task-auto` 自动拆分大功能为有序任务列表

**使用方式：**

```
/task 添加速率限制到 /api/upload          # 单个任务
/task-auto Implement @MY_PLAN.md           # 多功能拆分执行
/task-resume                                # 崩溃恢复
/task-config                                # 配置
```

**注意事项：**
- 许可证：AGPL-3.0（闭源/商业使用需留意 copyleft）
- 需要 Pi ≥ 0.80
- 管道阶段是固定代码，不支持自定义

### 方案 B：基于 subagent + plan-mode 模式自建

适合需要完全自定义管道行为、或 AGPL 不适用时的场景。

**核心 API 调用链：**

```
session_start → 注册 /goal 命令、--goal flag
  ↓
用户输入目标 → before_agent_start 注入 Goal Mode 上下文
  ↓
Agent 执行 → agent_end 检查状态标记
  ├─ [GOAL:DONE]    → 完成，通知用户
  ├─ [GOAL:BLOCKED] → 暂停，等待用户介入
  └─ 无标记         → sendMessage({triggerTurn:true}) 继续
```

**核心代码量：约 100 行 TypeScript**

**关键事件流：**

1. `pi.on("before_agent_start")` — 注入 Goal Mode 规则（目标描述、执行规则、暂停条件、轮次计数）
2. `pi.on("turn_end")` — 解析 `[GOAL:DONE]` / `[GOAL:BLOCKED:reason]` 标记
3. `pi.on("agent_end")` — 检测是否需要继续，调用 `pi.sendMessage({triggerTurn:true})`
4. `pi.on("session_start")` — 从 `pi.appendEntry` 持久化数据恢复状态

### 方案 C：仅使用 subagent 原语

Pi 内置的 subagent 扩展仅提供底层能力（spawn 子进程、single/parallel/chain 模式），**不提供**管道编排、崩溃恢复、验证/gate、进度追踪。适合作为方案 B 的底层组件，不适合直接作为 goal mode 使用。

## 四、方案对比

| 维度 | 方案 A：pi-task | 方案 B：自建 | 方案 C：subagent 原语 |
|---|---|---|---|
| **成熟度** | ⭐⭐⭐⭐⭐ 1939 tests, 459 commits | ⭐⭐ ~100 行原型 | ⭐⭐⭐ Pi 官方示例 |
| **管道** | 确定性 5 阶段 | 自由定义 | 无（需自己写） |
| **崩溃恢复** | ✅ Markdown 文件 | ⚠️ 仅 session 级 | ❌ |
| **子代理** | ✅ 4 个内置 worker | 可选集成 | ✅ single/parallel/chain |
| **验证** | ✅ VERIFY + enforce | 需自己实现 | ❌ |
| **远程控制** | ✅ 手机 Web + Push | ❌ | ❌ |
| **本地 LLM** | ✅ 循环检测等 | ❌ | ❌ |
| **许可证** | AGPL-3.0 | 自定义 | MIT |
| **安装** | `pi install npm:...` | 手动复制文件 | 手动复制文件 |
| **月度下载** | 20K/月 | N/A | N/A |

## 五、结论

**Pi 完全具备实现 Goal Mode 的能力。** 其核心理念"原语而非特性"意味着所有基础能力（事件系统、工具管理、上下文注入、会话持久化）都已就绪。

**推荐路径：**

1. **首选** → 安装 `@mjasnikovs/pi-task`，直接用 `/task` 和 `/task-auto`
2. **需要自定义管道** → fork pi-task 修改阶段顺序
3. **AGPL 不适用** → 基于 subagent 扩展 + plan-mode 模式自建（~100 行）
4. **只需底层能力** → 用 Pi 内置 subagent 扩展作为子任务委派组件
