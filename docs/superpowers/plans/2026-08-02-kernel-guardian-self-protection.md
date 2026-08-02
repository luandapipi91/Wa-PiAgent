# 内核守护 + Agent 自我保护 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让桌面端 kernel（9778）在 Electron 窗口存活期间无限自动重启（含端口探活兜底），并从提示词层面阻止 agent 误杀宿主。

**架构：** ① desktop 侧 `auto-respawn.cjs` 改为无限重启策略；新增 `health-check.cjs` 端口探活状态机，`kernel-sidecar.cjs` 接入探活定时器，连续 3 次探测失败强杀 kernel 走统一重启路径。② kernel 侧 `system-prompt.ts` 新增 `self-protection` 静态段（禁止 kill 宿主进程），`subagent-runner.ts` 组装子代理提示词时追加同一段。

**技术栈：** bun（bun:test）、Node child_process、Electron main process、TypeScript（kernel）/ CommonJS（desktop）。

**规格：** `docs/superpowers/specs/2026-08-02-kernel-guardian-self-protection-design.md`

---

## 文件结构

| 文件 | 职责 | 操作 |
| --- | --- | --- |
| `packages/desktop/src/util/auto-respawn.cjs` | 崩溃重启决策：无限重启 + 固定间隔 2s | 修改 |
| `packages/desktop/src/util/health-check.cjs` | **新增**：端口探活状态机（checkPort / updateHealthState） | 创建 |
| `packages/desktop/src/kernel-sidecar.cjs` | 组装探活定时器、强杀路径、无限重启 | 修改 |
| `packages/desktop/tests/auto-respawn.test.ts` | 无限重启决策测试 | 修改 |
| `packages/desktop/tests/health-check.test.ts` | **新增**：探活状态机测试 | 创建 |
| `packages/kernel/src/system-prompt.ts` | `self-protection` 段 + `composeSubagentPrompt` + schemaVersion 22→23 | 修改 |
| `packages/kernel/src/subagent-runner.ts` | 子代理提示词追加自我保护段 | 修改 |
| `packages/kernel/tests/system-prompt.test.ts` | 段落/顺序/迁移测试更新 + 新段单测 | 修改 |
| `CHANGELOG.md` | 变更记录 | 修改 |

---

## 任务 1：auto-respawn 无限重启

**文件：**

- 修改：`packages/desktop/src/util/auto-respawn.cjs`
- 测试：`packages/desktop/tests/auto-respawn.test.ts`

先确认 MAX_RESPAWN 的全部引用点（计划外的引用要一并处理）：

```bash
grep -rn "MAX_RESPAWN" packages/desktop/ --include="*.cjs" --include="*.test.ts"
```

预期：仅 `auto-respawn.cjs` 定义 + `kernel-sidecar.cjs` 引用 + `auto-respawn.test.ts` 引用。

- [ ] **步骤 1：编写失败的测试**

将 `packages/desktop/tests/auto-respawn.test.ts` 整体替换为：

```ts
import { test, expect } from "bun:test";
import { shouldRespawn, RESPAWN_DELAY_MS } from "../src/util/auto-respawn.cjs";

// auto-respawn：kernel sidecar 崩溃（被信号杀 code=null）后自动重启的决策逻辑。
// 策略：无限重启 + 固定间隔。attempts 仅用于日志，不再拦截。

// RespawnState 形状（cjs 无 TS 类型，本地定义）
interface RespawnState { stopped: boolean; attempts: number; }

function freshState(): RespawnState {
  return { stopped: false, attempts: 0 };
}

test("shouldRespawn: code=null 且未主动停止 → 应重启", () => {
  expect(shouldRespawn(null, freshState())).toBe(true);
});

test("shouldRespawn: code=0（正常退出）→ 不重启", () => {
  expect(shouldRespawn(0, freshState())).toBe(false);
});

test("shouldRespawn: 已主动 stop() → 不重启（即使命令崩溃）", () => {
  const s = freshState();
  s.stopped = true;
  expect(shouldRespawn(null, s)).toBe(false);
});

test("shouldRespawn: 无限重启——attempts 任意大仍重启", () => {
  const s = freshState();
  s.attempts = 999;
  expect(shouldRespawn(null, s)).toBe(true);
});

test("常量: RESPAWN_DELAY_MS 为正数（固定间隔）", () => {
  expect(RESPAWN_DELAY_MS).toBeGreaterThan(0);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd packages/desktop && bun test tests/auto-respawn.test.ts`
