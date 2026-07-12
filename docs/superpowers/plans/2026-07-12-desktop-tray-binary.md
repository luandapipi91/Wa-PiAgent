# HiAgent 桌面托盘单二进制 实现计划

> ⚠️ **实施结论（2026-07-12）**：本计划基于"单 exe 全嵌入"，真机验证后发现不可行（pi SDK jiti 解析扩展撞 `bun --compile` 虚拟 FS）。最终方案改为**文件夹模型**（launcher exe + `bun.exe` + `kernel.js` 解释运行 + `node_modules` + `web/`），即计划中的 Task 13/14 经多次 pivot 后落地为 P2 文件夹组装。本计划保留为原始任务记录；**最终形态见根 `CHANGELOG.md`**。

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤用 `- [ ]` 复选框跟踪。

**Goal:** 把 hiagent 打包成单个可执行二进制，双击启动后右下角出托盘（青蛙 logo），菜单「打开 HiAgent / 退出」，点打开用系统浏览器开 `http://127.0.0.1:9776`。

**Architecture:** 新增 `packages/desktop` 包，启动时**单进程**内调 kernel 的 `startKernel()`（WS+静态前端同 9776）+ 用 `systray2` 跑托盘；`bun build --compile` 把前端 dist、systray2 helper、图标全嵌入单 exe，Windows 额外做 PE 子系统 patch 去掉控制台。

**Tech Stack:** Bun 1.3.14（runtime + bundler/compile）、TypeScript、systray2（原生 helper 子进程）、Vite（前端）、Python+Pillow（图标生成）、Gitee Go（CI）。

## Global Constraints

- 沟通用中文；代码注释尽量中文（AGENTS.md §1）。
- 新增/修改的 service 方法和核心纯函数必须有 bun:test 单元测试（AGENTS.md §6）。
- 禁止生产代码留 `console.log`，用 logger（AGENTS.md / coding-style）。
- 不可变更新优先；不在 `.hiagent` 外写数据。
- 每个有意义的变更完成后更新根 `CHANGELOG.md`（AGENTS.md §7）。
- 四层验收：单元 + 组件 + 集成 + 真机手动；测试截图测后删除（AGENTS.md §6）。
- v1 三平台：Windows / macOS / Linux；分发 = 方案 A（单 exe，双击即用）。
- 托管 = Gitee（Gitee Go CI；不用 GitHub Actions / `gh` CLI）。
- 端口固定 9776（kernel WS + 静态前端同源；前端 `ws-instance.ts` 已硬编码 `ws://127.0.0.1:9776`，勿改）。

---

## File Structure

**修改：**
- `packages/kernel/src/index.ts` — 抽 `export async function startKernel(opts?)`，`import.meta.main` 时才自动跑。
- `packages/kernel/src/ws-server.ts` — `WSServerOpts` 加 `staticDir?`；`fetch` 非 WS 时按 `staticDir` 伺服静态（SPA fallback），否则维持 "WS only"。
- `package.json`（根）— 加 `pack:win` / `pack:mac` / `pack:linux` / `pack:all`。

**新建（`packages/desktop/`）：**
- `package.json`、`tsconfig.json`
- `src/main.ts` — 入口：清端口 → 起 kernel → 跑托盘 → 开浏览器 → 生命周期。
- `src/log.ts` — 文件日志（`~/.hiagent/logs/desktop.log`）。
- `src/util/port.ts` — 端口占用检测/清理（搬自 `scripts/port.ts`，desktop 副本）。
- `src/util/open-browser.ts` — 跨平台开浏览器（搬自 `scripts/open-browser.ts`）。
- `src/util/interop.ts` — systray2 CJS default 防御解包。
- `src/util/pe-subsystem.ts` — Windows PE 子系统 patch（3→2）。
- `src/embed.ts` — 运行时把嵌入的 helper/dist/图标解压到 `~/.hiagent/.cache/`。
- `src/kernel-boot.ts` — 调 `startKernel({ staticDir })` 的封装。
- `src/systray-setup.ts` — 托盘/菜单/点击封装。
- `src/embedded-assets.ts` — **build 时生成**，import 所有嵌入文件 + 导出清单。
- `scripts/build.ts` — 构建编排（测试钩子 + vite + 嵌入清单 + genicon + compile + PE patch）。
- `scripts/genicon.py` — logo.svg → win .ico / mac .png / linux .png（搬自 spike）。
- `tests/*.test.ts` — 各纯函数单元测试。

**新建（CI）：**
- `.workflow/ci.yml`、`.workflow/release.yml` — Gitee Go。

---

## Task 1: Spike — 验证编译后嵌入文件可读（去风险，一次性）

**Files:**
- Create: `.spike/embed-spike/embed.ts`、`.spike/embed-spike/hello.html`
- （`.spike/` 已在 .gitignore，不提交）

**Interfaces:** 无（throwaway）。

- [ ] **Step 1: 写 spike 代码**

`.spike/embed-spike/hello.html`：
```html
<!doctype html><html><body>embedded-ok</body></html>
```
`.spike/embed-spike/embed.ts`：
```ts
// 验证 bun build --compile 后，import {type:'file'} 嵌入的文件能用 Bun.file 读到内容。
import helloPath from "./hello.html" with { type: "file" };
const server = Bun.serve({
  port: 9931,
  fetch: () => new Response(Bun.file(helloPath)),
});
console.log("[embed-spike] serving on", server.port);
```

- [ ] **Step 2: 编译并运行，curl 验证**

Run:
```bash
cd .spike/embed-spike && bun build embed.ts --compile --outfile embed-spike.exe && ./embed-spike.exe &
sleep 1 && curl -s http://127.0.0.1:9931/ ; kill %1
```
Expected: 输出 `<!doctype html><html><body>embedded-ok</body></html>`。

- [ ] **Step 3: 判定**

若 curl 拿到 `embedded-ok` → 嵌入方案成立，继续 Task 2。若失败 → 改用「旁边 web/ 文件夹」方案（build.ts 把 dist 拷到 exe 旁，不嵌入），并在本计划 Task 9/13 相应改 `staticDir` 来源。记录结论到 CHANGELOG。

---

## Task 2: kernel — 可导入 + 静态前端伺服（SPA fallback）

**Files:**
- Modify: `packages/kernel/src/index.ts`（把 `main()` 体抽成 `startKernel`）
- Modify: `packages/kernel/src/ws-server.ts`（`WSServerOpts` + `fetch`）
- Test: `packages/kernel/tests/static-serve.test.ts`

**Interfaces:**
- Produces: `export async function startKernel(opts?: { staticDir?: string }): Promise<{ port: number }>`（`packages/kernel/src/index.ts`）
- Produces: `WSServerOpts` 新增可选字段 `staticDir?: string`
- Consumes: 现有 `getMimeType(filePath)`（已在 ws-server.ts）

- [ ] **Step 1: 写失败测试 `packages/kernel/tests/static-serve.test.ts`**

