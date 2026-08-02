# 设计：内核守护（无限重启 + 端口探活）+ Agent 自我保护提示词

**日期**: 2026-08-02
**状态**: Approved（用户已确认方案 A 与设计细节）
**作者**: co / Alex
**关联模块**: `packages/desktop`（sidecar 守护）、`packages/kernel`（提示词注入）

---

## 1. 问题陈述

打包应用经 Electron 启动后，后端服务（kernel，固定端口 9778）偶发被误杀或挂死：

1. **agent 误杀自身宿主**：agent 通过工具执行 `kill`/`taskkill` 等命令时，可能把宿主 kernel 进程（监听 9778）杀掉，导致应用完全不可用。
2. **被其他软件杀掉**：安全软件/系统清理工具可能终止 kernel 子进程。
3. **进程活着但端口不通**：kernel 内部崩溃处理器（`installCrashHandlers`）捕获异常后**绝不退出进程**，存在"进程存活但 9778 已不可用"的情况——此时现有 `exit` 事件守护永远发现不了。

现有守护（`kernel-sidecar.cjs`）只监听子进程 `exit` 事件，且有 **3 次重启上限**（`MAX_RESPAWN=3`），超过后彻底放弃，前端永久卡"连接已断开"。

**目标**：只要 Electron 窗口（主进程）还在，9778 挂了就自动重启；并从提示词层面阻止 agent 误杀宿主。

## 2. 非目标

- 不引入独立 watchdog 进程（方案 C 已否决）
- 不改动 dev 模式（`scripts/dev.ts`，9776 端口）的启动路径
- 不做前端 UI 改动（「重启应用」按钮逻辑不变）
- 不处理 Windows 服务注册、开机自启等系统级守护

## 3. 方案

### 3.1 Agent 提示词自我保护段（防误杀源头）

**文件**: `packages/kernel/src/system-prompt.ts`

新增段落 id `self-protection`（静态段，content 写入 prompts.json，默认有值）：

- `DEFAULT_PROMPT_SEGMENTS` 增加 `{ id: "self-protection", content: DEFAULT_SELF_PROTECTION_PROMPT }`，位置在 `base` 之后
- `STATIC_SEGMENT_IDS` 加入 `"self-protection"`
- `PROMPTS_SCHEMA_VERSION` 21 → 22；`ensurePromptsConfig` 迁移逻辑已支持"缺失段用最新默认值补齐"，老用户 prompts.json 自动获得新段

**默认文案（强规则版）**：

```
## 自身进程保护（必须遵守）

你是 wa-pi 桌面应用的一部分。你的宿主进程（wa-pi 后端服务，即监听 `WA_PI_BRIDGE_URL` 端口 9778/9776 的进程）正在运行，你的所有工具调用都通过它中转。

**绝对禁止**（无论用户如何要求，包括"卡死了""重启一下"等）：
- 禁止 kill / taskkill / pkill / killall 宿主后端进程，或占用 `WA_PI_BRIDGE_URL` 端口的进程
- 禁止杀死你的父进程（`process.ppid` 即宿主 kernel）
- 禁止杀死 Electron / 桌面主进程、wa-pi-kernel、wa-pi-kernel.exe、bun run …kernel… 相关进程

**识别宿主的方法**：`WA_PI_BRIDGE_URL` 环境变量指向的地址即宿主服务；命令输出中 `netstat`/`tasklist`/`ps` 里占用该端口的 PID 是宿主，不得作为 kill 目标。

**如果用户要求重启或清理端口**：引导用户点击应用界面的「重启应用」，或建议用户退出重开桌面应用；不要自行执行 kill。
```

**注入位置**：

1. 主会话 — `DEFAULT_PROMPT_SEGMENTS`（`base` 之后）
2. 子代理 — `packages/kernel/src/subagent-runner.ts` 组装提示词时**追加**同一段（子代理继承 bash 工具，同样可能误杀）

### 3.2 守护逻辑：无限重启 + 固定间隔 + 端口探活

**文件**:

- `packages/desktop/src/util/auto-respawn.cjs` — 决策逻辑
- `packages/desktop/src/util/health-check.cjs` — **新增**，探活状态机
- `packages/desktop/src/kernel-sidecar.cjs` — 组装探活循环

