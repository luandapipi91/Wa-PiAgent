# 应用版本检查与自动更新（Gitee Releases + electron-updater）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为桌面版提供「设置 → 关于」页签：检查更新 → 下载（带进度）→ 静默安装 → 自动重启。

**Architecture:** 更新链路不经过 kernel：Electron 主进程内用 electron-updater + 自定义 GiteeProvider（官方 `provider: "custom"` 通道，`setFeedURL({ provider: "custom", updateProvider: GiteeProvider, ... })`）从 Gitee Releases 拉 `latest.yml` 并下载安装包；前端经 preload 暴露的 `waPiUpdater` 桥接调用，Zustand store 做状态机，AboutSection 渲染各状态。Gitee API 交互拆成纯函数模块（fetch 注入）以便单测。

**Tech Stack:** Electron 43（主进程 CJS）、electron-updater ^6、React + Zustand、bun:test（desktop/frontend 单测）、Playwright（E2E）。

**Spec:** `docs/superpowers/specs/2026-08-02-app-updater-design.md`（已确认，逐条覆盖）

## Global Constraints

- electron-updater 版本：`^6`（随 electron-builder `^26` 生态；安装时确认装到的是 6.x）。
- 更新源：Gitee 公开仓库 `luandapipi/HiAgent`，API base `https://gitee.com/api/v5`，匿名访问（无 token）。
- 平台：Windows 优先（NSIS）；channel 文件 `latest.yml`（win32 下 `getDefaultChannelName()` 返回 `latest`，无平台前缀，天然兼容）。
- 更新链路**不经过 kernel**；前端只通过 preload 的 `waPiUpdater` 与主进程 IPC 通信。
- desktop 源码一律 CommonJS `.cjs`（`packages/desktop/package.json` 是 `"type": "module"`）。
- desktop 单测用 `bun:test`，在 `packages/desktop` 下跑 `bun test`；已有范例 `packages/desktop/tests/menu.test.ts`。
- frontend 单测用 `bun:test` + `@testing-library/react` + happy-dom，在 `packages/frontend` 下跑 `bun test --isolate`；已有范例 `packages/frontend/src/components/settings/CommandListModal.test.tsx`。
- V1 全量下载：`autoUpdater.disableDifferentialDownload = true`（不依赖 .blockmap 附件）。
- dev（`app.isPackaged === false`）不触发真实更新：`updater:check` 返回 `{ isDesktop: false }`，前端禁用按钮并提示「仅安装版支持」。
- UI 文案中文；代码注释中文；版本号唯一来源是 `packages/desktop/package.json` 的 `version`（当前 `0.1.0`）。
- 安装方式：静默安装 `quitAndInstall(true, true)`（NSIS `/S`，装完自动重启）。
- 已知风险（不在本计划解决）：当前 `electron-builder.yml` 的 `nsis.perMachine: true`，静默安装会触发 UAC 提权弹窗；这是既有打包决策的副作用，如产品不接受再单开任务评估改 `perMachine: false`。
- 改动完成后按根目录 `AGENTS.md` 要求更新 `CHANGELOG.md`（每个 Task 的 commit 步骤已含）。

---

### Task 1: Gitee API 纯函数模块（desktop）

**Files:**
- Create: `packages/desktop/src/updater/gitee-api.cjs`
- Test: `packages/desktop/tests/gitee-api.test.ts`

**Interfaces:**
- Consumes: 无（只依赖注入的 `fetch`，签名为 WHATWG fetch 子集：`fetch(url, {headers}) → { status, ok, json(), text() }`）。
- Produces（后续 Task 依赖的确切签名）:
  - `GITEE_API_BASE: string`（`= "https://gitee.com/api/v5"`）
  - `fetchGiteeLatestRelease(fetchImpl, opts) → Promise<{ id: number, tag_name: string, name: string|null, body: string|null }>`；404 时抛 `err.code === "NOT_FOUND"` 的 Error
  - `fetchAttachFiles(fetchImpl, opts, releaseId) → Promise<Array<{ name: string, browser_download_url: string }>>`
  - `findLatestYml(attachFiles, channelFile) → { name, browser_download_url } | null`
  - `fetchText(fetchImpl, url, what) → Promise<string>`
  - `buildFileUrlMap(attachFiles) → Map<string, string>`（文件名 → 下载 URL）
  - 其中 `opts = { owner: string, repo: string, baseUrl?: string }`（`baseUrl` 缺省用 `GITEE_API_BASE`，测试/mock server 时覆盖）

- [ ] **Step 1: 写失败测试**

创建 `packages/desktop/tests/gitee-api.test.ts`：

```ts
// gitee-api 纯函数单测：mock fetch，验证 URL 拼装 / 解析 / 错误边界。
import { test, expect } from "bun:test";
import {
	GITEE_API_BASE,
	fetchGiteeLatestRelease,
	fetchAttachFiles,
	findLatestYml,
	fetchText,
	buildFileUrlMap,
} from "../src/updater/gitee-api.cjs";

const OPTS = { owner: "luandapipi", repo: "HiAgent" };

// 构造最小 fetch mock：按 URL → 响应表路由
function fakeFetch(routes: Record<string, { status?: number; body?: any; text?: string }>) {
	const calls: string[] = [];
	const fn = async (url: string) => {
		calls.push(url);
		const r = routes[url];
		if (!r) throw new Error(`未 mock 的 URL: ${url}`);
		const status = r.status ?? 200;
		return {
			status,
			ok: status >= 200 && status < 300,
			json: async () => r.body,
			text: async () => r.text ?? "",
		};
	};
	return { fn: fn as any, calls };
}

test("fetchGiteeLatestRelease: 拼装正确 URL 并返回 release JSON", async () => {
	const url = `${GITEE_API_BASE}/repos/luandapipi/HiAgent/releases/latest`;
	const { fn, calls } = fakeFetch({
		[url]: { body: { id: 42, tag_name: "v0.2.0", name: "v0.2.0", body: "更新说明" } },
	});
	const rel = await fetchGiteeLatestRelease(fn, OPTS);
	expect(rel.id).toBe(42);
	expect(rel.tag_name).toBe("v0.2.0");
	expect(calls).toEqual([url]);
});

test("fetchGiteeLatestRelease: 404 抛 code=NOT_FOUND（仓库无 Release → 视为已是最新）", async () => {
	const url = `${GITEE_API_BASE}/repos/luandapipi/HiAgent/releases/latest`;
	const { fn } = fakeFetch({ [url]: { status: 404, body: { message: "404 Not Found" } } });
	const err = await fetchGiteeLatestRelease(fn, OPTS).catch((e) => e);
	expect(err.code).toBe("NOT_FOUND");
});

test("fetchGiteeLatestRelease: 500 抛可读错误（不带 NOT_FOUND code）", async () => {
	const url = `${GITEE_API_BASE}/repos/luandapipi/HiAgent/releases/latest`;
	const { fn } = fakeFetch({ [url]: { status: 500, body: {} } });
	const err = await fetchGiteeLatestRelease(fn, OPTS).catch((e) => e);
	expect(err.code).toBeUndefined();
	expect(String(err.message)).toContain("500");
});

test("fetchAttachFiles: 按 releaseId 拼装 URL 并返回附件数组", async () => {
	const url = `${GITEE_API_BASE}/repos/luandapipi/HiAgent/releases/42/attach_files`;
	const files = [
		{ name: "latest.yml", browser_download_url: "https://gitee.com/dl/latest.yml" },
		{ name: "WaPi-Setup-0.2.0.exe", browser_download_url: "https://gitee.com/dl/WaPi-Setup-0.2.0.exe" },
	];
	const { fn } = fakeFetch({ [url]: { body: files } });
	const got = await fetchAttachFiles(fn, OPTS, 42);
	expect(got).toHaveLength(2);
	expect(got[1].name).toBe("WaPi-Setup-0.2.0.exe");
});

test("findLatestYml: 命中返回附件，缺失返回 null", () => {
	const files = [
		{ name: "WaPi-Setup-0.2.0.exe", browser_download_url: "u1" },
		{ name: "latest.yml", browser_download_url: "u2" },
	];
	expect(findLatestYml(files as any, "latest.yml")?.browser_download_url).toBe("u2");
	expect(findLatestYml(files as any, "beta.yml")).toBeNull();
	expect(findLatestYml([] as any, "latest.yml")).toBeNull();
});

test("fetchText: 返回文本；非 2xx 抛错", async () => {
	const { fn } = fakeFetch({ "https://x/latest.yml": { text: "version: 0.2.0\n" } });
	expect(await fetchText(fn, "https://x/latest.yml", "latest.yml")).toBe("version: 0.2.0\n");
	const { fn: bad } = fakeFetch({ "https://x/a": { status: 403 } });
	await expect(fetchText(bad, "https://x/a", "latest.yml")).rejects.toThrow("403");
});

test("buildFileUrlMap: 建 文件名→下载URL 映射，跳过缺字段项", () => {
	const map = buildFileUrlMap([
		{ name: "latest.yml", browser_download_url: "u1" },
		{ name: "no-url" } as any,
		{ name: "WaPi-Setup-0.2.0.exe", browser_download_url: "u3" },
	]);
	expect(map.get("latest.yml")).toBe("u1");
	expect(map.get("WaPi-Setup-0.2.0.exe")).toBe("u3");
	expect(map.size).toBe(2);
});

test("baseUrl 覆盖：mock server 场景 URL 用自定义 base", async () => {
	const base = "http://127.0.0.1:9876";
	const url = `${base}/repos/luandapipi/HiAgent/releases/latest`;
	const { fn, calls } = fakeFetch({ [url]: { body: { id: 1, tag_name: "v9.9.9" } } });
	await fetchGiteeLatestRelease(fn, { ...OPTS, baseUrl: base });
	expect(calls).toEqual([url]);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/desktop && bun test tests/gitee-api.test.ts
```