```ts
import { test, expect } from "bun:test";
import { getMimeType, resolveStaticPath } from "../src/ws-server";

test("resolveStaticPath: 干净路径返回 index.html", () => {
  expect(resolveStaticPath("/", "/web")).toBe("/web/index.html");
  expect(resolveStaticPath("/foo/bar", "/web")).toBe("/web/index.html");
});

test("resolveStaticPath: 已知资产返回拼好的路径", () => {
  expect(resolveStaticPath("/assets/x.js", "/web")).toBe("/web/assets/x.js");
});

test("resolveStaticPath: 拒绝路径穿越", () => {
  expect(resolveStaticPath("/../../etc/passwd", "/web")).toBe("/web/index.html");
});

test("getMimeType: 常见类型", () => {
  expect(getMimeType("a.html")).toBe("text/html");
  expect(getMimeType("a.js")).toBe("text/javascript");
  expect(getMimeType("a.css")).toBe("text/css");
  expect(getMimeType("a.svg")).toBe("image/svg+xml");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/static-serve.test.ts`
Expected: FAIL（`resolveStaticPath` 未导出）。

- [ ] **Step 3: 在 `ws-server.ts` 实现 `resolveStaticPath` 并改 `WSServerOpts` + `fetch`**

在 `getMimeType` 函数附近新增（纯函数）：
```ts
/** 把 URL 路径解析成 staticDir 下的文件路径；未知/越权路径回退 index.html（SPA）。 */
export function resolveStaticPath(urlPath: string, staticDir: string): string {
  const clean = urlPath.split("?")[0].split("#")[0];
  // 只允许纯资产形 /a/b.c；其余（含 .. 、空、根、未知深路径）回退首页
  if (!/^\/[A-Za-z0-9_@\-./]+\.[A-Za-z0-9]+$/.test(clean)) return `${staticDir}/index.html`;
  if (clean.includes("..")) return `${staticDir}/index.html`;
  return `${staticDir}${clean}`;
}
```

`WSServerOpts`（约 115-125 行）加字段：
```ts
  staticDir?: string;
```

`start()` 内 `fetch`（约 145-148 行）改为：
```ts
      fetch: (req, server) => {
        if (server.upgrade(req)) return;            // WS 握手
        if (this.opts.staticDir) {
          const url = new URL(req.url).pathname;
          const filePath = resolveStaticPath(url, this.opts.staticDir);
          const file = Bun.file(filePath);
          if (file.size > 0) {
            return new Response(file, { headers: { "content-type": getMimeType(filePath) } });
          }
        }
        return new Response("WS only", { status: 426 });
      },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/static-serve.test.ts`
Expected: PASS。

- [ ] **Step 5: 抽 `startKernel`，改 `packages/kernel/src/index.ts`**

把现有 `async function main() { ... }` 改名为并导出 `startKernel`，接 `opts`，末尾返回端口，并保留 `import.meta.main` 自动调用：
```ts
export async function startKernel(opts?: { staticDir?: string }): Promise<{ port: number }> {
  process.env.PI_CODING_AGENT_DIR = HIAGENT_DIR;
  await migrateSettingsPackages();
  await mkdir(BUILTIN_SKILLS_DIR, { recursive: true });
  await mkdir(`${HIAGENT_DIR}/sessions`, { recursive: true });

  const configStore = new ConfigStore();
  const projectStore = new ProjectStore();
  const providerStore = new ProviderStore();
  const skillManager = new SkillManager(HIAGENT_DIR);
  const extensionManager = new ExtensionManager(HIAGENT_DIR);
  const memoryStore = new MemoryStore({ hiagentDir: HIAGENT_DIR, projectStore });

  await ensureProviderExtensionRegistered(providerStore);
  const migrated = await migrateLegacySessions(projectStore);
  if (migrated) console.log("[kernel] 已迁移老数据至默认项目");

  let broadcast: (e: WSServerEvent) => void = () => {};
  const server = new WSServer({
    configStore, projectStore, providerStore, skillManager, extensionManager,
    memoryStore, dataDir: HIAGENT_DIR, agentManager: null as any, port: WS_PORT,
    ...(opts?.staticDir ? { staticDir: opts.staticDir } : {}),
  });
  broadcast = (e) => server.broadcast(e);

  const agentManager = new AgentManager({
    projectStore, configStore, providerStore, skillManager,
    onEvent: (sessionId, projectId, agentName, event) => {
      console.log(`[kernel] sdk event: ${(event as any).type}`);
      broadcast({ type: "sdk:event", projectId, sessionId, agentName, event: event as any });
      const errMsg = extractSdkErrorMessage(event as any);
      if (errMsg) broadcast({ type: "error", message: errMsg, agentName, sessionId });
    },
  });
  (server as any).opts.agentManager = agentManager;
  await extensionManager.list();
  await server.start();
  console.log(`[kernel] WS 监听 ws://127.0.0.1:${server.actualPort}`);
  return { port: server.actualPort };
}

if (import.meta.main) {
  startKernel().catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 6: 验证 dev 路径未坏**

Run: `cd /h/workspace/hiagent && bun run --filter @hiagent/kernel typecheck`
Expected: typecheck 通过。

- [ ] **Step 7: 集成测试（起 server + curl 静态资产）**

写 `packages/kernel/tests/static-serve.integration.test.ts`：
```ts
import { test, expect, afterAll } from "bun:test";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { startKernel } from "../src/index";

const TMP = `${import.meta.dir}/.tmp-static`;
let port = 0;

afterAll(async () => { await rm(TMP, { recursive: true, force: true }); });

test("静态伺服：返回 index.html 与资产", async () => {
  await mkdir(`${TMP}/assets`, { recursive: true });
  await writeFile(`${TMP}/index.html`, "<html>ok</html>");
  await writeFile(`${TMP}/assets/x.js`, "console.log(1)");
  ({ port } = await startKernel({ staticDir: TMP }));
  const root = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const asset = await (await fetch(`http://127.0.0.1:${port}/assets/x.js`)).text();
  expect(root).toBe("<html>ok</html>");
  expect(asset).toBe("console.log(1)");
});
```
Run: `cd packages/kernel && bun test tests/static-serve.integration.test.ts`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add packages/kernel/src/index.ts packages/kernel/src/ws-server.ts packages/kernel/tests/static-serve.test.ts packages/kernel/tests/static-serve.integration.test.ts
git commit -m "feat(kernel): 抽出 startKernel + 可选静态前端伺服(SPA fallback)"
```

更新 `CHANGELOG.md`（顶部加一条）。

---

## Task 2b: 端口 .env 动态配置

**Files:**
- Modify: `packages/shared/src/constants.ts` — 新增 `resolvePort()` 纯函数；`WS_PORT`/`FRONTEND_PORT` 从 env 读（默认 9776/5180，行为不变）。
- Modify: `packages/frontend/vite.config.ts` — `loadEnv` 读 `.env`；`server.port` 用 `HIAGENT_WEB_PORT`；`define` 注入 `HIAGENT_WS_PORT` 给浏览器 bundle。
- Modify: `scripts/dev.ts` — 用 shared 的 `WS_PORT`/`FRONTEND_PORT` 替硬编码 9776/5180。
- Create: `.env.example`（入库；`.env` 已被 .gitignore 第 22 行忽略）。
- Test: `packages/shared/tests/ports.test.ts`

**Interfaces:**
- Produces: `resolvePort(envVal: string | undefined, def: number): number`；`WS_PORT`/`FRONTEND_PORT` 变为 env 感知（默认值不变）。
- Consumes: 根 `.env`（bun 自动加载到 `process.env`）；后续 desktop 任务继续用 `WS_PORT` 常量。

- [ ] **Step 1: 写失败测试 `packages/shared/tests/ports.test.ts`**

