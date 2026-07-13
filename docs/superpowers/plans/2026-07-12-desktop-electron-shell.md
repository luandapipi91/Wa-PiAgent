# HiAgent 桌面 Electron Shell 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤用 `- [ ]` 复选框跟踪。

**Goal:** 把 desktop shell 从「systray2 + 系统浏览器」迁到「Electron（BrowserWindow + Tray + kernel 解释 sidecar + electron-builder）」，为 spec B（录音系统声音）铺好可控 Chromium 基座。

**Architecture:** Electron main（Node CJS）管生命周期/单实例/窗口/托盘，spawn 一个**解释运行**的 kernel sidecar（`bun.exe + kernel.js + node_modules`，放 `resources/kernel/`）起 WS 9776，BrowserWindow load `http://127.0.0.1:9776`（前端零改动）。electron-builder 出 Win portable + Linux AppImage。kernel 必须解释运行（编译 exe 已证伪：pi SDK jiti 撞 bun compile 虚拟 FS）。spec B 音频前提已 POC 通过。

**Tech Stack:** Electron 33 + electron-builder、Bun（kernel sidecar）、TypeScript（kernel + 测试）、Python（genicon 复用）、Gitee Go + wine（CI 交叉编 Win）。

## Global Constraints

- 沟通用中文；代码注释尽量中文（AGENTS.md §1）。
- 四层验收：单元 + 集成 + 真机手动；测试截图测后删除（AGENTS.md §6）。
- 每个有意义的变更更新根 `CHANGELOG.md`（AGENTS.md §7）。
- **kernel sidecar 必须解释运行**（`bun.exe + kernel.js + node_modules`）；**不能用 `bun build --compile`**（已证伪：SDK jiti 解析扩展撞 bun compile 虚拟 FS → agent 创建挂）。
- **前端零改动**：React 前端原样跑在 BrowserWindow 里，连 kernel WS 9776（`ws-instance.ts` 硬编码 9776 勿改）。
- v1 = **Windows + Linux**；macOS = phase 2（Gitee Go 无 macOS runner，不做）。
- 托管 = **Gitee**（Gitee Go CI；用 wine 从 Linux 出 Win 包）。
- 本计划只交付 **Electron shell**；**不含录音 UI（spec B）**——那是独立 spec/plan。
- Electron main 用 **CommonJS（`.cjs`）**（Electron main 是 Node CJS，避免 ESM/编译复杂）；kernel sidecar 与测试保持 TS。

---

## File Structure

**改写 `packages/desktop/`（从 tray-binary → Electron）：**
- `package.json` —— Electron + electron-builder 依赖；`main: "src/main.cjs"`；scripts（dev/build/pack）。
- `tsconfig.json` —— 保留（测试 + kernel sidecar 脚本用 TS）。
- `src/main.cjs` —— Electron main：单实例锁 → spawn kernel sidecar → 等 9776 → BrowserWindow load 9776 → Tray；生命周期（window-all-closed/tray 退出 → kill sidecar → app.quit）。
- `src/tray.cjs` —— Electron `Tray` + `Menu`（打开/退出）；点「打开」focus 既有 BrowserWindow。
- `src/kernel-sidecar.cjs` —— spawn `bun.exe run kernel.js`、等 9776 ready、退出时 kill 子进程树。
- `src/util/port.cjs` —— `waitForPort(port, timeoutMs)`（轮询 `isPortInUse`）。
- `src/util/paths.cjs` —— `resolveKernelDir()` / `resolveWebDir()`（dev vs packaged：`app.isPackaged` + `process.resourcesPath`）。
- `src/util/menu.cjs` —— `buildTrayMenu(onOpen, onQuit)` → Electron `Menu` 模板（纯数据，可测）。
- `src/util/log.cjs` —— 文件日志（搬自现 `log.ts`，改 CJS；写 `~/.hiagent/logs/desktop.log`）。
- `electron-builder.yml` —— 打包配置（Win portable + Linux AppImage；`extraResources: kernel/ + web/`）。
- `scripts/build-kernel-sidecar.ts` —— 组装 `resources/kernel/`（bun.exe + kernel.js + node_modules）+ `resources/web/`（前端 dist）。
- `scripts/build.ts` —— 构建编排（测试钩子 → vite build → build-kernel-sidecar → electron-builder）。
- `tests/port.test.ts` / `paths.test.ts` / `menu.test.ts` —— 纯函数单测。

**删除（tray-binary 遗物）：** `src/main.ts`、`src/systray-setup.ts`、`src/embed.ts`、`src/embedded/`、`src/embedded-assets.ts`、`src/util/interop.ts`、`src/util/open-browser.ts`、`src/util/pe-subsystem.ts`、`scripts/genicon.py`（青蛙图标改 Electron `nativeImage`/ico，下述）、`scripts/build.ts`（旧的，被新 build.ts 替）。

