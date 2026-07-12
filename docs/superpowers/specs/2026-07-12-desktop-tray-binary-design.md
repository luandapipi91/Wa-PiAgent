# HiAgent 桌面托盘应用设计（单二进制 · 三平台 · 纯 Bun）

> ⚠️ **实施结论（2026-07-12）**：本文档原设计的"单 exe 全嵌入（方案 A）"经真机验证**不可行**——pi SDK 的扩展加载器 jiti 在 `bun --compile` 编译二进制里把 `require("pi-intercom/package.json")` 解析到虚拟 FS（`B:\~BUN\root`）而非磁盘，agent 创建失败。最终改用**文件夹模型**：launcher exe（托盘+spawn）+ `bun.exe` + `kernel.js`（解释运行）+ `node_modules` + `web/`。本文档保留为原始设计记录；**最终决策与验证见根 `CHANGELOG.md`**。

> 日期：2026-07-12
> 状态：待评审
> 决策摘要：托盘用 `systray2`（原生 helper 子进程）；单进程内同时跑 kernel（WS+静态前端）与托盘；`bun build --compile` 打成**单个可执行文件**；三平台；分发形态 = **方案 A（全塞单 exe，双击即用）**。

## 1. 背景与目标

现状：hiagent 是 Bun monorepo（`packages/{kernel,frontend,shared}`）。kernel 用 `Bun.serve` 起 WS（9776）；前端 Vite（dev 5180）。`scripts/dev.ts` 并行起两个进程并开浏览器。已有 `bun build --compile` 编译 kernel 二进制的脚本。

目标：把项目打包成**一个可执行二进制**，双击启动后：
- 右下角（Windows/Linux）/菜单栏（macOS）出现**托盘图标（青蛙 logo）**；
- 托盘菜单两项：**「打开 HiAgent」**、**「退出」**；
- 点「打开 HiAgent」→ 用**系统默认浏览器**打开 `http://127.0.0.1:9776`；
- 点「退出」→ 干净退出，托盘消失。

非目标（YAGNI）：桌面窗口/webview（HiAgent 走系统浏览器）、自动更新、代码签名、安装包（v1 直接发单 exe）、托盘通知/子菜单/多语言。

## 2. Spike 验证结论（2026-07-12 已真机验证）

在 `.spike/tray-spike/` 做了最小验证（验证后可删）：

| 验证点 | 结论 |
|---|---|
| 编译后 exe 能 spawn systray2 原生 helper 并出托盘 | ✅ `tray ready`，进程存活 |
| 点击 → JSON IPC → Bun 处理器 → 干净退出 闭环 | ✅ 日志见 `clicked: 退出` → `quit` → exit 0 |
| 图标可见 | ✅ Windows 用 `.ico`（PIL 从 `logo.svg` 图元手绘还原）；真机确认青蛙显示 |
| 无控制台黑窗 | ✅ Bun `--windows-hide-console` 在 1.3.14 **不生效**（oven-sh/bun#24164），改 **PE 子系统字节 patch（3 CONSOLE → 2 WINDOWS_GUI）** 解决，真机确认无黑窗 |

**暴露的两个集成坑（已解，须在实现中固化）：**

1. **CJS/ESM interop**：systray2 是 CommonJS（`exports.default = SysTray`）。`import SysTray from "systray2"` 在 Bun 解释执行 OK，但 `--compile` 后 `__toESM` 把 `.default` 多包一层 → `new .default()` 报 `Object is not a constructor`。
   - 解法：命名空间导入 + 防御性解包：
     ```ts
     import * as ns from "systray2";
     const SysTray = (ns as any).default?.default ?? (ns as any).default ?? ns;
     ```
   - 并用字面量 `{ title: "<SEPARATOR>", tooltip: "", enabled: true }` 代替 `SysTray.separator`（避开静态属性访问）。

2. **本机 `bun install` 装 systray2 确定性 EPERM**：systray2 的原生 helper tarball（含 `tray_*_release[.exe]`）触发 Defender 锁 cache move，本地缓存也绕不过（见 memory `bun-install-windows-eperm`）。
   - 解法（CI/构建机）：`curl` 从官方 `registry.npmjs.org` 拉 tarball，`tar -xzf` 手动解进 `node_modules/systray2`；其纯 JS 依赖 `debug`/`fs-extra` 正常 `bun add`。或给 bun 缓存目录加 Defender 排除。