预期：FAIL（`Cannot find module "../src/updater/gitee-api.cjs"`）。

- [ ] **Step 3: 实现 gitee-api.cjs**

创建 `packages/desktop/src/updater/gitee-api.cjs`：

```js
// gitee-api.cjs — Gitee Releases API 纯函数封装。
// fetch 由调用方注入（生产传全局 fetch，测试传 mock），模块本身不依赖 Electron，
// 可在 bun:test 纯环境单测。错误约定：404 → err.code = "NOT_FOUND"（调用方映射为「已是最新」）。
const GITEE_API_BASE = "https://gitee.com/api/v5";

function buildUrls(owner, repo, baseUrl) {
	const base = baseUrl || GITEE_API_BASE;
	return {
		latestRelease: `${base}/repos/${owner}/${repo}/releases/latest`,
		attachFiles: (releaseId) =>
			`${base}/repos/${owner}/${repo}/releases/${releaseId}/attach_files`,
	};
}

async function fetchJson(fetchImpl, url, what) {
	const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
	if (res.status === 404) {
		const err = new Error(`${what}不存在（404）`);
		err.code = "NOT_FOUND";
		throw err;
	}
	if (!res.ok) throw new Error(`${what}请求失败：HTTP ${res.status}`);
	return res.json();
}

async function fetchText(fetchImpl, url, what) {
	const res = await fetchImpl(url);
	if (!res.ok) throw new Error(`${what}下载失败：HTTP ${res.status}`);
	return res.text();
}

/** 最新发行版（tag_name / id / name / body）。无 Release 时抛 code=NOT_FOUND。 */
async function fetchGiteeLatestRelease(fetchImpl, opts) {
	const urls = buildUrls(opts.owner, opts.repo, opts.baseUrl);
	return fetchJson(fetchImpl, urls.latestRelease, "最新发行版");
}

/** 发行版附件列表（name / browser_download_url / size）。 */
async function fetchAttachFiles(fetchImpl, opts, releaseId) {
	const urls = buildUrls(opts.owner, opts.repo, opts.baseUrl);
	return fetchJson(fetchImpl, urls.attachFiles(releaseId), "发行版附件列表");
}

/** 附件列表中定位 channel 文件（如 latest.yml）；未找到返回 null。 */
function findLatestYml(attachFiles, channelFile) {
	const files = Array.isArray(attachFiles) ? attachFiles : [];
	return files.find((f) => f && f.name === channelFile) || null;
}

/** 建 文件名 → browser_download_url 映射表（跳过缺字段的附件项）。 */
function buildFileUrlMap(attachFiles) {
	const map = new Map();
	for (const f of Array.isArray(attachFiles) ? attachFiles : []) {
		if (f && f.name && f.browser_download_url) map.set(f.name, f.browser_download_url);
	}
	return map;
}

module.exports = {
	GITEE_API_BASE,
	buildUrls,
	fetchGiteeLatestRelease,
	fetchAttachFiles,
	findLatestYml,
	fetchText,
	buildFileUrlMap,
};
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/desktop && bun test tests/gitee-api.test.ts
```

预期：9 pass, 0 fail。

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/updater/gitee-api.cjs packages/desktop/tests/gitee-api.test.ts
git commit -m "feat(desktop): Gitee Releases API 纯函数模块（fetch 注入，可单测）"
```

---

### Task 2: GiteeProvider + updater 装配 + IPC/preload 接线（desktop）

**Files:**
- Create: `packages/desktop/src/updater/gitee-provider.cjs`
- Create: `packages/desktop/src/updater/updater.cjs`
- Test: `packages/desktop/tests/updater.test.ts`
- Modify: `packages/desktop/src/preload.cjs`（文件末尾追加 `waPiUpdater`）
- Modify: `packages/desktop/src/main.cjs`（在 `app.whenReady` 的 `ipcMain.handle("app:restart-after-port-kill", ...)` 块之后插入 updater 初始化，约第 314 行后）
- Modify: `packages/desktop/package.json`（dependencies 加 electron-updater，由 bun add 自动完成）

**Interfaces:**
- Consumes: Task 1 的 `fetchGiteeLatestRelease / fetchAttachFiles / findLatestYml / fetchText / buildFileUrlMap` 与 `GITEE_API_BASE`。
- Produces:
  - `class GiteeProvider extends Provider`（electron-updater），constructor `(options, updater, runtimeOptions)`——`options` 支持 `{ owner?, repo?, baseUrl? }`；方法 `getLatestVersion(): Promise<UpdateInfo>`、`resolveFiles(updateInfo): Array<{ url: URL, info: object }>`。缺 latest.yml 时抛 `err.code === "LATEST_YML_MISSING"`。
  - `initUpdater(opts)`：`opts = { ipcMain, app, getWindow: () => BrowserWindow|null, log: {info,warn,error}, autoUpdater?（测试注入）, feedOptions?（测试/集成覆盖 owner/repo/baseUrl） }`。注册 IPC handler 并接管事件翻译。
  - IPC 契约（前端 Task 3/4 依赖）：
    - `updater:get-info` → `{ appVersion: string, isDesktop: boolean }`（isDesktop = `app.isPackaged`）
    - `updater:check` → `{ ok: true }` | `{ ok: false }` | `{ isDesktop: false }`（dev）
    - `updater:download` → 触发下载（失败自动重试一次；`{ ok: true }` | `{ ok: false }`）
    - `updater:quit-and-install` → 静默安装并重启
    - 主→前端事件 `updater:event`，载荷 `{ phase, version?, releaseNotes?, progress?, transferred?, total?, message? }`，phase ∈ `checking | available | up-to-date | downloading | downloaded | error`
  - preload 全局 `window.waPiUpdater`：`{ getInfo(), check(), download(), quitAndInstall(), onEvent(cb) → unsubscribe }`

- [ ] **Step 1: 安装 electron-updater**

```bash
bun add --filter @wa-pi/desktop electron-updater@^6
```

验证：`grep '"electron-updater"' packages/desktop/package.json` 输出 `"electron-updater": "^6.` 开头。

- [ ] **Step 2: 写失败测试（updater 装配与事件翻译）**

创建 `packages/desktop/tests/updater.test.ts`：