```ts
import { test, expect } from "bun:test";
import { resolvePort } from "../src/constants";

test("resolvePort: 合法正整数用之", () => {
  expect(resolvePort("8888", 9776)).toBe(8888);
});

test("resolvePort: undefined/空/非数字/0/负数 → 默认", () => {
  expect(resolvePort(undefined, 9776)).toBe(9776);
  expect(resolvePort("", 9776)).toBe(9776);
  expect(resolvePort("abc", 9776)).toBe(9776);
  expect(resolvePort("0", 9776)).toBe(9776);
  expect(resolvePort("-1", 9776)).toBe(9776);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/shared && bun test tests/ports.test.ts`
Expected: FAIL（`resolvePort` 未导出）。

- [ ] **Step 3: 改 `packages/shared/src/constants.ts`**

在 `WS_PORT` 定义处，加纯函数 + env 感知（`env` 是文件里已有的 `{ ...nodeEnv, ...browserEnv }`）：
```ts
/** 端口解析：合法正整数用之，否则用默认。 */
export function resolvePort(envVal: string | undefined, def: number): number {
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? n : def;
}
export const WS_PORT = resolvePort(env.HIAGENT_WS_PORT, 9776);
export const PREVIEW_PORT = resolvePort(env.HIAGENT_PREVIEW_PORT, 9777);
/** 前端 dev 端口（Vite）；desktop 不用（走同源 9776）。 */
export const FRONTEND_PORT = resolvePort(env.HIAGENT_WEB_PORT, 5180);
```

- [ ] **Step 4: 跑测试确认通过** → Run: `cd packages/shared && bun test tests/ports.test.ts` → PASS。

- [ ] **Step 5: 改 `packages/frontend/vite.config.ts`** — `loadEnv` + `server.port` + `define` 注入 `HIAGENT_WS_PORT`

```ts
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => {
  const envVars = loadEnv(mode, process.cwd(), "");          // 读 .env（含非 VITE_ 前缀）
  const webPort = Number(envVars.HIAGENT_WEB_PORT) || 5180;
  const defineEntries: Record<string, string> = {
    "import.meta.env.HIAGENT_WS_PORT": JSON.stringify(envVars.HIAGENT_WS_PORT || "9776"),
  };
  for (const key of ["HIAGENT_DIR", "HOME", "USERPROFILE"]) {
    const val = process.env[key] ?? envVars[key];
    if (val !== undefined) defineEntries[`import.meta.env.${key}`] = JSON.stringify(val);
  }
  return {
    plugins: [react()],
    server: { port: webPort, strictPort: true },
    define: defineEntries,
    resolve: { alias: { "@hiagent/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) } },
  };
});
```

- [ ] **Step 6: 改 `scripts/dev.ts`** — 用 shared 常量替硬编码

把 `import { WS_PORT, FRONTEND_PORT } from "@hiagent/shared";` 加到顶部；删除 `const KERNEL_WS_PORT = 9776;` 和 `const FRONTEND_PORT = 5180;` 两行；文件内 `KERNEL_WS_PORT` 全部替换为 `WS_PORT`。（`FRONTEND_PORT` 现在从 shared 导入，语义不变。）

- [ ] **Step 7: 建 `.env.example`**（入库）

```
# HiAgent 端口（可选，留空/删除用默认值）
HIAGENT_WS_PORT=9776
HIAGENT_WEB_PORT=5180
```
确认 `git check-ignore .env` 返回 `.env`（已被忽略），`.env.example` 不被忽略。

- [ ] **Step 8: 验证**

Run: `cd /h/workspace/hiagent && bun run typecheck`
Expected: 全 workspace typecheck 通过。
（可选真机：`cp .env.example .env`，改 `HIAGENT_WEB_PORT=5200`，`bun run dev`，确认 Vite 在 5200、kernel 在 `HIAGENT_WS_PORT`。）

- [ ] **Step 9: 提交**

```bash
git add packages/shared/src/constants.ts packages/shared/tests/ports.test.ts packages/frontend/vite.config.ts scripts/dev.ts .env.example CHANGELOG.md
git commit -m "feat: 前后端端口支持 .env 动态配置(HIAGENT_WS_PORT/HIAGENT_WEB_PORT)"
```

---

## Task 3: `packages/desktop` 脚手架

**Files:**
- Create: `packages/desktop/package.json`、`packages/desktop/tsconfig.json`

**Interfaces:**
- Produces: workspace 包 `@hiagent/desktop`

- [ ] **Step 1: 建 `packages/desktop/package.json`**

```json
{
  "name": "@hiagent/desktop",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "build:win": "bun run scripts/build.ts --target=bun-windows-x64",
    "build:mac": "bun run scripts/build.ts --target=bun-darwin-arm64 --target=bun-darwin-x64",
    "build:linux": "bun run scripts/build.ts --target=bun-linux-x64",
    "build:all": "bun run build:win && bun run build:mac && bun run build:linux"
  },
  "dependencies": {
    "@hiagent/kernel": "workspace:*",
    "@hiagent/shared": "workspace:*",
    "systray2": "2.1.4"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/bun": "^1.3.0"
  }
}
```

- [ ] **Step 2: 建 `packages/desktop/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["bun"],
    "moduleResolution": "bundler",
    "module": "esnext",
    "target": "esnext",
    "skipLibCheck": true
  },
  "include": ["src", "scripts", "tests"]
}
```

- [ ] **Step 3: 安装依赖（避开本机 EPERM 坑）**

systray2 的 helper tarball 在本机会确定性 EPERM。用 curl 拉 + 手动解压绕过：
```bash
cd packages/desktop
curl -sSL -o systray2.tgz https://registry.npmjs.org/systray2/-/systray2-2.1.4.tgz
mkdir -p node_modules/systray2 && tar -xzf systray2.tgz -C node_modules/systray2 --strip-components=1
rm systray2.tgz
BUN_INSTALL_CACHE_DIR="$PWD/../../../.bun-cache-tmp" bun install   # debug/fs-extra 等纯 JS 正常装
```
Expected: `node_modules/systray2/traybin/tray_windows_release.exe` 存在。

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/package.json packages/desktop/tsconfig.json bun.lock
git commit -m "chore(desktop): 脚手架 @hiagent/desktop 包 + systray2 依赖"
```

---

## Task 4: desktop util/port.ts

**Files:**
- Create: `packages/desktop/src/util/port.ts`、`packages/desktop/tests/port.test.ts`
- Consumes: 无

**Interfaces:**
- Produces: `isPortInUse(port: number): Promise<boolean>`、`killPort(port: number): Promise<void>`

- [ ] **Step 1: 写失败测试 `tests/port.test.ts`**

```ts
import { test, expect } from "bun:test";
import { createServer } from "node:net";
import { isPortInUse } from "../src/util/port";

test("isPortInUse: 空闲端口返回 false", async () => {
  expect(await isPortInUse(59999)).toBe(false);
});

test("isPortInUse: 被监听端口返回 true", async () => {
  const s = createServer();
  await new Promise<void>(r => s.listen(59998, r));
  expect(await isPortInUse(59998)).toBe(true);
  await new Promise<void>(r => s.close(() => r()));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/desktop && bun test tests/port.test.ts` → FAIL（未实现）。

- [ ] **Step 3: 实现 `src/util/port.ts`**

```ts
// 端口占用检测与清理（搬自 scripts/port.ts，desktop 专用副本）。
import { createServer } from "node:net";
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port);
  });
}

