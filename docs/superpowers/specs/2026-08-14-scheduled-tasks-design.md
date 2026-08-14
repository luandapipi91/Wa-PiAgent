# 定时任务系统设计规格

## 概述

在 HiAgent 中新增「自动化」功能模块，允许用户创建定时任务，按计划自动触发智能体执行。任务指令中通过 `@` 标记 IM 渠道，Agent 执行时根据指令自主决定推送内容和推送目标。

## 设计决策

| 决策项 | 选择 | 理由 |
| -------- | ------ | ------ |
| 入口位置 | 侧边栏新 Tab（任务 \| IM \| **自动化**） | 与现有导航同级，切换便捷 |
| 角色选择 | 复用已有智能体（Agent） | 无需新建角色体系 |
| 快捷命令 | `$` 插入技能，`@` 关联 IM 渠道 | `$` 与现有触发符一致；`@` 在任务上下文中指向 IM 而非智能体 |
| 任务执行 | 每次触发创建新会话 | 保持隔离，便于追溯 |

## 架构

### 整体流程

```
用户创建任务（选择智能体 + 设定时间 + 编写指令）
  指令中用 @企微群 @飞书群 标记可推送的 IM 渠道
       │
       ▼
  定时调度引擎（kernel 进程内 cron）
       │  到达计划时间
       ▼
  解析指令中的 @ 标记 → 提取可用渠道列表
       │
       ▼
  创建新会话（使用选中智能体 + 工作目录）
       │  注入 robot_push 工具（携带可用渠道列表）
       ▼
  发送任务指令（含 @渠道 上下文）
       │
       ▼
  智能体执行 ──→ 根据 @ 提示自主选择渠道调用 robot_push
       │
       ▼
  记录执行结果（成功/失败 + 推送状态）
```

### 前端组件结构

```
Sidebar.tsx
  ├── main-tabs: 任务 | IM | 自动化
  └── 自动化 Tab 内容:
      ├── AutomationSidebar (紧凑任务卡片列表 + 新建按钮)
      └── MainContent (根据状态切换):
          ├── TaskDetailView (任务详情 + 最近执行)
          ├── TaskEditForm (新建/编辑表单)
          └── ExecutionRecords (执行记录列表)
```

### 数据模型

```typescript
// packages/shared/src/types.ts 新增

/** 定时任务 */
interface ScheduledTask {
  id: string;
  name: string;                  // 任务名称
  schedule: {
    type: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';
    time: string;                // "09:30"
    dayOfWeek?: number;          // weekly: 0-6 (0=周日)
    dayOfMonth?: number;         // monthly: 1-31
    cronExpression?: string;     // custom: 标准 cron 表达式
  };
  agentId: string;               // 执行角色（已有智能体 ID）
  prompt: string;                // 任务指令（含 $skill 标记和 @channel 标记）
  projectId?: string;            // 工作目录（项目 ID）
  enabled: boolean;              // 启用/禁用开关
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
}

/** 执行记录 */
interface ExecutionRecord {
  id: string;
  taskId: string;
  taskName: string;
  status: 'running' | 'success' | 'failed';
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  sessionId?: string;            // 关联会话 ID（可点击跳转查看对话）
  pushResults?: Array<{
    channelId: string;
    channelName: string;
    success: boolean;
    error?: string;
  }>;
  error?: string;                // 失败原因
  summary?: string;              // 执行摘要（agent 最后输出）
}
```

## 功能详细设计

### 1. 侧边栏改造

**改动文件：** `packages/frontend/src/components/Sidebar.tsx`

当前 main-tabs 为 `任务 | IM` 两项，改为 `任务 | IM | 自动化` 三项。

```typescript
// 现有
const [tab, setTab] = useState<'tasks' | 'im'>('tasks');

// 改为
const [tab, setTab] = useState<'tasks' | 'im' | 'automation'>('tasks');
```

- 选中「自动化」时，sidebar 内容区渲染 `AutomationSidebar` 组件
- sidebar 底部保持现有「系统设置」「回收站」不变
- 主内容区（右侧）根据自动化内部状态切换：任务详情 / 编辑表单 / 执行记录

### 2. 自动化侧边栏（AutomationSidebar）

**新建文件：** `packages/frontend/src/components/automation/AutomationSidebar.tsx`