**复用（不动）：** `packages/kernel/src/desktop-server.ts`（sidecar 入口，已存在）、`packages/kernel/src/index.ts`（`startKernel`）、`packages/frontend`（零改动）、`.workflow/ci.yml`（门禁不变）。

**改：** `.workflow/release.yml`（发版改 electron-builder + wine）。

---

## Task 1: 脚手架 —— 改写 packages/desktop 为 Electron + 清理 tray 遗物

**Files:**
- Modify: `packages/desktop/package.json`、`packages/desktop/tsconfig.json`
- Create: `packages/desktop/electron-builder.yml`（骨架）、`packages/desktop/.gitignore`（release/）
- Delete: `src/main.ts`、`src/systray-setup.ts`、`src/embed.ts`、`src/embedded/`、`src/embedded-assets.ts`、`src/util/interop.ts`、`src/util/open-browser.ts`、`src/util/pe-subsystem.ts`

**Interfaces:** 无（脚手架）。

- [ ] **Step 1: 改 `packages/desktop/package.json`**

```json
{
  "name": "@hiagent/desktop",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/main.cjs",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "dev": "electron .",
    "build:win": "bun run scripts/build.ts --target=win",
    "build:linux": "bun run scripts/build.ts --target=linux",
    "build:all": "bun run build:win && bun run build:linux"
  },
  "dependencies": {},
  "devDependencies": {
    "electron": "^33",
    "electron-builder": "^25",
    "typescript": "^5.6.0",
    "@types/bun": "^1.3.0"
  }
}
```
（注：不再依赖 systray2 / fs-extra。Electron 自带 Tray/BrowserWindow。）

- [ ] **Step 2: `tsconfig.json` 保留但 include 收紧（排除 .cjs，仅 TS 测试 + 脚本）**

```json
{
  "compilerOptions": {
    "types": ["bun"],
    "moduleResolution": "bundler",
    "module": "esnext",
    "target": "esnext",
    "skipLibCheck": true,
    "allowJs": true,
    "checkJs": false
  },
  "include": ["tests", "scripts"]
}
```

- [ ] **Step 3: `electron-builder.yml` 骨架（Task 6 补全 target/extraResources）**

```yaml
appId: ai.hiagent.desktop
productName: HiAgent
directories:
  output: release
  buildResources: build-assets
files:
  - src/**
  - package.json
# extraResources / target 在 Task 6 补
```

- [ ] **Step 4: 删除 tray-binary 遗物**

```bash
cd packages/desktop
rm -f src/main.ts src/systray-setup.ts src/embed.ts src/embedded-assets.ts
rm -rf src/embedded
rm -f src/util/interop.ts src/util/open-browser.ts src/util/pe-subsystem.ts
```
（保留 `src/util/port.ts`、`src/log.ts` 临时参考；Task 2/4 会改写成 .cjs，到时再删 .ts。）

- [ ] **Step 5: 装 Electron + electron-builder**

```bash
cd packages/desktop
BUN_CONFIG_REGISTRY=https://registry.npmjs.org/ ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ BUN_INSTALL_CACHE_DIR="$PWD/.bun-cache" bun install
rm -rf .bun-cache
```
Expected: `electron` + `electron-builder` 装好，`node_modules/electron/dist/electron.exe` 存在。

- [ ] **Step 6: 提交**

```bash
git add packages/desktop/package.json packages/desktop/tsconfig.json packages/desktop/electron-builder.yml packages/desktop/bun.lock
git commit -m "refactor(desktop): 脚手架改写为 Electron + 清理 tray 遗物"
```
（删除的文件由 `git add -A packages/desktop` 一并记录——本任务允许，因为是整体改写。）

---

## Task 2: 纯工具函数（port / paths / menu）+ 单测

**Files:**
- Create: `packages/desktop/src/util/port.cjs`、`src/util/paths.cjs`、`src/util/menu.cjs`
- Test: `packages/desktop/tests/port.test.ts`、`tests/paths.test.ts`、`tests/menu.test.ts`

**Interfaces:**
- Produces: `waitForPort(port:number, timeoutMs:number): Promise<boolean>`（port.cjs）；`resolveKernelDir(isPackaged:boolean, resourcesPath:string, env:Record<string,string|undefined>): string` + `resolveWebDir(...)`（paths.cjs）；`buildTrayMenu(onOpen:()=>void, onQuit:()=>void): Electron.MenuItemConstructorOptions[]`（menu.cjs）。

- [ ] **Step 1: 写失败测试 `tests/port.test.ts`**