export async function killPort(port: number): Promise<void> {
  // 实现：同 scripts/port.ts 的 killPort（PowerShell/taskkill + lsof 轮询）
  // 这里复刻其逻辑；详见 scripts/port.ts。
  const findPid = (p: number) => new Promise<number | null>((resolve) => {
    const ps = `Get-NetTCPConnection -LocalPort ${p} -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess`;
    const child = isWindows
      ? spawn("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: ["ignore", "pipe", "ignore"] })
      : spawn("/bin/sh", ["-c", `lsof -ti :${p}`], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      const m = out.trim().match(/(\d+)/);
      resolve(m ? Number(m[1]) : null);
    });
    child.on("error", () => resolve(null));
  });
  const killPid = (pid: number) => new Promise<void>((resolve) => {
    const c = isWindows
      ? spawn("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" })
      : spawn("/bin/sh", ["-c", `kill -9 ${pid}`], { stdio: "ignore" });
    c.on("close", () => resolve());
    c.on("error", () => resolve());
  });
  const pid = await findPid(port);
  if (pid != null) await killPid(pid);
  for (let i = 0; i < 15; i++) {
    if (!(await isPortInUse(port))) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/desktop && bun test tests/port.test.ts` → PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/util/port.ts packages/desktop/tests/port.test.ts
git commit -m "feat(desktop): 端口检测/清理工具 + 测试"
```

---

## Task 5: desktop util/open-browser.ts

**Files:**
- Create: `packages/desktop/src/util/open-browser.ts`、`packages/desktop/tests/open-browser.test.ts`

**Interfaces:**
- Produces: `openBrowserCommand(): { shell: string; args: string[] } | null`、`openBrowser(url): Promise<void>`

- [ ] **Step 1: 写失败测试（只测命令构建器，不真开浏览器）**

```ts
import { test, expect } from "bun:test";
import { openBrowserCommand } from "../src/util/open-browser";

test("openBrowserCommand: 当前平台返回非空", () => {
  const cmd = openBrowserCommand();
  expect(cmd).not.toBeNull();
  expect(cmd!.shell.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 跑测试确认失败** → Run: `cd packages/desktop && bun test tests/open-browser.test.ts` → FAIL。

- [ ] **Step 3: 实现 `src/util/open-browser.ts`**

```ts
// 跨平台用系统默认浏览器打开 URL（搬自 scripts/open-browser.ts）。
import { spawn } from "node:child_process";

export function openBrowserCommand(): { shell: string; args: string[] } | null {
  switch (process.platform) {
    case "win32": return { shell: "cmd.exe", args: ["/c", "start", ""] };
    case "darwin": return { shell: "/usr/bin/open", args: [] };
    default: return { shell: "xdg-open", args: [] };
  }
}

export async function openBrowser(url: string): Promise<void> {
  const cmd = openBrowserCommand();
  if (!cmd) return;
  return new Promise((resolve) => {
    const child = spawn(cmd.shell, [...cmd.args, url], { stdio: "ignore", detached: true });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}
```

- [ ] **Step 4: 跑测试确认通过** → PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/util/open-browser.ts packages/desktop/tests/open-browser.test.ts
git commit -m "feat(desktop): 跨平台开浏览器工具 + 测试"
```

---

## Task 6: desktop util/interop.ts（systray2 CJS 解包）

**Files:**
- Create: `packages/desktop/src/util/interop.ts`、`packages/desktop/tests/interop.test.ts`

**Interfaces:**
- Produces: `unwrapSysTray(namespace: any): any`（拿到真正的 SysTray 构造器）

- [ ] **Step 1: 写失败测试**

```ts
import { test, expect } from "bun:test";
import { unwrapSysTray } from "../src/util/interop";

test("unwrapSysTray: .default.default 存在时取内层", () => {
  const Ctor = function () {};
  const ns = { default: { default: Ctor } };   // bundle 后 __toESM 的形态
  expect(unwrapSysTray(ns)).toBe(Ctor);
});

test("unwrapSysTray: 仅 .default 时取它", () => {
  const Ctor = function () {};
  const ns = { default: Ctor };                 // 解释执行形态
  expect(unwrapSysTray(ns)).toBe(Ctor);
});

test("unwrapSysTray: 都没有时回退 namespace", () => {
  const Ctor = function () {};
  expect(unwrapSysTray(Ctor)).toBe(Ctor);
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现 `src/util/interop.ts`**

```ts
// systray2 是 CJS（exports.default = SysTray）。Bun 解释执行与 --compile 后的 __toESM
// 互操作层数不同：编译后 .default 被多包一层。这里防御性解包，两种模式都能拿到构造器。
export function unwrapSysTray(namespace: any): any {
  const d = namespace?.default;
  if (typeof d?.default === "function") return d.default;
  if (typeof d === "function") return d;
  return namespace;
}
```

- [ ] **Step 4: 跑测试确认通过** → PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/util/interop.ts packages/desktop/tests/interop.test.ts
git commit -m "feat(desktop): systray2 CJS 防御解包工具 + 测试"
```

---

## Task 7: desktop util/pe-subsystem.ts（Windows 去控制台）

**Files:**
- Create: `packages/desktop/src/util/pe-subsystem.ts`、`packages/desktop/tests/pe-subsystem.test.ts`

**Interfaces:**
- Produces: `patchPeSubsystemToGui(exePath: string): { before: number; after: number }`

- [ ] **Step 1: 写失败测试（用 Bun 自己的 exe 当 fixture，先复制一份）**

```ts
import { test, expect } from "bun:test";
import { copyFile, readFile } from "node:fs/promises";
import { patchPeSubsystemToGui, readSubsystem } from "../src/util/pe-subsystem";

test("patchPeSubsystemToGui: 把 CONSOLE(3) 改成 GUI(2)", async () => {
  const fixture = `${import.meta.dir}/.fixture.exe`;
  await copyFile(process.execPath, fixture);        // 复制一份 bun.exe 作 PE 样本
  const before = await readSubsystem(fixture);
  const { after } = await patchPeSubsystemToGui(fixture);
  expect(after).toBe(2);
  expect(await readSubsystem(fixture)).toBe(2);
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现 `src/util/pe-subsystem.ts`**

```ts
// 把 Windows PE 的 Subsystem 字段从 3(CONSOLE) 改成 2(WINDOWS_GUI)，去掉双击时的黑窗。
// Bun 的 --windows-hide-console 在 1.3.14 不生效（oven-sh/bun#24164），故字节 patch。
import { open } from "node:fs/promises";

export async function readSubsystem(exePath: string): Promise<number> {
  const f = await open(exePath, "r");
  try {
    const buf = Buffer.alloc(4);
    await f.read(buf, 0, 4, 0x3c);
    const eLfanew = buf.readUInt32LE(0);
    const opt = eLfanew + 24;            // optional header 起点
    const sub = Buffer.alloc(2);
    await f.read(sub, 0, 2, opt + 68);   // PE32+ Subsystem 偏移 68
    return sub.readUInt16LE(0);
  } finally {
    await f.close();
  }
}

export async function patchPeSubsystemToGui(exePath: string): Promise<{ before: number; after: number }> {
  const before = await readSubsystem(exePath);
  if (before === 2) return { before, after: 2 };
  const f = await open(exePath, "r+");
  try {
    const buf = Buffer.alloc(4);
    await f.read(buf, 0, 4, 0x3c);
    const opt = buf.readUInt32LE(0) + 24;
    const gui = Buffer.from([0x02, 0x00]);
    await f.write(gui, 0, 2, opt + 68);
    await f.sync();
  } finally {
    await f.close();
  }
  return { before, after: await readSubsystem(exePath) };
}
```

- [ ] **Step 4: 跑测试确认通过** → PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/util/pe-subsystem.ts packages/desktop/tests/pe-subsystem.test.ts
git commit -m "feat(desktop): Windows PE 子系统 patch(CONSOLE→GUI) + 测试"
```

---

## Task 8: desktop log.ts（文件日志）

**Files:**
- Create: `packages/desktop/src/log.ts`、`packages/desktop/tests/log.test.ts`

**Interfaces:**
- Produces: `createLogger(logPath: string): { info(msg): void; error(msg, err?): void }`

- [ ] **Step 1: 写失败测试**

```ts
import { test, expect } from "bun:test";
import { createLogger } from "../src/log";
import { readFile, rm } from "node:fs/promises";

test("createLogger: 写带时间戳的行", async () => {
  const path = `${import.meta.dir}/.tmp.log`;
  const log = createLogger(path);
  log.info("hello");
  log.error("bad", new Error("x"));
  await new Promise((r) => setTimeout(r, 50));
  const txt = await readFile(path, "utf8");
  expect(txt).toContain("hello");
  expect(txt).toContain("bad");
  expect(txt).toContain("Error: x");
  await rm(path, { force: true });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现 `src/log.ts`**

```ts
// 无控制台 GUI 应用用：写文件日志，带时间戳。append，单行。
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface Logger { info(msg: string): void; error(msg: string, err?: unknown): void; }

export function createLogger(logPath: string): Logger {
  const write = (level: string, line: string) => {
    const ts = new Date().toISOString();
    mkdir(dirname(logPath), { recursive: true }).then(
      () => appendFile(logPath, `[${ts}] ${level} ${line}\n`).catch(() => {}),
      () => {},
    );
  };
  return {
    info: (msg) => write("INFO", msg),
    error: (msg, err) => write("ERROR", `${msg}${err ? " " + (err instanceof Error ? err.stack : String(err)) : ""}`),
  };
}
```

- [ ] **Step 4: 跑测试确认通过** → PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/log.ts packages/desktop/tests/log.test.ts
git commit -m "feat(desktop): 文件日志器 + 测试"
```

---

## Task 9: desktop embed.ts（运行时解压嵌入资源）

**Files:**
- Create: `packages/desktop/src/embed.ts`、`packages/desktop/tests/embed.test.ts`
- Consumes: `embedded-assets.ts`（Task 13 生成；本任务先用 fixture 跑通）

**Interfaces:**
- Produces: `extractAssets(assets: Asset[], cacheDir: string): Promise<string>`（返回 cacheDir）

- [ ] **Step 1: 写失败测试（用真实小文件，不依赖编译产物）**

```ts
import { test, expect } from "bun:test";
import { writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractAssets, type Asset } from "../src/embed";

test("extractAssets: 把 src 文件复制到 cacheDir/<dest>", async () => {
  const src = `${import.meta.dir}/.src.txt`;
  await writeFile(src, "payload");
  const cache = `${import.meta.dir}/.cache`;
  const assets: Asset[] = [{ src, dest: "web/index.html" }];
  await extractAssets(assets, cache);
  expect(await readFile(join(cache, "web/index.html"), "utf8")).toBe("payload");
  await rm(src, { force: true });
  await rm(cache, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL。

- [ ] **Step 3: 实现 `src/embed.ts`**

```ts
// 把构建期嵌入的资源（前端 dist / systray helper / 图标）解压到真实缓存目录。
// 嵌入资源在 compiled binary 里是虚拟路径，用 Bun.file() 读字节再写到真实 fs。
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Asset { src: string; dest: string; }

export async function extractAssets(assets: Asset[], cacheDir: string): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  for (const a of assets) {
    const dest = join(cacheDir, a.dest);
    // 已存在且长度一致则跳过（避免每次启动重写）
    const data = await Bun.file(a.src).arrayBuffer();
    try {
      const st = await access(dest).then(() => true).catch(() => false);
      if (st) continue;
    } catch {}
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(data));
  }
  return cacheDir;
}
```

- [ ] **Step 4: 跑测试确认通过** → PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/embed.ts packages/desktop/tests/embed.test.ts
git commit -m "feat(desktop): 嵌入资源运行时解压工具 + 测试"
```

---

## Task 10: desktop systray-setup.ts（托盘/菜单/点击）

**Files:**
- Create: `packages/desktop/src/systray-setup.ts`
- Consumes: `unwrapSysTray`（Task 6）；运行时 helper 已由 embed.ts 解压到 `~/.hiagent/.cache/traybin/`

**Interfaces:**
- Produces: `startTray(opts: { iconPath: string; onOpen: () => void; onQuit: () => void }): Promise<{ kill(): Promise<void> }>`

- [ ] **Step 1: 实现 `src/systray-setup.ts`**（GUI 对象难单测，依赖 spike 已验证；以集成 + 真机为准）

```ts
// 托盘：菜单「打开 HiAgent / 退出」。systray2 helper 需在 ./traybin/（相对 CWD）可解析，
// 调用方需先把 helper 解压到 cacheDir/traybin/ 并 process.chdir(cacheDir)。
import * as ns from "systray2";
import { unwrapSysTray } from "./util/interop";

const SEPARATOR = { title: "<SEPARATOR>", tooltip: "", enabled: true };

export interface TrayHandle { kill(): Promise<void>; }

export function startTray(opts: { iconPath: string; onOpen: () => void; onQuit: () => void }): Promise<TrayHandle> {
  const SysTray = unwrapSysTray(ns);
  return new Promise((resolve, reject) => {
    const tray = new SysTray({
      menu: {
        icon: opts.iconPath,
        title: "HiAgent",
        tooltip: "HiAgent",
        isTemplateIcon: process.platform === "darwin",
        items: [
          { title: "打开 HiAgent", tooltip: "打开", checked: false, enabled: true },
          SEPARATOR,
          { title: "退出", tooltip: "退出", checked: false, enabled: true },
        ],
      },
      debug: false,
      copyDir: false,
    });
    tray.ready().then(() => {
      tray.onClick((action: any) => {
        const title = action?.item?.title;
        if (title === "打开 HiAgent") opts.onOpen();
        else if (title === "退出") opts.onQuit();
      });
      resolve({ kill: () => tray.kill(false) });
    }).catch(reject);
  });
}
```

- [ ] **Step 2: typecheck**

Run: `cd packages/desktop && bun run typecheck` → 通过。

- [ ] **Step 3: 提交**

```bash
git add packages/desktop/src/systray-setup.ts
git commit -m "feat(desktop): 托盘菜单(打开/退出)封装"
```

---

## Task 11: desktop kernel-boot.ts + main.ts（编排）

**Files:**
- Create: `packages/desktop/src/kernel-boot.ts`、`packages/desktop/src/main.ts`
- Consumes: `startKernel`（Task 2）、`embedded-assets.ts`（Task 13 生成）、`extractAssets`（Task 9）、`startTray`（Task 10）、`killPort`/`openBrowser`（Task 4/5）、`createLogger`（Task 8）

**Interfaces:**
- Produces: `packages/desktop/src/main.ts`（编译入口）

- [ ] **Step 1: 实现 `src/kernel-boot.ts`**

```ts
// 在本进程起 kernel（WS + 静态前端，同 9776）。
import { startKernel } from "@hiagent/kernel";
import { WS_PORT } from "@hiagent/shared";

export async function bootKernel(staticDir: string): Promise<{ port: number }> {
  const { port } = await startKernel({ staticDir });
  if (port !== WS_PORT) throw new Error(`kernel 端口异常: ${port}`);
  return { port };
}
```

- [ ] **Step 2: 实现 `src/main.ts`**

```ts
// 单进程编排：清端口 → 解压嵌入资源 → 起 kernel → 跑托盘 → 开浏览器 → 生命周期清理。
import { join } from "node:path";
import { homedir } from "node:os";
import { WS_PORT } from "@hiagent/shared";
import { createLogger } from "./log";
import { killPort } from "./util/port";
import { openBrowser } from "./util/open-browser";
import { extractAssets } from "./embed";
import { bootKernel } from "./kernel-boot";
import { startTray } from "./systray-setup";
import { EMBEDDED_ASSETS } from "./embedded-assets";   // build 时生成

const HIAGENT_DIR = process.env.HIAGENT_DIR || join(homedir(), ".hiagent");
const CACHE_DIR = join(HIAGENT_DIR, ".cache");
const log = createLogger(join(HIAGENT_DIR, "logs", "desktop.log"));

function iconPath(): string {
  const f = process.platform === "win32" ? "tray_windows.ico"
    : process.platform === "darwin" ? "tray_darwin.png" : "tray_linux.png";
  return join(CACHE_DIR, "icons", f);
}

async function main() {
  log.info(`启动 desktop, platform=${process.platform}`);
  await killPort(WS_PORT);

  // 廉价单实例：若仍被占，说明已有一个实例在跑 → 直接开浏览器后退出。
  const { isPortInUse } = await import("./util/port");
  if (await isPortInUse(WS_PORT)) {
    log.info("检测到已有实例，打开浏览器后退出");
    await openBrowser(`http://127.0.0.1:${WS_PORT}`);
    process.exit(0);
  }

  await extractAssets(EMBEDDED_ASSETS, CACHE_DIR);
  process.chdir(CACHE_DIR);   // 让 systray2 的 ./traybin/<bin> 解析命中

  await bootKernel(join(CACHE_DIR, "web"));
  log.info(`kernel 就绪，伺服 http://127.0.0.1:${WS_PORT}`);

  await openBrowser(`http://127.0.0.1:${WS_PORT}`);

  const tray = await startTray({
    iconPath: iconPath(),
    onOpen: () => { openBrowser(`http://127.0.0.1:${WS_PORT}`).catch(() => {}); },
    onQuit: () => { cleanup(tray).catch(() => process.exit(0)); },
  });

  const onSignal = () => cleanup(tray).catch(() => process.exit(0));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function cleanup(tray: { kill(): Promise<void> }) {
  log.info("退出清理");
  try { await tray.kill(); } catch {}
  try { await killPort(WS_PORT); } catch {}
  process.exit(0);
}

