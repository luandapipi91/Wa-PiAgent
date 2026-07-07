# 设计:移除 Rust 窗口层,改用 bun 启动前后端

**日期:** 2026-07-07
**状态:** 已确认,待出实现计划
**作者:** brainstorming 协作产出

## 背景与动机

当前 hiagent 是 **Tauri 2 原生壳(Rust)+ Bun sidecar 内核 + React 前端** 的三层架构。探索发现 Rust 与 JS/Bun 之间的耦合面极小:

- Rust 侧无任何 `#[tauri::command]`,前端无 `invoke()` 调用——零 IPC。
- 前后端只走 **WebSocket(`ws://127.0.0.1:9776`)**,与 Tauri 完全无关。
- kernel 已能独立 `bun run dev` 跑,frontend 是标准 Vite dev server。
- 前端唯一的 Tauri 依赖(`pick-directory.ts`)已自带 `isTauri()` 守卫和 prompt 降级。

Tauri 窗口层在当前阶段带来的价值低于其维护成本(编译慢、跨平台脚本重、node/npm/npx 工具链尾巴)。目标是**移除 Rust 窗口层,改用 bun 直接启动前后端**,并把测试工具链也统一到 bun。

## 目标形态

**本地服务为主,代码留桌面壳口子。**

- bun 跑 kernel(9776 WS)+ frontend(5173 Vite),用户开浏览器访问 `http://localhost:5173`。
- `src-tauri/` 物理删除,不再走桌面壳分发。
- 前端保留 `isTauri()` 守卫这类抽象(未来接 Electron/Neutralino 时可复用),不刻意删 Tauri 相关依赖包。

## §1 范围边界

本次只做"启动层 + 测试工具链"改造,**不碰业务代码**。

| 类别 | 处理方式 |
|------|---------|
| `src-tauri/` 整个目录 | **删除**(物理移除 Rust 窗口层) |
| `start.sh` / `start.command` | **删除**(由 `bun run dev` 取代) |
| `packages/kernel/src/*`(含 broker/intercom) | **不碰**——broker 清理在另一个计划 |
| `packages/frontend/src/*` | **不碰**(`pick-directory.ts` 的 `isTauri()` 守卫保留,作为"留桌面壳口子"的抽象) |
| 启动层 node/npm/npx 调用 | **全替换为 bun/bunx** |
| `packages/kernel/scripts/copy-sidecar.mjs` | **删除**(sidecar triple 命名是 Tauri externalBin 约定,移除后无用) |
| frontend 测试工具链 | **vitest → bun:test**(24 个测试文件迁移) |

**关于 broker 的范围澄清:** kernel 里的 `broker-proxy.ts`、`intercom-monitor.ts`、`BrokerProxyManager`、`IntercomMonitor`、`pi-intercom` 依赖**不在本次范围内**——它们属于"另一个计划"的废弃清理。本次启动流程**不跑 `ensure_broker`**:kernel 的 `intercom-monitor.ts:92-110` 已有"broker 不可用→降级 null→kernel 继续起 WS server"逻辑,本次直接走降级路径,不报错。等另一个计划清理 broker 后,降级路径自然消失。

**保留的"桌面壳口子":** `pick-directory.ts` 已有 `isTauri()` 守卫和 prompt 降级,本次**不删前端 Tauri 依赖**(`@tauri-apps/plugin-dialog`,以及若存在的 `@tauri-apps/api`),让 `isTauri()` 在非 Tauri 环境自然走 prompt 分支——这样未来接 Electron/Neutralino 时,抽象点还在。这些依赖在 `src-tauri/` 删除后会成为"孤立但无害"的依赖(`isTauri()` 在浏览器环境返回 false,永不执行 Tauri 分支)。是否在另一轮清理中移除,不属于本次范围。

## §2 新启动流程

**核心:根 `package.json` 新增 `dev` 脚本,调用一个极小的 `scripts/dev.ts`。**

```jsonc
// package.json (根)
"scripts": {
  "dev": "bun run scripts/dev.ts",
  "dev:kernel": "bun run --filter @hiagent/kernel dev",
  "dev:frontend": "bun run --filter @hiagent/frontend dev",
  "test": "bun test",
  "typecheck": "bun run --filter '*' typecheck"
}
```

**`scripts/dev.ts` 职责(约 40-60 行,零新依赖):**

1. **端口清理** —— kill 占用 9776(kernel WS)、5173(frontend Vite)的进程。跨平台:Windows 用 `taskkill`,POSIX 用 `kill`。
2. **并行 spawn 两个子进程:**
   - kernel:`bun run --filter @hiagent/kernel dev`(即 `bun run src/index.ts`,bun 内置文件监听热重载)
   - frontend:`bun run --filter @hiagent/frontend dev`(Vite HMR)