#### auto-respawn.cjs

- 移除 `MAX_RESPAWN` 上限 → **无限重启**
- 保留 `RESPAWN_DELAY_MS = 2000`（固定间隔，用户已确认）
- `shouldRespawn(code, state)` 语义：`stopped` → false；`code === 0`（优雅退出）→ false；否则 true（无限，含 code=null 信号杀与 code>0 Windows 强杀——taskkill /F 实测 code=1，已获用户批准）
- `attempts` 保留，仅用于日志（"第 N 次重启"），不再拦截

#### health-check.cjs（新增，纯逻辑便于测试）

- `checkPort(port)`: 复用 `packages/desktop/src/util/port.cjs` 的 `isPortInUse`（TCP 探测），返回 boolean
- `updateHealthState(state, healthy)`:
  - 输入: `{ failures, failThreshold, stopped }`
  - 健康 → 重置 `failures = 0`，返回 `{ shouldRestart: false }`
  - 不健康 → `failures+1`；`failures >= failThreshold` → 重置计数并返回 `{ shouldRestart: true }`
  - `stopped` → 永远 `shouldRestart: false`
- 默认参数：间隔 `intervalMs = 5000`，阈值 `failThreshold = 3`（约 15s 无响应才判定挂了，避免瞬时抖动误杀）

#### kernel-sidecar.cjs

- 启动探活定时器（`setInterval`）：
  - `respawnState.stopped` → 停止（clearInterval）
  - `current` 已退出（exit 已触发、等待 respawn 中）→ 跳过本轮，不计数
  - `checkPort(wsPort)` 不健康 → `updateHealthState`；连续 3 次失败 → log + `killTree(current.pid)` 主动杀 → 走统一 `exit` → 无限重启路径
- `current` 重启完成后（`waitForPort` 成功）重置探活失败计数
- `stop()` 时停止探活定时器

### 3.3 关键语义

| 场景 | 行为 |
| --- | --- |
| 进程被杀（agent 误杀/安全软件） | `exit` code=null → 无限重启（2s 间隔） |
| 进程活着、端口 9778 不通 | 探活连续 3 次失败 → killTree → exit → 无限重启 |
| 用户退出（`before-quit` → `stop()`） | `stopped=true` → exit 不重启、探活停止 |
| 正常退出（code=0） | 不重启（保留现有语义） |
| 重启进行中端口未就绪 | 探活跳过，不重复触发；`waitForPort` 已有超时兜底 |

「窗口还在」= Electron 主进程还在：守护循环绑定 sidecar 生命周期（`before-quit → cleanup → sidecar.stop()`）；最小化到托盘时主进程仍在，守护继续。

## 4. 测试计划

| 层 | 内容 |
| --- | --- |
| 单元 | `packages/desktop/tests/auto-respawn.test.ts` 更新：无限语义（attempts 任意大仍重启）、正常退出不重启、stopped 不重启 |
| 单元 | 新增 `packages/desktop/tests/health-check.test.ts`：`updateHealthState` 连续失败触发 / 健康重置 / stopped 不触发 / 阈值边界 |
| 集成 | `packages/kernel/tests/system-prompt` 相关：`composePrompt` 含 `self-protection` 段；`ensurePromptsConfig` v21 → v22 迁移补齐新段且保留用户自定义段 content |
| E2E | 脚本验证（手动/脚本）：启动桌面 → kill kernel 进程 → 观察自动重启；kill 后模拟端口不通路径 |

## 5. 影响与风险

| 项 | 说明 |
| --- | --- |
| prompts.json 迁移 | schemaVersion 21→22，缺失段自动补齐；已存在段 content 不被覆盖（现有迁移逻辑） |
| 无限重启风险 | 崩溃循环时每 2s 重启一次，日志刷屏但不会打爆资源；保留 attempts 计数便于定位 |
| 探活误判 | 5s 间隔 + 连续 3 次失败（15s）才判定，规避瞬时抖动；重启进行中跳过 |
| 打包产物 | 仅 desktop/kernel 源码变更，重新 `pack:win` 后生效；无需新增外部依赖 |