## 3. 架构：单进程 + 单二进制

新增 workspace 包 **`packages/desktop`**。启动时**在本进程**依次：
1. 端口清理（9776）；
2. 调 kernel 的 `startKernel({ staticDir: <嵌入的前端 dist> })`，在本进程起 `Bun.serve`（WS + 静态前端，同 9776）；
3. 起 systray2 托盘（菜单 打开 / 退出）；
4. 首启自动开浏览器 `http://127.0.0.1:9776`。

一个进程一个 PID → 退出干净。dev 模式（`scripts/dev.ts` 双进程 + Vite）保持不变。

## 4. 改动点

### 4.1 kernel：可导入 + 伺服静态前端

- [`packages/kernel/src/index.ts`](packages/kernel/src/index.ts)：把 `main()` 体抽成 `export async function startKernel(opts?: { staticDir?: string }): Promise<{ port: number }>`；仅 `import.meta.main` 时自动调用（dev 路径零影响）。
- [`packages/kernel/src/ws-server.ts`](packages/kernel/src/ws-server.ts)：`WSServerOpts` 加可选 `staticDir?: string`。`fetch`：先 `server.upgrade(req)`；失败则按 URL 从 `staticDir` 取文件（`getMimeType` 已存在），找不到回退 `index.html`（SPA）。dev 不传 `staticDir` → 维持现状 "WS only"，前端仍由 Vite 5180 伺服。
- 前端 [`ws-instance.ts`](packages/frontend/src/ws-instance.ts) 已硬编码 `ws://127.0.0.1:9776` → **同源伺服零改动**。

### 4.2 新包 `packages/desktop`

- `src/main.ts`：启动编排（清端口 → `startKernel` → 托盘 → 开浏览器 → 生命周期/信号清理）。
- `src/util/open-browser.ts`、`src/util/port.ts`：跨平台开浏览器 + 端口清理（搬自 `scripts/`，desktop 专用副本，不跨包引用 scripts）。
- `src/systray-setup.ts`：封装 systray2 创建/菜单/点击（**含 interop 防御解包**，见 §2 坑 1）。
- `src/embed.ts`：运行时把嵌入的 helper + 图标解压到 `~/.hiagent/.cache/traybin/`，并设置 CWD 使 systray2 的 `./traybin/<bin>` 路径解析命中。
- `scripts/genicon.py`（或 .ts）：由 `logo.svg` 生成 `tray_windows.ico` / `tray_darwin.png`(Template@2x) / `tray_linux.png`（spike 已用 PIL 手绘还原，可沿用）。
- `scripts/build.ts`：构建编排（见 §5）。

### 4.3 单二进制资源嵌入（方案 A 核心）

`bun build --compile` 把一切打进一个 exe：
- **前端 dist**：`vite build` → build 时生成清单 `embedded-web.ts`（对每个 dist 文件 `import f from './web/<file>' with { type: "file" }`，导出 `URL → path` 映射）→ 编译期嵌入 → 运行时 `Bun.file(path)` 伺服。`{type:"file"}` 同时支持文本与二进制资产。
- **systray2 helper**：按目标平台选 `tray_<platform>_release[.exe]`，`import` 为 asset 嵌入 → 运行时解压到 `~/.hiagent/.cache/traybin/`。
- **图标**：同样嵌入 → 解压到 cache，传文件路径给 systray2 `menu.icon`（systray2 `resolveIcon` 自动读文件→base64）。
- **交叉编译**：`--target=bun-windows-x64 | bun-darwin-arm64 | bun-darwin-x64 | bun-linux-x64`，每目标配对该平台的 helper + 图标。

### 4.4 无控制台（三平台）

- **Windows**：编译后做 PE 子系统 patch（3→2），写进 `build.ts`（spike 已验证的字节 patch：`e_lfanew` → PE sig → optional header offset+68，写 `2`）。
- **macOS/Linux**：托盘进程本就不开终端窗口，无需处理。

### 4.5 生命周期 / 日志