3. **日志前缀** —— kernel 行加 `[kernel]`、frontend 行加 `[web]`,混合输出易区分。
4. **统一 Ctrl+C 清理** —— 监听 SIGINT,kill 两个子进程后退出(不留孤儿进程占端口)。
5. **健康提示** —— frontend 起来后打印 `▶ http://localhost:5173`。

**热重载策略:** 各自原生热重载。kernel 用 `bun run src/index.ts`(bun 内置文件监听,改代码自动重启);frontend 用 vite 自带 HMR。两边独立,不需要 concurrently 类工具,不需要保留 fswatch 去抖逻辑。

**启动顺序:** kernel 在前、frontend 在后 spawn。但 frontend Vite 启动很快,WS 连接在前端代码里是"连不上重试"模式,即使 frontend 先就绪也不会崩。不引入"等 kernel WS 就绪再提示 frontend URL"的复杂握手——接受各自独立启动、前端 WS 自动重连。

**不跑 broker。** 见 §1 的范围澄清。

## §3 node → bun 替换清单

启动层之外的 node/npm/npx 调用,本次范围内唯一剩余的是 `copy-sidecar.mjs`(它由 `bun run` 触发,本身用 `node:fs`/`node:os`,但既然整个文件要删,无需替换)。

**其他确认无需改的:**
- 根 `package.json` 的 `test`/`typecheck`/`dev:*` 全是 `bun run`/`bun test`。
- kernel `build` 是 `bun build --compile`,删掉 `&& bun run scripts/copy-sidecar.mjs` 后纯 bun。
- frontend `dev`/`build` 是 vite(自带 runtime)。
- 无 `engines`/`.nvmrc`/`.node-version`/`@types/node`/原生模块。
- `tsconfig.base.json` 的 lib 不含 node 类型。
- 无 CI 配置。
- 源码里的 `node:` 内置模块 import 全部是 bun runtime 原生支持(`fs`/`path`/`crypto`/`net`/`events`/`os`/`url`/`child_process`/`fs/promises`),不是 node-only 特有 API,无需改动。

**结论:** 删掉 `copy-sidecar.mjs` + kernel `build` 脚本那段后,"移除 node"这一诉求在启动层范围内自动达成(没有残留 node/npm/npx 调用)。frontend 的 vitest 依赖移除(见 §5)后,node 工具链尾巴也消除。

## §4 kernel build 定稿

```jsonc
// packages/kernel/package.json
"build": "bun build src/index.ts --compile --target bun --outfile dist/hiagent-kernel"
```

- **保留** `bun build --compile --target bun` —— 产出独立 bun 二进制(自带 runtime,不依赖目标机器装 bun),为未来桌面壳分发留口子。
- **删除** `&& bun run scripts/copy-sidecar.mjs` —— triple 命名(`hiagent-kernel-x86_64-pc-windows-msvc`)是 Tauri externalBin 解析约定,移除后无用。
- **删除** `packages/kernel/scripts/copy-sidecar.mjs` 文件。

## §5 Vitest → bun:test 迁移

**目标:** 移除 `vitest` 依赖,frontend 24 个测试统一用 `bun:test`,与 kernel/shared 一致,全仓库单一测试 runner。