main().catch((e) => { log.error("启动失败", e); process.exit(1); });
```

- [ ] **Step 3: typecheck**

Run: `cd packages/desktop && bun run typecheck`
（注意：`embedded-assets.ts` 在 Task 13 生成前会缺，先建占位 stub：`export const EMBEDDED_ASSETS: any[] = [];` 跑通 typecheck，Task 13 覆盖为真清单。）

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/src/kernel-boot.ts packages/desktop/src/main.ts
git commit -m "feat(desktop): 主入口编排(清端口→解压→kernel→托盘→开浏览器)"
```

---

## Task 12: scripts/genicon.py（图标生成）

**Files:**
- Create: `packages/desktop/scripts/genicon.py`
- Consumes: 仓库根 `logo.svg`
- Produces: `packages/desktop/src/embedded/icons/{tray_windows.ico,tray_darwin.png,tray_linux.png}`

- [ ] **Step 1: 写 `scripts/genicon.py`**（搬自 spike 验证过的 PIL 手绘，可命令行指定 outDir）

```python
# 用 PIL 精确手绘 logo.svg（绿底青蛙线稿）-> Windows .ico / mac/linux .png。
# 用法: python genicon.py <logo.svg> <out_dir>
import sys, os
from PIL import Image, ImageDraw

def render(S=512):
    k = S/120.0
    img = Image.new("RGBA",(S,S),(0,0,0,0)); d = ImageDraw.Draw(img)
    d.rounded_rectangle([0,0,S-1,S-1], radius=int(26*k), fill=(75,162,111,255))
    def C(x,y,r,fill=None,outline=None,w=0.0):
        xx,yy,rr=x*k,y*k,r*k; box=[xx-rr,yy-rr,xx+rr,yy+rr]
        if fill is not None: d.ellipse(box,fill=fill)
        if outline is not None and w: d.ellipse(box,outline=outline,width=max(1,int(w*k)))
    C(60,64,38,outline=(255,255,255,255),w=2.5)
    for ex in (38,82):
        C(ex,30,18,fill=(255,255,255,255),outline=(255,255,255,255),w=2.5); C(ex,31,11,fill=(22,23,27,255))
    for (x,y,r) in [(33,24,5),(77,24,5),(41,34,2.5),(85,34,2.5)]: C(x,y,r,fill=(255,255,255,255))
    for (x,y) in [(24,65),(96,65)]: C(x,y,6,fill=(255,255,255,int(255*0.18)))
    p0=(40*k,78*k); p1=(60*k,95*k); p2=(80*k,78*k); pts=[p0]
    for i in range(1,49):
        t=i/48.0
        pts.append(((1-t)**2*p0[0]+2*(1-t)*t*p1[0]+t*t*p2[0], (1-t)**2*p0[1]+2*(1-t)*t*p1[1]+t*t*p2[1]))
    d.line(pts,fill=(255,255,255,255),width=max(2,int(2.8*k)),joint="curve")
    return img

if __name__ == "__main__":
    _svg, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    img = render(512)
    img.save(os.path.join(out,"tray_windows.ico"), format="ICO", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
    img.resize((128,128)).save(os.path.join(out,"tray_darwin.png"))
    img.resize((64,64)).save(os.path.join(out,"tray_linux.png"))
    print("icons ->", out)
```