```ts
import { test, expect } from "bun:test";
import { createServer } from "node:net";
import { waitForPort } from "../src/util/port.cjs";

test("waitForPort: 端口起来后 resolve true", async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(59997, r));
  const ok = await waitForPort(59997, 2000);
  expect(ok).toBe(true);
  await new Promise<void>((r) => s.close(() => r()));
});

test("waitForPort: 超时 resolve false", async () => {
  const ok = await waitForPort(59996, 500); // 没人监听
  expect(ok).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败** → `cd packages/desktop && bun test tests/port.test.ts` → FAIL（模块找不到）。

- [ ] **Step 3: 实现 `src/util/port.cjs`**

```js
// 等端口进入 LISTEN，超时返回 false。复用 scripts/port.ts 的 isPortInUse 思路。
const { createServer } = require("node:net");

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port);
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

module.exports = { isPortInUse, waitForPort };
```

- [ ] **Step 4: 跑测试确认通过** → PASS。

- [ ] **Step 5: 写失败测试 `tests/paths.test.ts`**

```ts
import { test, expect } from "bun:test";
import { resolveKernelDir, resolveWebDir } from "../src/util/paths.cjs";

test("packaged: 用 resourcesPath/kernel", () => {
  const env = {};
  expect(resolveKernelDir(true, "R:/resources", env)).toBe("R:/resources/kernel");
  expect(resolveWebDir(true, "R:/resources", env)).toBe("R:/resources/web");
});

test("dev: env 覆盖优先，否则回退 dev 默认", () => {
  expect(resolveKernelDir(false, "R:/resources", { HIAGENT_KERNEL_DIR: "/dev/kernel" })).toBe("/dev/kernel");
  expect(resolveKernelDir(false, "R:/resources", {})).toMatch(/packages[\\/]kernel$/);
});
```

- [ ] **Step 6: 跑测试确认失败** → FAIL。

- [ ] **Step 7: 实现 `src/util/paths.cjs`**

```js
// 解析 kernel sidecar 与 web 目录：packaged 走 resourcesPath，dev 走 env 或 repo 默认。
const path = require("node:path");

function devRepoRoot() {
  // dev 下从 CWD 找 repo 根（含 packages/kernel）
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      if (require("node:fs").existsSync(path.join(dir, "packages", "kernel"))) return dir;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function resolveKernelDir(isPackaged, resourcesPath, env) {
  if (!isPackaged && env.HIAGENT_KERNEL_DIR) return env.HIAGENT_KERNEL_DIR;
  if (isPackaged) return path.join(resourcesPath, "kernel");
  return path.join(devRepoRoot(), "packages", "kernel"); // dev: 解释跑 kernel 源码
}

function resolveWebDir(isPackaged, resourcesPath, env) {
  if (!isPackaged && env.HIAGENT_WEB_DIR) return env.HIAGENT_WEB_DIR;
  if (isPackaged) return path.join(resourcesPath, "web");
  return path.join(devRepoRoot(), "packages", "frontend", "dist");
}

module.exports = { resolveKernelDir, resolveWebDir };
```

- [ ] **Step 8: 跑测试确认通过** → PASS。

- [ ] **Step 9: 写失败测试 `tests/menu.test.ts`**

```ts
import { test, expect } from "bun:test";
import { buildTrayMenu } from "../src/util/menu.cjs";

test("buildTrayMenu: 两项 + 分隔（label 顺序）", () => {
  const m = buildTrayMenu(() => {}, () => {});
  const labels = m.filter((x: any) => x.type !== "separator").map((x: any) => x.label);
  expect(labels).toEqual(["打开 HiAgent", "退出"]);
});

test("buildTrayMenu: 点退出触发 onQuit", () => {
  let quit = 0;
  const m = buildTrayMenu(() => {}, () => { quit++; });
  const item: any = m.find((x: any) => x.label === "退出");
  item.click();
  expect(quit).toBe(1);
});
```

- [ ] **Step 10: 跑测试确认失败** → FAIL。

- [ ] **Step 11: 实现 `src/util/menu.cjs`**

```js
// 托盘菜单模板（纯数据 + click 回调），可单测。
function buildTrayMenu(onOpen, onQuit) {
  return [
    { label: "打开 HiAgent", click: onOpen },
    { type: "separator" },
    { label: "退出", click: onQuit },
  ];
}
module.exports = { buildTrayMenu };
```

- [ ] **Step 12: 跑全部桌面测试确认通过**

```bash
cd packages/desktop && bun test
```
Expected: port + paths + menu 全 PASS。

- [ ] **Step 13: 提交**

```bash
git add packages/desktop/src/util/port.cjs packages/desktop/src/util/paths.cjs packages/desktop/src/util/menu.cjs packages/desktop/tests/
git commit -m "feat(desktop): Electron 纯工具(waitForPort/paths/menu) + 单测"
```

---

## Task 3: Electron main（单实例 + BrowserWindow + 生命周期）

**Files:**
- Create: `packages/desktop/src/util/log.cjs`、`packages/desktop/src/main.cjs`

**Interfaces:**
- Consumes: `resolveKernelDir/WebDir`（Task 2；本任务先不用 kernel，Task 5 接）。
- Produces: `src/main.cjs`（Electron 入口，`package.json main`）。

- [ ] **Step 1: 实现 `src/util/log.cjs`（搬自 log.ts，CJS + flush）**

```js
// 文件日志（无控制台 GUI 用）。append，带时间戳；flush 等齐 in-flight 写入。
const { appendFile, mkdir } = require("node:fs/promises");
const { dirname } = require("node:path");

function createLogger(logPath) {
  const pending = new Set();
  const write = (level, line) => {
    const ts = new Date().toISOString();
    const p = mkdir(dirname(logPath), { recursive: true })
      .then(() => appendFile(logPath, `[${ts}] ${level} ${line}\n`))
      .catch(() => {});
    pending.add(p);
    p.finally(() => pending.delete(p));
  };
  return {
    info: (m) => write("INFO", m),
    error: (m, err) => write("ERROR", `${m}${err ? " " + (err instanceof Error ? err.stack : String(err)) : ""}`),
    flush: () => Promise.allSettled([...pending]).then(() => {}),
  };
}
module.exports = { createLogger };
```

- [ ] **Step 2: 实现 `src/main.cjs`（单实例 + 占位窗口；kernel 在 Task 5 接）**

```js
// Electron main：单实例锁 + BrowserWindow + 生命周期。kernel sidecar 在 Task 5 接入。
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const os = require("node:os");
const { createLogger } = require("./util/log.cjs");

const HIAGENT_DIR = process.env.HIAGENT_DIR || path.join(os.homedir(), ".hiagent");
const log = createLogger(path.join(HIAGENT_DIR, "logs", "desktop.log"));

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860,
    icon: path.join(__dirname, "assets", "icon.ico"), // Task 6 放；缺省无碍
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  // Task 5 会改成 loadURL("http://127.0.0.1:9776")；先占位确认窗口能开
  mainWindow.loadURL("data:text/html,<body style='font-family:sans-serif'>Electron shell 启动中…（Task 5 接 kernel）</body>");
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // 单实例：第二实例 → focus 既有窗口
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { log.info("已有实例，退出"); app.quit(); return; }
  app.on("second-instance", () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  log.info(`Electron main 就绪, isPackaged=${app.isPackaged}`);
  createWindow();
});

