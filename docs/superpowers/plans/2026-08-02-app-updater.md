# 应用版本检查与自动更新 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在桌面版「系统设置 → 关于」页签实现：显示版本 → 检查更新（Gitee Releases）→ 下载（进度条）→ 静默安装并重启。

**架构：** Electron 主进程新增 `updater/` 模块：`gitee-api.cjs`（纯函数，Gitee API 请求/解析）、`gitee-provider.cjs`（electron-updater 自定义 Provider）、`updater.cjs`（装配 autoUpdater + IPC + 事件翻译）。前端新增 `store/updater.ts`（Zustand 状态机）+ `AboutSection.tsx`。更新链路不经过 kernel，前端经 preload 暴露的 `waPiUpdater` 直连主进程 IPC。

**技术栈：** electron-updater@^6.8.9、Electron 43（desktop 为 CJS）、React 19 + Zustand + Tailwind（frontend）、bun:test（desktop/frontend 单测）、Playwright（E2E）。

**规格：** `docs/superpowers/specs/2026-08-02-app-updater-design.md`

---

## 文件结构

| 文件 | 职责 | 类型 |
|------|------|------|
| `packages/desktop/src/updater/gitee-api.cjs` | 纯函数：请求 Gitee releases/latest、attach_files，解析 latest.yml，fetch 由调用方注入 | 新增 |
| `packages/desktop/src/updater/gitee-provider.cjs` | `Provider` 子类：`getLatestVersion()` + `resolveFiles()`，下载 URL 映射 | 新增 |
| `packages/desktop/src/updater/updater.cjs` | `setupUpdater()`：创建 NsisUpdater、注入 provider、注册 IPC、事件翻译广播 | 新增 |
| `packages/desktop/src/updater/gitee-api.test.ts` | gitee-api 单元测试（mock fetch） | 新增 |
| `packages/desktop/src/updater/gitee-provider.test.ts` | provider 单元测试（mock executor） | 新增 |
| `packages/desktop/src/updater/updater.test.ts` | updater 事件翻译纯函数测试 | 新增 |
| `packages/desktop/src/preload.cjs` | 暴露 `waPiUpdater`（getInfo/check/download/quitAndInstall/onEvent） | 修改 |
| `packages/desktop/src/main.cjs` | `app.whenReady` 后调用 `setupUpdater` | 修改 |
| `packages/desktop/package.json` | 新增 `electron-updater` 依赖 | 修改 |
| `packages/frontend/src/store/updater.ts` | 前端更新状态机（Zustand）+ IPC 桥接 | 新增 |
| `packages/frontend/src/store/settings.ts` | `SettingsSection` 增加 `"about"` | 修改 |
| `packages/frontend/src/components/SettingsModal.tsx` | 左侧导航底部加「关于」按钮 | 修改 |
| `packages/frontend/src/components/settings/AboutSection.tsx` | 「关于」页签 UI（6 状态） | 新增 |
| `packages/frontend/tests/AboutSection.test.tsx` | 组件测试（mock waPiUpdater） | 新增 |
| `packages/frontend/e2e/updater.spec.ts` | E2E：注入 mock 的 waPiUpdater 验证完整 UI 流程 | 新增 |
| `scripts/publish-gitee.ts` | 发版辅助：上传 release/ 产物到 Gitee Release | 新增 |
| `CHANGELOG.md` | 变更记录 | 修改 |

---

## 任务 1：安装 electron-updater 依赖

**文件：**
- 修改：`packages/desktop/package.json`

- [ ] **步骤 1：安装依赖**

在 `packages/desktop` 下运行：

```bash
cd packages/desktop && bun add electron-updater@^6.8.9
```

预期：`package.json` 的 `dependencies` 出现 `"electron-updater": "^6.8.9"`，`node_modules` 安装成功。

- [ ] **步骤 2：验证导出可用**

```bash
cd packages/desktop && node -e "const u = require('electron-updater'); console.log(Object.keys(u).slice(0,20));"
```

预期：输出包含 `NsisUpdater`、`autoUpdater`。

- [ ] **步骤 3：Commit**

```bash
git add packages/desktop/package.json packages/desktop/bun.lock
git commit -m "chore(desktop): 添加 electron-updater 依赖"
```

---

## 任务 2：gitee-api.cjs 纯函数

**文件：**
- 创建：`packages/desktop/src/updater/gitee-api.cjs`
- 测试：`packages/desktop/src/updater/gitee-api.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `packages/desktop/src/updater/gitee-api.test.ts`：

```ts
import { test, expect, describe } from "bun:test";
import {
  fetchGiteeLatestRelease,
  fetchGiteeAttachFiles,
  fetchText,
  findLatestYml,
  buildGiteeApi,
} from "./gitee-api.cjs";

const RELEASE_JSON = {
  id: 42,
  tag_name: "v0.2.0",
  name: "v0.2.0",
  body: "修复：文件预览持久化",
  html_url: "https://gitee.com/luandapipi/HiAgent/releases/v0.2.0",
};

const ATTACH_JSON = [
  { id: 1, name: "latest.yml", browser_download_url: "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml", size: 1024 },
  { id: 2, name: "WaPi-Setup-0.2.0.exe", browser_download_url: "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/WaPi-Setup-0.2.0.exe", size: 134217728 },
  { id: 3, name: "WaPi-Setup-0.2.0.exe.blockmap", browser_download_url: "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/WaPi-Setup-0.2.0.exe.blockmap", size: 8192 },
];

const LATEST_YML = `version: 0.2.0
files:
  - url: WaPi-Setup-0.2.0.exe
    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==
    size: 134217728
path: WaPi-Setup-0.2.0.exe
sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==
releaseDate: '2026-08-02T00:00:00.000Z'
`;

function makeFetch(routes: Record<string, string>) {
  return async (url: string | URL) => {
    const key = String(url);
    const body = routes[key];
    if (body === undefined) throw new Error(`unexpected fetch: ${key}`);
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  };
}

describe("fetchGiteeLatestRelease", () => {
  test("解析 releases/latest 响应", async () => {
    const api = buildGiteeApi({
      baseUrl: "https://gitee.com/api/v5",
      owner: "luandapipi",
      repo: "HiAgent",
      fetchImpl: makeFetch({ "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/latest": JSON.stringify(RELEASE_JSON) }),
    });
    const release = await api.fetchLatestRelease();
    expect(release).toEqual({
      id: 42,
      tagName: "v0.2.0",
      body: "修复：文件预览持久化",
      htmlUrl: "https://gitee.com/luandapipi/HiAgent/releases/v0.2.0",
    });
  });

  test("404（无发行版）转为可读错误", async () => {
    const api = buildGiteeApi({
      baseUrl: "https://gitee.com/api/v5",
      owner: "luandapipi",
      repo: "HiAgent",
      fetchImpl: async () => new Response(JSON.stringify({ message: "404 Not Found" }), { status: 404 }),
    });
    await expect(api.fetchLatestRelease()).rejects.toThrow(/暂无发行版|没有发布|404/);
  });
});