- 无控制台 → 日志写 `~/.hiagent/logs/desktop.log`。
- 「打开 HiAgent」→ `openBrowser("http://127.0.0.1:9776")`。
- 「退出」→ `server.stop()` + `systray.kill(false)` + `process.exit(0)`；同时捕获 SIGINT/SIGTERM 做同样清理。
- 廉价单实例：启动时若 9776 已被一个 hiagent 占着，直接开浏览器后退出（不重复起 server）。

## 5. 构建编排（`packages/desktop/scripts/build.ts`）

```
0. 【打包前测试钩子】repo 根跑 `bun run typecheck` + `bun run test`（根脚本已排除 e2e）；任一失败 → 中止，不产二进制。
1. vite build（前端）→ packages/frontend/dist
2. 拷 dist → packages/desktop/src/web/，生成 embedded-web.ts 清单
3. genicon：logo.svg → tray_windows.ico / tray_darwin.png / tray_linux.png
4. 对每个目标平台：
   a. 选该平台 systray2 helper + 图标，准备 import 资产
   b. bun build src/main.ts --compile --target=<target> --outfile dist/desktop/<target>/HiAgent[.exe]
   c. Windows：PE 子系统 patch 3→2
5. 产物：dist/desktop/{win,mac,linux}/HiAgent[.exe]（各 ~100–130 MB）
```

### 5.1 打包命令

根 `package.json` 增加便捷入口（转发到 desktop 包）：
```json
"pack:win":   "bun run --filter @hiagent/desktop build:win",
"pack:mac":   "bun run --filter @hiagent/desktop build:mac",
"pack:linux": "bun run --filter @hiagent/desktop build:linux",
"pack:all":   "bun run --filter @hiagent/desktop build:all",
```

`packages/desktop/package.json`：
```json
"typecheck": "tsc --noEmit",
"test": "bun test",
"build:win":   "bun run scripts/build.ts --target=bun-windows-x64",
"build:mac":   "bun run scripts/build.ts --target=bun-darwin-arm64 --target=bun-darwin-x64",
"build:linux": "bun run scripts/build.ts --target=bun-linux-x64",
"build:all":   "bun run build:win && bun run build:mac && bun run build:linux",
```

用法（在 repo 根）：
- `bun run pack:win` → 产出 `dist/desktop/win/HiAgent.exe`（自动先过测试钩子，不过不打包）。
- `bun run pack:all` → 三平台全出。

### 5.2 打包前测试钩子

- **机制**：`build.ts` 步骤 0 内 spawn 根 `bun run typecheck` 与 `bun run test`，查退出码；任一非零 → 打印 `[build] 测试未通过，中止打包` 并 `process.exit(1)`，不进入 vite build。
- **为何写在 `build.ts` 而非 `pre*` 生命周期**：实际调用的是 `build:win`/`build:mac` 这类**带冒号**的脚本名，npm/bun 的 `pre<script>` 钩子对带冒号脚本名不可靠；gate 放进 `build.ts` 才确定生效。
- **范围**：typecheck（全 workspace）+ 单元/集成测试（根 `test` 已 `--path-ignore-patterns "**/e2e/**"`；e2e 不挡打包，留到真机验收阶段）。
- **旁路**：开发期可用 `build.ts --no-test` 跳过 gate 快速试包；正式发包不带此参数。

## 6. v1 平台范围

- **Windows**：`HiAgent.exe`，双击即用（spike 已验证可达）。
- **Linux**：`HiAgent`（AppImage/.deb 后续；需目标机有 `libayatana-appindicator3-1` 等托盘依赖，真机验证）。
- **macOS**：v1 先裸二进制；`.app`（`LSUIElement=true`，无 Dock 图标、纯菜单栏）后续。

## 7. 验收（AGENTS.md 四层 + 托盘特殊性）

- **单元（`bun:test`）**：端口/路径校验、SPA fallback（`/foo` → index.html）、interop 解包函数、图标选择（按 platform 选文件）、PE subsystem patch 字节正确。
- **集成**：起 server 后 `curl http://127.0.0.1:9776/` 得 index.html、`/assets/*` 得对应资产 + 正确 MIME、WS 可升级。
- **真机手动（三平台）**：双击 exe → 无控制台 → 托盘（青蛙）出现 → 右键菜单两项 → 点「打开」开浏览器且页面能访问、WS 能连、能正常用 → 点「退出」干净消失。**截图为证、测后删截图**（托盘难 E2E 自动化，以真机操作为证）。