```ts
// updater.cjs 装配单测：注入假 autoUpdater（EventEmitter）+ 假 ipcMain/app/window，
// 验证 IPC handler 行为与 autoUpdater 事件 → updater:event 的翻译。
import { test, expect, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import { initUpdater } from "../src/updater/updater.cjs";

function setup(opts: { isPackaged?: boolean } = {}) {
	const autoUpdater = Object.assign(new EventEmitter(), {
		autoDownload: true,
		disableDifferentialDownload: false,
		forceDevUpdateConfig: false,
		setFeedURL: (o: any) => { (autoUpdater as any)._feed = o; },
		checkForUpdates: async () => ({ isUpdateAvailable: true }),
		downloadUpdate: async () => ["tmp/setup.exe"],
		quitAndInstall: (...args: any[]) => { (autoUpdater as any)._quitArgs = args; },
	});
	const handlers = new Map<string, (...a: any[]) => any>();
	const ipcMain = {
		handle: (channel: string, fn: (...a: any[]) => any) => handlers.set(channel, fn),
	};
	const sent: any[] = [];
	const win = { isDestroyed: () => false, webContents: { send: (ch: string, p: any) => sent.push({ ch, p }) } };
	const app = { isPackaged: opts.isPackaged ?? true, getVersion: () => "0.1.0" };
	const log = { info: () => {}, warn: () => {}, error: () => {} };
	initUpdater({ ipcMain, app, getWindow: () => win, log, autoUpdater });
	return { autoUpdater, handlers, sent };
}

beforeEach(() => {});

test("装配：autoDownload 关闭 + 禁用差分 + 注册 custom provider feed", () => {
	const { autoUpdater } = setup();
	expect(autoUpdater.autoDownload).toBe(false);
	expect(autoUpdater.disableDifferentialDownload).toBe(true);
	const feed = (autoUpdater as any)._feed;
	expect(feed.provider).toBe("custom");
	expect(typeof feed.updateProvider).toBe("function");
	expect(feed.owner).toBe("luandapipi");
	expect(feed.repo).toBe("HiAgent");
});

test("updater:get-info 返回 appVersion 与 isDesktop(=isPackaged)", async () => {
	const { handlers } = setup({ isPackaged: true });
	const info = await handlers.get("updater:get-info")!();
	expect(info).toEqual({ appVersion: "0.1.0", isDesktop: true });
});

test("dev（未 packaged）updater:check 返回 isDesktop:false，不调 checkForUpdates", async () => {
	const { handlers, autoUpdater } = setup({ isPackaged: false });
	let called = 0;
	autoUpdater.checkForUpdates = async () => { called++; return null; };
	const r = await handlers.get("updater:check")!();
	expect(r).toEqual({ isDesktop: false });
	expect(called).toBe(0);
});

test("packaged 下 updater:check 调 checkForUpdates 并返回 ok", async () => {
	const { handlers, autoUpdater } = setup({ isPackaged: true });
	let called = 0;
	autoUpdater.checkForUpdates = async () => { called++; return null; };
	const r = await handlers.get("updater:check")!();
	expect(r).toEqual({ ok: true });
	expect(called).toBe(1);
});

test("事件翻译：checking/available/up-to-date/downloading/downloaded", () => {
	const { autoUpdater, sent } = setup();
	autoUpdater.emit("checking-for-update");
	autoUpdater.emit("update-available", { version: "0.2.0", releaseNotes: "很多改进" });
	autoUpdater.emit("update-not-available", { version: "0.1.0" });
	autoUpdater.emit("download-progress", { percent: 45.5, transferred: 450, total: 1000 });
	autoUpdater.emit("update-downloaded", { version: "0.2.0" });
	const phases = sent.map((s) => s.p.phase);
	expect(phases).toEqual(["checking", "available", "up-to-date", "downloading", "downloaded"]);
	expect(sent[1].p.version).toBe("0.2.0");
	expect(sent[1].p.releaseNotes).toBe("很多改进");
	expect(sent[3].p.progress).toBe(45.5);
	expect(sent[3].p.transferred).toBe(450);
	expect(sent[3].p.total).toBe(1000);
	expect(sent.every((s) => s.ch === "updater:event")).toBe(true);
});

test("error 事件：NOT_FOUND → up-to-date；LATEST_YML_MISSING → 配置不完整；sha512 → 校验失败", () => {
	const { autoUpdater, sent } = setup();
	const nf = new Error("404") as any; nf.code = "NOT_FOUND";
	autoUpdater.emit("error", nf);
	const bad = new Error("缺 latest.yml") as any; bad.code = "LATEST_YML_MISSING";
	autoUpdater.emit("error", bad);
	autoUpdater.emit("error", new Error("network boom"));
	autoUpdater.emit("error", new Error("sha512 checksum mismatch, expected X got Y"));
	expect(sent[0].p.phase).toBe("up-to-date");
	expect(sent[1].p.phase).toBe("error");
	expect(sent[1].p.message).toBe("发行版配置不完整，请稍后再试");
	expect(sent[2].p.phase).toBe("error");
	expect(sent[2].p.message).toBe("操作失败，请稍后重试");
	expect(sent[3].p.phase).toBe("error");
	expect(sent[3].p.message).toBe("下载文件校验失败，请重试");
});

test("updater:download 失败自动重试一次，第二次成功返回 ok", async () => {
	const { handlers, autoUpdater } = setup();
	let calls = 0;
	autoUpdater.downloadUpdate = async () => {
		calls++;
		if (calls === 1) throw new Error("network reset");
		return ["tmp/setup.exe"];
	};
	const r = await handlers.get("updater:download")!();
	expect(calls).toBe(2);
	expect(r).toEqual({ ok: true });
});

test("updater:download 两次都失败返回 ok:false（前端由 error 事件驱动，可再次点击下载）", async () => {
	const { handlers, autoUpdater } = setup();
	let calls = 0;
	autoUpdater.downloadUpdate = async () => { calls++; throw new Error("boom"); };
	const r = await handlers.get("updater:download")!();
	expect(calls).toBe(2);
	expect(r).toEqual({ ok: false });
});

test("updater:quit-and-install 以静默+强制重启参数调 quitAndInstall", async () => {
	const { handlers, autoUpdater } = setup();
	await handlers.get("updater:quit-and-install")!();
	// setImmediate 调度，等一拍
	await new Promise((r) => setTimeout(r, 10));
	expect((autoUpdater as any)._quitArgs).toEqual([true, true]);
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd packages/desktop && bun test tests/updater.test.ts
```

预期：FAIL（`Cannot find module "../src/updater/updater.cjs"`）。

- [ ] **Step 4: 实现 gitee-provider.cjs 与 updater.cjs**

创建 `packages/desktop/src/updater/gitee-provider.cjs`：

```js
// gitee-provider.cjs — electron-updater 自定义 Provider（Gitee Releases）。
// 装配方式（electron-updater 官方 custom provider 通道）：
//   autoUpdater.setFeedURL({ provider: "custom", updateProvider: GiteeProvider, owner, repo, baseUrl? })
// electron-updater 会以 new GiteeProvider(options, updater, runtimeOptions) 实例化。
// Provider 基类依赖 ElectronHttpExecutor，无法在纯 bun 环境实例化——
// 解析/映射逻辑全部下沉到 gitee-api.cjs 纯函数（Task 1），这里只做薄封装。
const { Provider, parseUpdateInfo } = require("electron-updater/out/providers/Provider");
const { URL } = require("node:url");
const giteeApi = require("./gitee-api.cjs");

class GiteeProvider extends Provider {
	constructor(options, _updater, runtimeOptions) {
		super(runtimeOptions);
		this.owner = options.owner || "luandapipi";
		this.repo = options.repo || "HiAgent";
		// baseUrl 仅供测试/mock server 覆盖，生产缺省 GITEE_API_BASE
		this.baseUrl = options.baseUrl || undefined;
		// 文件名 → Gitee 附件真实下载 URL（getLatestVersion 时建立）
		this.fileUrls = new Map();
	}

	async getLatestVersion() {
		const fetchImpl = globalThis.fetch.bind(globalThis);
		const opts = { owner: this.owner, repo: this.repo, baseUrl: this.baseUrl };
		// 1. 最新发行版（无 Release 时 gitee-api 抛 code=NOT_FOUND，updater.cjs 映射为 up-to-date）
		const release = await giteeApi.fetchGiteeLatestRelease(fetchImpl, opts);
		// 2. 附件列表
		const attachFiles = await giteeApi.fetchAttachFiles(fetchImpl, opts, release.id);
		// 3. 定位 channel 文件（win32 → latest.yml，darwin → latest-mac.yml，linux → latest-linux.yml）
		const channelFile = `${this.getDefaultChannelName()}.yml`;
		const yml = giteeApi.findLatestYml(attachFiles, channelFile);
		if (!yml) {
			const err = new Error(`发行版附件中缺少 ${channelFile}`);
			err.code = "LATEST_YML_MISSING";
			throw err;
		}
		// 4. 下载 latest.yml 并解析为 UpdateInfo（version 以 latest.yml 为准，单一事实来源）
		const raw = await giteeApi.fetchText(fetchImpl, yml.browser_download_url, channelFile);
		const info = parseUpdateInfo(raw, channelFile, new URL(yml.browser_download_url));
		// release notes / 发行版标题带给前端（update-available 事件载荷）
		if (release.body) info.releaseNotes = release.body;
		if (release.name) info.releaseName = release.name;
		this.fileUrls = giteeApi.buildFileUrlMap(attachFiles);
		return info;
	}

	resolveFiles(updateInfo) {
		// latest.yml 的 files[].url 是文件名（如 WaPi-Setup-0.2.0.exe），
		// 映射到 Gitee 附件真实下载 URL
		const files =
			updateInfo.files && updateInfo.files.length > 0
				? updateInfo.files
				: [{ url: updateInfo.path, sha512: updateInfo.sha512 }];
		return files.map((f) => {
			const direct = this.fileUrls.get(f.url);
			if (!direct) throw new Error(`Gitee 发行版附件中找不到文件：${f.url}`);
			return { url: new URL(direct), info: f };
		});
	}
}

module.exports = { GiteeProvider };
```

创建 `packages/desktop/src/updater/updater.cjs`：