describe("fetchGiteeAttachFiles", () => {
  test("解析附件列表", async () => {
    const api = buildGiteeApi({
      baseUrl: "https://gitee.com/api/v5",
      owner: "luandapipi",
      repo: "HiAgent",
      fetchImpl: makeFetch({ "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/42/attach_files": JSON.stringify(ATTACH_JSON) }),
    });
    const files = await api.fetchAttachFiles(42);
    expect(files).toHaveLength(3);
    expect(files[0]).toEqual({
      name: "latest.yml",
      browserDownloadUrl: "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml",
      size: 1024,
    });
  });
});

describe("findLatestYml", () => {
  test("从附件列表找到 latest.yml", () => {
    const files = ATTACH_JSON.map(f => ({ name: f.name, browserDownloadUrl: f.browser_download_url, size: f.size }));
    const yml = findLatestYml(files);
    expect(yml?.name).toBe("latest.yml");
  });

  test("缺失时返回 null", () => {
    const files = ATTACH_JSON.slice(1).map(f => ({ name: f.name, browserDownloadUrl: f.browser_download_url, size: f.size }));
    expect(findLatestYml(files)).toBeNull();
  });
});

describe("fetchText + 解析", () => {
  test("下载 latest.yml 文本", async () => {
    const api = buildGiteeApi({
      baseUrl: "https://gitee.com/api/v5",
      owner: "luandapipi",
      repo: "HiAgent",
      fetchImpl: makeFetch({ "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml": LATEST_YML }),
    });
    const text = await fetchText(api, "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml");
    expect(text).toContain("version: 0.2.0");
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

```bash
cd packages/desktop && bun test src/updater/gitee-api.test.ts
```

预期：FAIL，`Cannot find module "./gitee-api.cjs"`。

- [ ] **步骤 3：实现 gitee-api.cjs**

创建 `packages/desktop/src/updater/gitee-api.cjs`：

```js
// Gitee API v5 纯函数层：所有请求/解析逻辑与 electron-updater 解耦，fetch 由调用方注入（测试可 mock）。
// 仅依赖全局 fetch（Electron 主进程 / Node 18+ 均可用）。

function buildGiteeApi({ baseUrl, owner, repo, fetchImpl = globalThis.fetch }) {
	if (!fetchImpl) throw new Error("gitee-api: fetchImpl 不可用");

	const apiRoot = `${baseUrl.replace(/\/$/, "")}/repos/${owner}/${repo}`;

	async function fetchJson(url, label) {
		let res;
		try {
			res = await fetchImpl(url);
		} catch (e) {
			throw new Error(`${label}：网络请求失败（${e.message || e}）`);
		}
		if (!res.ok) {
			let detail = "";
			try { detail = (await res.text()).slice(0, 200); } catch {}
			if (res.status === 404) {
				throw new Error(`${label}：仓库暂无发行版（404）`);
			}
			if (res.status === 429) {
				throw new Error(`${label}：请求过于频繁（Gitee API 限流），请稍后再试`);
			}
			throw new Error(`${label}：HTTP ${res.status} ${detail}`);
		}
		return res.json();
	}

	/** GET /repos/{owner}/{repo}/releases/latest → { id, tagName, body, htmlUrl } */
	async function fetchLatestRelease() {
		const raw = await fetchJson(`${apiRoot}/releases/latest`, "检查更新");
		return {
			id: raw.id,
			tagName: raw.tag_name,
			body: raw.body ?? "",
			htmlUrl: raw.html_url,
		};
	}

	/** GET /repos/{owner}/{repo}/releases/{releaseId}/attach_files → [{ name, browserDownloadUrl, size }] */
	async function fetchAttachFiles(releaseId) {
		const list = await fetchJson(`${apiRoot}/releases/${releaseId}/attach_files`, "获取发行版附件");
		return (list || []).map((f) => ({
			name: f.name,
			browserDownloadUrl: f.browser_download_url,
			size: f.size,
		}));
	}

	return { fetchLatestRelease, fetchAttachFiles };
}

/** 下载文本内容（用于 latest.yml / 安装包头校验），返回 string */
async function fetchText(api, url) {
	let res;
	try {
		res = await api.fetchImpl ? await api.fetchImpl(url) : await globalThis.fetch(url);
	} catch (e) {
		throw new Error(`下载失败：${e.message || e}`);
	}
	if (!res.ok) {
		throw new Error(`下载失败：HTTP ${res.status}`);
	}
	return res.text();
}

/** 在附件列表中定位 latest.yml（Windows 通道文件），找不到返回 null */
function findLatestYml(files) {
	return files.find((f) => f.name === "latest.yml") || null;
}

module.exports = { buildGiteeApi, fetchText, findLatestYml };
```

- [ ] **步骤 4：运行测试确认通过**

```bash
cd packages/desktop && bun test src/updater/gitee-api.test.ts
```

预期：PASS（6 个用例）。

- [ ] **步骤 5：Commit**

```bash
git add packages/desktop/src/updater/gitee-api.cjs packages/desktop/src/updater/gitee-api.test.ts
git commit -m "feat(desktop): gitee-api 纯函数层（releases/attach_files 请求与解析）"
```

---

## 任务 3：GiteeProvider（electron-updater 自定义 Provider）

**文件：**
- 创建：`packages/desktop/src/updater/gitee-provider.cjs`
- 测试：`packages/desktop/src/updater/gitee-provider.test.ts`

依赖任务 2 的 `buildGiteeApi`/`findLatestYml`/`fetchText`。

- [ ] **步骤 1：编写失败的测试**

创建 `packages/desktop/src/updater/gitee-provider.test.ts`：

```ts
import { test, expect, describe } from "bun:test";
import { GiteeProvider } from "./gitee-provider.cjs";

const LATEST_YML = `version: 0.2.0
files:
  - url: WaPi-Setup-0.2.0.exe
    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==
    size: 134217728
path: WaPi-Setup-0.2.0.exe
sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==
releaseDate: '2026-08-02T00:00:00.000Z'
`;

const RELEASE_JSON = {
  id: 42,
  tag_name: "v0.2.0",
  name: "v0.2.0",
  body: "修复：文件预览持久化",
  html_url: "https://gitee.com/luandapipi/HiAgent/releases/v0.2.0",
};

const ATTACH_JSON = [
  { id: 1, name: "latest.yml", browser_download_url: "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml", size: 1024 },
  { id: 2, name: "WaPi-Setup-0.2.0.exe", browser_download_url: "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/WaPi-Setup-0.2.0.exe", size: 134217728 },
];

function makeFetch(routes: Record<string, string>) {
  return async (url: string | URL) => {
    const body = routes[String(url)];
    if (body === undefined) throw new Error(`unexpected fetch: ${url}`);
    return new Response(body, { status: 200 });
  };
}

function makeProvider(fetchImpl: any) {
  // executor 只用于 Provider 基类属性（isUseMultipleRangeRequest/fileExtraDownloadHeaders），
  // getLatestVersion 用注入的 fetch，不依赖 executor 发起真实请求。
  const executor = { request: async () => { throw new Error("executor 不应被调用"); } };
  const provider = new GiteeProvider({
    runtimeOptions: { isUseMultipleRangeRequest: true, platform: "win32", executor },
    baseUrl: "https://gitee.com/api/v5",
    owner: "luandapipi",
    repo: "HiAgent",
    fetchImpl,
  });
  return provider;
}

describe("GiteeProvider.getLatestVersion", () => {
  test("返回解析后的 UpdateInfo + releaseNotes", async () => {
    const fetchImpl = makeFetch({
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/latest": JSON.stringify(RELEASE_JSON),
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/42/attach_files": JSON.stringify(ATTACH_JSON),
      "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml": LATEST_YML,
    });
    const provider = makeProvider(fetchImpl);
    const info = await provider.getLatestVersion();
    expect(info.version).toBe("0.2.0");
    expect(info.releaseNotes).toBe("修复：文件预览持久化");
    expect(info.files).toHaveLength(1);
    expect(info.files[0].url).toBe("WaPi-Setup-0.2.0.exe");
  });

  test("附件缺 latest.yml 时报错", async () => {
    const fetchImpl = makeFetch({
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/latest": JSON.stringify(RELEASE_JSON),
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/42/attach_files": JSON.stringify([]),
    });
    const provider = makeProvider(fetchImpl);
    await expect(provider.getLatestVersion()).rejects.toThrow(/latest\.yml/);
  });
});

describe("GiteeProvider.resolveFiles", () => {
  test("把文件名映射为 Gitee 下载 URL", async () => {
    const fetchImpl = makeFetch({
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/latest": JSON.stringify(RELEASE_JSON),
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/42/attach_files": JSON.stringify(ATTACH_JSON),
      "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml": LATEST_YML,
    });
    const provider = makeProvider(fetchImpl);
    await provider.getLatestVersion();
    const files = provider.resolveFiles({ files: [{ url: "WaPi-Setup-0.2.0.exe", sha512: "x", size: 1 }] });
    expect(files[0].url.href).toBe("https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/WaPi-Setup-0.2.0.exe");
  });

  test("文件不在附件列表时报错", async () => {
    const fetchImpl = makeFetch({
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/latest": JSON.stringify(RELEASE_JSON),
      "https://gitee.com/api/v5/repos/luandapipi/HiAgent/releases/42/attach_files": JSON.stringify(ATTACH_JSON),
      "https://gitee.com/luandapipi/HiAgent/releases/download/v0.2.0/latest.yml": LATEST_YML,
    });
    const provider = makeProvider(fetchImpl);
    await provider.getLatestVersion();
    expect(() => provider.resolveFiles({ files: [{ url: "missing.exe", sha512: "x", size: 1 }] }))
      .toThrow(/missing\.exe/);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

```bash
cd packages/desktop && bun test src/updater/gitee-provider.test.ts
```

预期：FAIL，`Cannot find module "./gitee-provider.cjs"`。

- [ ] **步骤 3：实现 gitee-provider.cjs**

创建 `packages/desktop/src/updater/gitee-provider.cjs`：

```js
// electron-updater 自定义 Provider：从 Gitee Releases 检查版本 + 解析下载地址。
// 继承 Provider 基类以获得 executor / isUseMultipleRangeRequest / fileExtraDownloadHeaders 等
// AppUpdater 可能访问的成员；实际请求用注入的 fetch（getLatestVersion）与 base 逻辑（resolveFiles）。
const { Provider } = require("electron-updater/out/providers/Provider");
const { buildGiteeApi, fetchText, findLatestYml } = require("./gitee-api.cjs");

class GiteeProvider extends Provider {
	constructor(options) {
		// options: { runtimeOptions: ProviderRuntimeOptions, baseUrl?, owner, repo, fetchImpl? }
		super(options.runtimeOptions);
		this.baseUrl = options.baseUrl || "https://gitee.com/api/v5";
		this.owner = options.owner;
		this.repo = options.repo;
		this.fetchImpl = options.fetchImpl || globalThis.fetch;
		this.api = buildGiteeApi({
			baseUrl: this.baseUrl,
			owner: this.owner,
			repo: this.repo,
			fetchImpl: this.fetchImpl,
		});
		this.fileUrls = new Map(); // 文件名 → browser_download_url
		this.releaseBody = "";
	}

	// electron-updater 要求：返回 UpdateInfo（version / files / releaseNotes 等）
	async getLatestVersion() {
		const release = await this.api.fetchLatestRelease();
		const attachFiles = await this.api.fetchAttachFiles(release.id);
		const latestYml = findLatestYml(attachFiles);
		if (!latestYml) {
			const e = new Error(`Cannot find latest.yml in the latest release artifacts (${release.htmlUrl})`);
			e.code = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
			throw e;
		}
		const rawData = await fetchText(this.api, latestYml.browserDownloadUrl);
		const channelFileUrl = new URL(latestYml.browserDownloadUrl);
		const updateInfo = parseUpdateInfo(rawData, "latest.yml", channelFileUrl);
		// 建立 文件名 → 下载 URL 映射（供 resolveFiles 使用）
		this.fileUrls = new Map(attachFiles.map((f) => [f.name, f.browserDownloadUrl]));
		this.releaseBody = release.body || "";
		// releaseNotes：优先用 Gitee Release body（UI 展示发行说明）
		if (!updateInfo.releaseNotes) updateInfo.releaseNotes = this.releaseBody;
		return updateInfo;
	}

	// electron-updater 要求：返回 ResolvedUpdateFileInfo[]（绝对下载 URL）
	resolveFiles(updateInfo) {
		const files = updateInfo.files || [];
		if (files.length === 0) {
			const e = new Error("Update info doesn't contain any files");
			e.code = "ERR_UPDATER_NO_FILES_PROVIDED";
			throw e;
		}
		return files.map((fileInfo) => {
			const url = this.fileUrls.get(fileInfo.url);
			if (!url) {
				const e = new Error(`Cannot find ${fileInfo.url} in the latest release artifacts`);
				e.code = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
				throw e;
			}
			return { url: new URL(url), info: fileInfo };
		});
	}
}

module.exports = { GiteeProvider };
```

- [ ] **步骤 4：运行测试确认通过**

```bash
cd packages/desktop && bun test src/updater/gitee-provider.test.ts
```

预期：PASS（4 个用例）。

- [ ] **步骤 5：Commit**

```bash
git add packages/desktop/src/updater/gitee-provider.cjs packages/desktop/src/updater/gitee-provider.test.ts
git commit -m "feat(desktop): GiteeProvider 自定义 electron-updater provider（latest.yml 解析 + URL 映射）"
```

---

## 任务 4：updater.cjs（装配 autoUpdater + IPC + 事件翻译）

**文件：**
- 创建：`packages/desktop/src/updater/updater.cjs`
- 测试：`packages/desktop/src/updater/updater.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `packages/desktop/src/updater/updater.test.ts`：

```ts
import { test, expect, describe } from "bun:test";
import { translateUpdaterEvent, updaterPhases } from "./updater.cjs";

describe("translateUpdaterEvent", () => {
  test("checking-for-update → checking", () => {
    expect(translateUpdaterEvent({ type: "checking-for-update" })).toEqual({ phase: "checking" });
  });

  test("update-available → available（携带 version + releaseNotes）", () => {
    const out = translateUpdaterEvent({ type: "update-available", info: { version: "0.2.0", releaseNotes: "修复" } });
    expect(out).toEqual({ phase: "available", version: "0.2.0", releaseNotes: "修复" });
  });

  test("update-not-available → up-to-date", () => {
    expect(translateUpdaterEvent({ type: "update-not-available" })).toEqual({ phase: "up-to-date" });
  });

  test("download-progress → downloading（percent/transferred/total）", () => {
    const out = translateUpdaterEvent({
      type: "download-progress",
      progress: { percent: 45.6, transferred: 57671680, total: 134217728 },
    });
    expect(out).toEqual({ phase: "downloading", progress: 45.6, transferred: 57671680, total: 134217728 });
  });

  test("update-downloaded → downloaded", () => {
    expect(translateUpdaterEvent({ type: "update-downloaded" })).toEqual({ phase: "downloaded" });
  });

  test("error → error（message 提取）", () => {
    const out = translateUpdaterEvent({ type: "error", error: new Error("网络失败") });
    expect(out.phase).toBe("error");
    expect(out.message).toBe("网络失败");
  });

  test("未知事件 → null（忽略）", () => {
    expect(translateUpdaterEvent({ type: "unknown-event" })).toBeNull();
  });
});

describe("updaterPhases", () => {
  test("包含全部阶段", () => {
    expect(updaterPhases).toEqual(["checking", "available", "up-to-date", "downloading", "downloaded", "error"]);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

```bash
cd packages/desktop && bun test src/updater/updater.test.ts
```

预期：FAIL，`Cannot find module "./updater.cjs"`。

- [ ] **步骤 3：实现 updater.cjs（先实现可测试的纯函数部分）**

创建 `packages/desktop/src/updater/updater.cjs`：

```js
// 自动更新装配层：创建 NsisUpdater、注入 GiteeProvider、注册 IPC、事件翻译广播。
// translateUpdaterEvent / updaterPhases 为纯函数（可单测）；setupUpdater 依赖 Electron 环境（main 进程调用）。

const updaterPhases = ["checking", "available", "up-to-date", "downloading", "downloaded", "error"];

// autoUpdater 事件 → 前端 updater:event 载荷（{ phase, ... }）。未知事件返回 null。
function translateUpdaterEvent({ type, info, progress, error }) {
	switch (type) {
		case "checking-for-update":
			return { phase: "checking" };
		case "update-available":
			return {
				phase: "available",
				version: info?.version ?? null,
				releaseNotes: info?.releaseNotes ?? null,
			};
		case "update-not-available":
			return { phase: "up-to-date" };
		case "download-progress":
			return {
				phase: "downloading",
				progress: progress?.percent ?? 0,
				transferred: progress?.transferred ?? 0,
				total: progress?.total ?? 0,
			};
		case "update-downloaded":
			return { phase: "downloaded", version: info?.version ?? null };
		case "error":
			return { phase: "error", message: error?.message || String(error) };
		default:
			return null;
	}
}

module.exports = { updaterPhases, translateUpdaterEvent };
```

- [ ] **步骤 4：运行测试确认通过**

```bash
cd packages/desktop && bun test src/updater/updater.test.ts
```

预期：PASS（8 个用例）。

- [ ] **步骤 5：实现 setupUpdater（Electron 装配，本步骤不测，接入任务 6 后靠 E2E 覆盖）**

在 `updater.cjs` 末尾追加：

```js
// —— Electron 装配（main 进程调用）——

const { NsisUpdater } = require("electron-updater");
const { GiteeProvider } = require("./gitee-provider.cjs");

/**
 * @param {object} deps
 * @param {() => import("electron").BrowserWindow | null} deps.getMainWindow 获取主窗口（广播用）
 * @param {(msg: string) => void} deps.log
 * @param {boolean} deps.isPackaged 是否打包版（dev 下禁用真实更新）
 * @param {string} deps.currentVersion app.getVersion()
 * @param {{ baseUrl?: string, owner?: string, repo?: string }} [deps.config] 可覆盖（E2E/测试指向本地 mock）
 */
function setupUpdater({ getMainWindow, log, isPackaged, currentVersion, config = {} }) {
	const { ipcMain } = require("electron");

	const broadcast = (payload) => {
		const win = getMainWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send("updater:event", payload);
		}
	};

	ipcMain.handle("updater:get-info", () => ({
		appVersion: currentVersion,
		isDesktop: isPackaged,
	}));

	if (!isPackaged) {
		// dev 模式：注册占位 handler，返回不可用，避免误触发真实更新
		ipcMain.handle("updater:check", () => ({ ok: false, reason: "dev" }));
		ipcMain.handle("updater:download", () => ({ ok: false, reason: "dev" }));
		ipcMain.handle("updater:quit-and-install", () => ({ ok: false, reason: "dev" }));
		return;
	}

	const updater = new NsisUpdater();
	updater.autoDownload = false;
	updater.logger = {
		info: (m) => log(`[updater] ${m}`),
		warn: (m) => log(`[updater] ${m}`),
		error: (m) => log(`[updater] ${m}`),
		debug: (m) => log(`[updater] ${m}`),
	};
	const provider = new GiteeProvider({
		runtimeOptions: {
			isUseMultipleRangeRequest: true,
			platform: process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "win32",
			executor: updater.httpExecutor,
		},
		baseUrl: config.baseUrl || "https://gitee.com/api/v5",
		owner: config.owner || "luandapipi",
		repo: config.repo || "HiAgent",
	});
	updater.provider = provider;

	for (const eventName of updaterPhases.map((p) => ({
		checking: "checking-for-update",
		available: "update-available",
		"up-to-date": "update-not-available",
		downloading: "download-progress",
		downloaded: "update-downloaded",
		error: "error",
	})).map((m) => m[Object.keys(m)[0]])) {
		updater.on(eventName, (...args) => {
			const payload = translateUpdaterEvent({
				type: eventName,
				info: args[0]?.version ? args[0] : undefined,
				progress: args[0],
				error: args[0],
			});
			if (payload) broadcast(payload);
		});
	}

	ipcMain.handle("updater:check", async () => {
		try {
			await updater.checkForUpdates();
			return { ok: true };
		} catch (e) {
			log(`[updater] check 失败: ${e.message || e}`);
			broadcast({ phase: "error", message: e.message || String(e) });
			return { ok: false, error: e.message || String(e) };
		}
	});

	ipcMain.handle("updater:download", async () => {
		try {
			await updater.downloadUpdate();
			return { ok: true };
		} catch (e) {
			log(`[updater] download 失败: ${e.message || e}`);
			broadcast({ phase: "error", message: e.message || String(e) });
			return { ok: false, error: e.message || String(e) };
		}
	});

	ipcMain.handle("updater:quit-and-install", () => {
		updater.quitAndInstall(false, true);
		return { ok: true };
	});

	log("[updater] 已装配（packaged）");
}

module.exports = { updaterPhases, translateUpdaterEvent, setupUpdater };
```

- [ ] **步骤 6：运行全部 desktop 单测确认无回归**

```bash
cd packages/desktop && bun test
```

预期：全部 PASS（含既有 tests/）。

- [ ] **步骤 7：Commit**

```bash
git add packages/desktop/src/updater/updater.cjs packages/desktop/src/updater/updater.test.ts
git commit -m "feat(desktop): updater 装配层（NsisUpdater + GiteeProvider 注入 + IPC + 事件翻译）"
```

---

## 任务 5：preload.cjs 暴露 waPiUpdater

**文件：**
- 修改：`packages/desktop/src/preload.cjs`

- [ ] **步骤 1：在 contextBridge 增加 waPiUpdater**

在 `packages/desktop/src/preload.cjs` 末尾（`waPiApp` 之后）追加：

```js
// 自动更新桥接：暴露给渲染进程（设置 → 关于 页签）
contextBridge.exposeInMainWorld("waPiUpdater", {
  getInfo: () => ipcRenderer.invoke("updater:get-info"),
  check: () => ipcRenderer.invoke("updater:check"),
  download: () => ipcRenderer.invoke("updater:download"),
  quitAndInstall: () => ipcRenderer.invoke("updater:quit-and-install"),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("updater:event", listener);
    return () => ipcRenderer.removeListener("updater:event", listener);
  },
});
```

- [ ] **步骤 2：验证语法**

```bash
cd packages/desktop && node -e "require('./src/preload.cjs')" 2>&1 | head -3
```

预期：因缺少 `electron` 模块而报错（说明语法加载正常，contextBridge 调用发生在 Electron 内）。用 `bun test` 跑既有 `tests/web-preferences.test.ts` 确认无破坏：

```bash
cd packages/desktop && bun test tests/web-preferences.test.ts
```

预期：PASS。

- [ ] **步骤 3：Commit**

```bash
git add packages/desktop/src/preload.cjs
git commit -m "feat(desktop): preload 暴露 waPiUpdater 桥接"
```

---

## 任务 6：main.cjs 接线

**文件：**
- 修改：`packages/desktop/src/main.cjs`

- [ ] **步骤 1：在 app.whenReady 内初始化 updater**

在 `packages/desktop/src/main.cjs` 的 `app.whenReady().then(async () => {` 块内、`createSplash(); createWindow();` 之后（`const gotLock` 判断通过后）追加：

```js
	// 自动更新：设置 → 关于（Gitee Releases）
	const { setupUpdater } = require("./updater/updater.cjs");
	setupUpdater({
		getMainWindow: () => mainWindow,
		log: (m) => log.info(m),
		isPackaged: app.isPackaged,
		currentVersion: app.getVersion(),
		config: {
			baseUrl: process.env.WA_PI_UPDATER_BASE_URL || undefined,
			owner: process.env.WA_PI_UPDATER_OWNER || undefined,
			repo: process.env.WA_PI_UPDATER_REPO || undefined,
		},
	});
```

> 说明：`WA_PI_UPDATER_BASE_URL` 等 env 仅为 E2E/测试指向本地 mock 服务预留，生产默认走 `https://gitee.com/api/v5`。

- [ ] **步骤 2：typecheck + 语法校验**

```bash
cd /h/workspace/hiagent && bun run typecheck --filter @wa-pi/desktop 2>&1 | tail -5
```

预期：无新增错误（desktop 为 CJS，typecheck 主要检查 tests）。

- [ ] **步骤 3：Commit**

```bash
git add packages/desktop/src/main.cjs
git commit -m "feat(desktop): main.cjs 接线 setupUpdater（支持 WA_PI_UPDATER_* env 覆盖）"
```

---

## 任务 7：前端 updater store

**文件：**
- 创建：`packages/frontend/src/store/updater.ts`

- [ ] **步骤 1：实现 updater store**

创建 `packages/frontend/src/store/updater.ts`：

```ts
import { create } from "zustand";

export type UpdaterStatus =
  | "idle" | "checking" | "up-to-date"
  | "available" | "downloading" | "downloaded"
  | "error";

interface WaPiUpdaterApi {
  getInfo(): Promise<{ appVersion: string; isDesktop: boolean }>;
  check(): Promise<unknown>;
  download(): Promise<unknown>;
  quitAndInstall(): Promise<unknown>;
  onEvent(cb: (payload: Record<string, unknown>) => void): () => void;
}

declare global {
  interface Window {
    waPiUpdater?: WaPiUpdaterApi;
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
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  quitAndInstall: () => Promise<void>;
}

const initialState = {
  status: "idle" as UpdaterStatus,
  appVersion: "",
  latestVersion: null,
  releaseNotes: null,
  progress: 0,
  transferred: 0,
  total: 0,
  error: null,
  isDesktop: false,
};

function applyEvent(state: UpdaterState, payload: Record<string, unknown>): Partial<UpdaterState> {
  const phase = payload.phase as UpdaterStatus;
  switch (phase) {
    case "checking":
      return { status: "checking", error: null };
    case "available":
      return {
        status: "available",
        latestVersion: (payload.version as string) ?? null,
        releaseNotes: (payload.releaseNotes as string) ?? null,
        error: null,
      };
    case "up-to-date":
      return { status: "up-to-date", error: null };
    case "downloading":
      return {
        status: "downloading",
        progress: (payload.progress as number) ?? 0,
        transferred: (payload.transferred as number) ?? 0,
        total: (payload.total as number) ?? 0,
        error: null,
      };
    case "downloaded":
      return { status: "downloaded", error: null };
    case "error":
      return { status: "error", error: (payload.message as string) ?? "更新失败" };
    default:
      return {};
  }
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  ...initialState,

  checkForUpdates: async () => {
    const api = window.waPiUpdater;
    if (!api) return;
    set({ status: "checking", error: null });
    try {
      await api.check();
    } catch (e) {
      set({ status: "error", error: (e as Error).message ?? "检查失败" });
    }
  },

  downloadUpdate: async () => {
    const api = window.waPiUpdater;
    if (!api) return;
    try {
      await api.download();
    } catch (e) {
      set({ status: "error", error: (e as Error).message ?? "下载失败" });
    }
  },

  quitAndInstall: async () => {
    const api = window.waPiUpdater;
    if (!api) return;
    await api.quitAndInstall();
  },
}));

/** 初始化：拉取版本信息 + 订阅 updater:event */
export function initUpdater() {
  const api = window.waPiUpdater;
  if (!api) return;
  void api.getInfo().then((info) => {
    useUpdaterStore.setState({ appVersion: info.appVersion, isDesktop: info.isDesktop });
  });
  api.onEvent((payload) => {
    useUpdaterStore.setState((s) => applyEvent(s, payload));
  });
}
```

- [ ] **步骤 2：在 App 挂载处调用 initUpdater**

在 `packages/frontend/src/main.tsx`（或 App.tsx 顶层 useEffect）追加：

```tsx
import { initUpdater } from "./store/updater";
initUpdater();
```

（在 `main.tsx` 渲染后调用即可；浏览器 dev 下 `window.waPiUpdater` 不存在，initUpdater 直接返回。）

- [ ] **步骤 3：typecheck**

```bash
cd /h/workspace/hiagent && bun run typecheck --filter @wa-pi/frontend 2>&1 | tail -5
```

预期：无新增类型错误。

- [ ] **步骤 4：Commit**

```bash
git add packages/frontend/src/store/updater.ts packages/frontend/src/main.tsx
git commit -m "feat(frontend): updater store 状态机 + IPC 桥接初始化"
```

---

## 任务 8：settings store + SettingsModal 导航

**文件：**
- 修改：`packages/frontend/src/store/settings.ts`
- 修改：`packages/frontend/src/components/SettingsModal.tsx`

- [ ] **步骤 1：SettingsSection 增加 "about"**

修改 `packages/frontend/src/store/settings.ts`：

```ts
export type SettingsSection = "models" | "skills" | "plugins" | "memory" | "mcp" | "about";
```

- [ ] **步骤 2：SettingsModal 加「关于」导航按钮**

修改 `packages/frontend/src/components/SettingsModal.tsx`：
- 在 `<nav>` 中最后一个按钮（MCP 连接器）之后追加：

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

- 在内容区渲染条件追加：

```tsx
          {activeSection === "about" && <AboutSection />}
```

- 顶部 import 追加：

```tsx
import { AboutSection } from "./settings/AboutSection";
```

- [ ] **步骤 3：typecheck**

```bash
cd /h/workspace/hiagent && bun run typecheck --filter @wa-pi/frontend 2>&1 | tail -5
```

预期：报错 `Cannot find module './settings/AboutSection'`（任务 9 实现后消除）——若如此，先进行任务 9 再回本任务验证。

- [ ] **步骤 4：Commit（若 AboutSection 未就绪则与任务 9 一起提交）**

```bash
git add packages/frontend/src/store/settings.ts packages/frontend/src/components/SettingsModal.tsx
git commit -m "feat(frontend): 设置页新增「关于」导航入口"
```

---

## 任务 9：AboutSection 组件（TDD）

**文件：**
- 创建：`packages/frontend/src/components/settings/AboutSection.tsx`
- 测试：`packages/frontend/tests/AboutSection.test.tsx`

- [ ] **步骤 1：编写失败的组件测试**

创建 `packages/frontend/tests/AboutSection.test.tsx`：

```tsx
import { beforeEach, afterEach, test, expect, vi } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AboutSection } from "../src/components/settings/AboutSection";
import { useUpdaterStore } from "../src/store/updater";

function mockUpdaterApi() {
  const listeners: Array<(p: Record<string, unknown>) => void> = [];
  const api = {
    getInfo: vi.fn(async () => ({ appVersion: "0.1.0", isDesktop: true })),
    check: vi.fn(async () => ({ ok: true })),
    download: vi.fn(async () => ({ ok: true })),
    quitAndInstall: vi.fn(async () => ({ ok: true })),
    onEvent: vi.fn((cb: (p: Record<string, unknown>) => void) => {
      listeners.push(cb);
      return () => {};
    }),
    _emit: (p: Record<string, unknown>) => listeners.forEach((cb) => cb(p)),
  };
  (window as any).waPiUpdater = api;
  return api;
}

beforeEach(() => {
  mockUpdaterApi();
  useUpdaterStore.setState({
    status: "idle", appVersion: "0.1.0", latestVersion: null, releaseNotes: null,
    progress: 0, transferred: 0, total: 0, error: null, isDesktop: true,
  });
});
afterEach(() => {
  cleanup();
  delete (window as any).waPiUpdater;
});

test("渲染应用名与版本号", () => {
  render(<AboutSection />);
  expect(screen.getByText("WA PI Agent")).toBeTruthy();
  expect(screen.getByText("版本 0.1.0")).toBeTruthy();
});

test("idle 显示检查更新按钮，点击触发 check", () => {
  const api = (window as any).waPiUpdater;
  render(<AboutSection />);
  fireEvent.click(screen.getByText("检查更新"));
  expect(api.check).toHaveBeenCalled();
});

test("available 显示新版本与 release notes", () => {
  (window as any).waPiUpdater._emit({ phase: "available", version: "0.2.0", releaseNotes: "修复：文件预览持久化" });
  render(<AboutSection />);
  expect(screen.getByText(/0\.2\.0/)).toBeTruthy();
  expect(screen.getByText(/文件预览持久化/)).toBeTruthy();
  fireEvent.click(screen.getByText("立即更新"));
  expect((window as any).waPiUpdater.download).toHaveBeenCalled();
});

test("downloading 显示进度", () => {
  (window as any).waPiUpdater._emit({ phase: "downloading", progress: 45, transferred: 57, total: 128 });
  render(<AboutSection />);
  expect(screen.getByText(/45%/)).toBeTruthy();
});

test("downloaded 显示重启安装按钮", () => {
  (window as any).waPiUpdater._emit({ phase: "downloaded", version: "0.2.0" });
  render(<AboutSection />);
  fireEvent.click(screen.getByText("立即重启安装"));
  expect((window as any).waPiUpdater.quitAndInstall).toHaveBeenCalled();
});

test("error 显示错误与重试", () => {
  (window as any).waPiUpdater._emit({ phase: "error", message: "网络失败" });
  render(<AboutSection />);
  expect(screen.getByText(/网络失败/)).toBeTruthy();
  fireEvent.click(screen.getByText("重试"));
  expect((window as any).waPiUpdater.check).toHaveBeenCalled();
});

test("非桌面环境（isDesktop=false）隐藏更新按钮", () => {
  useUpdaterStore.setState({ isDesktop: false });
  render(<AboutSection />);
  expect(screen.queryByText("检查更新")).toBeNull();
});
```

- [ ] **步骤 2：运行测试确认失败**

```bash
cd /h/workspace/hiagent/packages/frontend && bun test --isolate tests/AboutSection.test.tsx
```

预期：FAIL，`Cannot find module '../src/components/settings/AboutSection'`。

- [ ] **步骤 3：实现 AboutSection**

创建 `packages/frontend/src/components/settings/AboutSection.tsx`：

```tsx
import { useUpdaterStore } from "../../store/updater";

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function AboutSection() {
  const {
    status, appVersion, latestVersion, releaseNotes,
    progress, transferred, total, error, isDesktop,
    checkForUpdates, downloadUpdate, quitAndInstall,
  } = useUpdaterStore();

  const showUpdateControls = isDesktop;

  return (
    <div className="flex flex-col items-center p-8 overflow-auto gap-0" data-testid="about-section">
      <div
        className="w-24 h-24 rounded-[22px] flex items-center justify-center shadow-md"
        style={{ background: "var(--brand)" }}
      >
        <span className="text-white text-[40px] font-black select-none">WA</span>
      </div>
      <div className="mt-4 text-lg font-semibold text-primary">WA PI Agent</div>
      <div className="mt-1 text-[13px] text-secondary">版本 {appVersion || "—"}</div>
      <div className="w-[280px] h-px my-5" style={{ background: "var(--hairline)" }} />

      {!showUpdateControls ? (
        <div className="text-xs text-tertiary">自动更新仅适用于桌面安装版</div>
      ) : (
        <div className="flex flex-col items-center gap-3 w-[340px]" data-testid="updater-status">
          {status === "idle" && (
            <button
              className="px-6 py-2 rounded-sm text-sm font-medium border-0 cursor-pointer"
              style={{ background: "var(--brand)", color: "var(--on-brand)" }}
              onClick={() => void checkForUpdates()}
              data-testid="check-update-btn"
            >检查更新</button>
          )}

          {status === "checking" && (
            <div className="flex items-center gap-2 text-sm text-primary">
              <span className="inline-block w-3.5 h-3.5 rounded-full border-2"
                style={{ borderColor: "var(--hairline-strong)", borderTopColor: "var(--accent)" }} />
              正在检查更新…
            </div>
          )}

          {status === "available" && (
            <>
              <div className="text-sm text-primary">
                发现新版本 <b>{latestVersion ? `v${latestVersion}` : ""}</b>
              </div>
              {releaseNotes && <div className="text-xs text-tertiary text-center leading-5 max-w-[340px]">{releaseNotes}</div>}
              <button
                className="px-5 py-2 rounded-sm text-sm font-medium border-0 cursor-pointer"
                style={{ background: "var(--accent)", color: "var(--on-accent)" }}
                onClick={() => void downloadUpdate()}
                data-testid="download-update-btn"
              >立即更新</button>
            </>
          )}

          {status === "downloading" && (
            <>
              <div className="text-sm text-primary">正在下载 {latestVersion ? `v${latestVersion}` : ""}…</div>
              <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface-hover)" }}>
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${Math.min(100, progress)}%`, background: "var(--accent)" }}
                  data-testid="download-progress-bar"
                />
              </div>
              <div className="w-full flex justify-between text-xs text-secondary">
                <span>{Math.round(progress)}%</span>
                <span>{fmtBytes(transferred)} / {fmtBytes(total)}</span>
              </div>
            </>
          )}

          {status === "downloaded" && (
            <>
              <div className="text-sm font-medium" style={{ color: "var(--success)" }}>更新已就绪</div>
              <div className="text-xs text-secondary">新版本 {latestVersion ? `v${latestVersion}` : ""} 已下载完成</div>
              <button
                className="px-5 py-2 rounded-sm text-sm font-medium border-0 cursor-pointer"
                style={{ background: "var(--success)", color: "#fff" }}
                onClick={() => void quitAndInstall()}
                data-testid="install-update-btn"
              >立即重启安装</button>
            </>
          )}

          {status === "up-to-date" && (
            <div className="text-sm" style={{ color: "var(--success)" }}>已是最新版本 ✓</div>
          )}

          {status === "error" && (
            <>
              <div className="text-sm" style={{ color: "var(--danger)" }}>{error || "更新失败"}</div>
              <button
                className="px-4 py-1.5 rounded-sm text-sm border cursor-pointer"
                style={{ borderColor: "var(--hairline-strong)", color: "var(--text-secondary)", background: "transparent" }}
                onClick={() => void checkForUpdates()}
                data-testid="retry-update-btn"
              >重试</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **步骤 4：运行测试确认通过**

```bash
cd /h/workspace/hiagent/packages/frontend && bun test --isolate tests/AboutSection.test.tsx
```

预期：PASS（8 个用例）。

- [ ] **步骤 5：回任务 8 步骤 3 确认 typecheck 通过，并提交本任务**

```bash
cd /h/workspace/hiagent && bun run typecheck --filter @wa-pi/frontend 2>&1 | tail -5
```

预期：无类型错误。然后：

```bash
git add packages/frontend/src/components/settings/AboutSection.tsx packages/frontend/tests/AboutSection.test.tsx
git commit -m "feat(frontend): 关于页签 AboutSection（6 状态 UI + 组件测试）"
```

---

## 任务 10：E2E（注入 mock 验证完整 UI 流程）

**文件：**
- 创建：`packages/frontend/e2e/updater.spec.ts`

- [ ] **步骤 1：编写 E2E 测试**

创建 `packages/frontend/e2e/updater.spec.ts`（沿用既有 e2e 的打开方式，参考 `settings-provider.spec.ts` 的导航模式）：

```ts
import { test, expect } from "@playwright/test";

// 注入 mock 的 waPiUpdater（真实 IPC 在 dev 下不可用；mock 模拟主进程事件流）
const MOCK_SCRIPT = `
window.__updaterListeners = [];
window.waPiUpdater = {
  getInfo: async () => ({ appVersion: "0.1.0", isDesktop: true }),
  check: async () => { window.__updaterListeners.forEach(cb => cb({ phase: "available", version: "0.2.0", releaseNotes: "修复：文件预览持久化" })); return { ok: true }; },
  download: async () => {
    [10, 40, 70, 100].forEach((p, i) => setTimeout(() => window.__updaterListeners.forEach(cb => cb({ phase: "downloading", progress: p, transferred: p * 10, total: 1000 })), i * 100));
    setTimeout(() => window.__updaterListeners.forEach(cb => cb({ phase: "downloaded", version: "0.2.0" })), 450);
    return { ok: true };
  },
  quitAndInstall: async () => ({ ok: true }),
  onEvent: (cb) => { window.__updaterListeners.push(cb); return () => {}; },
};
`;

test("关于页签：检查更新 → 发现新版本 → 下载 → 就绪", async ({ page }) => {
  await page.addInitScript(MOCK_SCRIPT);
  await page.goto("/");

  // 打开系统设置
  await page.click('[data-testid="settings-button"]');
  await page.click('[data-testid="settings-nav-about"]');

  // 初始：版本 + 检查更新按钮
  await expect(page.getByTestId("about-section")).toBeVisible();
  await expect(page.getByText("版本 0.1.0")).toBeVisible();

  // 检查更新 → 发现新版本
  await page.click('[data-testid="check-update-btn"]');
  await expect(page.getByTestId("download-update-btn")).toBeVisible();
  await expect(page.getByText(/0\.2\.0/)).toBeVisible();

  // 下载 → 进度 → 就绪
  await page.click('[data-testid="download-update-btn"]');
  await expect(page.getByTestId("download-progress-bar")).toBeVisible();
  await expect(page.getByTestId("install-update-btn")).toBeVisible({ timeout: 5000 });
});
```

- [ ] **步骤 2：确认 e2e 可运行（先查 settings-button 的既有 testid）**

```bash
cd /h/workspace/hiagent/packages/frontend && grep -rn "settings-button\|settings-nav" e2e/settings-provider.spec.ts src/components/SettingsButton.tsx | head
```

预期：找到打开设置的实际 testid（若与上面不同，修正步骤 1 的选择器）。

- [ ] **步骤 3：运行 E2E**

```bash
cd /h/workspace/hiagent && WA_PI_E2E_WS_PORT=9777 bun run --filter @wa-pi/frontend e2e -- --project=chromium updater.spec.ts
```

预期：PASS。首次运行若挂起，timeout 杀掉残留 kernel 后重跑。

- [ ] **步骤 4：Commit**

```bash
git add packages/frontend/e2e/updater.spec.ts
git commit -m "test(frontend): 关于页签更新流程 E2E（mock waPiUpdater）"
```

---

## 任务 11：发版脚本 publish-gitee.ts

**文件：**
- 创建：`scripts/publish-gitee.ts`

- [ ] **步骤 1：实现发版脚本**

创建 `scripts/publish-gitee.ts`（根目录，用 bun 运行）：

```ts
// 发版辅助：把 packages/desktop/release/ 产物上传到 Gitee Release。
// 用法：GITEE_TOKEN=<私人令牌> bun run scripts/publish-gitee.ts <version>
// 若未提供 token，打印手动上传指引后退出（不失败）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version) {
  console.error("用法: GITEE_TOKEN=<token> bun run scripts/publish-gitee.ts <version>");
  process.exit(1);
}

const OWNER = "luandapipi";
const REPO = "HiAgent";
const API = "https://gitee.com/api/v5";
const token = process.env.GITEE_TOKEN;
const releaseDir = join(import.meta.dir, "..", "packages", "desktop", "release");

function listArtifacts(): Array<{ path: string; name: string; size: number }> {
  return readdirSync(releaseDir)
    .filter((f) => f.endsWith(".exe") || f === "latest.yml")
    .map((f) => ({ path: join(releaseDir, f), name: f, size: statSync(join(releaseDir, f)).size }));
}

if (!token) {
  const artifacts = listArtifacts();
  console.log("未提供 GITEE_TOKEN，以下产物需要手动上传到 Gitee Release：");
  console.log(`  https://gitee.com/${OWNER}/${REPO}/releases/new?tag=v${version}`);
  for (const a of artifacts) console.log(`  - ${a.name} (${a.size} bytes)`);
  process.exit(0);
}

async function main() {
  const artifacts = listArtifacts();
  if (artifacts.length === 0) {
    console.error(`release 目录为空：${releaseDir}`);
    process.exit(1);
  }

  const headers = { "Content-Type": "application/json" };
  // 1) 创建 release（已存在则忽略）
  const createRes = await fetch(`${API}/repos/${OWNER}/${REPO}/releases`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      tag_name: `v${version}`,
      name: `v${version}`,
      body: `WA PI Agent v${version}`,
      access_token: token,
    }),
  });
  if (!createRes.ok && createRes.status !== 409) {
    console.error("创建 release 失败:", createRes.status, await createRes.text());
    process.exit(1);
  }
  const release = await createRes.json();

  // 2) 上传附件
  for (const a of artifacts) {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(a.path)]), a.name);
    form.append("access_token", token);
    const upRes = await fetch(`${API}/repos/${OWNER}/${REPO}/releases/${release.id}/attach_files`, {
      method: "POST",
      body: form,
    });
    if (!upRes.ok) {
      console.error(`上传 ${a.name} 失败:`, upRes.status, await upRes.text());
      process.exit(1);
    }
    console.log(`✓ 已上传 ${a.name}`);
  }
  console.log(`✅ 发布完成: https://gitee.com/${OWNER}/${REPO}/releases/v${version}`);
}

