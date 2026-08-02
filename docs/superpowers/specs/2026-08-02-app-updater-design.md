# 设计：应用版本检查与自动更新（Gitee Releases + electron-updater）

**日期**: 2026-08-02
**状态**: 已确认（设计审查通过）
**作者**: Alex（产品经理）
**范围**: `packages/desktop`（Electron 主进程）+ `packages/frontend`（设置页「关于」页签）

---

## 1. 背景与目标

WA PI Agent 当前没有任何版本检查/更新能力。用户每次想升级只能手动去仓库找安装包。本功能为桌面版提供：

1. **系统设置 → 关于**：显示当前软件版本 + 「检查更新」按钮
2. **检查更新**：请求 Gitee Releases 检查最新发行版，如有更新可下载
3. **下载更新**：显示下载进度条，下载完成后提醒用户安装（静默安装并自动重启）

### 目标

- 用户在「关于」页签一键完成：检查 → 下载（带进度）→ 静默安装 → 自动重启到新版本
- 完整性与可读性：latest.yml 的 sha512 校验保证安装包未被篡改
- 发布流程简单：打包产物上传 Gitee Release 即完成发版

## 2. 已确认决策

| 决策点 | 选择 | 理由 |
| -------- | ------ | ------ |
| 更新源 | **Gitee Releases**（`luandapipi/HiAgent`，公开仓库） | 项目实际托管在 Gitee |
| 更新机制 | **electron-updater**（方案 A：自定义 GiteeProvider） | 下载进度 / sha512 校验 / quitAndInstall 全免费 |
| 安装方式 | **静默安装**（`quitAndInstall`，NSIS `/S`） | 用户确认选择 electron-updater 静默装 |
| 平台 | **Windows 优先**（NSIS），代码结构预留 macOS/Linux | 主要使用平台 |
| 版本号来源 | desktop `package.json` 的 version；远程版本取 `latest.yml` 的 `version` | 单一事实来源，避免 tag 解析歧义 |

## 3. 架构总览

```
┌─ 前端 (React) ──────────────────────────────┐   ┌─ Electron 主进程 ─────────────────────────┐
│ 设置 → 关于 页签 (AboutSection)              │   │  updater.cjs (新增)                        │
│   · 显示版本号/应用信息                       │   │   · 创建 autoUpdater，注入 GiteeProvider   │
│   · 「检查更新」按钮                          │IPC │   · 转发检查/下载/安装指令                  │
│   · 状态区：检查中/有更新/最新/错误           │◄──►│   · 监听 update-available /                 │
│   · 进度条 + 百分比 + 「立即重启安装」        │   │     download-progress / update-downloaded   │
└──────────────────────────────────────────────┘   └────────────────────────────────────────────┘
        ▲ HTTP + SSE（kernel 侧不变）                     ▲ Gitee API v5
        └────────── 不经过 kernel，直接 IPC ─────────────┴── https://gitee.com/api/v5/...
```

**关键决策**：更新链路**不经过 kernel**——检查、下载、安装是 Electron 主进程职责（electron-updater 只能跑在主进程，安装需要 `app.quit()` 权限），前端通过 preload 暴露的 `waPiUpdater` 桥接调用。

### 新增/修改文件

| 文件 | 类型 | 职责 |
| ------ | ------ | ------ |
| `packages/desktop/src/updater/gitee-api.cjs` | 新增 | 纯函数：调 Gitee API 获取最新 release / 附件列表 / latest.yml 解析（fetch 注入，可单测） |
| `packages/desktop/src/updater/gitee-provider.cjs` | 新增 | `Provider` 薄封装：`getLatestVersion()` + `resolveFiles()` |
| `packages/desktop/src/updater/updater.cjs` | 新增 | 装配 autoUpdater + 注册 IPC handler + 事件广播 |
| `packages/desktop/src/updater/gitee-api.test.ts` | 新增 | 单元测试（mock fetch） |
| `packages/desktop/src/updater/updater.test.ts` | 新增 | 单元测试（IPC 装配 / 事件翻译） |
| `packages/desktop/src/preload.cjs` | 修改 | 暴露 `waPiUpdater`（getInfo / check / download / quitAndInstall） |
| `packages/desktop/src/main.cjs` | 修改 | `app.whenReady` 后初始化 updater |
| `packages/desktop/package.json` | 修改 | 新增 `electron-updater` 依赖 |
| `packages/frontend/src/components/settings/AboutSection.tsx` | 新增 | 「关于」页签 UI |
| `packages/frontend/src/store/updater.ts` | 新增 | 前端更新状态机（Zustand） |
| `packages/frontend/src/store/settings.ts` | 修改 | `SettingsSection` 增加 `"about"` |
| `packages/frontend/src/components/SettingsModal.tsx` | 修改 | 左侧导航加「关于」按钮 |
| `packages/frontend/src/components/settings/AboutSection.test.tsx` | 新增 | 组件测试 |
| `scripts/publish-gitee.ts` | 新增（可选） | 发版辅助：上传产物到 Gitee Release |

## 4. GiteeProvider 设计（核心）