紧凑任务卡片列表，每张卡片包含：

- 任务标题 + 启用开关（toggle）
- 计划时间（如「每天 09:30」）
- IM 推送标记（绿色 📨 徽章，仅绑定了渠道时显示）
- 选中态高亮（蓝色边框 + 背景）

顶部工具栏：

- 任务计数 `定时任务 (n)`
- `+ 新建` 按钮

点击卡片 → 主内容区展示 TaskDetailView。
点击 `+ 新建` → 主内容区展示 TaskEditForm（空表单）。

### 3. 任务详情视图（TaskDetailView）

**新建文件：** `packages/frontend/src/components/automation/TaskDetailView.tsx`

四宫格信息卡片：

- **计划时间**：🕐 每天 09:30
- **执行角色**：🤖 智能体名称
- **推送渠道**：📨 IM 渠道名（无绑定则显示「无」）
- **工作目录**：📂 项目名

任务指令区域：

- 展示 prompt 原文，`$技能` 显示为紫色标签，`@渠道` 显示为绿色标签

操作按钮：

- `▶ 立即执行`：手动触发一次（不等计划时间）
- `✏️ 编辑`：切换到编辑表单

最近执行（最近 3 条）：

- 成功 ✓ / 失败 ✕ / 运行中 ⟳
- 时间 + 耗时 + 推送状态

### 4. 新建/编辑表单（TaskEditForm）

**新建文件：** `packages/frontend/src/components/automation/TaskEditForm.tsx`

表单字段：

| 字段 | 类型 | 说明 |
| ------ | ------ | ------ |
| 任务名称 | text input | 必填 |
| 计划时间 | select + time picker | 频率下拉（每天/工作日/每周/每月/自定义 Cron）+ 时间输入 |
| 执行角色 | 智能体选项卡 | 从已有智能体列表中选择，单选 |
| 任务指令 | 富文本输入框 | 支持 `$` 插入技能、`@` 关联 IM 渠道（见下方详细设计） |
| 工作目录 | 目录选择 + 项目下拉 | 选择工作目录和关联项目 |

底部：`取消` + `保存任务`

#### 任务指令输入框（TaskPromptComposer）

**新建文件：** `packages/frontend/src/components/automation/TaskPromptComposer.tsx`

复用现有 `quick-invoke/trigger.ts` 的检测逻辑，但行为调整：

| 触发符 | 现有行为（聊天） | 任务指令行为 |
| -------- | ------------------ | ------------- |
| `$` | 插入技能 | **插入技能**（不变） |
| `@` | 插入智能体 | **关联 IM 渠道**（改为渠道列表） |
| `#` | 插入文件 | 插入文件（不变） |
| `/` | 插入命令 | 不启用 |

输入框底部提示行：

```
⌨️ $ 插入技能    @ 关联 IM 渠道
```

选中后在文本中插入标签：

- `$daily-report` → `<span class="chip-skill">$/daily-report</span>`
- `@企微群` → `<span class="chip-im">@企微群</span>`

底层存储格式为纯文本：`...用 $/daily-report 生成报表，通过 @wecom-bot 推送。`（渠道存储 ID，显示时映射名称）。

### 5. 执行记录（ExecutionRecords）

**新建文件：** `packages/frontend/src/components/automation/ExecutionRecords.tsx`

筛选栏：

- 时间维度：按天 / 按周 / 按月（按钮组）
- 任务筛选：全部任务 / 指定任务（下拉）
- 状态筛选：全部状态 / 成功 / 失败 / 运行中（下拉）

记录列表，每条记录：

- 状态图标（✓ 绿 / ✕ 红 / ⟳ 蓝）
- 任务名称
- 执行时间 + 耗时
- 推送结果标记（`📨 已推送至企微群` 绿色标签，仅绑定了渠道时显示）
- 失败时显示错误原因（红色文字）
- 可点击展开查看执行详情（跳转到关联会话）

### 6. robot_push 工具（Agent 推送能力）

**新建文件：** `packages/kernel/src/tools/robot-push.ts`

当任务指令中包含 `@渠道` 标记时，解析出可用渠道列表，在创建执行会话时注入此工具。Agent 根据指令中的 `@` 上下文自主决定推送什么、推送给谁：