// Win/Linux：窗口全关 = 退出（托盘「退出」也调 app.quit）
app.on("window-all-closed", () => app.quit());
process.on("SIGINT", () => app.quit());
process.on("SIGTERM", () => app.quit());
```

- [ ] **Step 3: 真机烟测（开窗口）**

```bash
cd packages/desktop
# 注意：必须不带 ELECTRON_RUN_AS_NODE（Claude 环境有就清掉）
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe .
```
Expected: 弹出窗口「Electron shell 启动中…」。关窗即退出。确认无控制台黑窗、无崩溃。
（验证后关窗。Claude 环境须 `env -u ELECTRON_RUN_AS_NODE`；用户自己的终端通常无需。）

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/src/util/log.cjs packages/desktop/src/main.cjs
git commit -m "feat(desktop): Electron main(单实例锁+BrowserWindow+生命周期)"
```

---

## Task 4: 托盘（打开/退出）

**Files:**
- Create: `packages/desktop/src/tray.cjs`
- Modify: `packages/desktop/src/main.cjs`（接 tray）

**Interfaces:**
- Consumes: `buildTrayMenu`（Task 2）。

- [ ] **Step 1: 实现 `src/tray.cjs`**

```js
// Electron Tray + Menu（替 systray2）。「打开」focus 既有窗口。
const { Tray, Menu, nativeImage } = require("electron");
const path = require("node:path");
const { buildTrayMenu } = require("./util/menu.cjs");

let tray = null;
function startTray({ iconPath, onOpen, onQuit }) {
  // icon 缺省用 1x1 nativeImage 占位（Task 6 换真青蛙 ico）
  let image;
  try { image = nativeImage.createFromPath(iconPath); } catch { image = nativeImage.createEmpty(); }
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip("HiAgent");
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(onOpen, onQuit)));
  // 左键单击 = 打开
  tray.on("click", onOpen);
  return tray;
}
module.exports = { startTray };
```

- [ ] **Step 2: 改 `src/main.cjs` 接 tray（在 createWindow 后）**

在 `app.whenReady` 的 `createWindow()` 后追加：
```js
  const { startTray } = require("./tray.cjs");
  startTray({
    iconPath: path.join(__dirname, "assets", "icon.ico"),
    onOpen: () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } },
    onQuit: () => app.quit(),
  });
```
（`onQuit` → app.quit；window-all-closed 已处理退出。kernel kill 在 Task 5 接 cleanup。）

- [ ] **Step 3: 真机烟测**