- [ ] **Step 2: 跑一次验证产出**

Run: `cd packages/desktop && python scripts/genicon.py ../../logo.svg src/embedded/icons && ls src/embedded/icons`
Expected: 三个文件齐。

- [ ] **Step 3: 提交**

```bash
git add packages/desktop/scripts/genicon.py
git commit -m "feat(desktop): logo.svg 图标生成脚本(ico/png)"
```

---

## Task 13: scripts/build.ts（构建编排 + 测试钩子 + 嵌入清单 + PE patch）

**Files:**
- Create: `packages/desktop/scripts/build.ts`、`packages/desktop/src/embedded-assets.ts`（生成）
- Consumes: `patchPeSubsystemToGui`（Task 7）、根 `bun run test`/`typecheck`

**Interfaces:**
- Produces: `<repo-根>/dist/desktop/<win-x64|mac-arm64|mac-x64|linux-x64>/HiAgent[.exe]`

- [ ] **Step 1: 实现 `scripts/build.ts`**

```ts
// 构建编排：[0]测试钩子 → [1]vite build + 物化 dist/helper 到 src/embedded → [2]genicon → [3]生成嵌入清单(walk src/embedded) → [4]每目标 bun build --compile → [5]Windows PE patch。
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PKG = join(import.meta.dir, "..");
const EMBED = join(PKG, "src", "embedded");
const { values } = parseArgs({ options: { target: { type: "string", multiple: true }, "no-test": { type: "boolean" } }, allowNegative: true });

function run(bin: string, args: string[], cwd = ROOT) {
  console.log(`[build] $ ${bin} ${args.join(" ")}`);
  const r = spawnSync(bin, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) { console.error(`[build] 失败: ${bin}`); process.exit(1); }
}

async function step0TestGate() {
  if (values["no-test"]) { console.log("[build] 跳过测试钩子(--no-test)"); return; }
  console.log("[build] 步骤0: 打包前测试钩子");
  run("bun", ["run", "typecheck"]);
  run("bun", ["run", "test"]);   // 根脚本已排除 e2e
}

async function step1Materialize() {
  console.log("[build] 步骤1: vite build + 物化 dist/helper 到 src/embedded");
  run("bun", ["run", "--filter", "@hiagent/frontend", "build"]);
  await rm(join(EMBED, "web"), { recursive: true, force: true });
  await rm(join(EMBED, "traybin"), { recursive: true, force: true });
  await cp(join(ROOT, "packages", "frontend", "dist"), join(EMBED, "web"), { recursive: true });
  await mkdir(join(EMBED, "traybin"), { recursive: true });
  const helperDir = join(PKG, "node_modules", "systray2", "traybin");
  for (const f of ["tray_windows_release.exe", "tray_darwin_release", "tray_linux_release"]) {
    await cp(join(helperDir, f), join(EMBED, "traybin", f));
  }
}

function step2Genicon() {
  console.log("[build] 步骤2: 生成图标");
  run("python", ["scripts/genicon.py", join(ROOT, "logo.svg"), join(EMBED, "icons")], PKG);
}

async function step3Manifest() {
  console.log("[build] 步骤3: 生成 embedded-assets.ts 清单（walk src/embedded 全量）");
  const files: string[] = [];
  for await (const p of walk(EMBED)) files.push(p);
  // main.ts 在 src/，import 路径相对 src/：./embedded/<rel>；dest 相对 src/embedded/。
  const rel = (p: string) => "./embedded/" + p.slice(EMBED.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  const dest = (p: string) => p.slice(EMBED.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  const imports = files.map((p, i) => `import a${i} from ${JSON.stringify(rel(p))} with { type: "file" };`).join("\n");
  const arr = `export const EMBEDDED_ASSETS = [\n${files.map((p, i) => `  { src: a${i}, dest: ${JSON.stringify(dest(p))} }`).join(",\n")}\n];`;
  await writeFile(join(PKG, "src", "embedded-assets.ts"), `${imports}\n\n${arr}\n`);
  console.log(`[build] 清单 ${files.length} 项`);
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

// Bun target → 干净目录名；产物落 repo 根 dist/desktop/<name>/（根 .gitignore 的 dist/ 已排除）。
const TARGET_DIR: Record<string, string> = {
  "bun-windows-x64": "win-x64",
  "bun-darwin-arm64": "mac-arm64",
  "bun-darwin-x64": "mac-x64",
  "bun-linux-x64": "linux-x64",
};
function targetInfo(t: string): { outDir: string; outfile: string; isWin: boolean } {
  const outDir = join(ROOT, "dist", "desktop", TARGET_DIR[t] ?? t);
  return { outDir, outfile: join(outDir, t.includes("windows") ? "HiAgent.exe" : "HiAgent"), isWin: t.includes("windows") };
}

async function step4Compile() {
  const targets = values.target ?? ["bun-windows-x64"];
  for (const t of targets) {
    console.log(`[build] 步骤4: 编译 ${t}`);
    const { outDir, outfile, isWin } = targetInfo(t);
    await mkdir(outDir, { recursive: true });
    run("bun", ["build", join(PKG, "src", "main.ts"), "--compile", `--target=${t}`, `--outfile=${outfile}`], PKG);
    if (isWin) {
      console.log("[build] 步骤5: Windows PE 子系统 patch");
      const { patchPeSubsystemToGui } = await import(join(PKG, "src", "util", "pe-subsystem.ts"));
      const r = await patchPeSubsystemToGui(outfile);
      console.log(`[build] subsystem ${r.before} -> ${r.after}`);
    }
  }
}

(async () => {
  await step0TestGate();
  await step1Materialize();
  step2Genicon();
  await step3Manifest();
  await step4Compile();
  console.log("[build] ✅ 完成");
})();
```