预期：FAIL——`shouldRespawn` 仍引用 `MAX_RESPAWN` 导致"attempts 任意大"断言不通过（旧逻辑 attempts >= 3 返回 false）；同时 `MAX_RESPAWN` 导入报错。

- [ ] **步骤 3：编写最少实现代码**

将 `packages/desktop/src/util/auto-respawn.cjs` 整体替换为：

```js
// auto-respawn.cjs — kernel sidecar 崩溃自动重启的决策逻辑（纯函数，便于测试）
//
// 背景：kernel 是 desktop spawn 的子进程。历史 bug 中 kernel 被 Bun 因未捕获异常
// 杀死（exit code=null），但 kernel-sidecar.cjs 的 child.on("exit") 只 log 不重启，
// 前端永远卡在"连接已断开，正在重连"。本模块封装"是否该重启"的决策，供 sidecar 组装。
// 策略：无限重启 + 固定间隔（attempts 仅用于日志计数，不再拦截）。

/** 重启延迟（毫秒）——固定间隔，无限重启 */
const RESPAWN_DELAY_MS = 2000;

/** 重启状态：sidecar 持有，随生命周期更新 */
// @ts-check
/**
 * @typedef {Object} RespawnState
 * @property {boolean} stopped - 用户主动 stop() 后置 true，禁止重启
 * @property {number} attempts - 已重启次数（仅用于日志）
 */

/**
 * 判断 kernel 子进程退出后是否应自动重启（无限重启策略）。
 *
 * @param {number|null} code - 子进程 exit code（null = 被信号杀/崩溃）
 * @param {RespawnState} state - 重启状态
 * @returns {boolean} 是否应重启
 */
function shouldRespawn(code, state) {
  // 用户主动退出（stop()）→ 绝不重启
  if (state.stopped) return false;
  // 仅崩溃（被信号杀）才重启；正常退出（code=0）或显式错误退出（code>0）不重启
  if (code !== null) return false;
  // 无限重启：只要未主动停止，崩溃就拉起（attempts 仅用于日志计数）
  return true;
}

module.exports = { shouldRespawn, RESPAWN_DELAY_MS };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd packages/desktop && bun test tests/auto-respawn.test.ts`
预期：PASS，5 个测试全部通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/desktop/src/util/auto-respawn.cjs packages/desktop/tests/auto-respawn.test.ts
git commit -m "feat(desktop): kernel sidecar 崩溃改为无限自动重启（移除 3 次上限）"
```

---

## 任务 2：新增 health-check 端口探活模块

**文件：**

- 创建：`packages/desktop/src/util/health-check.cjs`
- 测试：`packages/desktop/tests/health-check.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `packages/desktop/tests/health-check.test.ts`：

