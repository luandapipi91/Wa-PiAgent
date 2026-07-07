# 移除 Rust 窗口层 + bun 启动 + vitest 迁移 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 Tauri/Rust 窗口层,改用 `bun run dev` 一键启动 kernel+frontend(自动开浏览器到 5180),并把 frontend 24 个 vitest 测试迁到 bun:test。

**Architecture:** `scripts/dev.ts`(零新依赖)用 `Bun.spawn` 并行起 kernel(9776 WS)和 frontend(Vite 5180 HMR),检测 Vite 就绪后跨平台开浏览器,统一 SIGINT 清理。kernel build 保留 `bun build --compile`(去 Tauri sidecar 命名)。frontend 测试用 `@happy-dom/global-registrator` + `bunfig.toml [test].preload` 接管 DOM 环境,`vi.*` 迁到 `bun:test` 的 `mock*`。

**Tech Stack:** Bun(runtime/test runner)、Vite 6、React 19、@testing-library/react、happy-dom、Playwright(e2e,不动)。

**Spec:** `docs/superpowers/specs/2026-07-07-remove-rust-window-bun-launch-design.md`

## Global Constraints

- **不碰** `packages/kernel/src/*`(含 broker/intercom)——属于另一个计划。
- **不碰** `packages/frontend/src/*`(业务组件代码)——`pick-directory.ts` 的 `isTauri()` 守卫保留。
- **不删** 前端 Tauri 依赖包(`@tauri-apps/plugin-dialog`)——留桌面壳口子。
- **不改** 历史文档(`2026-07-06-hiagent-mvp.md`、CHANGELOG 旧条目)里的 5173/tauri 描述。
- 端口:**frontend 5180**(新)、kernel 9776(不变)、preview 9777(不变)。
- 测试 runner 全仓库统一为 `bun:test`(kernel/shared 已是,frontend 本次迁)。
- 平台:必须 Windows(Git Bash)和 POSIX 都能跑。
- 所有 commit 信息和代码注释用中文。

---

## 文件结构总览

**删除:**
- `src-tauri/`(整个目录)
- `start.sh`、`start.command`
- `packages/kernel/scripts/copy-sidecar.mjs`
- `packages/frontend/vitest.config.ts`

**新增:**
- `scripts/dev.ts`(根级,一键启动)
- `scripts/port.ts`(根级,跨平台端口清理纯函数,可单测)
- `scripts/open-browser.ts`(根级,跨平台开浏览器纯函数,可单测)
- `packages/frontend/tests/happydom-setup.ts`(happy-dom + WS polyfill preload)
- `packages/frontend/bunfig.toml`(bun test 配置)
- `scripts/__tests__/port.test.ts`、`scripts/__tests__/open-browser.test.ts`(单测)

**修改:**
- `package.json`(根):加 `dev` 脚本
- `packages/frontend/vite.config.ts`:端口 5173→5180
- `packages/frontend/playwright.config.ts`:baseURL/waitFor 5173→5180
- `packages/kernel/package.json`:`build` 去 copy-sidecar 段
- `packages/frontend/package.json`:`test` 脚本 + 依赖增删
- `packages/frontend/tests/*.test.tsx`、`*.test.ts`(24 个):import 和 mock API 迁移
- `CHANGELOG.md`:加条目

---

## 阶段一:启动层重构(删除 Tauri + bun 一键启动)

### Task 1: 跨平台端口清理纯函数 + 单测

**Files:**
- Create: `scripts/port.ts`
- Create: `scripts/__tests__/port.test.ts`

**Interfaces:**
- Produces: `killPort(port: number): Promise<void>` —— 给定端口,跨平台 kill 占用进程;无占用则静默返回。

- [ ] **Step 1: 写失败测试**

Create `scripts/__tests__/port.test.ts`:

```ts
import { test, expect } from "bun:test";
import { killPort, findPidOnPort } from "../port";

test("findPidOnPort 在无占用端口返回 null", async () => {
  const pid = await findPidOnPort(19999);  // 极可能空闲的高端口
  expect(pid).toBeNull();
});

test("killPort 对无占用端口不抛错", async () => {
  await expect(killPort(19998)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test scripts/__tests__/port.test.ts`
Expected: FAIL —— `Cannot find module '../port'`

- [ ] **Step 3: 写实现**

Create `scripts/port.ts`:

