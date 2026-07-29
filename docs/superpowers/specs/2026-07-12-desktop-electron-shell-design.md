# WaPi 桌面 Shell 迁移至 Electron（设计稿 A）

> 日期：2026-07-12
> 状态：**POC 通过（spec B 前提已验证）**，待 planning
> 取代：[2026-07-12-desktop-tray-binary-design.md](./2026-07-12-desktop-tray-binary-design.md)（Bun-compile 单二进制 + systray2 方案）
> 决策摘要：为支持"录音系统声音"功能（spec B），desktop shell 从「`bun build --compile` 单二进制 + systray2 + 系统浏览器」迁到「Electron（BrowserWindow + Tray + kernel sidecar + electron-builder）」。Electron 控制自带 Chromium，使 spec B 能用 `setDisplayMediaRequestHandler` 去掉 `getDisplayMedia` 共享框并抓系统 loopback 音频。v1 = Windows + Linux；macOS = phase 2。

## 1. 背景与动机

原始需求（spec B）：附件按钮旁加一个录音按钮，点击录**系统声音**，可暂停/停止，结束后把录音当附件存进项目附件文件夹并发给 agent。

brainstorm 阶段调研结论（关键事实，已和用户确认）：

1. **系统声音 loopback 在"用户系统浏览器"里只能走 `getDisplayMedia`**，而浏览器安全规范**强制每次弹共享框、不让网站永久持有屏幕捕获权** → 每次录音都要用户手动选"整个屏幕 + 勾选共享系统音频"。这是 UX 硬伤。
2. **macOS 的 Chrome `getDisplayMedia` 录不到系统声音**（只能录标签页声音）。
3. **跨平台免原生组件的唯一办法是控制 Chromium**（[electron-audio-loopback](https://github.com/alectrocute/electron-audio-loopback) 即 patch Electron 自带 Chromium 实现）。wa-pi 现在跑在用户系统浏览器里、不控制 Chromium，故每平台原生组件不可避免 —— 除非换成 Electron。
4. 用户核心价值：**一套代码跑所有、不东拼西凑、宁愿重构也不愿拼凑**；且要去掉共享框。综合下来，唯一同时满足的路 = **Electron + WebRTC**。

**因此先迁 shell 到 Electron（本 spec = A），录音功能（spec B）叠在其上。** spec A 不含录音 UI，只交付可用的 Electron shell。

## 2. 现状（被取代的）

`packages/desktop` 现状 = `bun build --compile` 单二进制：本进程内起 kernel（`Bun.serve` WS 9776 + 静态前端）+ `systray2` 托盘 + 开系统浏览器。详见被取代的设计文档。已由 5 个 commit 实现（systray2 互通、嵌入前端 dist、PE 子系统 patch 去黑窗、build.ts 编排、CI 流水线）。

本 spec 将其替换为 Electron 实现；那 5 个 commit 保留为 git 历史参考。

## 3. 目标架构（Electron）

```
双击 WaPi.exe  (electron-builder 产物: Electron 启动器 + Chromium + Node + app.asar + 内嵌 kernel sidecar 二进制)
   │
   ▼ Electron main (Node)
   ① app.requestSingleInstanceLock()           // 单实例
   ② spawn Bun kernel sidecar 二进制            // kernel 代码不变, 起 WS 9776
   ③ 等 9776 ready                              // 端口轮询 / kernel 主动信号
   ④ BrowserWindow → load http://127.0.0.1:9776 // React 前端原样
   ⑤ Tray(打开 / 退出)                          // 替 systray2
   ⑥ 日志 → ~/.wa-pi/logs/desktop.log         // 无控制台, parity
   │
   ▼ 退出: window-all-closed / tray 退出 → stop kernel sidecar → app.quit()
```

- **Electron main（Node）**：生命周期、托盘、窗口、spawn kernel sidecar。**不**起 kernel 业务逻辑。
- **kernel sidecar（Bun 二进制）**：现有 kernel 代码不变，`bun build --compile` 成独立 exe，被 main spawn。前端 `ws-instance.ts` 硬编码 9776 → 不变。
- **BrowserWindow**：`loadURL('http://127.0.0.1:9776')`，前端原样跑。
- **Tray**：菜单"打开 WaPi / 退出"，parity（点"打开"focus 既有 BrowserWindow；不再开系统浏览器）。

## 4. 改动点

### 4.1 `packages/desktop` 重写为 Electron

- `src/main.ts`（Electron main）：`app.whenReady` → 单实例锁 → spawn kernel sidecar → 等 WS ready → `BrowserWindow` load 9776 → Tray。
- `src/tray.ts`：Electron `Tray` + `Menu`（替 `systray-setup.ts` 的 systray2）。
- `src/kernel-sidecar.ts`：spawn Bun kernel 二进制（解析 `process.resourcesPath` 定位 sidecar）、等端口 ready、退出时 kill。
- `src/util/single-instance.ts`：`app.requestSingleInstanceLock()`（替原"9776 被占即退出"的廉价单实例）。
- `src/log.ts`：日志写 `~/.wa-pi/logs/desktop.log`（parity；无控制台）。
- **删除**：`systray-setup.ts`、`embed.ts`/`embedded-assets.ts`（前端不再嵌入进 Bun 二进制，由 Electron 伺服/打包）、`util/pe-subsystem.ts`（Electron 自带无控制台窗口，无需 PE patch）、`util/interop.ts`（systray2 CJS 互通专用）。

### 4.2 kernel：**解释运行**的 sidecar（不能用编译 exe）

- 现有 [`startKernel`](packages/kernel/src/index.ts) 逻辑不变。
- ⚠️ **不能用 `bun build --compile` 单 exe**：已真机验证——编译后的 kernel exe 在 agent 创建时，pi SDK 的扩展加载器 jiti 把 `require("pi-intercom/package.json")` 解析到 bun `--compile` 的虚拟 FS（`B:\~BUN\root`）而非磁盘 node_modules → agent 挂（bun compile 的磁盘回退只对原生 require 生效，不覆盖 SDK 的 jiti）。这与由谁 spawn 无关（Electron main spawn 一样会挂）。
- **必须解释运行**：`bun.exe` + `kernel.js`（`bun build --target bun` 的 bundle）+ `node_modules`（kernel 生产依赖），由 Electron main spawn；整体塞进 electron-builder 的 `resources/kernel/`。
- 运行时 main 用 `process.resourcesPath` 定位 `resources/kernel/`，spawn `<resources>/kernel/bun.exe run <resources>/kernel/kernel.js`（CWD=该目录，node_modules 在同级 → SDK 动态加载从磁盘正常解析）。
- dev 路径（`scripts/dev.ts` 双进程 + Vite）维持不变。

### 4.3 前端：零改动

React 前端原样跑在 BrowserWindow 里，连 kernel WS（9776）。`getDisplayMedia` 在 renderer 可用（localhost 是安全上下文）。

### 4.4 构建：electron-builder

- `electron-builder` 出 Windows（nsis 安装包；或 portable 单 exe —— planning 选定）+ Linux（AppImage）。
- kernel sidecar 二进制塞进 `resources/`，运行时 `process.resourcesPath` 定位并 spawn。
- 交叉编译：
  - **Windows**：从 Linux runner 用 `wine` 交叉编（electron-builder 支持，historically 偶发不稳，见 §8 风险 1）。
  - **Linux**：原生构建。
  - **macOS**：需 macOS runner —— Gitee Go 免费版无 → **v1 不出 macOS**；phase 2 需自托管或付费 macOS runner。
- 产物体积：Electron 基座 ~80–150MB + **kernel sidecar 解释运行 = bun.exe(~94MB) + kernel.js(~12MB) + node_modules(~660MB) ≈ 766MB**（node_modules 是大头：pi SDK + ast-grep 原生 + 扩展）→ **预估总计 ~900MB+**（见 §8 风险 2，体积优化是必做项：裁 prod-only / 去重 / 评估能否复用 Electron 的 Node 跑部分逻辑）。
- `packages/desktop/scripts/build.ts` 重写为 electron-builder 编排；保留"打包前 typecheck + test 门禁"。

### 4.5 CI（Gitee Go）

- **CI 门禁**（PR + push master）：不变 —— `bun install` → `bun run typecheck` → `bun run test`。
- **发版**（push tag `v*`）：改为 装 Node + `electron-builder` + `wine`（Win）→ 出 Win + Linux 包 → sha256 → Gitee Release API 上传。macOS 包不发（phase 2）。
- `bunfig.toml` 镜像固定等沿用原设计。

## 5. 生命周期 / 单实例 / 日志

- **启动**：main → `requestSingleInstanceLock()` → spawn kernel sidecar → 轮询 9776 ready（复用 `scripts/` 端口等待逻辑）→ `BrowserWindow` load → Tray。
- **第二实例**：`second-instance` 事件 → focus 既有窗口，不重复起 kernel。
- **退出**：`window-all-closed`（Win/Linux）或托盘"退出" → stop kernel sidecar（SIGTERM → 超时强杀）→ `app.quit()`。捕获 SIGINT/SIGTERM 同样清理。
- **日志**：main 与 kernel sidecar 各自写 `~/.wa-pi/logs/desktop.log` + `kernel.log`。

## 6. 与 spec B（录音）的接口

- spec A 交付**可用的 Electron shell**（窗口 + 托盘 + kernel sidecar + 打包）。**不含**录音 UI。
- spec B 将在 main 注册：
  ```js
  session.defaultSession.setDisplayMediaRequestHandler(
    (req, cb) => cb({ video: <主屏 source>, audio: 'loopback' })  // 自动批准 + 系统 loopback, 不弹框
  )
  ```
  并在前端加 🎙 按钮 + `MediaRecorder`。
- **spec A 的 de-risk spike**（在 A 的 planning 阶段验，因依赖 A 的 Electron 基座）：在 Win 真机验证 `setDisplayMediaRequestHandler` + `audio:'loopback'` 能去框 + 抓系统声音。这是 spec B 的技术前提；若 Win 不过，整个 Electron+WebRTC 方向要重评。

## 7. 验收

- **单元（`bun:test`）**：kernel sidecar spawn/ready 等待逻辑、tray 菜单构建、单实例锁行为、`resourcesPath` 解析。
- **集成**：起 main → kernel sidecar ready → `BrowserWindow` load 9776 得 index.html → WS 可连 → 能正常用。
- **真机手动（Win，截图为证）**：双击 → 无控制台 → 托盘（青蛙）+ 窗口 → wa-pi 页面能访问、WS 连、正常用 → 托盘"退出" → kernel sidecar 也干净退出（任务管理器无残留）。
- **真机手动（Linux）**：AppImage 跑通 + 托盘（需 `libayatuna-appindicator3` 等，同原设计）。
- **macOS**：phase 2，v1 不验。

## 8. 风险（留给 planning 先 spike/验证）

1. **electron-builder 从 Linux + Wine 出 Win 包的确定性**：historically fiddly（wine 版本/nsis 偶发问题）；planning 做最小交叉编译验证，备选 = 用 GitHub Actions 出 Win 包再捞回。
2. **产物体积**（Electron + kernel sidecar 预估 150–250MB）：评估可接受性；优化方向 = kernel sidecar 是否能精简、是否能复用 Electron 的 Node 跑部分 kernel（YAGNI，暂不做，仅评估）。
3. **kernel sidecar ready 检测**：端口轮询 vs kernel 启动后主动 stdout 信号 —— planning 选定。
4. ✅ **`setDisplayMediaRequestHandler` + `audio:'loopback'` 在 Win 真机已 POC 验证通过（2026-07-12）**：最小 Electron app（`.spike/electron-audio-poc/`）拦截 getDisplayMedia 自动批准 + loopback，Win 真机录到系统声音且全程无共享框。spec B 前提成立，本风险消除。
5. **Linux Electron 构建 + 真机托盘依赖**（libayatuna-appindicator 等）—— 真机验证。
6. **macOS runner 缺失** → v1 不出 macOS；phase 2 需自托管/付费 runner。

## 9. 不做的事（YAGNI / 非本 spec）

- **录音功能本身**（spec B）：🎙 按钮、`MediaRecorder`、`setDisplayMediaRequestHandler`、`audio` 附件 kind。
- 自动更新、代码签名、安装包美化。
- macOS `.app` / `LSUIElement`（phase 2）。
- 多 arch（arm64）。
- 把 kernel 改写成 Node 跑在 Electron main 内（kernel 保持 Bun sidecar；混合双运行时是已知代价）。
- 实时音频电平 / 设备选择器 / STT（spec B 的 YAGNI）。

## 10. 取代关系

- 本 spec **取代** [2026-07-12-desktop-tray-binary-design.md](./2026-07-12-desktop-tray-binary-design.md) 的"Bun-compile 单二进制 + systray2"路线。
- 已实现的 5 个 commit（packages/desktop 的 systray2/embed/PE-patch/build.ts/CI）将被本 spec 的 Electron 实现替换；保留为 git 历史参考。
- spec B（录音）将作为独立 spec 后续编写，依赖本 spec 交付的 Electron 基座。