```bash
cd packages/desktop && env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe .
```
Expected: 右下角出托盘图标（暂为空/默认，Task 6 换青蛙）；右键菜单「打开 HiAgent / 退出」；点「打开」focus 窗口；点「退出」干净退出。关窗验证。

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/src/tray.cjs packages/desktop/src/main.cjs
git commit -m "feat(desktop): Electron 托盘(打开/退出)"
```

---

## Task 5: kernel sidecar（spawn 解释 kernel + 等 9776 + 窗口 load + 退出 kill）

**Files:**
- Create: `packages/desktop/src/kernel-sidecar.cjs`
- Modify: `packages/desktop/src/main.cjs`（接 sidecar + load 9776 + cleanup kill）

**Interfaces:**
- Consumes: `resolveKernelDir/WebDir`（Task 2）、`waitForPort`（Task 2）、`WS_PORT`（9776，`@hiagent/shared`；CJS 里直接写常量 9776 避免引入 TS 包）。

- [ ] **Step 1: 实现 `src/kernel-sidecar.cjs`**

```js
// spawn 解释运行的 kernel sidecar：dev 下 bun.exe run <repo>/packages/kernel/src/desktop-server.ts；
// packaged 下 <kernelDir>/bun.exe run <kernelDir>/kernel.js。等 9776 ready；退出时 kill 子进程树。
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const { waitForPort } = require("./util/port.cjs");

const WS_PORT = 9776;

function killTree(pid) {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {}
}

async function startSidecar({ isPackaged, kernelDir, webDir, bunExe, log }) {
  // dev: repo 下用 bun 跑 kernel 源码入口；packaged: kernelDir 里 bun.exe run kernel.js
  const cmd = isPackaged ? bunExe : "bun";
  const arg = isPackaged
    ? ["run", path.join(kernelDir, "kernel.js")]
    : ["run", path.join(kernelDir, "src", "desktop-server.ts")];
  const child = spawn(cmd, arg, {
    cwd: kernelDir,
    env: { ...process.env, HIAGENT_WEB_DIR: webDir },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (d) => log.info(`[kernel] ${d.toString().trim()}`));
  child.stderr.on("data", (d) => log.error(`[kernel] ${d.toString().trim()}`));
  child.on("exit", (code) => log.info(`[kernel] 退出 code=${code}`));
  log.info(`kernel sidecar pid=${child.pid} cmd=${cmd} ${arg.join(" ")}`);
  const ready = await waitForPort(WS_PORT, 30000);
  if (!ready) { log.error("kernel sidecar 30s 未就绪"); killTree(child.pid); throw new Error("kernel not ready"); }
  log.info(`kernel 就绪 @${WS_PORT}`);
  return { child, pid: child.pid, stop: () => killTree(child.pid) };
}

module.exports = { startSidecar, WS_PORT, killTree };
```

- [ ] **Step 2: 改 `src/main.cjs` 接 sidecar（替换占位 load；加 cleanup）**

把 Task 3 的占位 `mainWindow.loadURL("data:...")` 改为侧车就绪后 `loadURL`，并接 cleanup。完整 `app.whenReady` 段改为：
```js
const { startSidecar, WS_PORT } = require("./kernel-sidecar.cjs");
const { resolveKernelDir, resolveWebDir } = require("./util/paths.cjs");

let sidecar = null;

app.whenReady().then(async () => {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { log.info("已有实例，退出"); app.quit(); return; }
  app.on("second-instance", () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });

  const kernelDir = resolveKernelDir(app.isPackaged, process.resourcesPath, process.env);
  const webDir = resolveWebDir(app.isPackaged, process.resourcesPath, process.env);
  const bunExe = path.join(kernelDir, process.platform === "win32" ? "bun.exe" : "bun");
  try {
    sidecar = await startSidecar({ isPackaged: app.isPackaged, kernelDir, webDir, bunExe, log });
  } catch (e) { log.error("kernel 启动失败", e); app.quit(); return; }

  createWindow();
  mainWindow.loadURL(`http://127.0.0.1:${WS_PORT}`);

  const { startTray } = require("./tray.cjs");
  startTray({
    iconPath: path.join(__dirname, "assets", "icon.ico"),
    onOpen: () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } },
    onQuit: () => app.quit(),
  });
});