```typescript
// 工具定义
{
  name: "robot_push",
  description: "推送消息到 IM 渠道。根据任务指令中 @ 标记的渠道，选择目标渠道发送消息。",
  parameters: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        enum: ["bot_xxxx", "bot_yyyy", ...],  // 动态填充：从 prompt @ 标记解析出的渠道 ID
        description: "目标推送渠道 ID"
      },
      message: {
        type: "string",
        description: "要推送的消息内容，支持纯文本和 Markdown"
      }
    },
    required: ["channel", "message"]
  }
}
```

执行逻辑：

1. 从 prompt 中解析所有 `@bot_xxxx` 标记，提取可用渠道 ID 列表
2. 将渠道 ID 列表注入工具的 `channel` 枚举参数
3. Agent 根据指令上下文选择渠道 ID 并调用工具
4. 调用 `ChannelManager` 的出站消息接口发送消息
5. 返回推送结果（成功/失败）给 Agent
6. 记录推送结果到 ExecutionRecord

### 7. 定时调度引擎

**新建文件：** `packages/kernel/src/scheduler.ts`

使用 **Bun 内置 `Bun.cron` API**（v1.3.11+，项目当前 1.3.14），无需引入第三方框架：

```typescript
import type { CronJob } from "bun";

// schedule 类型 → cron 表达式转换
function toCronExpression(schedule: ScheduledTask['schedule']): string {
  const [h, m] = schedule.time.split(':');
  switch (schedule.type) {
    case 'daily':    return `${m} ${h} * * *`;
    case 'weekdays': return `${m} ${h} * * 1-5`;
    case 'weekly':   return `${m} ${h} * * ${schedule.dayOfWeek ?? 1}`;
    case 'monthly':  return `${m} ${h} ${schedule.dayOfMonth ?? 1} * *`;
    case 'custom':   return schedule.cronExpression ?? '* * * * *';
  }
}

class TaskScheduler {
  private jobs: Map<string, CronJob> = new Map();

  // 启动时加载所有 enabled 任务
  start(): void {
    for (const task of this.loadEnabledTasks()) {
      this.scheduleTask(task);
    }
  }

  // 使用 Bun.cron 注册任务
  scheduleTask(task: ScheduledTask): void {
    this.cancelTask(task.id); // 先取消旧的
    const expr = toCronExpression(task.schedule);
    const job = Bun.cron(expr, async () => {
      await this.executeTask(task);
    });
    this.jobs.set(task.id, job);
    // 计算下次执行时间用于展示
    task.nextRunAt = Bun.cron.parse(expr)?.getTime() ?? undefined;
  }

  // 取消任务
  cancelTask(taskId: string): void {
    this.jobs.get(taskId)?.stop();
    this.jobs.delete(taskId);
  }

  private async executeTask(task: ScheduledTask): Promise<void> {
    // 1. 创建执行记录（status: running）
    // 2. 通过 AgentManager 创建新会话（指定 agentId + projectId）
    // 3. 从 prompt 解析 @bot_xxxx 标记，提取渠道 ID 列表
    // 4. 若渠道列表非空，注入 robot_push 工具（携带渠道枚举）
    // 5. 发送 prompt（含 $skill 和 @channel 上下文）
    // 6. 等待执行完成
    // 7. 更新执行记录（status: success/failed + pushResults）
  }
}
```

`Bun.cron` 关键特性：

- **不重叠保证**：下一次触发在 handler（含 Promise）完成后才计算，不会叠加执行
- **`Bun.cron.parse(expr)`**：计算下次触发时间，用于 UI 展示「下次执行」
- **`CronJob.stop()`**：取消单个任务
- **标准 5 字段 cron**：支持 `*/15`、`1-5`、`JAN-DEC` 等，以及 `@daily`/`@weekly` 预定义
- **本地时区**：按系统本地时间调度
- **`bun --hot` 兼容**：热重载时自动停止旧 job 并重新注册
- **测试友好**：支持 `jest.useFakeTimers()` / `setSystemTime()`

启动时检查错过的任务（应用关闭期间），可选择补执行或跳过。

「保持系统唤醒」开关通过 `caffeinate`（macOS）/ 电源管理 API 实现（可选，后期迭代）。