```js
// updater.cjs — 装配 electron-updater + 注册 IPC + 事件翻译广播。
// 设计要点：
// - 更新链路不经过 kernel，全部在主进程完成；前端只收 updater:event。
// - autoUpdater 经 opts 注入（测试传 EventEmitter 假对象；生产缺省 lazy require，
//   避免纯 bun 测试环境加载 electron-updater 时连带 require("electron")）。
// - V1 全量下载：disableDifferentialDownload = true（不要求 .blockmap 附件）。
// - dev（未 packaged）check 返回 { isDesktop: false }，不触发真实更新流程；
//   集成测试可用 WA_PI_UPDATER_DEV=1 强制 forceDevUpdateConfig。
const { GiteeProvider } = require("./gitee-provider.cjs");

function mapErrorMessage(err) {
	if (err && err.code === "LATEST_YML_MISSING") return "发行版配置不完整，请稍后再试";
	// sha512 校验失败（安装包被篡改/下载损坏）——electron-updater 抛 checksum mismatch
	if (err && /sha512|checksum/i.test(String(err.message || err))) return "下载文件校验失败，请重试";
	return "操作失败，请稍后重试";
}

function initUpdater(opts) {
	const autoUpdater = opts.autoUpdater || require("electron-updater").autoUpdater;
	const { ipcMain, app, getWindow, log } = opts;

	autoUpdater.autoDownload = false; // 检查与下载分离：用户点「立即更新」才下载
	autoUpdater.disableDifferentialDownload = true;
	if (process.env.WA_PI_UPDATER_DEV === "1") autoUpdater.forceDevUpdateConfig = true;
	if (log) autoUpdater.logger = log;
	autoUpdater.setFeedURL({
		provider: "custom",
		updateProvider: GiteeProvider,
		owner: "luandapipi",
		repo: "HiAgent",
		...(opts.feedOptions || {}),
		// 集成测试：mock Gitee server 的 baseUrl（env 优先，feedOptions 可再覆盖）
		...(process.env.WA_PI_UPDATER_BASE_URL && !(opts.feedOptions || {}).baseUrl
			? { baseUrl: process.env.WA_PI_UPDATER_BASE_URL }
			: {}),
	});

	const send = (payload) => {
		const win = getWindow();
		if (win && !win.isDestroyed()) win.webContents.send("updater:event", payload);
	};

	autoUpdater.on("checking-for-update", () => send({ phase: "checking" }));
	autoUpdater.on("update-available", (info) =>
		send({
			phase: "available",
			version: info.version,
			releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : null,
		}),
	);
	autoUpdater.on("update-not-available", () => send({ phase: "up-to-date" }));
	autoUpdater.on("download-progress", (p) =>
		send({ phase: "downloading", progress: p.percent, transferred: p.transferred, total: p.total }),
	);
	autoUpdater.on("update-downloaded", (e) => send({ phase: "downloaded", version: e.version }));
	autoUpdater.on("error", (err) => {
		// 仓库无 Release / 404 → 视为「已是最新版本」
		if (err && err.code === "NOT_FOUND") return send({ phase: "up-to-date" });
		if (log) log.error("[updater]", err);
		send({ phase: "error", message: mapErrorMessage(err) });
	});

	ipcMain.handle("updater:get-info", () => ({
		appVersion: app.getVersion(),
		isDesktop: app.isPackaged,
	}));
	ipcMain.handle("updater:check", async () => {
		if (!app.isPackaged && !autoUpdater.forceDevUpdateConfig) return { isDesktop: false };
		try {
			await autoUpdater.checkForUpdates();
			return { ok: true };
		} catch {
			// checkForUpdates 失败前已 emit error 事件（前端状态由事件驱动），这里只回执
			return { ok: false };
		}
	});
	ipcMain.handle("updater:download", async () => {
		// 下载中断自动重试一次；仍失败返回 ok:false（electron-updater 已 emit error
		// 事件驱动前端报错，用户可再次点击下载）
		try {
			await autoUpdater.downloadUpdate();
			return { ok: true };
		} catch {
			try {
				await autoUpdater.downloadUpdate();
				return { ok: true };
			} catch {
				return { ok: false };
			}
		}
	});
	ipcMain.handle("updater:quit-and-install", () => {
		// setImmediate：让 IPC 回执先返回渲染进程，再退出安装（NSIS /S 静默 + 装完自动重启）
		setImmediate(() => {
			try {
				autoUpdater.quitAndInstall(true, true);
			} catch (err) {
				if (log) log.error("[updater] quitAndInstall 失败", err);
				send({ phase: "error", message: "安装失败，请前往 Gitee Release 页面手动下载安装包" });
			}
		});
		return { ok: true };
	});
}

module.exports = { initUpdater };
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd packages/desktop && bun test tests/updater.test.ts
```

预期：9 pass, 0 fail。

- [ ] **Step 6: preload 暴露 waPiUpdater**

在 `packages/desktop/src/preload.cjs` 文件末尾追加：

```js
// 应用更新桥：前端「设置 → 关于」页签调用（事件订阅返回取消订阅函数）
contextBridge.exposeInMainWorld("waPiUpdater", {
  getInfo: () => ipcRenderer.invoke("updater:get-info"),
  check: () => ipcRenderer.invoke("updater:check"),
  download: () => ipcRenderer.invoke("updater:download"),
  quitAndInstall: () => ipcRenderer.invoke("updater:quit-and-install"),
  onEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("updater:event", listener);
    return () => ipcRenderer.removeListener("updater:event", listener);
  },
});
```

- [ ] **Step 7: main.cjs 初始化 updater**

在 `packages/desktop/src/main.cjs` 中定位 `app:restart-after-port-kill` 的 `ipcMain.handle(...)` 块（约第 300-314 行，以 `});` 结束），在其后插入：

```js
	// 应用更新（Gitee Releases + electron-updater）：dev 下 check 降级为 isDesktop:false
	const { initUpdater } = require("./updater/updater.cjs");
	initUpdater({
		ipcMain,
		app,
		getWindow: () => mainWindow,
		log,
	});
```

- [ ] **Step 8: 类型检查 + 全量 desktop 测试**

```bash
cd packages/desktop && bun run typecheck && bun test
```

预期：typecheck 无错；全部测试 pass（含 Task 1 + Task 2 新增）。

- [ ] **Step 9: Commit**

```bash
git add packages/desktop
git commit -m "feat(desktop): electron-updater + GiteeProvider 装配，waPiUpdater IPC 桥接"
```

---

### Task 3: 前端 updater 状态机（Zustand store）

**Files:**
- Create: `packages/frontend/src/store/updater.ts`
- Test: `packages/frontend/src/store/updater.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `window.waPiUpdater` 桥（getInfo/check/download/quitAndInstall/onEvent）与 `updater:event` 载荷 `{ phase, version?, releaseNotes?, progress?, transferred?, total?, message? }`。
- Produces（Task 4 依赖）:
  - `useUpdaterStore`（Zustand），state：
    - `status: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "error"`
    - `appVersion: string`（浏览器 dev 时为 `""`）
    - `latestVersion: string | null`
    - `releaseNotes: string | null`
    - `progress: number`（0-100）、`transferred: number`、`total: number`
    - `error: string | null`
    - `isDesktop: boolean`（初始 `typeof window !== "undefined" && !!window.waPiUpdater`，getInfo 后以主进程返回值为准）
  - actions：`init(): Promise<void>`（幂等，只做一次 getInfo + onEvent 订阅）、`checkForUpdates(): void`、`downloadUpdate(): void`、`quitAndInstall(): void`、`reset(): void`（回 idle 清 error）

- [ ] **Step 1: 写失败测试**

创建 `packages/frontend/src/store/updater.test.ts`：

```ts
// updater store 单测：注入假 waPiUpdater 桥，验证 init / 事件 → 状态迁移 / actions。
import { test, expect, beforeEach } from "bun:test";
import { useUpdaterStore } from "./updater";

type Payload = any;

function fakeBridge(info = { appVersion: "0.1.0", isDesktop: true }) {
	const listeners: ((p: Payload) => void)[] = [];
	const calls: string[] = [];
	const bridge = {
		getInfo: async () => { calls.push("getInfo"); return info; },
		check: async () => { calls.push("check"); return { ok: true }; },
		download: async () => { calls.push("download"); return { ok: true }; },
		quitAndInstall: async () => { calls.push("quitAndInstall"); return { ok: true }; },
		onEvent: (cb: (p: Payload) => void) => { listeners.push(cb); return () => {}; },
	};
	return {
		bridge,
		calls,
		emit: (p: Payload) => listeners.forEach((l) => l(p)),
	};
}

beforeEach(() => {
	// 每个用例重建 store 初始态 + 清桥
	useUpdaterStore.setState(useUpdaterStore.getInitialState());
	delete (window as any).waPiUpdater;
});

test("init：从 getInfo 取 appVersion/isDesktop，并订阅事件", async () => {
	const { bridge, calls } = fakeBridge();
	(window as any).waPiUpdater = bridge;
	await useUpdaterStore.getState().init();
	expect(calls).toContain("getInfo");
	expect(useUpdaterStore.getState().appVersion).toBe("0.1.0");
	expect(useUpdaterStore.getState().isDesktop).toBe(true);
});

test("init 幂等：重复调用只 getInfo 一次", async () => {
	const { bridge, calls } = fakeBridge();
	(window as any).waPiUpdater = bridge;
	await useUpdaterStore.getState().init();
	await useUpdaterStore.getState().init();
	expect(calls.filter((c) => c === "getInfo")).toHaveLength(1);
});

test("无桥（浏览器 dev）：isDesktop=false，不抛错", async () => {
	await useUpdaterStore.getState().init();
	expect(useUpdaterStore.getState().isDesktop).toBe(false);
});

test("事件迁移：checking → available（带版本与 releaseNotes）", async () => {
	const { bridge, emit } = fakeBridge();
	(window as any).waPiUpdater = bridge;
	await useUpdaterStore.getState().init();
	emit({ phase: "checking" });
	expect(useUpdaterStore.getState().status).toBe("checking");
	emit({ phase: "available", version: "0.2.0", releaseNotes: "很多改进" });
	const s = useUpdaterStore.getState();
	expect(s.status).toBe("available");
	expect(s.latestVersion).toBe("0.2.0");
	expect(s.releaseNotes).toBe("很多改进");
});