```ts
import { test, expect } from "bun:test";
import { createServer } from "node:net";
import {
  updateHealthState,
  checkPort,
  HEALTH_FAIL_THRESHOLD,
  HEALTH_CHECK_INTERVAL_MS,
} from "../src/util/health-check.cjs";
import { findAvailablePort } from "../src/util/port.cjs";

// health-check：端口探活状态机。
// 连续失败达到阈值才判定「挂了」（规避瞬时抖动）；健康立即重置；stopped 永不触发重启。

interface HealthState { failures: number; failThreshold: number; stopped: boolean; }

function freshState(): HealthState {
  return { failures: 0, failThreshold: HEALTH_FAIL_THRESHOLD, stopped: false };
}

test("updateHealthState: 健康 → 重置失败计数且不重启", () => {
  const s = freshState();
  s.failures = 2;
  expect(updateHealthState(s, true)).toEqual({ shouldRestart: false, failures: 0 });
});

test("updateHealthState: 连续失败未达阈值 → 计数增加但不重启", () => {
  const s = freshState();
  const r = updateHealthState(s, false);
  expect(r.shouldRestart).toBe(false);
  expect(r.failures).toBe(1);
});

test("updateHealthState: 连续失败达到阈值 → 触发重启并重置计数", () => {
  const s = freshState();
  s.failures = HEALTH_FAIL_THRESHOLD - 1;
  const r = updateHealthState(s, false);
  expect(r.shouldRestart).toBe(true);
  expect(r.failures).toBe(0);
});

test("updateHealthState: 已停止 → 永不触发重启", () => {
  const s = freshState();
  s.stopped = true;
  s.failures = HEALTH_FAIL_THRESHOLD;
  expect(updateHealthState(s, false).shouldRestart).toBe(false);
});

test("checkPort: 端口被监听（健康）→ true", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    expect(await checkPort(port)).toBe(true);
  } finally {
    server.close();
  }
});

test("checkPort: 端口未监听（挂了）→ false", async () => {
  const freePort = await findAvailablePort(50000);
  expect(await checkPort(freePort)).toBe(false);
});

test("常量: 探活间隔与失败阈值均为正数", () => {
  expect(HEALTH_CHECK_INTERVAL_MS).toBeGreaterThan(0);
  expect(HEALTH_FAIL_THRESHOLD).toBeGreaterThan(0);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd packages/desktop && bun test tests/health-check.test.ts`
预期：FAIL——模块 `../src/util/health-check.cjs` 不存在，导入报错。

- [ ] **步骤 3：编写最少实现代码**

创建 `packages/desktop/src/util/health-check.cjs`：

```js
// health-check.cjs — kernel sidecar 端口探活状态机（纯逻辑，便于测试）
//
// 背景：kernel 崩溃处理器捕获异常后不退出进程（crash-logger 只写日志），
// 存在「进程存活但 9778 端口已不可用」的情况，仅靠 child.on("exit") 永远发现不了。
// 本模块封装「端口是否健康」的判定与连续失败计数，供 sidecar 定期探活：
// 连续失败达到阈值 → 判定挂了 → 主动强杀走统一重启路径。
const { isPortInUse } = require("./port.cjs");

/** 探活间隔（毫秒） */
const HEALTH_CHECK_INTERVAL_MS = 5000;
/** 连续失败多少次判定「挂了」（5s × 3 ≈ 15s 无响应，规避瞬时抖动） */
const HEALTH_FAIL_THRESHOLD = 3;
/** 单次探测超时（毫秒），防 isPortInUse 挂起 */
const HEALTH_CHECK_TIMEOUT_MS = 2000;

/**
 * 探测端口是否被监听（健康）。复用 port.cjs 的 isPortInUse：
 * 端口被占用（kernel 在监听）→ true；空闲 → false；超时 → false（不健康）。
 *
 * @param {number} port
 * @param {number} [timeoutMs=HEALTH_CHECK_TIMEOUT_MS]
 * @returns {Promise<boolean>}
 */
function checkPort(port, timeoutMs = HEALTH_CHECK_TIMEOUT_MS) {
  return Promise.race([
    isPortInUse(port),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

/**
 * 探活状态更新（纯函数）。
 *
 * @param {{ failures: number, failThreshold: number, stopped: boolean }} state
 * @param {boolean} healthy - 本轮探测是否健康
 * @returns {{ shouldRestart: boolean, failures: number }}
 */
function updateHealthState(state, healthy) {
  if (state.stopped) return { shouldRestart: false, failures: state.failures };
  if (healthy) return { shouldRestart: false, failures: 0 };
  const failures = state.failures + 1;
  if (failures >= state.failThreshold) {
    return { shouldRestart: true, failures: 0 };
  }
  return { shouldRestart: false, failures };
}

module.exports = {
  checkPort,
  updateHealthState,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_FAIL_THRESHOLD,
  HEALTH_CHECK_TIMEOUT_MS,
};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd packages/desktop && bun test tests/health-check.test.ts`
预期：PASS，7 个测试全部通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/desktop/src/util/health-check.cjs packages/desktop/tests/health-check.test.ts
git commit -m "feat(desktop): 新增 kernel 端口健康探活状态机（health-check）"
```

---

## 任务 3：kernel-sidecar 接入无限重启 + 探活

**文件：**

- 修改：`packages/desktop/src/kernel-sidecar.cjs`

> 本任务是进程编排逻辑（spawn/exit/timer 集成），不新增单测文件——决策逻辑已由任务 1/2 的纯函数测试覆盖。步骤 4 跑 desktop 全量测试做回归。

- [ ] **步骤 1：修改 import 与顶部常量**

将文件头部改为（移除 `MAX_RESPAWN` 引用，新增 health-check 与强杀函数）：

```js
// spawn 解释运行的 kernel sidecar：dev 下 bun run <repo>/packages/kernel/src/desktop-server.ts；
// packaged 下 <kernelDir>/wa-pi-kernel(.exe) run <kernelDir>/kernel.js。等 9778 ready；退出时 kill 子进程树。
// 守护策略：无限自动重启（固定间隔 2s）+ 端口健康探活（5s 间隔，连续 3 次失败强杀重启）。
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const { waitForPort } = require("./util/port.cjs");
const { shouldRespawn, RESPAWN_DELAY_MS } = require("./util/auto-respawn.cjs");
const {
  checkPort,
  updateHealthState,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_FAIL_THRESHOLD,
} = require("./util/health-check.cjs");