### 8. 数据持久化

定时任务和执行记录存储在 kernel 的数据目录中（与 sessions、channels 同级）：

```
~/.wa-pi/data/
  ├── scheduled-tasks.json      // 任务定义
  └── execution-records.json    // 执行记录（或使用 SQLite，视数据量）
```

执行记录保留策略：默认保留 90 天，超期自动清理。

## API 设计

### REST 路由

**新建文件：** `packages/kernel/src/routes/scheduler.ts`

| 方法 | 路径 | 说明 |
| ------ | ------ | ------ |
| GET | `/api/scheduled-tasks` | 获取所有定时任务 |
| POST | `/api/scheduled-tasks` | 创建定时任务 |
| PUT | `/api/scheduled-tasks/:id` | 更新定时任务 |
| DELETE | `/api/scheduled-tasks/:id` | 删除定时任务 |
| POST | `/api/scheduled-tasks/:id/run` | 立即执行一次 |
| GET | `/api/scheduled-tasks/:id/records` | 获取指定任务的执行记录 |
| GET | `/api/execution-records` | 获取所有执行记录（支持筛选） |

### SSE 事件

| 事件 | 触发时机 | 数据 |
| ------ | ---------- | ------ |
| `scheduled-task:started` | 任务开始执行 | taskId, recordId |
| `scheduled-task:completed` | 任务执行完成 | taskId, recordId, status |
| `scheduled-task:pushed` | 消息推送完成 | taskId, channelId, success |
| `scheduled-tasks:changed` | 任务列表变更 | 刷新信号 |

## 前端 Store

**新建文件：** `packages/frontend/src/store/scheduler.ts`

```typescript
interface SchedulerStore {
  tasks: ScheduledTask[];
  records: ExecutionRecord[];
  selectedTaskId: string | null;
  view: 'detail' | 'edit' | 'records';

  // Actions
  loadTasks(): Promise<void>;
  loadRecords(filter?: RecordFilter): Promise<void>;
  createTask(data: CreateTaskInput): Promise<void>;
  updateTask(id: string, data: UpdateTaskInput): Promise<void>;
  deleteTask(id: string): Promise<void>;
  runTaskNow(id: string): Promise<void>;
  selectTask(id: string | null): void;
  setView(view: 'detail' | 'edit' | 'records'): void;
}
```

## 测试策略

### 单元测试（bun:test）

- **scheduler.ts**：调度时间计算（daily/weekdays/weekly/monthly/custom cron）、错过的任务处理
- **robot-push.ts**：工具参数校验、ChannelManager 调用、推送结果记录
- **prompt 解析**：`$skill` 和 `@channel` 标记的提取与转换

### 组件测试（Vitest + @testing-library/react）

- **AutomationSidebar**：任务列表渲染、选中态、开关切换
- **TaskEditForm**：表单校验、角色选择、提交
- **TaskPromptComposer**：`$` 和 `@` 触发检测、标签插入
- **ExecutionRecords**：筛选交互、状态展示

### API 集成测试（curl）

- CRUD 全路径（创建 → 查询 → 更新 → 删除）
- 立即执行接口
- 执行记录查询 + 筛选

### E2E 测试（Playwright）

- 完整流程：侧边栏切到自动化 → 新建任务 → 填写表单 → 保存 → 列表展示 → 立即执行 → 查看执行记录
- IM 渠道绑定场景的推送验证

## 实施顺序

1. **数据层**：shared 类型定义 + kernel 数据持久化 + REST 路由
2. **调度引擎**：scheduler.ts + robot-push.ts + AgentManager 集成
3. **前端基础**：store + sidebar Tab 改造 + AutomationSidebar
4. **前端表单**：TaskEditForm + TaskPromptComposer（`$` / `@` 触发）
5. **前端详情/记录**：TaskDetailView + ExecutionRecords
6. **联调测试**：四层测试全覆盖

## 范围外（本次不实现）

- 自定义 Cron 表达式可视化编辑器（先用文本输入）
- 任务执行失败的重试策略（先记录失败，手动重新执行）
- 「保持系统唤醒」的实际电源管理实现（先做 UI 开关，后端 noop）
- 执行记录的 SQLite 迁移（先用 JSON 文件，数据量大了再迁移）