```ts
// 跨平台端口占用检测与清理。Windows 用 netstat,POSIX 用 lsof。
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

/** 查端口占用的 PID,无占用返回 null */
export async function findPidOnPort(port: number): Promise<number | null> {
  // 命令拼接;用 buffer 收集输出后正则提取 PID
  const cmd = isWindows ? `netstat -ano | findstr :${port}` : `lsof -ti :${port}`;
  return new Promise((resolve) => {
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWindows ? ["/c", cmd] : ["-c", cmd];
    const child = spawn(shell, shellArgs, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      if (!out.trim()) return resolve(null);
      // Windows netstat 最后一列是 PID;POSIX lsof -ti 直接是 PID
      const match = isWindows ? out.match(/\s(\d+)\s*$/) : out.match(/(\d+)/);
      const pid = match ? Number(match[1]) : null;
      resolve(pid);
    });
    child.on("error", () => resolve(null));
  });
}

/** kill 占用端口的进程;无占用静默返回 */
export async function killPort(port: number): Promise<void> {
  const pid = await findPidOnPort(port);
  if (pid == null) return;
  const cmd = isWindows ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`;
  return new Promise((resolve) => {
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWindows ? ["/c", cmd] : ["-c", cmd];
    spawn(shell, shellArgs, { stdio: "ignore" }).on("close", () => resolve());
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test scripts/__tests__/port.test.ts`
Expected: PASS(2 个测试)

- [ ] **Step 5: commit**

```bash
git add scripts/port.ts scripts/__tests__/port.test.ts
git commit -m "feat(scripts): 跨平台端口清理纯函数 findPidOnPort/killPort"
```

---

### Task 2: 跨平台开浏览器纯函数 + 单测

**Files:**
- Create: `scripts/open-browser.ts`
- Create: `scripts/__tests__/open-browser.test.ts`

**Interfaces:**
- Produces: `openBrowser(url: string): Promise<void>` —— 跨平台用系统默认浏览器打开 url。
- Produces: `openBrowserCommand(): { shell: string; args: string[] } | null` —— 返回当前平台的开浏览器命令(纯函数,可单测;`openBrowser` 内部调它)。

- [ ] **Step 1: 写失败测试**

Create `scripts/__tests__/open-browser.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openBrowserCommand } from "../open-browser";

test("openBrowserCommand 在当前平台返回有效命令", () => {
  const cmd = openBrowserCommand();
  expect(cmd).not.toBeNull();
  expect(cmd!.shell.length).toBeGreaterThan(0);
  expect(cmd!.args.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test scripts/__tests__/open-browser.test.ts`
Expected: FAIL —— `Cannot find module '../open-browser'`

- [ ] **Step 3: 写实现**

Create `scripts/open-browser.ts`:

```ts
// 跨平台用系统默认浏览器打开 URL。
import { spawn } from "node:child_process";

/** 当前平台的开浏览器命令;不支持的平台返回 null */
export function openBrowserCommand(): { shell: string; args: string[] } | null {
  switch (process.platform) {
    case "win32":
      return { shell: "cmd.exe", args: ["/c", "start", ""] };  // start 后空引号是 Windows idiom(避免把 URL 当标题)
    case "darwin":
      return { shell: "/usr/bin/open", args: [] };  // open <url>
    default:
      // Linux/BSD 等,优先 xdg-open
      return { shell: "xdg-open", args: [] };
  }
}

/** 用系统默认浏览器打开 url */
export async function openBrowser(url: string): Promise<void> {
  const cmd = openBrowserCommand();
  if (!cmd) return;
  return new Promise((resolve) => {
    const child = spawn(cmd.shell, [...cmd.args, url], { stdio: "ignore", detached: true });
    child.on("close", () => resolve());
    child.on("error", () => resolve());  // 开浏览器失败不阻塞启动
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test scripts/__tests__/open-browser.test.ts`
Expected: PASS(1 个测试)

- [ ] **Step 5: commit**

```bash
git add scripts/open-browser.ts scripts/__tests__/open-browser.test.ts
git commit -m "feat(scripts): 跨平台开浏览器纯函数 openBrowser"
```

---

### Task 3: 一键启动器 scripts/dev.ts

**Files:**
- Create: `scripts/dev.ts`

**Interfaces:**
- Consumes: `killPort`(Task 1)、`openBrowser`(Task 2)
- Produces: `bun run dev` 入口 —— spawn kernel+frontend,日志前缀,自动开浏览器,SIGINT 清理。

- [ ] **Step 1: 写实现**

Create `scripts/dev.ts`:

```ts
// 一键启动:并行起 kernel(9776 WS)+ frontend(Vite 5180),自动开浏览器,SIGINT 清理。
import { spawn } from "node:child_process";
import { killPort } from "./port";
import { openBrowser } from "./open-browser";

const KERNEL_WS_PORT = 9776;
const FRONTEND_PORT = 5180;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

async function main() {
  // 1. 端口清理(兜底,防止上次没干净)
  console.log("[dev] 清理端口 %d / %d ...", KERNEL_WS_PORT, FRONTEND_PORT);
  await Promise.all([killPort(KERNEL_WS_PORT), killPort(FRONTEND_PORT)]);

  // 2. 并行 spawn 两个子进程
  const kernel = spawnProcs({
    label: "kernel",
    cmd: ["bun", ["run", "--filter", "@hiagent/kernel", "dev"]],
  });
  const frontend = spawnProcs({
    label: "web",
    cmd: ["bun", ["run", "--filter", "@hiagent/frontend", "dev"]],
  });

  let browserOpened = false;
  frontend.stdout.on("data", (d: Buffer) => {
    const line = d.toString();
    process.stdout.write(`[web] ${line}`);
    // Vite 就绪输出含 "Local:   http://localhost:5180",检测到就开浏览器(只开一次)
    if (!browserOpened && line.includes(`localhost:${FRONTEND_PORT}`)) {
      browserOpened = true;
      console.log("[dev] ▶ 打开浏览器 %s", FRONTEND_URL);
      openBrowser(FRONTEND_URL);
    }
  });
  kernel.stdout.on("data", (d: Buffer) => process.stdout.write(`[kernel] ${d.toString()}`));
  // stderr 同样打前缀
  kernel.stderr.on("data", (d: Buffer) => process.stderr.write(`[kernel] ${d.toString()}`));
  frontend.stderr.on("data", (d: Buffer) => process.stderr.write(`[web] ${d.toString()}`));

  // 3. 统一 SIGINT/SIGTERM 清理
  const cleanup = async () => {
    console.log("\n[dev] 退出,清理子进程...");
    for (const p of [kernel, frontend]) {
      try { process.kill(p.pid!, "SIGTERM"); } catch {}
    }
    await Promise.all([killPort(KERNEL_WS_PORT), killPort(FRONTEND_PORT)]);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

interface ProcSpec { label: string; cmd: [string, string[]]; }

function spawnProcs(spec: ProcSpec) {
  const [bin, args] = spec.cmd;
  return spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
}

main().catch((e) => { console.error("[dev] 启动失败:", e); process.exit(1); });
```

- [ ] **Step 2: 暂不写单测**

`scripts/dev.ts` 是 side-effect 编排器(spawn 子进程、信号监听),纯函数部分(`spawnProcs`、`main`)难以有意义地单测。它的验证靠 Task 4 的 API/E2E 层。符合 spec §6 的分层:启动器本身由第③层验证。

- [ ] **Step 3: commit**

```bash
git add scripts/dev.ts
git commit -m "feat(scripts): 一键启动器 dev.ts —— 并行 kernel+frontend,自动开浏览器,SIGINT 清理"
```

---

### Task 4: 根 package.json 加 dev 脚本 + 端口改 5180

**Files:**
- Modify: `package.json`(根)
- Modify: `packages/frontend/vite.config.ts:7`
- Modify: `packages/frontend/playwright.config.ts:15,21`

- [ ] **Step 1: 根 package.json 加 dev 脚本**

读 `package.json` 的 scripts 段(当前有 `dev:kernel`、`dev:frontend`、`test`、`typecheck`),在最前面加 `dev`:

将:
```jsonc
"scripts": {
  "dev:kernel": "bun run --filter @hiagent/kernel dev",
  "dev:frontend": "bun run --filter @hiagent/frontend dev",
  "test": "bun test",
  "typecheck": "bun run --filter '*' typecheck"
}
```
改为:
```jsonc
"scripts": {
  "dev": "bun run scripts/dev.ts",
  "dev:kernel": "bun run --filter @hiagent/kernel dev",
  "dev:frontend": "bun run --filter @hiagent/frontend dev",
  "test": "bun test",
  "typecheck": "bun run --filter '*' typecheck"
}
```

- [ ] **Step 2: frontend vite 端口 5173→5180**

`packages/frontend/vite.config.ts:7`:

将 `  server: { port: 5173 },`
改为 `  server: { port: 5180 },`

- [ ] **Step 3: playwright 端口 5173→5180**

`packages/frontend/playwright.config.ts:15`:
将 `  use: { baseURL: "http://localhost:5173", headless: true },`
改为 `  use: { baseURL: "http://localhost:5180", headless: true },`

`packages/frontend/playwright.config.ts:21`:
将 `    url: "http://localhost:5173",`
改为 `    url: "http://localhost:5180",`

- [ ] **Step 4: 手动验证启动**

Run: `bun run dev`
Expected:
- 终端看到 `[kernel]` 和 `[web]` 前缀的日志
- 浏览器自动打开 `http://localhost:5180`
- 页面正常加载(前端 WS 会尝试连 9776,可能因 broker 降级而功能受限,但页面不白屏)
- Ctrl+C 后,`netstat -ano | findstr :5180`(Windows)或 `lsof -ti :5180`(POSIX)无输出

- [ ] **Step 5: commit**

```bash
git add package.json packages/frontend/vite.config.ts packages/frontend/playwright.config.ts
git commit -m "feat: 根 dev 脚本 + frontend/playwright 端口 5173→5180"
```

---

### Task 5: 删除 src-tauri/、start.sh、start.command

**Files:**
- Delete: `src-tauri/`(整个目录)
- Delete: `start.sh`
- Delete: `start.command`

- [ ] **Step 1: 删除文件**

```bash
git rm -r src-tauri/
git rm start.sh start.command
```

- [ ] **Step 2: 验证 frontend/kernel 仍能独立跑**

Run: `bun run --filter @hiagent/frontend dev`
Expected: Vite 起在 5180(独立能跑,不依赖 src-tauri)

Run: `bun run --filter @hiagent/kernel dev`
Expected: kernel WS server 起在 9776(独立能跑)

- [ ] **Step 3: 验证类型检查不坏**

Run: `bun run typecheck`
Expected: 无新增错误(确认没有任何代码 import src-tauri 或 start.sh)

- [ ] **Step 4: commit**

```bash
git commit -m "chore: 删除 src-tauri/、start.sh、start.command —— 移除 Rust 窗口层"
```

---

### Task 6: kernel build 去 Tauri sidecar 命名

**Files:**
- Modify: `packages/kernel/package.json:8`
- Delete: `packages/kernel/scripts/copy-sidecar.mjs`

- [ ] **Step 1: 改 build 脚本**

`packages/kernel/package.json:8`:

将 `  "build": "bun build src/index.ts --compile --target bun --outfile dist/hiagent-kernel && bun run scripts/copy-sidecar.mjs",`
改为 `  "build": "bun build src/index.ts --compile --target bun --outfile dist/hiagent-kernel",`

注意:**不动** `build:bundle`(`:9`,它不走 copy-sidecar)。

- [ ] **Step 2: 删 copy-sidecar.mjs**

```bash
git rm packages/kernel/scripts/copy-sidecar.mjs
```

(若 `packages/kernel/scripts/` 删后为空目录,git 会自动处理;不手动删空目录。)

- [ ] **Step 3: 验证 kernel build 产物**

Run: `bun run --filter @hiagent/kernel build`
Expected: 产出 `packages/kernel/dist/hiagent-kernel` 可执行文件,**不再**有 `hiagent-kernel-x86_64-...` 的 triple 命名副本。

Run(验证可执行): `./packages/kernel/dist/hiagent-kernel`(POSIX)或对应 Windows 二进制
Expected: kernel WS server 起在 9776(Ctrl+C 退出)

- [ ] **Step 4: 验证现有 kernel 单测仍绿**

Run: `bun run --filter @hiagent/kernel test`
Expected: 全绿(确认删 copy-sidecar 不破坏测试)

- [ ] **Step 5: commit**

```bash
git add packages/kernel/package.json
git commit -m "refactor(kernel): build 去 Tauri sidecar triple 命名,删 copy-sidecar.mjs"
```

---

### Task 7: 阶段一集成验证(API + E2E 回归)

**Files:** 无改动,纯验证。

- [ ] **Step 1: 启动并验证 API 层**

Run: `bun run dev`(后台运行,或另开终端)

Run(另一终端,验证 frontend HTTP):
```bash
curl -s http://localhost:5180 | head -20
```
Expected: 返回 HTML(`<html>...` 开头,含 React root div)

Run(验证 kernel WS 握手,用 curl 升级):
```bash
curl -sv -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://127.0.0.1:9776/ 2>&1 | head -10
```
Expected: HTTP 101 Switching Protocols(或 kernel WS server 的握手响应)

Run(验证 Ctrl+C 端口释放):
在 `bun run dev` 终端按 Ctrl+C,然后:
```bash
# Windows
netstat -ano | findstr ":5180 :9776"
# POSIX
lsof -ti :5180 :9776
```
Expected: 无输出(端口已释放)

- [ ] **Step 2: 验证 e2e(如有头浏览器环境)**

Run:
```bash
cd packages/frontend && bunx playwright test --reporter=line 2>&1 | tail -20
```
Expected: 现有 e2e 套件通过(或仅因 broker 降级导致 intercom 相关用例 skip/fail,但 app-flow/migrate/multi-project 等不依赖 broker 的应通过)。

**注意:** 若 e2e 中有 `intercom.spec.ts` 因 broker 缺失而 fail,这是预期(spec §1 明确不碰 broker,降级路径)。记录 fail 情况,但不视为本任务阻塞——这些用例在另一个 broker 清理计划后才会重新绿。

- [ ] **Step 3: 截图清理(若有)**

e2e 跑完若在 `packages/frontend/e2e/` 或项目任何位置产生截图(.png/.jpg),全部删除:
```bash
find . -name "*.png" -path "*/e2e/*" -delete 2>/dev/null || true
find . -name "*playwright*screenshot*" -delete 2>/dev/null || true
```

- [ ] **Step 4: 不 commit(纯验证步骤)**

阶段一完成。此时 `bun run dev` 已是完整工作的一键启动。

---

## 阶段二:frontend 测试工具链迁移(vitest → bun:test)

### Task 8: happy-dom preload + bunfig.toml

**Files:**
- Create: `packages/frontend/tests/happydom-setup.ts`
- Create: `packages/frontend/bunfig.toml`

- [ ] **Step 1: 写 preload**

Create `packages/frontend/tests/happydom-setup.ts`:

```ts
// bun:test 的 DOM 测试 preload:注册 happy-dom 全局 + WebSocket polyfill。
// vitest 时代靠 vitest.config.ts 的 environment+setupFiles;迁 bun:test 后改用 preload。
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import "./setup-websocket";  // 复用现有 WebSocket polyfill(setup-websocket.ts 内容不变)
GlobalRegistrator.register();
```

- [ ] **Step 2: 写 bunfig.toml**

Create `packages/frontend/bunfig.toml`:

```toml
[test]
preload = ["./tests/happydom-setup.ts"]
```

**关于 `@hiagent/shared` alias(spec §7 风险⑤):** vitest.config.ts 原有 `resolve.alias` 把 `@hiagent/shared` 指向 `../shared/src/index.ts`。bun:test 不读 vitest.config.ts,但 bun workspace 已把 `@hiagent/shared` 注册为 workspace 包(根 `package.json` 的 `workspaces: ["packages/*"]`),bun 能直接解析包名。**若 Task 9 跑测试时出现 `Cannot find module '@hiagent/shared'`,在 `tsconfig.json` 的 `paths` 加 `{"@hiagent/shared": ["../shared/src"]}` 兜底。** 先不加,遇到再加(YAGNI)。

- [ ] **Step 3: 添加依赖**

```bash
cd packages/frontend
bun add -d @happy-dom/global-registrator
```

确认 `package.json` devDependencies 出现 `@happy-dom/global-registrator`。`happy-dom` 本身 vitest 已带,确认它在依赖里(若没有则 `bun add -d happy-dom`)。

- [ ] **Step 4: 暂不 commit(等 Task 9 一起验证)**

---

### Task 9: 迁第一个测试文件验证迁移模式

**Files:**
- Modify: `packages/frontend/tests/Composer.test.tsx`(最简单,无 vi.mock,验证基本模式)

- [ ] **Step 1: 改 import**

`packages/frontend/tests/Composer.test.tsx:1`:

将 `import { test, expect, beforeEach } from "vitest";`
改为 `import { test, expect, beforeEach } from "bun:test";`

其余代码不动(这个文件没用 vi.*)。

- [ ] **Step 2: 删 vitest.config.ts**

```bash
git rm packages/frontend/vitest.config.ts
```

注意:这会让所有其他 23 个测试暂时 import 失败的 `vitest`,但此刻只验证这一个。**先不跑全量**。

- [ ] **Step 3: 跑这一个测试**

```bash
cd packages/frontend
bun test tests/Composer.test.tsx
```
Expected: PASS(1 个测试)。

若失败:
- "Cannot find module 'bun:test'" → 检查 bun 版本 >= 1.1
- "document is not defined" → preload 未生效,检查 `bunfig.toml` 路径
- WebSocket 报错 → `setup-websocket.ts` 未被 preload 引入,检查 `happydom-setup.ts` 的 import 路径

- [ ] **Step 4: 改 frontend test 脚本**

`packages/frontend/package.json` 的 `"test": "vitest run"` 改为 `"test": "bun test"`。

- [ ] **Step 5: commit**

```bash
git add packages/frontend/tests/happydom-setup.ts packages/frontend/bunfig.toml packages/frontend/tests/Composer.test.tsx packages/frontend/package.json
git commit -m "test(frontend): bun:test 基础设施(happy-dom preload + bunfig),迁第一个文件 Composer"
```

---

### Task 10: 批量迁 vi.mock 文件(9 个)

这 9 个文件用 `vi.mock(path, factory)`,迁到 `mock.module(path, factory)`。**重点验证 hoisting 行为**(spec §7 风险③)。

9 个文件:`AgentConfig`、`App-canvas`、`App-routing`、`Canvas`、`CanvasNode`、`ProjectItem.sort-menu`、`SessionView`、`render`、加上 `App-canvas` 里的第二个 `vi.mock("reactflow")`。

**Files:**
- Modify: `packages/frontend/tests/AgentConfig.test.tsx`
- Modify: `packages/frontend/tests/App-canvas.test.tsx`
- Modify: `packages/frontend/tests/App-routing.test.tsx`
- Modify: `packages/frontend/tests/Canvas.test.tsx`
- Modify: `packages/frontend/tests/CanvasNode.test.tsx`
- Modify: `packages/frontend/tests/ProjectItem.sort-menu.test.tsx`
- Modify: `packages/frontend/tests/SessionView.test.tsx`
- Modify: `packages/frontend/tests/render.test.tsx`

- [ ] **Step 1: 每个文件做相同的三步替换**

对每个文件:
1. `import { ..., vi, ... } from "vitest"` → `import { ..., mock, ... } from "bun:test"`(去掉 `vi`,按需加 `mock`;保留 `test`/`expect`/`beforeEach`)
2. `vi.mock("../path", factory)` → `mock.module("../path", factory)`(factory 签名一致,直接换函数名)
3. 文件内若有 `vi.fn()`,→ `mock()`(这些文件主要是 mock.module)

**示例 —— AgentConfig.test.tsx:**

`:1` 将:
```tsx
import { test, expect, vi, beforeEach } from "vitest";
```
改为:
```tsx
import { test, expect, beforeEach, mock } from "bun:test";
```

`:15-18` 将:
```tsx
vi.mock("../src/ws-instance", () => ({
  send: () => {},
  onMessage: (cb: any) => { cb({ type: "agent:config", agentName: "dev", config: mockConfig }); return () => {}; },
}));
```
改为:
```tsx
mock.module("../src/ws-instance", () => ({
  send: () => {},
  onMessage: (cb: any) => { cb({ type: "agent:config", agentName: "dev", config: mockConfig }); return () => {}; },
}));
```

`:36`(vi.fn 用法)将:
```tsx
  const onClose = vi.fn();
```
改为:
```tsx
  const onClose = mock();
```

**示例 —— App-canvas.test.tsx(两个 mock + JSX factory):**

import 同上模式。两个 `vi.mock` 都改为 `mock.module`:
```tsx
mock.module("../src/ws-instance", () => ({
  getWs: () => ({ readyState: 1, addEventListener: () => {}, send: () => {} }),
  send: () => {},
  onMessage: () => () => {},
}));

// mock reactflow:Canvas 内的 ReactFlow 透传节点(用 rf-mock 区分 Canvas 外层 testid)
mock.module("reactflow", () => ({
  default: ({ nodes }: any) => (
    <div data-testid="rf-mock">{nodes.map((n: any) => <span key={n.id}>{n.id}</span>)}</div>
  ),
  Background: () => null,
}));
```
(注意:`reactflow` 的 factory 含 JSX,文件必须保持 `.tsx` 扩展名——它已经是。)

- [ ] **Step 2: 逐个跑验证**

每改完一个文件,跑:
```bash
cd packages/frontend && bun test tests/<file>.test.tsx
```
Expected: 该文件测试全绿。

**若 mock.module 不生效(hoisting 问题):** bun 的 `mock.module` 默认不 hoist 到文件顶部(与 vitest 的 `vi.mock` 不同)。若测试因 import 时序失败,改用 bun 推荐的"在 import 被测模块前先 mock"——由于 ESM import 是静态提升的,这可能需要把被测模块改为动态 `await import()`。**遇到再处理**,不预先改写。

- [ ] **Step 3: 全量跑这 8 个文件**

```bash
cd packages/frontend && bun test tests/AgentConfig.test.tsx tests/App-canvas.test.tsx tests/App-routing.test.tsx tests/Canvas.test.tsx tests/CanvasNode.test.tsx tests/ProjectItem.sort-menu.test.tsx tests/SessionView.test.tsx tests/render.test.tsx
```
Expected: 全绿。

- [ ] **Step 4: commit**

```bash
git add packages/frontend/tests/
git commit -m "test(frontend): 9 个 vi.mock 文件迁 mock.module"
```

---

### Task 11: 迁剩余文件(含 vi.fn / vi.spyOn)

剩余文件主要是用 `vi.fn`(非 mock.module)和 1 处 `vi.spyOn`。

**Files:**
- Modify: `packages/frontend/tests/` 下所有仍 `from "vitest"` 的文件(约 15 个,含 `AgentListSection`、`AskCard`、`ConfirmDialog`、`MessageList`、`Modal`、`NewSessionButton`、`NewSessionPane`、`ProjectList`、`SessionRow`、`SessionRow.context`、`Sidebar`、`store-agents`、`store-projects`、`theme`、`AskCard` 等)

- [ ] **Step 1: 找出剩余 vitest 文件**

```bash
cd packages/frontend/tests && grep -rl 'from "vitest"' .
```
Expected: 列出约 15 个文件。

- [ ] **Step 2: 统一替换规则**

对每个文件:
1. `import { ..., vi, ... } from "vitest"` → `import { ..., mock, ... } from "bun:test"`
2. `vi.fn()` → `mock()`
3. `vi.spyOn(obj, "method")` → `mock(obj, "method")`(仅 `SessionRow.context.test.tsx:21` 一处:`vi.spyOn(event, "preventDefault")` → `mock(event, "preventDefault")`)
4. 没用 `vi.*` 的文件:只换 import 路径 `from "vitest"` → `from "bun:test"`

**SessionRow.context.test.tsx:21 示例:**

将:
```tsx
  const preventDefault = vi.spyOn(event, "preventDefault");
```
改为:
```tsx
  const preventDefault = mock(event, "preventDefault");
```

- [ ] **Step 3: 批量跑验证**

```bash
cd packages/frontend && bun test
```
Expected: 全部 24 个测试文件全绿。

- [ ] **Step 4: commit**

```bash
git add packages/frontend/tests/
git commit -m "test(frontend): 剩余文件迁 bun:test(vi.fn→mock, vi.spyOn→mock)"
```

---

### Task 12: 删 vitest 依赖 + 全仓库测试统一

**Files:**
- Modify: `packages/frontend/package.json`

- [ ] **Step 1: 确认无残留 vitest import**

```bash
cd packages/frontend && grep -rn 'from "vitest"\|vi\.\(mock\|fn\|spyOn\)' tests/ src/ ; echo "exit: $?"
```
Expected: 无输出(grep 退出码 1)。

- [ ] **Step 2: 删 vitest 依赖**

```bash
cd packages/frontend && bun remove vitest
```

确认 `package.json` 不再有 `vitest`。**保留** `@vitejs/plugin-react`(vite.config.ts 构建共用,spec §5 已确认)、`@testing-library/react`、`happy-dom`。

- [ ] **Step 3: 全仓库单命令测试**

Run(根目录): `bun test`
Expected: kernel + shared + frontend + scripts 所有测试全绿。

- [ ] **Step 4: 验证 frontend 仍能构建**

```bash
bun run --filter @hiagent/frontend build
```
Expected: vite build 成功(确认删 vitest 不影响构建)。

- [ ] **Step 5: commit**

```bash
git add packages/frontend/package.json
git commit -m "chore(frontend): 删 vitest 依赖,全仓库统一 bun:test"
```

---

### Task 13: CHANGELOG + 最终集成验证

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 加 CHANGELOG 条目(顶部)**

在 `CHANGELOG.md` 顶部加:

```markdown
## 2026-07-07

### 重构 / 配置变更

- **移除 Rust 窗口层(Tauri),改用 bun 一键启动** —— 删除 `src-tauri/`、`start.sh`、`start.command`;新增 `scripts/dev.ts` 并行起 kernel(9776)+ frontend(5180),自动开浏览器,SIGINT 清理。frontend 默认端口 5173→5180。
- **frontend 测试工具链 vitest → bun:test** —— 24 个测试迁移,统一全仓库单一 runner;新增 happy-dom preload。
- **kernel build 去 Tauri sidecar 命名** —— 删 `copy-sidecar.mjs`,build 保留 `bun build --compile`。
- **影响范围:** `src-tauri/`(删)、`start.sh`/`start.command`(删)、`scripts/`(新)、`packages/frontend/{vite.config.ts,playwright.config.ts,vitest.config.ts(删),package.json,tests/*,bunfig.toml(新)}`、`packages/kernel/{package.json,scripts/copy-sidecar.mjs(删)}`、`CHANGELOG.md`。
```

- [ ] **Step 2: 最终 4 层验证**

**第①层(单元/组件,bun:test):**
```bash
bun test
```
Expected: 全绿(kernel + shared + frontend + scripts)。

**第③层(API):**
```bash
bun run dev &
sleep 5
curl -s http://localhost:5180 | head -5    # frontend HTML
curl -sv -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://127.0.0.1:9776/ 2>&1 | head -5    # WS 握手
# 验证浏览器被自动打开(观察是否弹出)
# Ctrl+C 停止
```
Expected: HTML 返回;WS 101;浏览器自动开;端口释放。

**第④层(E2E):**
```bash
cd packages/frontend && bunx playwright test --reporter=line 2>&1 | tail -15
```
Expected: 不依赖 broker 的 e2e 通过;`intercom.spec.ts` 因 broker 缺失 fail/skip 属预期(另一计划处理)。

**截图清理:**
```bash
find . -name "*.png" -path "*/e2e/*" -delete 2>/dev/null || true
```

- [ ] **Step 3: commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): 记录移除 Rust 窗口层 + bun 启动 + vitest 迁移"
```

---

## 阶段三:本地目录树服务(替代 Tauri 原生目录选择器)

移除 Tauri 后,"新建项目"的目录选择从原生对话框降级为 `window.prompt`。本阶段用 react-complex-tree + kernel fs WS 接口实现树选择器。**关键决策:不做安全加固、用 react-complex-tree 库、不要手动输入框、起始根是系统根。**

### Task 14+15: shared 类型 + kernel fs case ✅

`packages/shared/src/types.ts` 新增 `FSHomeRequest`/`FSRootsRequest`/`FSListDirRequest`/`FSHomeResult`/`FSRootsResult`/`FSListDirResult`/`FSErrorEvent`/`DirEntry`,加入 WSClientEvent/WSServerEvent 联合。`packages/kernel/src/ws-server.ts` 加三个 case:`fs:home`(返回 homedir)、`fs:roots`(Windows 枚举 C:-Z: 盘符,POSIX `/`)、`fs:listDir`(readdir 列子项,含文件和目录,过滤隐藏项,不做路径校验)。

### Task 16+17: react-complex-tree + DirTreePicker ✅

- `packages/frontend/src/fs-client.ts` —— send/onMessage 封装成 Promise。
- `packages/frontend/src/components/DirTreePicker.tsx` —— react-complex-tree 的 UncontrolledTreeEnvironment + 异步 DataProvider(展开时 await listDir 懒加载)。
- `store/projects.ts` + `App.tsx` —— createProjectFromDir 改为打开 picker,选中后走 createProjectFromPath。
- react-complex-tree v2.6.2 实际 API:onDidChangeTreeData 返回 Disposable、canDropOnFolder(非 canDropOnFolderWithChildren)、renderItemTitle 顶层 prop、viewState 必填。

### Task 18: 集成验证 ✅

浏览器实测:点新建项目 → 树选择器弹 Windows 盘符 → 展开懒加载 → 选中目录 → 项目创建成功。kernel 37/37 + frontend 65/65 全绿。

---

## 完成标志

- [x] `bun run dev` 一键启动,浏览器自动开到 `http://localhost:5180`,Ctrl+C 干净退出
- [x] `start.command`(macOS)+ `start.bat`(Windows)双击入口,bun 检查
- [x] `src-tauri/`、`start.sh`、`copy-sidecar.mjs`、`vitest.config.ts`、`vitest` 依赖全部删除
- [x] `bun test`(根目录单命令)全绿(scripts 5 + frontend 65 + kernel/shared 44)
- [x] `bun run --filter @hiagent/kernel build` 产出 `dist/hiagent-kernel`(无 triple 后缀)
- [x] **新建项目走目录树选择器**(浏览器点选目录 → 项目创建成功,跨盘符可选)
- [x] CHANGELOG 已记录
- [ ] CHANGELOG 已记录