test("事件迁移：downloading 更新进度，downloaded 收尾", async () => {
	const { bridge, emit } = fakeBridge();
	(window as any).waPiUpdater = bridge;
	await useUpdaterStore.getState().init();
	emit({ phase: "downloading", progress: 45.5, transferred: 450, total: 1000 });
	let s = useUpdaterStore.getState();
	expect(s.status).toBe("downloading");
	expect(s.progress).toBe(45.5);
	expect(s.transferred).toBe(450);
	expect(s.total).toBe(1000);
	emit({ phase: "downloaded", version: "0.2.0" });
	s = useUpdaterStore.getState();
	expect(s.status).toBe("downloaded");
	expect(s.progress).toBe(100);
});

test("事件迁移：up-to-date 与 error", async () => {
	const { bridge, emit } = fakeBridge();
	(window as any).waPiUpdater = bridge;
	await useUpdaterStore.getState().init();
	emit({ phase: "up-to-date" });
	expect(useUpdaterStore.getState().status).toBe("up-to-date");
	emit({ phase: "error", message: "操作失败，请稍后重试" });
	const s = useUpdaterStore.getState();
	expect(s.status).toBe("error");
	expect(s.error).toBe("操作失败，请稍后重试");
});

test("actions：checkForUpdates/downloadUpdate/quitAndInstall 调桥对应方法", async () => {
	const { bridge, calls } = fakeBridge();
	(window as any).waPiUpdater = bridge;
	await useUpdaterStore.getState().init();
	useUpdaterStore.getState().checkForUpdates();
	useUpdaterStore.getState().downloadUpdate();
	useUpdaterStore.getState().quitAndInstall();
	expect(calls).toEqual(["getInfo", "check", "download", "quitAndInstall"]);
});

test("reset：回 idle 并清错误/进度", async () => {
	const { bridge, emit } = fakeBridge();
	(window as any).waPiUpdater = bridge;
	await useUpdaterStore.getState().init();
	emit({ phase: "error", message: "x" });
	useUpdaterStore.getState().reset();
	const s = useUpdaterStore.getState();
	expect(s.status).toBe("idle");
	expect(s.error).toBeNull();
	expect(s.progress).toBe(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/frontend && bun test --isolate src/store/updater.test.ts
```

预期：FAIL（`Cannot find module "./updater"`）。

- [ ] **Step 3: 实现 store/updater.ts**

创建 `packages/frontend/src/store/updater.ts`：

```ts
// updater store — 「设置 → 关于」的更新状态机。
// 桥（window.waPiUpdater）由桌面 preload 注入；浏览器 dev 无桥 → isDesktop=false，隐藏更新区。
import { create } from "zustand";

export type UpdaterStatus =
	| "idle"
	| "checking"
	| "up-to-date"
	| "available"
	| "downloading"
	| "downloaded"
	| "error";

/** 主进程 updater:event 载荷（与 packages/desktop/src/updater/updater.cjs 对齐） */
export interface UpdaterEventPayload {
	phase: "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";
	version?: string;
	releaseNotes?: string | null;
	progress?: number;
	transferred?: number;
	total?: number;
	message?: string;
}

declare global {
	interface Window {
		waPiUpdater?: {
			getInfo(): Promise<{ appVersion: string; isDesktop: boolean }>;
			check(): Promise<{ ok?: boolean; isDesktop?: boolean }>;
			download(): Promise<unknown>;
			quitAndInstall(): Promise<unknown>;
			onEvent(cb: (payload: UpdaterEventPayload) => void): () => void;
		};
	}
}

interface UpdaterState {
	status: UpdaterStatus;
	appVersion: string;
	latestVersion: string | null;
	releaseNotes: string | null;
	progress: number;
	transferred: number;
	total: number;
	error: string | null;
	isDesktop: boolean;
	init(): Promise<void>;
	checkForUpdates(): void;
	downloadUpdate(): void;
	quitAndInstall(): void;
	reset(): void;
}

let initialized = false;

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
	status: "idle",
	appVersion: "",
	latestVersion: null,
	releaseNotes: null,
	progress: 0,
	transferred: 0,
	total: 0,
	error: null,
	isDesktop: typeof window !== "undefined" && !!window.waPiUpdater,

	init: async () => {
		if (initialized) return;
		initialized = true;
		const bridge = window.waPiUpdater;
		if (!bridge) {
			set({ isDesktop: false });
			return;
		}
		try {
			const info = await bridge.getInfo();
			set({ appVersion: info.appVersion, isDesktop: info.isDesktop });
		} catch {
			set({ isDesktop: false });
		}
		bridge.onEvent((p) => {
			switch (p.phase) {
				case "checking":
					set({ status: "checking", error: null });
					break;
				case "available":
					set({
						status: "available",
						latestVersion: p.version ?? null,
						releaseNotes: p.releaseNotes ?? null,
					});
					break;
				case "up-to-date":
					set({ status: "up-to-date" });
					break;
				case "downloading":
					set({
						status: "downloading",
						progress: p.progress ?? 0,
						transferred: p.transferred ?? 0,
						total: p.total ?? 0,
					});
					break;
				case "downloaded":
					set({ status: "downloaded", progress: 100, latestVersion: p.version ?? get().latestVersion });
					break;
				case "error":
					set({ status: "error", error: p.message ?? "操作失败，请稍后重试" });
					break;
			}
		});
	},

	checkForUpdates: () => {
		set({ status: "checking", error: null });
		void window.waPiUpdater?.check().then((r) => {
			// dev 降级：主进程回 isDesktop:false（防御；正常 getInfo 已同步该值）
			if (r && r.isDesktop === false) set({ isDesktop: false, status: "idle" });
		}).catch(() => set({ status: "error", error: "操作失败，请稍后重试" }));
	},
	downloadUpdate: () => {
		set({ status: "downloading", progress: 0, transferred: 0, total: 0 });
		void window.waPiUpdater?.download().catch(() =>
			set({ status: "error", error: "操作失败，请稍后重试" }),
		);
	},
	quitAndInstall: () => {
		void window.waPiUpdater?.quitAndInstall();
	},
	reset: () => set({ status: "idle", error: null, progress: 0, transferred: 0, total: 0 }),
}));
```

注意：`initialized` 模块级标记会让测试间串态——上面的测试用 `useUpdaterStore.getInitialState()` 重置 state，但 `initialized` 标记需要同样可重置。实现时把标记放进 store 外的可重置结构，测试文件 Step 1 的 `beforeEach` 需补一行 `(useUpdaterStore as any).__resetInit?.()`。更简单做法：把 `initialized` 放到 store state 之外的模块变量，并导出内部 reset：

在文件末尾追加（实现时直接写进同一文件，不是独立 step）：

```ts
/** 仅测试用：重置 init 幂等标记 */
export function __resetUpdaterInitForTest() {
	initialized = false;
}
```

同时把 Step 1 测试的 `beforeEach` 改为：

```ts
beforeEach(() => {
	useUpdaterStore.setState(useUpdaterStore.getInitialState());
	__resetUpdaterInitForTest();
	delete (window as any).waPiUpdater;
});
```

并在 import 处加 `__resetUpdaterInitForTest`：

```ts
import { useUpdaterStore, __resetUpdaterInitForTest } from "./updater";
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/frontend && bun test --isolate src/store/updater.test.ts
```

预期：8 pass, 0 fail。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/store/updater.ts packages/frontend/src/store/updater.test.ts
git commit -m "feat(frontend): updater Zustand 状态机（桥接 waPiUpdater）"
```

---

### Task 4: 「关于」页签 UI + 设置导航接入（frontend）

**Files:**
- Create: `packages/frontend/src/components/settings/AboutSection.tsx`
- Test: `packages/frontend/src/components/settings/AboutSection.test.tsx`
- Modify: `packages/frontend/src/store/settings.ts`（`SettingsSection` union 加 `"about"`）
- Modify: `packages/frontend/src/components/SettingsModal.tsx`（导航底部加「关于」按钮 + 内容区渲染 AboutSection）

**Interfaces:**
- Consumes: Task 3 的 `useUpdaterStore`（status/appVersion/latestVersion/releaseNotes/progress/transferred/total/error/isDesktop + checkForUpdates/downloadUpdate/quitAndInstall/reset + init）。
- Produces: `AboutSection` 组件（data-testid：`about-section`、`about-check-btn`、`about-download-btn`、`about-install-btn`、`about-retry-btn`）；导航按钮 data-testid `settings-nav-about`。

- [ ] **Step 1: 写失败测试**

创建 `packages/frontend/src/components/settings/AboutSection.test.tsx`：