- [ ] **Step 2: 端到端构建 Windows（本机）**

Run: `cd packages/desktop && bun run build:win`
Expected: 产出 `<repo-根>/dist/desktop/win-x64/HiAgent.exe`，且 `[build] subsystem 3 -> 2`。

- [ ] **Step 3: 给 git 排除（产物 + 构建中间产物）**

根 `.gitignore` 已有 `dist/`（覆盖 `<repo-根>/dist/desktop/...` 产物）。再补 build 生成的中间文件：在根 `.gitignore` 追加：
```
# desktop 构建中间产物（build.ts 生成，不入库）
packages/desktop/src/embedded/
packages/desktop/src/embedded-assets.ts
```
验证：`cd /h/workspace/hiagent && git status` 不应出现 `dist/` 或 `packages/desktop/src/embedded/` 任何文件。

- [ ] **Step 4: 真机烟测**（详见 Task 16 完整验收；这里只确认双击不崩、有托盘）

双击 `<repo-根>/dist/desktop/win-x64/HiAgent.exe` → 无黑窗、右下角出现青蛙托盘 → 右键菜单两项 → 点「打开」浏览器开 `http://127.0.0.1:9776` 能访问、WS 连上 → 点「退出」干净消失。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/scripts/build.ts .gitignore
git commit -m "feat(desktop): 构建编排(测试钩子+vite+嵌入清单+genicon+compile+PE patch)"
```

---

## Task 14: 根 pack:* 脚本

**Files:**
- Modify: `package.json`（根）

- [ ] **Step 1: 根 `package.json` 的 scripts 加四行**

```json
    "pack:win":   "bun run --filter @hiagent/desktop build:win",
    "pack:mac":   "bun run --filter @hiagent/desktop build:mac",
    "pack:linux": "bun run --filter @hiagent/desktop build:linux",
    "pack:all":   "bun run --filter @hiagent/desktop build:all",