## 8. 风险（留给 planning 先 spike/验证）

1. ~~systray2 helper + `bun build --compile` 出托盘~~ ✅ 已验证。
2. **dist 目录嵌入清单**（`embedded-web.ts` 生成 + `{type:"file"}` import 在编译后能否被 `Bun.file()` 伺服）——planning 做最小 spike。
3. **macOS `.app` 打包 + Linux 各发行版托盘依赖**——真机验证。
4. **CI/构建机安装 systray2** 的 EPERM/镜像问题——用 §2 坑 2 的 curl+手动解压流程固化进构建脚本。

## 9. 不做的事（YAGNI）

- 桌面窗口 / webview（HiAgent 走系统浏览器）。
- 自动更新、代码签名、安装包（v1 = 方案 A 直接发单 exe）。
- 托盘通知、子菜单、多语言、托盘图标动态切换。

## 10. CI/CD 流程（Gitee / Gitee Go）

仓库托管在 **Gitee**，CI 用 **Gitee Go**（`.workflow/*.yml`，stages/jobs/steps 语法，与 GitHub Actions 不同，按构建分钟计量）。构建逻辑全在 `build.ts` + 根脚本（`pack:all`/`typecheck`/`test`），CI 只是薄封装。

### 10.1 两条流水线的步骤序列（跨 CI 通用）
- **CI 门禁**（PR + push 到 `master`，失败阻断合并）：装 bun → `bun install --frozen-lockfile` → `bun run typecheck` → `bun run test`。
- **发版**（push tag `v*`）：装 bun → setup-python + `pip install pillow`（genicon 用 PIL）→ `bun install --frozen-lockfile` → `bun run pack:all`（内部 `build.ts` 步骤 0 测试钩子先跑，不过即失败）→ `sha256sum` 生成校验 → 调 **Gitee Release API** 上传 `dist/desktop/{win,mac,linux}/HiAgent[.exe]` + checksums。

### 10.2 Gitee Go 关键点
- **单台 Linux runner 出三平台**：Bun `--compile --target` 交叉编译。Windows Defender/EPERM 在 Linux 不存在；PE 子系统 patch 是字节级、Linux 上照做；macOS v1 是裸二进制（无 `.app`/签名）。**不需要** macOS/Windows 原生 runner（Gitee Go 免费版以 Linux/Ubuntu 为主，macOS 环境基本没有）。
- **双测试门禁**：CI 门禁跑 test+typecheck；`pack:all` 内置 `build.ts` 步骤 0 测试钩子再跑一次。
- **免费额度紧**（200 分钟/仓库 + 500 分钟/月）：PR 只跑 test+typecheck（不打包）；激进缓存 bun 全局缓存与 `node_modules`；release 打包只在 tag 触发。
- **装 bun**：Gitee Go 默认环境无 bun，流水线里装（`curl -fsSL https://bun.sh/install | bash`）。
- **npm 镜像**：国内 runner 默认可能走 npmmirror，部分包 tarball 坏（见 memory `bun-install-windows-eperm`）；用 `bunfig.toml` 固定 `registry.npmjs.org` 或经验证可用的镜像。
- **发版上传**：用 **Gitee Release API**（curl + 私人 access token），**不是** `gh` CLI。

### 10.3 具体 Gitee Go YAML
在 planning 阶段按当时官方文档编写 `.workflow/ci.yml` 与 `.workflow/release.yml`（schema 与 GitHub Actions 不同，此处不臆造）。

### 10.4 待办（非 v1）
- **代码签名**：Windows Authenticode、macOS codesign + notarize（需对应 OS runner + 证书 secret；不签会被 SmartScreen/Gatekeeper 拦）。
- **macOS `.app`** + `LSUIElement`（需 macOS runner，Gitee Go 可能要自托管 runner）。
- **自动更新**（release 后生成 `latest.json`）、**多 arch**（`linux-arm64`/`windows-arm64`，Bun target 支持）。
- 若未来迁 GitHub，再补 `.github/workflows/`（薄封装同一脚本）。