async function cleanup() {
  log.info("退出清理");
  try { if (sidecar) sidecar.stop(); } catch {}
  await log.flush();
}
app.on("before-quit", () => { cleanup(); });
```
（`createWindow` 里去掉占位 loadURL，改由这里 load。）

- [ ] **Step 3: 真机烟测（dev：解释跑 repo kernel）**

```bash
cd /h/workspace/hiagent && bun run --filter @hiagent/frontend build   # 先出前端 dist（dev webDir 用）
cd packages/desktop && env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe .
```
Expected: 托盘出 + 窗口加载 `http://127.0.0.1:9776`（hiagent 页面）+ 能正常用（kernel sidecar 解释跑，agent 创建过了扩展加载，需选模型才能 prompt——同 tray-binary 那次）。关窗 → kernel sidecar 也退出（任务管理器无残留 bun）。验证日志 `~/.hiagent/logs/desktop.log` 有 `kernel 就绪`。

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/src/kernel-sidecar.cjs packages/desktop/src/main.cjs
git commit -m "feat(desktop): kernel sidecar(spawn 解释运行)+等9776+窗口load+退出kill"
```

---

## Task 6: 打包 —— kernel sidecar 组装 + electron-builder + build.ts

**Files:**
- Create: `packages/desktop/scripts/build-kernel-sidecar.ts`、`packages/desktop/scripts/build.ts`、`packages/desktop/src/assets/icon.ico`
- Modify: `packages/desktop/electron-builder.yml`、根 `package.json`（pack:* 改）、`.gitignore`

**Interfaces:**
- Produces: `packages/desktop/release/HiAgent <ver>.exe`（Win portable）/ `HiAgent-<ver>.AppImage`（Linux）。

- [ ] **Step 1: 生成青蛙 `src/assets/icon.ico`**（复用 P2 的 PIL genicon，输出到 `src/assets/`）

```bash
cd /h/workspace/hiagent && python packages/desktop/scripts/genicon.py logo.svg packages/desktop/src/assets 2>/dev/null || \
  python -c "from PIL import Image; Image.new('RGBA',(48,48),(75,162,111,255)).save('packages/desktop/src/assets/icon.ico')" 
# 注：genicon.py 在 Task 1 被删了？若已删，用内联 PIL 画青蛙(同 tray-binary 的 genicon 逻辑)或先 git show 恢复
```
> 若 `genicon.py` 已删，`git show 1a69f71:packages/desktop/scripts/genicon.py > packages/desktop/scripts/genicon.py` 恢复后跑，产出 `icon.ico` + 复制为 `icon.png`（Linux 用）。确认 `src/assets/icon.ico` 存在。

- [ ] **Step 2: 实现 `scripts/build-kernel-sidecar.ts`**

```ts
// 组装 resources/kernel/(bun.exe + kernel.js + node_modules) + resources/web/(前端 dist)。
// 复用 tray-binary P2 的文件夹组装逻辑（解释 kernel sidecar = 已验证形态）。
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PKG = join(import.meta.dir, "..");
const RES = join(PKG, "resources");

function run(bin: string, args: string[], cwd = ROOT) {
  console.log(`[sidecar] $ ${bin} ${args.join(" ")}`);
  const r = spawnSync(bin, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) { console.error(`[sidecar] 失败: ${bin}`); process.exit(1); }
}

export async function buildSidecar(target: string) {
  const kernelDir = join(RES, "kernel");
  const webDir = join(RES, "web");
  await rm(RES, { recursive: true, force: true });
  await mkdir(kernelDir, { recursive: true });

  // 1. kernel.js（解释 bundle；--target bun，平台中立，一次构建）
  run("bun", ["build", join(ROOT, "packages", "kernel", "src", "desktop-server.ts"), "--target", "bun", "--outfile", join(kernelDir, "kernel.js")]);

  // 2. node_modules（kernel 生产依赖；排除 workspace，已内联进 kernel.js）
  await writeFile(join(kernelDir, "package.json"), JSON.stringify({
    name: "hiagent-kernel-sidecar", private: true,
    dependencies: {
      "@earendil-works/pi-coding-agent": "^0.80.0", "pi-intercom": "^0.6.0",
      "pi-web-access": "^0.13.0", "pi-lens": "^3.8.0", "@amaster.ai/pi-memory": "^0.1.5",
      typebox: "1.1.38",
    },
  }, null, 2));
  run("bun", ["install", "--production", "--cwd", kernelDir]); // CI 加 BUN_CONFIG_REGISTRY

  // 3. bun 运行时（host 平台复制 process.execPath；非 host 待 wine/跨平台补）
  await cp(process.execPath, join(kernelDir, process.platform === "win32" ? "bun.exe" : "bun"));

  // 4. web（前端 dist）
  run("bun", ["run", "--filter", "@hiagent/frontend", "build"]);
  await cp(join(ROOT, "packages", "frontend", "dist"), webDir, { recursive: true });
  console.log("[sidecar] ✅ resources/kernel + resources/web 组装完成");
}
```

- [ ] **Step 3: 实现 `scripts/build.ts`（编排：测试钩子 → sidecar → electron-builder）**

```ts
// 构建编排：[0]测试钩子 → [1]build-kernel-sidecar(组装 resources/) → [2]electron-builder 出 portable/AppImage。
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { buildSidecar } from "./build-kernel-sidecar";