```

- [ ] **Step 2: 验证**

Run: `cd /h/workspace/hiagent && bun run pack:win`
Expected: 与 Task 13 等价，产出 `<repo-根>/dist/desktop/win-x64/HiAgent.exe`。

- [ ] **Step 3: 提交**

```bash
git add package.json
git commit -m "feat: 根 pack:win/mac/linux/all 打包脚本"
```

---

## Task 15: Gitee Go CI 流水线

**Files:**
- Create: `.workflow/ci.yml`、`.workflow/release.yml`

> **注意：** Gitee Go 的 `.workflow/*.yml` schema 与 GitHub Actions 不同，且会随平台迭代。下面是步骤序列与草稿 YAML；实现时须对照当时的 [Gitee Go 官方文档](https://help.gitee.com/gitee-go/) 在 Gitee 流水线编辑器里核对字段（如 `stages`/`steps`/触发器/镜像名），跑通一次为准。

- [ ] **Step 1: 写 `.workflow/ci.yml`（CI 门禁：PR + push master）**

步骤序列（跨 CI 通用，Gitee Go 里逐 step 实现）：
1. 环境：Ubuntu 镜像，装 bun（`curl -fsSL https://bun.sh/install | bash`）。
2. `bun install --frozen-lockfile`（配 `bunfig.toml` 固定 registry）。
3. `bun run typecheck`。
4. `bun run test`。

草稿 YAML（核对后落盘）：
```yaml
# 参考 Gitee Go 文档校准字段名/触发器/镜像
name: hiagent-ci
displayName: CI 门禁
triggers:
  push:
    branches: [master]
  pull_request:
    branches: [master]
stages:
  - name: check
    steps:
      - step: script
        name: install-bun
        run: |
          curl -fsSL https://bun.sh/install | bash
          echo "$HOME/.bun/bin" >> $GITEE_ENV_PATH
      - step: script
        name: deps
        run: bun install --frozen-lockfile
      - step: script
        name: typecheck
        run: bun run typecheck
      - step: script
        name: test
        run: bun run test
```

- [ ] **Step 2: 写 `.workflow/release.yml`（发版：push tag v*）**

步骤序列：
1. Ubuntu + bun + python(pillow)。
2. `bun install --frozen-lockfile`。
3. `bun run pack:all`（内含测试钩子）。
4. `sha256sum` 生成 checksums。
5. 调 Gitee Release API（curl + `${GITEE_TOKEN}` 私人令牌）上传 `dist/desktop/**/HiAgent[.exe]` + checksums。

草稿 YAML：
```yaml
name: hiagent-release
displayName: 发版打包
triggers:
  push:
    tags: [v*]
stages:
  - name: build-release
    steps:
      - step: script
        name: setup
        run: |
          curl -fsSL https://bun.sh/install | bash
          echo "$HOME/.bun/bin" >> $GITEE_ENV_PATH
          pip install pillow
      - step: script
        name: install
        run: bun install --frozen-lockfile
      - step: script
        name: pack
        run: bun run pack:all
      - step: script
        name: checksums
        run: |
          cd dist/desktop
          sha256sum */HiAgent */HiAgent.exe > checksums.txt || true
      - step: script
        name: upload-release
        run: |
          # 用 Gitee Release API 上传资产；TAG=${GITEE_REF##*/}
          # curl -F "file=@..." "https://gitee.com/api/v5/repos/<owner>/<repo>/releases/<id>/attach_files?access_token=$GITEE_TOKEN"
          echo "TODO: 按 Gitee Release API 上传（见注释）"
```

- [ ] **Step 3: 配 `packages/desktop/bunfig.toml` 固定 registry（避免 npmmirror 坏 tarball）**

```toml
[install]
registry = "https://registry.npmjs.org/"
```

- [ ] **Step 4: 在 Gitee 仓库开启 Gitee Go、推送、确认 ci 流水线在 PR 上触发并绿**

人工验证：提一个测试 PR，看 `hiagent-ci` 是否触发、是否通过 typecheck+test。

- [ ] **Step 5: 提交**

```bash
git add .workflow/ci.yml .workflow/release.yml packages/desktop/bunfig.toml
git commit -m "ci: Gitee Go 流水线(ci 门禁 + release 打包/发版)"
```

---

## Task 16: Windows 真机验收（AGENTS.md 第四层）

**Files:**
- 截图放临时目录，测后删（不入库）。

- [ ] **Step 1: 构建 Windows 产物**

Run: `cd /h/workspace/hiagent && bun run pack:win`

- [ ] **Step 2: 双击 `<repo-根>/dist/desktop/win-x64/HiAgent.exe`，逐项验证并截图**

- [ ] **验收清单（全绿才算过）：**
- [ ] 无控制台黑窗弹出。
- [ ] 右下角出现**青蛙**托盘图标。
- [ ] 右键托盘 → 菜单含「打开 HiAgent」「退出」两项。
- [ ] 点「打开 HiAgent」→ 系统浏览器开 `http://127.0.0.1:9776` → 页面正常加载、kernel WS 连上、能正常用。
- [ ] 点「退出」→ 托盘消失、进程退出干净（任务管理器无 HiAgent 残留）。
- [ ] 再次双击 → 单实例：若上一次还在，直接开浏览器（或干净重启）。

- [ ] **Step 3: 截图清理**

测试截图（无论放哪）全部删除，不提交。

- [ ] **Step 4: 更新 CHANGELOG + 提交验收记录**

```bash
# CHANGELOG.md 顶部加一条「桌面托盘单二进制 v1（Windows）真机验收通过」
git add CHANGELOG.md
git commit -m "docs: 桌面托盘单二进制 v1 Windows 验收记录"
```

---

## Self-Review（计划作者自查）

**1. Spec 覆盖：**
- §3/4.1 kernel 可导入 + 静态伺服 → Task 2 ✓
- §4.2 desktop 包结构（util/systray/embed/main）→ Task 3–11 ✓
- §4.3 单二进制嵌入 → Task 1(spike) + 9(embed) + 13(manifest/compile) ✓
- §4.4 无控制台 PE patch → Task 7 + 13 ✓
- §4.5 生命周期/日志/单实例 → Task 8(log) + 11(main) ✓
- §5 打包命令 + 测试钩子 → Task 13(build) + 14(pack) ✓
- §10 Gitee CI → Task 15 ✓
- §7 验收 → Task 16 ✓
- 图标 → Task 12 ✓
- interop 坑 → Task 6 ✓
- EPERM 安装坑 → Task 3 Step 3 ✓

**2. 占位符扫描：** Task 15 的 release 上传脚本含 `echo "TODO..."` —— 这是真实的外部 API 依赖（Gitee Release API 细节需在 Gitee 上对齐 owner/repo/id），已在 task 内说明并附 curl 注释模板，验收靠「跑通一次」。其余无 TBD/TODO。

**3. 类型一致性：** `startKernel(opts?: {staticDir?})`（Task 2）↔ `bootKernel`（Task 11）↔ `startKernel` import（kernel-boot）一致；`Asset {src,dest}`（Task 9）↔ `extractAssets(assets, cacheDir)`（Task 9/11）↔ `EMBEDDED_ASSETS`（Task 13 生成、Task 11 消费）一致；`unwrapSysTray`（Task 6）↔ systray-setup（Task 10）一致；`patchPeSubsystemToGui`（Task 7）↔ build.ts（Task 13）一致。

---

## Execution Handoff

计划已存 `docs/superpowers/plans/2026-07-12-desktop-tray-binary.md`。两种执行方式：

1. **Subagent-Driven（推荐）** — 每个任务派新 subagent，任务间两阶段评审，迭代快。
2. **Inline Execution** — 本会话内逐任务批量执行，带检查点评审。

你选哪种？