`electron-updater` 的 `Provider` 抽象类需实现两个方法：

```js
class GiteeProvider extends Provider {
  constructor(options) {
    super(options);
    this.owner = "luandapipi";
    this.repo = "HiAgent";
    this.baseUrl = "https://gitee.com/api/v5";
  }

  async getLatestVersion() {
    // 1. GET /repos/{owner}/{repo}/releases/latest
    //    → tag_name（如 "v0.2.0"）+ release id
    // 2. GET /repos/{owner}/{repo}/releases/{id}/attach_files
    //    → 附件列表（含 latest.yml、WaPi-Setup-x.y.z.exe，各有 browser_download_url）
    // 3. 找 latest.yml → 下载内容 → parseUpdateInfo() 解析成 UpdateInfo
    // 4. 建 文件名 → browser_download_url 映射表，存 this.fileUrls
    // 返回 UpdateInfo（version 用 latest.yml 的 version）
  }

  resolveFiles(updateInfo) {
    // 用 latest.yml 里的文件名（如 WaPi-Setup-0.2.0.exe）
    // 查映射表得到 Gitee 真实下载 URL，返回 ResolvedUpdateFileInfo[]
  }
}
```

### Gitee API 端点

| 端点 | 用途 |
| ------ | ------ |
| `GET /repos/{owner}/{repo}/releases/latest` | 最新发行版（tag_name / id / name / body） |
| `GET /repos/{owner}/{repo}/releases/{id}/attach_files` | 附件列表（name / browser_download_url / size） |
| `GET {browser_download_url}` | 下载 latest.yml 与安装包 |

公开仓库无需 token；检查更新是低频操作，可接受匿名 API 限流（失败时前端给出可读错误）。

### 流程时序

```
前端 ──waPiUpdater.checkForUpdates()──► 主进程 ──► autoUpdater.checkForUpdates()
                                                          │
                    GiteeProvider.getLatestVersion()      │
                      ├─ Gitee API: releases/latest  ─────┤
                      ├─ Gitee API: attach_files  ────────┤
                      └─ 下载 latest.yml，解析 UpdateInfo ┘
                                                          │
                    autoUpdater 比较版本（semver）           │
                    ──有更新──► 前端收到 update-available    │
                    ──无更新──► 前端收到 up-to-date          │
                                                          │
前端 ──waPiUpdater.downloadUpdate()──► 主进程 ──► autoUpdater.downloadUpdate()
                    download-progress 事件 ──► 前端进度条（percent）
                    update-downloaded 事件 ──► 前端显示「立即重启安装」按钮
前端 ──waPiUpdater.quitAndInstall()──► 主进程 ──► autoUpdater.quitAndInstall()
                    （静默安装 NSIS /S → 自动重启新版本）
```

## 5. 前端「关于」页签 + 状态机

### 导航

`SettingsSection` 增加 `"about"`；`SettingsModal` 左侧导航底部加「关于」按钮。

### AboutSection 组件（居中卡片式，已确认）

布局：logo（96px 圆角方块，深色底）→ 应用名（18px 加粗）→ 版本号（13px 次要色）→ hairline 分隔线 → 操作/状态区，全部居中。

```
┌─────────────────────────────────────┐
│          [logo 96px]                │
│          WA PI Agent                │
│          版本 0.1.0                  │
│  ───────────────────────────────    │
│  [检查更新]                          │   ← idle / up-to-date / error 时可用
│                                     │
│  状态区（按状态切换）：                │
│  · checking   → 转圈 "正在检查更新…"  │
│  · available  → "发现新版本 v0.2.0"   │
│                 [绿色「最新」徽标]     │
│                 当前/新版本+大小      │
│                 release notes       │
│                 [立即更新]（紫色）    │
│  · downloading→ 进度条 45%          │
│                 (已下载/总量)        │
│                 [取消]              │
│  · downloaded → 绿色"更新已就绪"     │
│                 [立即重启安装]（绿）  │
│                 [稍后再说]          │
│  · up-to-date → 绿色"已是最新版本 ✓" │
│  · error      → 红色错误文案 + [重试] │
└─────────────────────────────────────┘
```

**release notes**：available 状态展示发行版说明，从 Gitee Release 的 `body` 字段读取（经 `update-available` 事件携带给前端）。

交互原型：`.spike/updater-ui-proto.html`（gitignore，不入库），样式复用 `styles.css` 主题变量。

### updater store（Zustand）

```ts
type UpdaterStatus =
  | "idle" | "checking" | "up-to-date"
  | "available" | "downloading" | "downloaded"
  | "error";

interface UpdaterState {
  status: UpdaterStatus;
  appVersion: string;        // 当前版本（来自主进程 app.getVersion()）
  latestVersion: string | null;
  progress: number;          // 0-100
  transferred: number;       // 已下载字节
  total: number;             // 总字节
  error: string | null;
  isDesktop: boolean;        // 是否 Electron 环境（浏览器 dev 时隐藏更新区）
  checkForUpdates(): void;
  downloadUpdate(): void;
  quitAndInstall(): void;
  reset(): void;
}
```