const PKG = join(import.meta.dir, "..");
const ROOT = join(PKG, "..", "..");
function run(bin: string, args: string[], cwd = PKG) {
  console.log(`[build] $ ${bin} ${args.join(" ")}`);
  const r = spawnSync(bin, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) { console.error(`[build] 失败: ${bin}`); process.exit(1); }
}

async function step0TestGate(noTest: boolean) {
  if (noTest) { console.log("[build] 跳过测试钩子(--no-test)"); return; }
  console.log("[build] 步骤0: 测试钩子");
  run("bun", ["run", "typecheck"], ROOT);
  run("bun", ["run", "test"], ROOT);
}

(async () => {
  const { values } = parseArgs({ options: { target: { type: "string" }, "no-test": { type: "boolean" } } });
  const target = values.target ?? "win";
  await step0TestGate(!!values["no-test"]);
  console.log("[build] 步骤1: 组装 kernel sidecar + web");
  await buildSidecar(target);
  console.log(`[build] 步骤2: electron-builder 出 ${target}`);
  run("npx", ["electron-builder", `--${target}`]);
  console.log("[build] ✅ 完成 → packages/desktop/release/");
})();
```

- [ ] **Step 4: 补全 `electron-builder.yml`**

```yaml
appId: ai.hiagent.desktop
productName: HiAgent
directories:
  output: release
files:
  - src/**
  - package.json
  - node_modules/**      # electron-builder 自动只打包运行时依赖；electron 本体由它处理
extraResources:
  - from: resources/kernel
    to: kernel
    filter: ["**/*"]
  - from: resources/web
    to: web
    filter: ["**/*"]