const WS_PORT = Number(process.env.WA_PI_WS_PORT) > 0 ? Number(process.env.WA_PI_WS_PORT) : 9778;

function killTree(pid) {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {}
}

// 强杀（探活判定挂了时用）：POSIX SIGKILL / Windows taskkill /F，保证 exit code=null 走统一崩溃重启路径。
// 不能用 killTree（POSIX 下 SIGTERM 会被 kernel 优雅退出 code=0，shouldRespawn 不重启）。
function forceKill(pid) {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {}
}
```

- [ ] **步骤 2：修改 spawnOnce / exit 处理 / 探活 / stop**

将 `startSidecar` 内部（从 `const respawnState = ...` 到 `return {...}`）整体替换为：

```js
  // 守护状态：stopped（用户主动退出）+ attempts（重启计数，仅日志）+ failures（探活连续失败计数）
  const respawnState = { stopped: false, attempts: 0, failures: 0, failThreshold: HEALTH_FAIL_THRESHOLD };
  let current = null; // 当前 child 引用（重启时替换）
  let childExited = false; // 当前 child 是否已退出（重启间隙探活跳过，避免误判）
  let healthTimer = null;

  // 创建一个 kernel 子进程并绑定日志/崩溃重启。返回 child。
  function spawnOnce() {
    childExited = false;
    const child = spawn(cmd, finalArg, spawnOpts);
    child.on("error", (e) => log.error(`[kernel] spawn error: ${e.message}`));
    child.stdout.on("data", (d) => log.info(`[kernel] ${d.toString().trim()}`));
    child.stderr.on("data", (d) => log.error(`[kernel] ${d.toString().trim()}`));
    child.on("exit", (code, signal) => {
      childExited = true;
      // code=null 表示被信号杀；signal 才是定位根因的关键（SIGTERM=被主动杀，
      // SIGKILL=强制杀/可能 OOM，SIGSEGV=段错误）。crash-logger 只能抓 JS 异常，
      // 信号杀死不进 JS，故这里必须记录 signal。
      log.info(`[kernel] 退出 code=${code} signal=${signal ?? "none"}`);
      // 崩溃（被信号杀 code=null）且非用户主动退出 → 固定间隔后无限自动重启
      if (shouldRespawn(code, respawnState)) {
        respawnState.attempts++;
        log.info(`[kernel] 崩溃自动重启 第 ${respawnState.attempts} 次，${RESPAWN_DELAY_MS}ms 后 respawn...`);
        setTimeout(() => {
          if (respawnState.stopped) return; // 退避期间用户退出了
          current = spawnOnce();
          // 重启后等待端口就绪（不就绪则下次 exit 会再触发）
          waitForPort(wsPort, 30000).then((ready) => {
            if (ready) {
              log.info(`[kernel] 重启就绪 @${wsPort}`);
              respawnState.attempts = 0;
              respawnState.failures = 0;
            } else log.error(`[kernel] 重启后 30s 未就绪`);
          });
        }, RESPAWN_DELAY_MS);
      }
    });
    return child;
  }

  // 探活循环：每 5s 探测端口；连续 3 次失败 → 强杀走统一重启。stopped / 重启间隙 / 上轮未完成 跳过。
  function startHealthCheck() {
    let inFlight = false;
    healthTimer = setInterval(async () => {
      if (respawnState.stopped || childExited || inFlight || !current?.pid) return;
      inFlight = true;
      try {
        const healthy = await checkPort(wsPort);
        const { shouldRestart, failures } = updateHealthState(respawnState, healthy);
        respawnState.failures = failures;
        if (shouldRestart) {
          log.error(`[kernel] 端口 ${wsPort} 连续 ${respawnState.failThreshold} 次探测失败，判定挂死，强杀重启`);
          forceKill(current.pid); // exit 事件会触发统一崩溃重启
        }
      } finally {
        inFlight = false;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    if (healthTimer.unref) healthTimer.unref(); // 不阻塞主进程退出
  }

  current = spawnOnce();
  log.info(`kernel sidecar pid=${current.pid} cmd=${cmd} ${arg.join(" ")} port=${wsPort}`);
  const ready = await waitForPort(wsPort, 30000);
  if (!ready) { respawnState.stopped = true; log.error("kernel sidecar 30s 未就绪"); killTree(current.pid); throw new Error("kernel not ready"); }
  log.info(`kernel 就绪 @${wsPort}`);
  startHealthCheck();
  return {
    child: current,
    pid: current.pid,
    port: wsPort,
    // 主动停止：置 stopped 标志后 kill，防止 exit handler 误判为崩溃而重启；停止探活
    stop: () => {
      respawnState.stopped = true;
      if (healthTimer) clearInterval(healthTimer);
      killTree(current?.pid);
    },
  };
```

- [ ] **步骤 3：验证修改后文件无残留 MAX_RESPAWN / 语法正确**

运行：

```bash
grep -n "MAX_RESPAWN" packages/desktop/src/kernel-sidecar.cjs; echo "exit=$?"   # 预期无输出（grep 非零）
cd packages/desktop && bun -e "require('./src/kernel-sidecar.cjs'); console.log('syntax ok')"
```

- [ ] **步骤 4：运行 desktop 全量测试回归**

运行：`cd packages/desktop && bun test`
预期：全部 PASS（auto-respawn、health-check、menu、paths、port、recording-handlers、web-preferences）。

- [ ] **步骤 5：Commit**

```bash
git add packages/desktop/src/kernel-sidecar.cjs
git commit -m "feat(desktop): sidecar 接入端口健康探活，端口挂死时强杀走无限重启"
```

---

## 任务 4：system-prompt 新增 self-protection 段

**文件：**

- 修改：`packages/kernel/src/system-prompt.ts`
- 测试：`packages/kernel/tests/system-prompt.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `packages/kernel/tests/system-prompt.test.ts`：

1. import 处增加：

```ts
 DEFAULT_SELF_PROTECTION_PROMPT,
 composeSubagentPrompt,
```

1. 更新「composePrompt 默认段落全部出现」测试（7 段），在 `expect(result).toContain(WA_PI_DEFAULT_BASE_PROMPT);` 前插入：

```ts
 expect(result).toContain(DEFAULT_SELF_PROTECTION_PROMPT);
```

1. 更新「顺序」测试，在 `const basePos = ...` 附近加 self-protection 位置断言（base 之后、delegate-mechanism 之前），并在断言区插入：

```ts
 const selfProtPos = result.indexOf(DEFAULT_SELF_PROTECTION_PROMPT);
 expect(basePos).toBeLessThan(selfProtPos);
 expect(selfProtPos).toBeLessThan(mechanismPos);
```

1. 在「composePrompt 静态段（delegate-mechanism）没写 content」测试之后新增：

```ts
test("composePrompt 静态段（self-protection）默认有 content → 默认提示词出现", () => {
 const result = composePrompt(DEFAULT_PROMPT_SEGMENTS, defaultCtx);
 expect(result).toContain("自身进程保护（必须遵守）");
 expect(result).toContain("禁止 kill / taskkill / pkill / killall");
});

test("composePrompt 静态段（self-protection）没写 content → 返回空串（不出现）", () => {
 const result = composePrompt([{ id: "self-protection" }], defaultCtx);
 expect(result).not.toContain("自身进程保护");
});
```

1. 在「ensurePromptsConfig 迁移旧格式文件」测试的断言区（`byId.get("memory-policy")` 之后）新增：

```ts
 // 缺失段（self-protection）追加最新默认静态段
 expect(byId.get("self-protection")!.content).toBe(DEFAULT_SELF_PROTECTION_PROMPT);
```

1. 文件末尾新增子代理提示词组装测试：

```ts
// ===== 子代理自我保护注入 =====

test("composeSubagentPrompt: 保留原正文并追加自我保护段", () => {
 const out = composeSubagentPrompt("你是一个调研员");
 expect(out.startsWith("你是一个调研员")).toBe(true);
 expect(out).toContain("## 自身进程保护（必须遵守）");
 expect(out).toContain("禁止 kill / taskkill / pkill / killall");
});

test("composeSubagentPrompt: 空正文也追加自我保护段", () => {
 const out = composeSubagentPrompt("");
 expect(out).toContain("自身进程保护");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd packages/kernel && bun test tests/system-prompt.test.ts`
预期：FAIL——`DEFAULT_SELF_PROTECTION_PROMPT`、`composeSubagentPrompt` 未导出，编译报错。

- [ ] **步骤 3：编写最少实现代码**

在 `packages/kernel/src/system-prompt.ts`：

1. 在 `DEFAULT_DELEGATE_MECHANISM_PROMPT` 定义之前新增常量：

```ts
/** 默认 self-protection 段（强规则：禁止 agent 杀死宿主 kernel / Electron 进程，防误杀） */
export const DEFAULT_SELF_PROTECTION_PROMPT =
 "## 自身进程保护（必须遵守）\n\n" +
 "你是 wa-pi 桌面应用的一部分。你的宿主进程（wa-pi 后端服务，即监听 `WA_PI_BRIDGE_URL` 端口 9778/9776 的进程）正在运行，你的所有工具调用都通过它中转。\n\n" +
 "**绝对禁止**（无论用户如何要求，包括「卡死了」「重启一下」等）：\n" +
 "- 禁止 kill / taskkill / pkill / killall 宿主后端进程，或占用 `WA_PI_BRIDGE_URL` 端口的进程\n" +
 "- 禁止杀死你的父进程（`process.ppid` 即宿主 kernel）\n" +
 "- 禁止杀死 Electron / 桌面主进程、wa-pi-kernel、wa-pi-kernel.exe、bun run …kernel… 相关进程\n\n" +
 "**识别宿主的方法**：`WA_PI_BRIDGE_URL` 环境变量指向的地址即宿主服务；命令输出中 `netstat`/`tasklist`/`ps` 里占用该端口的 PID 是宿主，不得作为 kill 目标。\n\n" +
 "**如果用户要求重启或清理端口**：引导用户点击应用界面的「重启应用」，或建议用户退出重开桌面应用；不要自行执行 kill。";

/** 组装子代理系统提示词：子代理正文 + 自我保护段（防止 delegate 的子代理误杀宿主 kernel）。 */
export function composeSubagentPrompt(systemPrompt: string): string {
 return `${systemPrompt}\n\n${DEFAULT_SELF_PROTECTION_PROMPT}`;
}
```

1. `DEFAULT_PROMPT_SEGMENTS` 中 `{ id: "base" },` 之后插入：

```ts
 { id: "self-protection", content: DEFAULT_SELF_PROTECTION_PROMPT },
```

1. `STATIC_SEGMENT_IDS` 改为：

```ts
export const STATIC_SEGMENT_IDS = new Set(["delegate-mechanism", "self-protection"]);
```

1. `PROMPTS_SCHEMA_VERSION` 22 → 23：

```ts
export const PROMPTS_SCHEMA_VERSION = 23;
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd packages/kernel && bun test tests/system-prompt.test.ts`
预期：PASS（含新增 4 个测试 + 更新后的段落/顺序/迁移断言）。

- [ ] **步骤 5：Commit**

```bash
git add packages/kernel/src/system-prompt.ts packages/kernel/tests/system-prompt.test.ts
git commit -m "feat(kernel): 系统提示词新增 self-protection 段（禁止误杀宿主），schemaVersion 22→23"
```

---

## 任务 5：subagent-runner 子代理提示词注入

**文件：**

- 修改：`packages/kernel/src/subagent-runner.ts`

> 行为由任务 4 的 `composeSubagentPrompt` 单测覆盖；本任务只接线。步骤 2 跑 subagent-runner 全量测试确认不回归。

- [ ] **步骤 1：修改提示词写入**

在 `packages/kernel/src/subagent-runner.ts`：

1. import 区增加（与现有 `import { join } from "node:path"` 等并列）：

```ts
import { composeSubagentPrompt } from "./system-prompt";
```

1. 将 `await writeFile(promptFile, config.systemPrompt, "utf8");` 改为：

```ts
   await writeFile(promptFile, composeSubagentPrompt(config.systemPrompt), "utf8");
```

- [ ] **步骤 2：运行测试回归**

运行：`cd packages/kernel && bun test tests/subagent-runner.test.ts tests/agent-manager-subagent-overrides.test.ts`
预期：全部 PASS（现有测试用 fake-pi 只断言 argv 含 `--system-prompt` 与文件路径，不检查内容，不受影响）。

- [ ] **步骤 3：Commit**

```bash
git add packages/kernel/src/subagent-runner.ts
git commit -m "feat(kernel): 子代理提示词追加自我保护段，防 delegate 子代理误杀宿主"
```

---

## 任务 6：全量回归 + CHANGELOG + 手动验证

**文件：**

- 修改：`CHANGELOG.md`

- [ ] **步骤 1：全仓测试**

运行（根目录）：`bun run test`
预期：kernel / shared / desktop / frontend 四个 package 全部 PASS。

- [ ] **步骤 2：更新 CHANGELOG.md**

在根目录 `CHANGELOG.md` 顶部新增（时间倒序）：

```markdown
## [2026-08-02]

### 新增
- 内核守护增强：kernel sidecar 崩溃改为无限自动重启（移除 3 次上限，固定间隔 2s）；新增端口 9778 健康探活（5s 间隔，连续 3 次失败强杀重启），覆盖「进程存活但端口不可用」场景
- Agent 自我保护提示词：系统提示词新增 self-protection 段（禁止 agent 误杀宿主 kernel / Electron 进程），主会话与子代理均注入；prompts.json schemaVersion 22 → 23（自动迁移补齐新段）

### 修复
- kernel 被误杀或被安全软件终止后不再因 3 次上限而永久停摆，窗口存活期间持续自动重启
```

- [ ] **步骤 3：Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: 记录内核守护与自我保护提示词变更"
```

- [ ] **步骤 4：手动 E2E 验证（进程被杀自动重启）**

1. `bun run dev:desktop` 启动桌面应用（或打包版），确认 9778 就绪。
2. 找到 kernel 进程 PID（`netstat -ano | findstr 9778` 或日志中 `kernel sidecar pid=`），用任务管理器/`taskkill /F /PID <pid>` 杀掉。
3. 观察 `~/.wa-pi/logs/desktop.log`：应出现 `[kernel] 退出 code=null` 与 `崩溃自动重启 第 N 次`，约 2s 后 `重启就绪 @9778`。
4. 连续杀 5 次以上，确认每次都重启（不再有 3 次上限）。
5. 正常退出应用（托盘退出），确认不再重启（日志无新 `崩溃自动重启`）。

- [ ] **步骤 5：收尾检查**

运行：

```bash
git log --oneline -8
git status --short
```

预期：本计划 6 个 commit 按序出现；工作区仅剩与本计划无关的既有改动（不提交）。