```tsx
// AboutSection 组件测试：mock updater store，逐状态断言渲染与按钮交互。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AboutSection } from "./AboutSection";
import { useUpdaterStore, __resetUpdaterInitForTest } from "../../store/updater";

function setUpdater(partial: Partial<ReturnType<typeof useUpdaterStore.getState>>) {
	useUpdaterStore.setState({
		...useUpdaterStore.getInitialState(),
		appVersion: "0.1.0",
		isDesktop: true,
		...partial,
	});
}

beforeEach(() => {
	useUpdaterStore.setState(useUpdaterStore.getInitialState());
	__resetUpdaterInitForTest();
	delete (window as any).waPiUpdater;
});

test("idle：logo/名称/版本 + 检查更新按钮可用", () => {
	setUpdater({ status: "idle" });
	render(<AboutSection />);
	expect(screen.getByText("WA PI Agent")).toBeTruthy();
	expect(screen.getByText("版本 0.1.0")).toBeTruthy();
	const btn = screen.getByTestId("about-check-btn") as HTMLButtonElement;
	expect(btn.disabled).toBe(false);
});

test("checking：显示检查中文案，按钮禁用", () => {
	setUpdater({ status: "checking" });
	render(<AboutSection />);
	expect(screen.getByText(/正在检查更新/)).toBeTruthy();
	expect((screen.getByTestId("about-check-btn") as HTMLButtonElement).disabled).toBe(true);
});

test("available：新版本号 + release notes + 立即更新触发 downloadUpdate", () => {
	const downloadUpdate = mock(() => {});
	useUpdaterStore.setState({ ...useUpdaterStore.getInitialState(), appVersion: "0.1.0", isDesktop: true,
		status: "available", latestVersion: "0.2.0", releaseNotes: "修复若干问题", downloadUpdate });
	render(<AboutSection />);
	expect(screen.getByText(/发现新版本 v0\.2\.0/)).toBeTruthy();
	expect(screen.getByText("修复若干问题")).toBeTruthy();
	fireEvent.click(screen.getByTestId("about-download-btn"));
	expect(downloadUpdate).toHaveBeenCalledTimes(1);
});

test("downloading：进度条百分比 + 字节文案", () => {
	setUpdater({ status: "downloading", progress: 45, transferred: 450, total: 1000 });
	render(<AboutSection />);
	expect(screen.getByText(/45%/)).toBeTruthy();
	expect(screen.getByText(/450/)).toBeTruthy();
});

test("downloaded：已就绪文案 + 立即重启安装触发 quitAndInstall", () => {
	const quitAndInstall = mock(() => {});
	useUpdaterStore.setState({ ...useUpdaterStore.getInitialState(), appVersion: "0.1.0", isDesktop: true,
		status: "downloaded", latestVersion: "0.2.0", quitAndInstall });
	render(<AboutSection />);
	expect(screen.getByText(/更新已就绪/)).toBeTruthy();
	fireEvent.click(screen.getByTestId("about-install-btn"));
	expect(quitAndInstall).toHaveBeenCalledTimes(1);
});

test("up-to-date：已是最新", () => {
	setUpdater({ status: "up-to-date" });
	render(<AboutSection />);
	expect(screen.getByText(/已是最新版本/)).toBeTruthy();
});

test("error：错误文案 + 重试触发 checkForUpdates", () => {
	const checkForUpdates = mock(() => {});
	useUpdaterStore.setState({ ...useUpdaterStore.getInitialState(), appVersion: "0.1.0", isDesktop: true,
		status: "error", error: "操作失败，请稍后重试", checkForUpdates });
	render(<AboutSection />);
	expect(screen.getByText("操作失败，请稍后重试")).toBeTruthy();
	fireEvent.click(screen.getByTestId("about-retry-btn"));
	expect(checkForUpdates).toHaveBeenCalledTimes(1);
});

test("非安装版（isDesktop=false）：按钮禁用 + 仅安装版支持提示", () => {
	setUpdater({ status: "idle", isDesktop: false });
	render(<AboutSection />);
	expect((screen.getByTestId("about-check-btn") as HTMLButtonElement).disabled).toBe(true);
	expect(screen.getByText(/仅安装版支持/)).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/frontend && bun test --isolate src/components/settings/AboutSection.test.tsx
```

预期：FAIL（`Cannot find module "./AboutSection"`）。

- [ ] **Step 3: 实现 AboutSection.tsx**

创建 `packages/frontend/src/components/settings/AboutSection.tsx`：

```tsx
// AboutSection — 系统设置「关于」页签：应用信息 + 检查/下载/安装更新。
// 布局：logo → 应用名 → 版本号 → 分隔线 → 操作/状态区（全部居中），复用 styles.css 主题变量。
import { useEffect } from "react";
import { useUpdaterStore } from "../../store/updater";

function formatBytes(n: number): string {
	if (!n || n <= 0) return "0 B";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function AboutSection() {
	const s = useUpdaterStore();

	useEffect(() => {
		void s.init();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const canCheck = s.isDesktop && (s.status === "idle" || s.status === "up-to-date" || s.status === "error");

	return (
		<div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 overflow-auto" data-testid="about-section">
			<img src="/logo.svg" alt="WA PI Agent" className="w-24 h-24 rounded-2xl" />
			<span className="text-lg font-bold text-primary mt-2">WA PI Agent</span>
			<span className="text-[13px] text-tertiary">
				{s.appVersion ? `版本 ${s.appVersion}` : "开发模式"}
			</span>
			<div className="w-56 border-b border-hairline my-3" />

			<button
				onClick={() => s.checkForUpdates()}
				disabled={!canCheck}
				className={`px-4 py-1.5 rounded-pill text-sm font-semibold border-0 ${canCheck ? "bg-accent-soft text-accent cursor-pointer" : "bg-surface-elevated text-tertiary cursor-not-allowed"}`}
				data-testid="about-check-btn"
			>
				{s.status === "checking" ? "正在检查更新…" : "检查更新"}
			</button>
			{!s.isDesktop && (
				<span className="text-xs text-tertiary mt-1">当前为开发/浏览器模式，仅安装版支持在线更新</span>
			)}

			<div className="mt-3 flex flex-col items-center gap-2 max-w-md w-full">
				{s.status === "checking" && (
					<span className="text-sm text-secondary">正在检查更新…</span>
				)}

				{s.status === "available" && (
					<>
						<span className="text-sm font-semibold text-success">
							发现新版本 v{s.latestVersion}
						</span>
						<span className="text-xs text-tertiary">
							当前版本 {s.appVersion} → 新版本 {s.latestVersion}
						</span>
						{s.releaseNotes && (
							<div className="text-xs text-secondary bg-surface-elevated rounded-sm p-3 w-full whitespace-pre-wrap max-h-40 overflow-auto">
								{s.releaseNotes}
							</div>
						)}
						<button
							onClick={() => s.downloadUpdate()}
							className="px-4 py-1.5 rounded-pill text-sm font-semibold border-0 bg-accent text-on-accent cursor-pointer"
							data-testid="about-download-btn"
						>
							立即更新
						</button>
					</>
				)}

				{s.status === "downloading" && (
					<>
						<div className="w-56 h-1.5 rounded-pill bg-surface-elevated overflow-hidden">
							<div
								className="h-full bg-accent transition-all"
								style={{ width: `${Math.min(100, Math.max(0, s.progress))}%` }}
							/>
						</div>
						<span className="text-xs text-secondary">
							{Math.round(s.progress)}%（{formatBytes(s.transferred)} / {formatBytes(s.total)}）
						</span>
					</>
				)}

				{s.status === "downloaded" && (
					<>
						<span className="text-sm font-semibold text-success">更新已就绪</span>
						<div className="flex gap-2">
							<button
								onClick={() => s.quitAndInstall()}
								className="px-4 py-1.5 rounded-pill text-sm font-semibold border-0 bg-success text-on-accent cursor-pointer"
								data-testid="about-install-btn"
							>
								立即重启安装
							</button>
							<button
								onClick={() => s.reset()}
								className="px-4 py-1.5 rounded-pill text-sm font-semibold border-0 bg-surface-elevated text-secondary cursor-pointer"
							>
								稍后再说
							</button>
						</div>
					</>
				)}

				{s.status === "up-to-date" && (
					<span className="text-sm text-success">已是最新版本 ✓</span>
				)}

				{s.status === "error" && (
					<>
						<span className="text-sm text-danger">{s.error}</span>
						<button
							onClick={() => s.checkForUpdates()}
							className="px-4 py-1.5 rounded-pill text-sm font-semibold border-0 bg-accent-soft text-accent cursor-pointer"
							data-testid="about-retry-btn"
						>
							重试
						</button>
					</>
				)}
			</div>
		</div>
	);
}
```

说明：组件用了 `text-success / bg-success / bg-accent / text-on-accent / bg-accent-soft / text-accent / text-danger / bg-surface-elevated / rounded-pill / border-hairline` 等既有工具类与主题变量（与 `SessionView.tsx`、`SettingsModal.tsx` 中用法一致）。若某个类名在 `styles.css` 中不存在（如 `text-on-accent`），实现时先 `grep` 确认并换成既有等价类，组件测试不受影响。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/frontend && bun test --isolate src/components/settings/AboutSection.test.tsx
```

预期：8 pass, 0 fail。

- [ ] **Step 5: 接入设置导航**

修改 `packages/frontend/src/store/settings.ts`，把 union 改为：

```ts
export type SettingsSection =
	| "general"
	| "models"
	| "skills"
	| "plugins"
	| "memory"
	| "mcp"
	| "about";