asarUnpack:
  - resources/**          # sidecar 含原生二进制(bun.exe/ast-grep)，需解包到磁盘才能 spawn
win:
  target: [portable]
  icon: src/assets/icon.ico
linux:
  target: [AppImage]
  icon: src/assets/icon.png
```

- [ ] **Step 5: 根 `package.json` pack 脚本改 + `.gitignore`**

根 `package.json` scripts：
```json
    "pack:win":   "bun run --filter @hiagent/desktop build:win",
    "pack:linux": "bun run --filter @hiagent/desktop build:linux",
    "pack:all":   "bun run pack:win && bun run pack:linux",
```
（删 `pack:mac`——macOS phase 2。）
`packages/desktop/.gitignore`（或根）加：`resources/`、`release/`、`.bun-cache`。

- [ ] **Step 6: 端到端构建（Win portable）**

```bash
cd /h/workspace/hiagent && BUN_CONFIG_REGISTRY=https://registry.npmjs.org/ ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ bun run pack:win
```
Expected: `packages/desktop/release/HiAgent <ver>.exe`（Win portable）产出。验证：双击它 → 解压启动 → 托盘 + 窗口（hiagent 页面）+ agent（解释 sidecar，选模型可 prompt）。

- [ ] **Step 7: 提交**

```bash
git add packages/desktop/scripts/build-kernel-sidecar.ts packages/desktop/scripts/build.ts packages/desktop/electron-builder.yml packages/desktop/src/assets/ package.json
git commit -m "feat(desktop): electron-builder 打包(Win portable+Linux AppImage)+kernel sidecar 组装"
```

---

## Task 7: CI 发版（Gitee Go，wine 出 Win）

**Files:**
- Modify: `.workflow/release.yml`

**Interfaces:** 无。

- [ ] **Step 1: 改 `.workflow/release.yml`（electron-builder + wine）**

```yaml
# 参考 Gitee Go 文档校准字段名/触发器/镜像名；推送后在流水线编辑器核对一次。
name: hiagent-release
displayName: 发版打包(Electron)
triggers:
  push:
    tags: [v*]
stages:
  - name: build-release
    steps:
      - step: script
        name: setup
        run: |
          # Node + wine（Linux runner 出 Win 包）+ Electron 镜像加速
          curl -fsSL https://bun.sh/install | bash
          echo "$HOME/.bun/bin" >> $GITEE_ENV_PATH
          export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
          export BUN_CONFIG_REGISTRY=https://registry.npmjs.org/
          sudo apt-get update && sudo apt-get install -y wine64
      - step: script
        name: install
        run: BUN_CONFIG_REGISTRY=https://registry.npmjs.org/ bun install --frozen-lockfile
      - step: script
        name: build-win
        run: bun run pack:win     # electron-builder 用 wine 交叉编 Win portable
      - step: script
        name: build-linux
        run: bun run pack:linux   # 原生 AppImage
      - step: script
        name: checksums
        run: |
          cd packages/desktop/release
          sha256sum *.exe *.AppImage > checksums.txt 2>/dev/null || true
          cat checksums.txt
      - step: script
        name: upload-release
        run: |
          # Gitee Release API（owner/repo/release-id 首次运行核对，见注释）
          TAG="${GITEE_REF##*/}"
          OWNER="hiagent"; REPO="hiagent"
          for f in packages/desktop/release/*.exe packages/desktop/release/*.AppImage packages/desktop/release/checksums.txt; do
            [ -f "$f" ] || continue
            RELEASE_ID=$(curl -fsSL -H "Authorization: token $GITEE_TOKEN" \
              "https://gitee.com/api/v5/repos/$OWNER/$REPO/releases/tags/$TAG" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
            curl -fsSL -X POST "https://gitee.com/api/v5/repos/$OWNER/$REPO/releases/$RELEASE_ID/attach_files" \
              -H "Authorization: token $GITEE_TOKEN" -F "file=@$f"
          done
```
（macOS 包不发——phase 2。）

- [ ] **Step 2: YAML 语法校验**

```bash
cd /h/workspace/hiagent && python -c "import yaml; [yaml.safe_load(open(f)) for f in ['.workflow/ci.yml','.workflow/release.yml']]; print('YAML OK')"
```

- [ ] **Step 3: 提交**

```bash
git add .workflow/release.yml
git commit -m "ci: Gitee Go 发版改 electron-builder(+wine 出 Win)"
```

> Schema 验收（Gitee Go 字段名/wine 镜像）在首次 push tag 到 Gitee 后核对——属人工门，非本计划代码门。

---

## Task 8: Windows 真机验收

**Files:** 截图放临时目录，测后删。

- [ ] **Step 1: 构建 Win portable**

```bash
cd /h/workspace/hiagent && BUN_CONFIG_REGISTRY=https://registry.npmjs.org/ ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ bun run pack:win
```

- [ ] **验收清单（双击 `packages/desktop/release/HiAgent <ver>.exe`）**：
- [ ] 无控制台黑窗；弹出 Electron 窗口
- [ ] 右下角**青蛙**托盘
- [ ] 右键托盘 → 「打开 HiAgent」「退出」
- [ ] 窗口加载 `http://127.0.0.1:9776` → hiagent 页面正常
- [ ] **选模型 + 发消息给 agent → 收到回复**（kernel 解释 sidecar，pi-intercom 从磁盘解析）
- [ ] 点「退出」→ 托盘消失 + Electron + kernel sidecar（bun）都干净退出（任务管理器无残留）
- [ ] 再次双击 → 单实例：focus 既有（或干净重启）

- [ ] **Step 2: 截图清理 + CHANGELOG + 提交验收记录**

```bash
# 测试截图全部删除
git add CHANGELOG.md
git commit -m "docs: Electron shell v1(Win) 真机验收通过"
```

---

## Self-Review

**1. Spec 覆盖：**
- §3 架构（Electron main + kernel sidecar + BrowserWindow + Tray）→ Task 3/4/5 ✓
- §4.1 desktop 改写 Electron（删 systray2/embed/pe/interop）→ Task 1/2/3/4 ✓
- §4.2 kernel **解释** sidecar（不编译 exe）→ Task 5/6（buildSidecar 出 bun.exe+kernel.js+node_modules）✓
- §4.3 前端零改动 → 不涉及（BrowserWindow load 9776）✓
- §4.4 electron-builder（Win portable + Linux AppImage，macOS 不做）→ Task 6 ✓
- §4.5 CI（Gitee Go + wine）→ Task 7 ✓
- §5 生命周期/单实例/日志 → Task 3（单实例+log）/Task 5（cleanup kill）✓
- §6 spec B 接口 → **不在本计划**（spec B 独立；POC 已过，shell 已留 BrowserWindow+可控 Chromium）✓
- §7 验收（Win 真机）→ Task 8 ✓
- §8 风险 4（音频）→ **POC 已过**（设计稿 §8.4 标记）✓

**2. 占位符扫描：** Task 6 Step 1 的 icon.ico 生成有 `git show` 回退（明确）；Task 7 release 的 owner/repo 标注"首次核对"（外部 Gitee API，已在 Task 内说明）；其余无 TBD/TODO。

**3. 类型/接口一致性：** `waitForPort(port,timeoutMs):Promise<boolean>`（Task 2→5 一致）；`resolveKernelDir(isPackaged,resourcesPath,env):string`（Task 2→5 一致）；`buildTrayMenu(onOpen,onQuit):MenuItem[]`（Task 2→4 一致）；`startSidecar({isPackaged,kernelDir,webDir,bunExe,log}):{stop()}`（Task 5 内部一致）；`WS_PORT=9776`（kernel-sidecar.cjs 与 shared 常量一致）。

---

## Execution Handoff

计划存 `docs/superpowers/plans/2026-07-12-desktop-electron-shell.md`。两种执行：
1. **Subagent-Driven（推荐）** — 每任务派新 subagent + 两阶段评审。
2. **Inline Execution** — 本会话逐任务批量 + 检查点。

你选哪种？