**可行性依据(已查 bun 官方文档 https://bun.sh/docs/test/dom):** bun:test 原生支持 happy-dom(通过 `@happy-dom/global-registrator`)+ React Testing Library,有 `mock()`/`mock.module()`/`beforeEach`/`afterEach` 等全 API。

**现状摸底:**
- kernel/shared 已全部用 `bun:test`(16 处 import)。
- frontend 有 24 个 `.test.tsx`/`.test.ts`,全部用 `vitest`。
- frontend 测试用到的 vitest API 实测频次:`vi.fn`(10 文件)、`vi.mock`(9 文件)、`vi.spyOn`(1 文件)、`beforeEach`(15 文件)。
- **frontend 测试没用 jest-dom**(0 处 import),用原生 `toBeTruthy()`/`toBeFalsy()`(16 文件)——bun:test 原生支持,无需 jest-dom 适配。
- `vitest.config.ts` 配置:`environment: "happy-dom"`、`globals: true`、`setupFiles: ["./tests/setup-websocket.ts"]`(WebSocket polyfill,因为 happy-dom 无原生 WebSocket)。
- e2e 的 `.spec.ts` 是 Playwright(自带 runner),不归 vitest。

**改动点:**

1. **新增 preload 文件 `packages/frontend/tests/happydom-setup.ts`:**
   ```ts
   import { GlobalRegistrator } from "@happy-dom/global-registrator";
   import "./setup-websocket";  // 复用现有 WebSocket polyfill
   GlobalRegistrator.register();
   ```
   (现有 `setup-websocket.ts` 内容保留,被 preload 引用。)

2. **新增 `packages/frontend/bunfig.toml`:**
   ```toml
   [test]
   preload = ["./tests/happydom-setup.ts"]
   ```

3. **24 个测试文件改 import:**
   - `from "vitest"` → `from "bun:test"`
   - `vi.mock("../path", factory)` → `mock.module("../path", factory)`(签名略不同,需逐个调整)
   - `vi.fn()` → `mock()`
   - `vi.spyOn(obj, "m")` → `mock(obj, "m")`
   - `vi` 全局(vitest `globals: true` 提供)→ 改为从 `bun:test` 显式 import
   - 由于不再有 `globals: true`,所有 `beforeEach` 必须显式 import(bun:test 不默认注入全局)

4. **依赖增删(`packages/frontend/package.json`):**
   - 删:`vitest`
   - 新增:`@happy-dom/global-registrator`
   - 保留:`@testing-library/react`(bun 兼容)、`happy-dom`(global-registrator 依赖它,现有 vitest 已带)
   - `@vitejs/plugin-react`:**在 plan 阶段确认** `vite.config.ts` 构建是否也用;若仅测试用则删,若构建共用则保留。

5. **删 `packages/frontend/vitest.config.ts`。**

6. **脚本改:** `"test": "vitest run"` → `"test": "bun test"`。

**迁移粒度:** 24 个测试文件在 plan 阶段拆成可独立验证的小步(按文件或小批量),每步跑 `bun test` 确认绿,再迁下一批。9 个用 `vi.mock` 的文件重点验证 `mock.module` 的 hoisting 行为。

## §6 验证标准

本次改动性质是**删除 + 启动脚本重写 + 测试工具链迁移**,4 层金字塔的适用性逐层说明:

| 层 | 适用? | 验证内容 | 通过标准 |
|----|-------|---------|---------|
| ① 单元/组件(bun:test) | **适用** | `bun test`(kernel + shared + frontend 全部) | 全绿;frontend 24 个组件测试迁移后断言不弱化(用 RTL 的 render/fireEvent/screen 正常工作) |
| ② (合并入①) | — | bun:test + happy-dom + @testing-library/react 组件测试 | render/fireEvent/screen 工作;9 个 vi.mock 文件迁到 mock.module 后 mock 生效 |
| ③ API(curl) | **适用** | `bun run dev` 起后:curl `http://localhost:5173` 返回 frontend HTML;WS 连 `ws://127.0.0.1:9776` 握手成功;Ctrl+C 后端口释放(lsof/netstat 验证无遗留) | 三项通过 |
| ④ E2E(Playwright) | **适用(回归)** | 现有 e2e 套件(`app-flow.spec.ts` 等) | 移除 Tauri 后浏览器流程不坏 |

**额外强约束(本次特有):**
- `bun run dev` 必须在 Windows(Git Bash)和 POSIX 都能起(跨平台验证)。
- `bun run --filter @hiagent/kernel build` 产出 `dist/hiagent-kernel` 可执行,且运行后能起 WS server。
- `bun test` 单命令跑全仓库测试(kernel + shared + frontend)。
- 现有 kernel/shared 单测全绿——确认删 `copy-sidecar.mjs`、改 build 脚本不破坏。

## §7 风险与缓解

- **风险① Ctrl+C 清理不干净,遗留进程占端口。** 缓解:`scripts/dev.ts` 监听 SIGINT/SIGTERM,显式 kill 子进程;启动前先做端口清理兜底。
- **风险② Windows 下 bun 子进程 spawn 的行为差异(信号传递、stdio)。** 缓解:`scripts/dev.ts` 用 `Bun.spawn` + `windowsHide:false`;Windows 验证必跑。
- **风险③ `mock.module` 与 `vi.mock` 行为不完全对等(hoisting 时机不同)。** 缓解:逐个迁移时关注 mock 是否生效,9 个 vi.mock 文件重点验证;必要时调整 factory 写法。
- **风险④ happy-dom global-registrator 与现有 `setup-websocket.ts` polyfill 的注册顺序。** 缓解:preload 里先 `GlobalRegistrator.register()` 再注入 WebSocket;验证组件测试不白屏。
- **风险⑤ 删 `vitest.config.ts` 的 `resolve.alias`(`@hiagent/shared`)丢失。** 缓解:bun:test 解析 workspace 包路径的方式与 vitest 不同,迁移时确认 frontend 测试能正确 import `@hiagent/shared`(必要时在 bunfig.toml 或 tsconfig paths 补齐)。

## 不做什么(YAGNI)

- **不实现桌面壳分发。** 本次只删 Tauri,不接 Electron/Neutralino。未来需要时另开 spec。
- **不清理 kernel 的 broker/intercom 代码。** 那是另一个计划的职责。
- **不写 Windows 专用 `.bat`/`.ps1` 启动脚本。** `scripts/dev.ts` 通过 bun 子进程 API 实现跨平台,不需要平台专用脚本。
- **不引入 concurrently 等并行工具。** `scripts/dev.ts` 自己 spawn,零新依赖。
- **不改历史文档。** MVP plan(`2026-07-06-hiagent-mvp.md`)里"Tauri 窗口"描述是历史记录,违反精准修改原则不改。