```

修改 `packages/frontend/src/components/SettingsModal.tsx`：
- 顶部 import 加 `import { AboutSection } from "./settings/AboutSection";`
- 在「MCP 连接器」按钮后追加导航按钮：

```tsx
          <button
            onClick={() => setSection("about")}
            className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
            style={activeSection === "about"
              ? { background: "var(--surface-hover)", color: "var(--brand)" }
              : { color: "var(--secondary)" }}
            data-testid="settings-nav-about"
          >关于</button>
```

- 内容区在 `{activeSection === "mcp" && <McpSection />}` 后追加：

```tsx
          {activeSection === "about" && <AboutSection />}
```

- [ ] **Step 6: 全量 frontend 测试 + typecheck**

```bash
cd packages/frontend && bun test --isolate && bun run typecheck
```

预期：全部 pass（含既有 1000+ 用例），typecheck 无错。

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/store/settings.ts packages/frontend/src/components/SettingsModal.tsx packages/frontend/src/components/settings/AboutSection.tsx packages/frontend/src/components/settings/AboutSection.test.tsx
git commit -m "feat(frontend): 设置新增「关于」页签（版本信息 + 检查/下载/安装更新 UI）"
```

---

### Task 5: 集成验证——mock Gitee server + dev 模式真实 autoUpdater（测试第 3 层）

**Files:**
- Create: `packages/desktop/scripts/mock-gitee-server.ts`

**Interfaces:**
- Consumes: Task 2 的 `WA_PI_UPDATER_BASE_URL` / `WA_PI_UPDATER_DEV` env 约定。
- Produces: `bun run packages/desktop/scripts/mock-gitee-server.ts` 启动 mock server（默认端口 9876），打印可用版本与 URL。

本 Task 同时验证 spec §12 的开放问题（Gitee 附件匿名下载）——用 curl 实测并记录结论。

- [ ] **Step 1: 实现 mock Gitee server**

创建 `packages/desktop/scripts/mock-gitee-server.ts`：

```ts
// mock-gitee-server.ts — 本地 mock Gitee Releases API，用于 dev 模式走真实
// electron-updater 检查流程（WA_PI_UPDATER_DEV=1 + WA_PI_UPDATER_BASE_URL 指向本服务）。
// 用法：bun run packages/desktop/scripts/mock-gitee-server.ts（默认 :9876，最新版本恒为 9.9.9）
import { createHash } from "node:crypto";

const PORT = Number(process.env.MOCK_GITEE_PORT) || 9876;
const VERSION = "9.9.9";
const EXE_NAME = `WaPi-Setup-${VERSION}.exe`;
// 小体积假安装包（下载流程只校验 sha512，不执行）
const exeBytes = new TextEncoder().encode(`fake installer for ${VERSION}\n`);
const sha512 = createHash("sha512").update(exeBytes).digest("base64");
const base = `http://127.0.0.1:${PORT}`;

const latestYml = `version: ${VERSION}
files:
  - url: ${EXE_NAME}
    sha512: ${sha512}
    size: ${exeBytes.length}
path: ${EXE_NAME}
sha512: ${sha512}
releaseDate: '2026-08-04T00:00:00.000Z'
`;

Bun.serve({
	port: PORT,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/api/v5/repos/luandapipi/HiAgent/releases/latest") {
			return Response.json({ id: 1, tag_name: `v${VERSION}`, name: `v${VERSION}`, body: "mock 发行说明\n\n- 集成测试用" });
		}
		if (url.pathname === "/api/v5/repos/luandapipi/HiAgent/releases/1/attach_files") {
			return Response.json([
				{ name: "latest.yml", browser_download_url: `${base}/dl/latest.yml` },
				{ name: EXE_NAME, browser_download_url: `${base}/dl/${EXE_NAME}` },
			]);
		}
		if (url.pathname === "/dl/latest.yml") {
			return new Response(latestYml, { headers: { "Content-Type": "text/yaml" } });
		}
		if (url.pathname === `/dl/${EXE_NAME}`) {
			return new Response(exeBytes, { headers: { "Content-Type": "application/octet-stream" } });
		}
		return new Response("not found", { status: 404 });
	},
});

console.log(`[mock-gitee] listening on ${base}（latest = v${VERSION}）`);
```

- [ ] **Step 2: 启动 mock server 并 curl 自检**

```bash
bun run packages/desktop/scripts/mock-gitee-server.ts &
sleep 1
curl -s http://127.0.0.1:9876/api/v5/repos/luandapipi/HiAgent/releases/latest
curl -s http://127.0.0.1:9876/api/v5/repos/luandapipi/HiAgent/releases/1/attach_files
curl -s http://127.0.0.1:9876/dl/latest.yml
```

预期：三个端点分别返回 release JSON、附件数组、latest.yml 文本。

- [ ] **Step 3: dev 模式真实 autoUpdater 走查（macOS/Linux 上验证检查链路）**

```bash
cd packages/desktop
WA_PI_UPDATER_DEV=1 WA_PI_UPDATER_BASE_URL=http://127.0.0.1:9876 bun run dev
```

操作：应用启动后打开 系统设置 → 关于 → 点「检查更新」。
预期：显示「发现新版本 v9.9.9」+ mock 发行说明 + 「立即更新」按钮。
注意：macOS/Linux dev 下不要点「立即更新」——MacUpdater/AppImageUpdater 期望 zip/AppImage 附件，会报文件类型错误（属预期，Windows NSIS 链路在 Windows 上验证）。此步验证的是 GiteeProvider → parseUpdateInfo → 版本比较 → update-available 事件全链路。

- [ ] **Step 4: 实测 Gitee 真实端点（spec §12 开放问题）**

```bash
# 仓库无 Release 时应为 404（前端映射为「已是最新」）
curl -s -o /dev/null -w "%{http_code}\n" https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/latest
# 建一个带附件的测试 Release 后，实测匿名附件下载（有真实 Release 后执行）：
curl -sL -o /dev/null -w "%{http_code}\n" "<latest.yml 的 browser_download_url>"
```

把结论记录在 commit message 或 PR 描述中：若 `browser_download_url` 匿名下载被鉴权拦截（403/302 到登录页），gitee-api.cjs 的 `fetchText` 需改走 `attach_files/{attach_id}/download` 端点——届时只需改 `buildFileUrlMap` 的取值字段，Provider 不变。

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/scripts/mock-gitee-server.ts
git commit -m "test(desktop): mock Gitee server 支撑 dev 模式真实 autoUpdater 集成验证"
```

---

### Task 6: E2E——Playwright 走查「关于」页签全流程（测试第 4 层）

**Files:**
- Create: `packages/frontend/e2e/updater.spec.ts`

**Interfaces:**
- Consumes: Task 3/4 的 UI（data-testid：`settings-btn`、`settings-modal`、`settings-nav-about`、`about-check-btn`、`about-download-btn`、`about-install-btn`）与 e2e 既有基建（`playwright.config.ts` 的 webServer + `e2e/helpers.ts`）。
- Produces: `cd packages/frontend && bunx playwright test e2e/updater.spec.ts` 通过。

桥不存在于浏览器环境，用 `page.addInitScript` 在页面脚本执行前注入可控假 `waPiUpdater`，走查 检查 → 有更新 → 下载进度 → 下载完成 全链路的 DOM 断言。

- [ ] **Step 1: 实现 e2e/updater.spec.ts**

创建 `packages/frontend/e2e/updater.spec.ts`：

```ts
// updater E2E：注入假 waPiUpdater 桥，走查「设置 → 关于」更新全流程 UI。
// 不依赖 Electron/真实 Gitee——桥的假实现通过 page.evaluate 触发事件。
import { test, expect } from "@playwright/test";
import { createProject } from "./helpers";

test.describe.serial("设置-关于：应用更新", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			const listeners: ((p: any) => void)[] = [];
			(window as any).__updaterEmit = (p: any) => listeners.forEach((l) => l(p));
			(window as any).waPiUpdater = {
				getInfo: async () => ({ appVersion: "0.1.0", isDesktop: true }),
				check: async () => ({ ok: true }),
				download: async () => ({ ok: true }),
				quitAndInstall: async () => ({ ok: true }),
				onEvent: (cb: (p: any) => void) => {
					listeners.push(cb);
					return () => {};
				},
			};
		});
	});

	test("检查 → 发现新版本 → 下载进度 → 下载完成（不点重启）", async ({ page }) => {
		await page.goto("/");
		await createProject("e2e-updater", "/tmp/e2e-updater");
		await page.getByTestId("settings-btn").click();
		await expect(page.getByTestId("settings-modal")).toBeVisible();
		await page.getByTestId("settings-nav-about").click();

		// 初始：版本号 + 检查更新
		await expect(page.getByText("版本 0.1.0")).toBeVisible();
		await page.getByTestId("about-check-btn").click();
		await page.evaluate(() => (window as any).__updaterEmit({ phase: "checking" }));
		await expect(page.getByText("正在检查更新…").first()).toBeVisible();

		// 有更新
		await page.evaluate(() =>
			(window as any).__updaterEmit({ phase: "available", version: "0.2.0", releaseNotes: "e2e 发行说明" }),
		);
		await expect(page.getByText("发现新版本 v0.2.0")).toBeVisible();
		await expect(page.getByText("e2e 发行说明")).toBeVisible();

		// 下载进度
		await page.getByTestId("about-download-btn").click();
		await page.evaluate(() =>
			(window as any).__updaterEmit({ phase: "downloading", progress: 100, transferred: 1000, total: 1000 }),
		);
		await expect(page.getByText(/100%/)).toBeVisible();

		// 下载完成 → 出现「立即重启安装」（不点击，避免真退出）
		await page.evaluate(() => (window as any).__updaterEmit({ phase: "downloaded", version: "0.2.0" }));
		await expect(page.getByTestId("about-install-btn")).toBeVisible();
		await expect(page.getByText("更新已就绪")).toBeVisible();
	});

	test("无更新与错误态", async ({ page }) => {
		await page.goto("/");
		await createProject("e2e-updater2", "/tmp/e2e-updater2");
		await page.getByTestId("settings-btn").click();
		await page.getByTestId("settings-nav-about").click();
		await page.getByTestId("about-check-btn").click();
		await page.evaluate(() => (window as any).__updaterEmit({ phase: "up-to-date" }));
		await expect(page.getByText("已是最新版本 ✓")).toBeVisible();

		await page.getByTestId("about-check-btn").click();
		await page.evaluate(() =>
			(window as any).__updaterEmit({ phase: "error", message: "操作失败，请稍后重试" }),
		);
		await expect(page.getByText("操作失败，请稍后重试")).toBeVisible();
		await expect(page.getByTestId("about-retry-btn")).toBeVisible();
	});
});
```