void main();
```

- [ ] **步骤 2：验证脚本可执行（无 token 分支）**

```bash
cd /h/workspace/hiagent && bun run scripts/publish-gitee.ts 0.1.0
```

预期：打印手动上传指引（release 目录可能为空则提示）。

- [ ] **步骤 3：Commit**

```bash
git add scripts/publish-gitee.ts
git commit -m "feat(scripts): publish-gitee 发版辅助脚本"
```

---

## 任务 12：收尾——CHANGELOG + 全量验证

**文件：**
- 修改：`CHANGELOG.md`

- [ ] **步骤 1：CHANGELOG 顶部追加条目**

在 `CHANGELOG.md` 顶部新增：

```markdown
## 2026-08-02

- **新增功能**：桌面版「系统设置 → 关于」支持版本显示与自动更新（检查 Gitee Releases → 下载带进度 → 静默安装并重启），基于 electron-updater + 自定义 GiteeProvider。
- **新增功能**：`scripts/publish-gitee.ts` 发版辅助脚本（上传安装包 + latest.yml 到 Gitee Release）。
- **影响范围**：packages/desktop（updater 模块、preload、main）、packages/frontend（AboutSection、updater store、SettingsModal）、scripts/publish-gitee.ts。
```

- [ ] **步骤 2：全量测试**

```bash
cd /h/workspace/hiagent && bun run test
```

预期：全部 PASS（kernel + shared + desktop + frontend）。

- [ ] **步骤 3：全量 typecheck**

```bash
cd /h/workspace/hiagent && bun run typecheck
```

预期：无错误。

- [ ] **步骤 4：Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录自动更新功能"
```

---

## 自检结果

- **规格覆盖度**：规格 §4（GiteeProvider）→ 任务 2/3；§5（UI + 状态机）→ 任务 7/8/9；§6（IPC）→ 任务 4/5；§7（可测试性）→ 任务 2 纯函数拆分；§8（发版）→ 任务 11；§9（错误处理）→ 任务 4（事件翻译 error）+ 任务 9（UI error 态）；§10（测试）→ 任务 2/3/4（单测）+ 任务 9（组件）+ 任务 10（E2E）。
- **占位符扫描**：无 TODO/待定；每个代码步骤含完整可运行代码。
- **类型一致性**：`GiteeProvider` 构造（options: baseUrl/owner/repo/fetchImpl）在任务 3 定义、任务 4 使用一致；`translateUpdaterEvent` 载荷与前端 `applyEvent` 字段（phase/version/releaseNotes/progress/transferred/total/message）在任务 4/7 中一致；`updater:event` 通道名在 preload（任务 5）、updater.cjs（任务 4）、store（任务 7）三处一致。