## 6. IPC 契约

preload 暴露 `waPiUpdater`：

| 方向 | 通道 | 载荷 |
| ------ | ------ | ------ |
| 前端→主 | `updater:get-info` | → `{ appVersion, isDesktop }` |
| 前端→主 | `updater:check` | 触发检查，结果经事件回传 |
| 前端→主 | `updater:download` | 开始下载 |
| 前端→主 | `updater:quit-and-install` | 退出并安装 |
| 主→前端 | `updater:event` | `{ phase, version?, releaseNotes?, progress?, transferred?, total?, message? }` |

主进程 `updater.cjs` 将 autoUpdater 事件统一翻译为 `updater:event` 推给前端：
`checking-for-update` → `checking`；`update-available` → `available`（携带 version + releaseNotes，releaseNotes 取自 Gitee Release body）；`update-not-available` → `up-to-date`；`download-progress` → `downloading`；`update-downloaded` → `downloaded`；`error` → `error`。

**约束**：`app.isPackaged === false`（dev）时 `updater:check` 返回 `{ isDesktop: false }`，前端禁用按钮并提示「仅安装版支持」；不触发真实更新流程。

## 7. 可测试性拆分

`GiteeProvider` 依赖 electron-updater 的 `Provider`（内部用 `ElectronHttpExecutor`），无法在纯 Node 单元测试中实例化。核心解析逻辑拆成纯函数模块：

```
packages/desktop/src/updater/
├── gitee-api.cjs      ← 纯函数：fetchGiteeLatestRelease / fetchAttachFiles / findLatestYml
│                          （fetch 由调用方注入，测试时传 mock）
├── gitee-provider.cjs ← Provider 薄封装：调 gitee-api → parseUpdateInfo → resolveFiles
├── updater.cjs        ← 装配 autoUpdater + IPC
└── gitee-api.test.ts  ← 单元测试：mock fetch，验证解析/映射/边界
```

## 8. 发版流程

```
1. bump 版本号（packages/desktop/package.json）
2. bun run pack:win
   → 产出 release/WaPi-Setup-{ver}.exe + latest.yml (+ .blockmap)
3. 在 Gitee 创建 Release（tag = v{ver}），附件上传：
   latest.yml（必传，Provider 依赖）
   WaPi-Setup-{ver}.exe（必传）
4.（可选自动化）scripts/publish-gitee.ts：
   读 release/ 产物 → 调 Gitee API 创建 release + 上传附件
   （需 GITEE_TOKEN 环境变量；没有 token 时打印手动上传指引）
```

**风险与缓解**：

- Gitee API 匿名限流（约 60 次/小时/IP）→ 检查更新是低频操作，可接受；失败时前端显示可读错误
- 附件 `browser_download_url` 匿名可下载性 → 实现时 curl 实测；若被鉴权拦截，改用 `attach_files/{id}/download` 端点

## 9. 错误处理与降级

| 场景 | 处理 |
| ------ | ------ |
| 非 packaged（dev） | 检查按钮禁用 + 提示「仅安装版支持」 |
| Gitee API 网络失败 / 超时 | `error` 状态 + 「检查失败，请重试」+ 重试按钮 |
| 仓库无 Release / 404 | 视为「已是最新版本」并提示 |
| 附件缺 latest.yml | 「发行版配置不完整，请稍后再试」 |
| 下载中断 | 自动重试一次，仍失败则报错（可再次点击下载） |
| sha512 校验失败 | electron-updater 报错 → 显示「下载文件校验失败」 |
| 安装失败 | 提示手动从 Gitee Release 下载安装包 |

## 10. 测试策略（四层）

1. **单元测试**（bun:test，desktop）：gitee-api 纯函数解析/映射/边界（mock fetch）
2. **组件测试**（vitest + testing-library）：AboutSection 各状态渲染、按钮交互、进度条更新
3. **接口/集成测试**：本地 mock Gitee HTTP server（返回固定 release JSON + latest.yml + 小体积安装包）→ 走真实 autoUpdater 流程（dev 模式可跑）
4. **E2E**（playwright + mock server）：打开设置→关于→点检查→断言出现「发现新版本」→点下载→断言进度到 100%→断言「立即重启安装」出现（最后一步点「暂不重启」避免真重启）

## 11. 非目标（Non-Goals）

- 本版本不做 macOS / Linux 更新链路（Provider 已按平台预留，Windows 的 latest.yml 通道名无平台前缀，天然兼容）
- 不做差分更新（.blockmap 差分包），V1 全量下载
- 不做更新策略配置（自动检查频率、channel 选择等），V1 仅手动检查
- 不做强制更新 / 更新通知角标
- 浏览器 dev 模式（非 Electron）不提供更新功能

## 12. 开放问题

- [ ] Gitee release 附件 `browser_download_url` 的匿名下载可行性 —— 实现时 curl 实测，必要时改用 API download 端点
- [ ] electron-updater 版本选择（随 electron-builder 26 生态，选 `^6.x` 稳定版）—— 安装时确认