- [ ] **Step 2: 跑 E2E 确认通过**

```bash
cd packages/frontend && bunx playwright test e2e/updater.spec.ts
```

预期：2 passed。若 `createProject` 的签名/导入与 `helpers.ts` 不符，打开 `packages/frontend/e2e/settings-provider.spec.ts` 对照修正（该文件是既有范例）。

- [ ] **Step 3: 清理截图产物 + Commit**

按根 AGENTS.md 规则，测试产生的截图（`test-results/`、`.playwright-mcp/` 下本次新增）全部删除后：

```bash
git add packages/frontend/e2e/updater.spec.ts
git commit -m "test(frontend): updater E2E（假桥走查 检查→下载→就绪 全流程）"
```

---

### Task 7: 发版链路——latest.yml 生成 + Gitee Release 上传脚本（可选但推荐）

**Files:**
- Modify: `packages/desktop/electron-builder.yml`（加 `publish` 段触发 latest.yml 生成）
- Create: `scripts/publish-gitee.ts`

**Interfaces:**
- Consumes: Task 2 的 GiteeProvider 对附件布局的要求（`latest.yml` + `WaPi-Setup-{version}.exe` 必须在同一个 Release 附件列表中，`browser_download_url` 匿名可下载）。
- Produces: `GITEE_TOKEN=xxx bun run scripts/publish-gitee.ts` 完成发版；无 token 时打印手动上传指引。

背景：`electron-builder.yml` 当前没有 `publish` 段，electron-builder **不会生成 latest.yml**（只有配置了 publish provider 才产出更新元数据）。这里配置 `generic` provider——它只是写进打包产物 `app-update.yml` 的兜底元数据，运行时由 Task 2 的 `setFeedURL({ provider: "custom" })` 完全覆盖、不会实际使用。

- [ ] **Step 1: electron-builder.yml 加 publish 段**

在 `packages/desktop/electron-builder.yml` 末尾追加：

```yaml
publish:
  - provider: generic
    url: https://gitee.com/luandapipi/HiAgent/releases
```

- [ ] **Step 2: 验证打包产物含 latest.yml（Windows 机器上执行）**

```bash
bun run pack:win
ls packages/desktop/release/ | grep -E "latest\.yml|WaPi-Setup-.*\.exe$"
```

预期：`latest.yml` 与 `WaPi-Setup-{version}.exe` 都在。macOS 上无法构建 NSIS，此步在 Windows 打包机上做；若本机就是 macOS，跳过并在 PR 描述标注「待 Windows 打包机验证」。

- [ ] **Step 3: 实现 scripts/publish-gitee.ts**

创建 `scripts/publish-gitee.ts`：

```ts
// publish-gitee.ts — 发版辅助：把 packages/desktop/release/ 产物上传为 Gitee Release。
// 用法：GITEE_TOKEN=xxx bun run scripts/publish-gitee.ts
// 无 GITEE_TOKEN 时打印手动上传指引后退出（不发版）。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const OWNER = "luandapipi";
const REPO = "HiAgent";
const API = "https://gitee.com/api/v5";
const RELEASE_DIR = join(import.meta.dir, "..", "packages", "desktop", "release");

const version = JSON.parse(
	readFileSync(join(import.meta.dir, "..", "packages", "desktop", "package.json"), "utf-8"),
).version as string;
const tag = `v${version}`;

function manualGuide(reason: string): never {
	console.error(`[publish] ${reason}`);
	console.log(`
手动发版步骤：
1. bun run pack:win  →  产物在 packages/desktop/release/
2. 打开 https://gitee.com/${OWNER}/${REPO}/releases/new ，tag 填 ${tag}
3. 附件必须上传：
   - latest.yml（GiteeProvider 依赖，缺了客户端报「发行版配置不完整」）
   - WaPi-Setup-${version}.exe
4. 发布后客户端「设置 → 关于 → 检查更新」即可发现 v${version}
`);
	process.exit(1);
}

const token = process.env.GITEE_TOKEN;
if (!token) manualGuide("未设置 GITEE_TOKEN，改手动发版");
if (!existsSync(RELEASE_DIR)) manualGuide(`产物目录不存在：${RELEASE_DIR}（先 bun run pack:win）`);

const artifacts = readdirSync(RELEASE_DIR).filter(
	(f) => f === "latest.yml" || /^WaPi-Setup-.+\.exe$/.test(f),
);
if (!artifacts.includes("latest.yml")) manualGuide("release/ 缺 latest.yml（electron-builder.yml 需有 publish 段）");
if (!artifacts.some((f) => f.endsWith(".exe"))) manualGuide("release/ 缺 WaPi-Setup-*.exe");

async function api(path: string, init: RequestInit = {}) {
	const res = await fetch(`${API}${path}`, {
		...init,
		headers: { Authorization: `token ${token}`, ...(init.headers || {}) },
	});
	if (!res.ok) throw new Error(`${init.method || "GET"} ${path} → HTTP ${res.status}: ${await res.text()}`);
	return res;
}

// 1. 找/建 Release（tag 已存在则复用，便于重跑补传附件）
const list = (await (await api(`/repos/${OWNER}/${REPO}/releases?per_page=100`)).json()) as any[];
let release = list.find((r) => r.tag_name === tag);
if (!release) {
	release = await (
		await api(`/repos/${OWNER}/${REPO}/releases`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tag_name: tag, name: tag, body: `WA PI Agent ${tag}`, target_commitish: "master" }),
		})
	).json();
	console.log(`[publish] 已创建 Release ${tag} (id=${release.id})`);
} else {
	console.log(`[publish] 复用已有 Release ${tag} (id=${release.id})`);
}

// 2. 逐个上传附件（Gitee：POST /releases/{id}/attach_files，multipart 字段名 file）
for (const f of artifacts) {
	const form = new FormData();
	form.append("file", new Blob([readFileSync(join(RELEASE_DIR, f))]), f);
	await api(`/repos/${OWNER}/${REPO}/releases/${release.id}/attach_files`, { method: "POST", body: form });
	console.log(`[publish] 已上传附件 ${f}`);
}
console.log(`[publish] 完成：https://gitee.com/${OWNER}/${REPO}/releases/${tag}`);
```

- [ ] **Step 4: 无 token 路径自测**

```bash
bun run scripts/publish-gitee.ts
```

预期：退出码 1，打印「未设置 GITEE_TOKEN」+ 手动发版指引（含正确 tag 与附件清单）。

- [ ] **Step 5: 更新 CHANGELOG + Commit**

在根 `CHANGELOG.md` 顶部按既有格式补一条本次功能的总记录（新增功能：应用版本检查与自动更新；影响范围列 packages/desktop、packages/frontend、scripts、根 package.json）。然后：

```bash
git add packages/desktop/electron-builder.yml scripts/publish-gitee.ts CHANGELOG.md
git commit -m "feat(desktop): 发版链路——latest.yml 生成 + Gitee Release 上传脚本"
```

---

## 验收清单（四层测试对照 AGENTS.md §6）

1. 单元：`packages/desktop` `bun test`（gitee-api 9 例 + updater 9 例）；`packages/frontend` `bun test --isolate`（updater store 8 例 + AboutSection 8 例）——Task 1/2/3/4
2. 组件：AboutSection 8 例（渲染/交互/条件渲染）——Task 4
3. 集成：mock Gitee server + dev 真实 autoUpdater 走查 + Gitee 端点 curl 实测——Task 5
4. E2E：`bunx playwright test e2e/updater.spec.ts` 2 例——Task 6
5. 截图清理：E2E 产生的 `test-results/` 截图删除（AGENTS.md §6 规则）
6. CHANGELOG：Task 7 Step 5 统一记录
