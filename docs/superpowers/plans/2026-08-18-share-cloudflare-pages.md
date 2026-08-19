# 分享渠道增加 Cloudflare Pages 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在「系统设置 → 分享 → 分享渠道」中新增 Cloudflare Pages 渠道，用户可选择 edgeone（现状，保留 token 鉴权）或 cloudflare（公开链接、无 token），部署链路按 channel 分派。

**架构：** 复用现有 `channel: "edgeone" | "cloudflare"` 字段做分派。新增 `packages/kernel/src/share/cloudflare-pages-client.ts`，实现 Cloudflare Pages Direct Upload 流程（upload-token → check-missing → assets/upload → deployments multipart → 轮询）。Cloudflare 分享链接**永久公开**（无 eo_token），`expiresAt` 返回 0 表示不过期。设置里 cloudflare 渠道需要 `token`（CF API Token）+ `accountId` 两个字段。

**技术栈：** Node/bun（kernel）、fflate（zip 解压）、`@noble/hashes`（blake3，纯 JS 无原生依赖，跨平台稳定）、原生 fetch/FormData（Node 18+）、Vitest/Testing Library（前端）。

**背景事实（已 POC 实测确认，2026-08-18）：**
- Cloudflare Pages **不能**用「部署 multipart 里直接塞文件」的方式——文件必须先按**内容 hash** 上传到 `/pages/assets/upload`，部署请求的 `manifest` 是 **`{相对路径: 文件hash}`**（不是 content-type）。
- 文件 hash 算法：`blake3(base64(文件内容) + 扩展名(不带点)).hex.slice(0, 32)`（wrangler 源码 `hashFile` 同款）。
- 桶限制：单桶 ≤ 40MiB、≤ 2000 文件，并发 3（wrangler `constants.ts`）。
- 免费版：单文件 ≤ 25MB、无限带宽、构建/上传无硬存储上限（fair use）。
- 部署后访问：`https://{projectName}.pages.dev/<路径>` 公开可访问，国内直连 0.5~2s（POC 实测 HTTP 200）。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/kernel/package.json` | 修改 | 加 `@noble/hashes` 依赖 |
| `packages/kernel/src/share/file-hash.ts` | 创建 | blake3 文件 hash 工具（CF 内容寻址 key） |
| `packages/kernel/tests/file-hash.test.ts` | 创建 | hash 工具单测 |
| `packages/kernel/src/share/cloudflare-pages-client.ts` | 创建 | CF Direct Upload 核心客户端（项目/上传/部署/轮询） |
| `packages/kernel/tests/cloudflare-pages-client.test.ts` | 创建 | 客户端单测（mock fetch） |
| `packages/shared/src/types.ts` | 修改 | `ShareSettings` 加 `accountId` |
| `packages/kernel/src/settings-store.ts` | 修改 | `SHARE_DEFAULTS` 加 `accountId`，read-modify-write 保留 |
| `packages/kernel/src/routes/settings.ts` | 修改 | GET/PUT share 设置透传 `accountId` |
| `packages/kernel/src/routes/share.ts` | 修改 | `deployNow` 按 channel 分派；CF 渠道解压 zip → 上传部署 |
| `packages/kernel/src/ws-server.ts` | 修改 | channel 从设置读取，不再硬编码 |
| `packages/frontend/src/share-client.ts` | 修改 | `saveShareSettings` 支持 accountId（如类型变化） |
| `packages/frontend/src/components/settings/ShareSection.tsx` | 修改 | 渠道选择 UI + cloudflare 配置字段 |
| `packages/kernel/tests/share-routes.test.ts` | 修改 | 加 cloudflare 渠道 mock 用例 |
| `packages/kernel/tests/settings-share.test.ts` | 修改 | 默认值含 accountId 断言 |
| `packages/frontend/src/components/settings/ShareSection.test.tsx` | 修改 | 渠道切换/字段渲染断言 |
| `docs/superpowers/specs/2026-08-18-share-cloudflare-channel-design.md` | 创建 | 简要设计文档（本计划配套） |
| `CHANGELOG.md` | 修改 | 顶部加本次变更记录 |

---

## 任务 1：blake3 依赖 + 文件 hash 工具

**文件：**
- 修改：`packages/kernel/package.json`
- 创建：`packages/kernel/src/share/file-hash.ts`
- 测试：`packages/kernel/tests/file-hash.test.ts`

- [ ] **步骤 1：安装依赖**

```bash
cd /Users/pipi/work/HiAgent/packages/kernel
bun add @noble/hashes
```

预期：`package.json` 的 dependencies 出现 `@noble/hashes`。

- [ ] **步骤 2：编写失败的测试**

创建 `packages/kernel/tests/file-hash.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { hashFileContent } from "../src/share/file-hash";

describe("hashFileContent", () => {
  test("确定性：相同内容+扩展名产生相同 hash", () => {
    const a = hashFileContent(new TextEncoder().encode("hello world"), "html");
    const b = hashFileContent(new TextEncoder().encode("hello world"), "html");
    expect(a).toBe(b);
  });

  test("不同内容产生不同 hash", () => {
    const a = hashFileContent(new TextEncoder().encode("hello"), "html");
    const b = hashFileContent(new TextEncoder().encode("world"), "html");
    expect(a).not.toBe(b);
  });

  test("hash 为 32 字符 hex（内容寻址 key 格式）", () => {
    const h = hashFileContent(new TextEncoder().encode("hello world"), "html");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  test("扩展名参与 hash（同内容不同扩展名结果不同）", () => {
    const a = hashFileContent(new TextEncoder().encode("hello"), "html");
    const b = hashFileContent(new TextEncoder().encode("hello"), "txt");
    expect(a).not.toBe(b);
  });
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/file-hash.test.ts`
预期：FAIL，`Cannot find module '../src/share/file-hash'`

- [ ] **步骤 4：实现 hash 工具**

创建 `packages/kernel/src/share/file-hash.ts`：

```ts
// Cloudflare Pages 内容寻址 hash：与 wrangler hashFile 完全一致
// blake3(base64(内容) + 扩展名).hex.slice(0, 32)
import { blake3 } from "@noble/hashes/blake3";

export function hashFileContent(content: Uint8Array, ext: string): string {
  const base64Contents = Buffer.from(content).toString("base64");
  const extension = ext.replace(/^\./, ""); // 不带点
  const digest = blake3(new TextEncoder().encode(base64Contents + extension));
  return Buffer.from(digest).toString("hex").slice(0, 32);
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/file-hash.test.ts`
预期：PASS（4 个用例全过）

- [ ] **步骤 6：Commit**

```bash
cd /Users/pipi/work/HiAgent
git add packages/kernel/package.json packages/kernel/src/share/file-hash.ts packages/kernel/tests/file-hash.test.ts
git commit -m "feat(share): add blake3 file hash util for Cloudflare Pages content addressing"
```

---

## 任务 2：cloudflare-pages-client.ts 核心客户端

**文件：**
- 创建：`packages/kernel/src/share/cloudflare-pages-client.ts`
- 测试：`packages/kernel/tests/cloudflare-pages-client.test.ts`

**接口设计（本任务交付）：**

```ts
export const CF_API_BASE = "https://api.cloudflare.com/client/v4";
export const CF_SHARE_PROJECT_NAME = "wapi-shares"; // 与 edgeone 固定项目同名，互不冲突（不同平台）

export interface CloudflareShareOptions {
  token: string;      // CF API Token（设置页配置）
  accountId: string;  // CF Account ID（设置页配置）
  files: Record<string, Uint8Array>; // 相对路径 -> 内容（zip 解压产物）
  projectName?: string;              // 默认 CF_SHARE_PROJECT_NAME
  branch?: string;                   // 默认 "main"（生产分支）
  onProgress?: (p: {
    phase: "uploading" | "deploying";
    percent?: number;
    loaded?: number;
    total?: number;
  }) => void;
}

export interface CloudflareDeployResult {
  projectName: string;
  projectId: string;
  url: string;         // https://{projectName}.pages.dev（公开访问根链接）
  deploymentId: string;
  deploymentUrl: string; // https://{deploymentId}.{projectName}.pages.dev
}
```

**实现要点（已实测确认）：**

```ts
import { hashFileContent } from "./file-hash";

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";
export const CF_SHARE_PROJECT_NAME = "wapi-shares";

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript",
    json: "application/json", txt: "text/plain", md: "text/markdown",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
    pdf: "application/pdf", zip: "application/zip", wasm: "application/wasm",
  };
  return map[ext] ?? "application/octet-stream";
}

async function cfApi<T = any>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${CF_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const json = await res.json().catch(() => ({ success: false, errors: [{ message: "json parse failed" }] }));
  if (!res.ok || json.success === false) {
    const msg = (json.errors?.[0]?.message ?? `HTTP ${res.status}`) as string;
    throw new Error(msg);
  }
  return json.result as T;
}
```

**完整流程函数（先创建项目 → 上传文件 → 创建部署 → 轮询）：**

```ts
export async function getOrCreateProject(
  token: string,
  accountId: string,
  projectName: string,
): Promise<{ id: string }> {
  const existing = await cfApi<{ id: string }>(
    token, `/accounts/${accountId}/pages/projects/${projectName}`,
  ).catch(() => null);
  if (existing) return existing;
  return cfApi<{ id: string }>(token, `/accounts/${accountId}/pages/projects`, {
    method: "POST",
    body: JSON.stringify({ name: projectName, production_branch: "main" }),
  });
}

// 上传文件（内容寻址，返回 路径 -> hash 的 manifest）
async function uploadFiles(
  token: string,
  accountId: string,
  projectName: string,
  files: Record<string, Uint8Array>,
  onProgress?: CloudflareShareOptions["onProgress"],
): Promise<Record<string, string>> {
  // 1. 计算每个文件的 hash 与 manifest
  const entries = Object.entries(files);
  const manifest: Record<string, string> = {};
  const byHash = new Map<string, { path: string; content: Uint8Array }>();
  for (const [path, content] of entries) {
    const ext = path.includes(".") ? path.split(".").pop()! : "";
    const h = hashFileContent(content, ext);
    manifest[path] = h;
    if (!byHash.has(h)) byHash.set(h, { path, content });
  }

  // 2. 拿 JWT
  const { jwt } = await cfApi<{ jwt: string }>(
    token, `/accounts/${accountId}/pages/projects/${projectName}/upload-token`,
  );

  // 3. check-missing（跳过已上传的）
  const hashes = [...byHash.keys()];
  const missing = await fetch(`${CF_API_BASE}/pages/assets/check-missing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ hashes }),
  }).then((r) => r.json()) as string[];

  // 4. 分桶上传（单桶 ≤ 40MiB / ≤ 2000 文件，串行即可，分享文件量小）
  const uploadHashes = hashes.filter((h) => missing.includes(h));
  const totalBytes = uploadHashes.reduce((sum, h) => sum + byHash.get(h)!.content.byteLength, 0);
  let uploadedBytes = 0;

  for (const h of uploadHashes) {
    const { content } = byHash.get(h)!;
    const payload = [{
      key: h,
      value: Buffer.from(content).toString("base64"),
      metadata: { contentType: contentTypeFor(byHash.get(h)!.path) },
      base64: true,
    }];
    await fetch(`${CF_API_BASE}/pages/assets/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(payload),
    }).then((r) => {
      if (!r.ok) throw new Error(`upload failed: HTTP ${r.status}`);
    });
    uploadedBytes += content.byteLength;
    onProgress?.({
      phase: "uploading",
      percent: totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 100,
      loaded: uploadedBytes,
      total: totalBytes,
    });
  }
  return manifest;
}

// 创建部署（multipart：manifest + branch）
async function createDeployment(
  token: string,
  accountId: string,
  projectName: string,
  manifest: Record<string, string>,
  branch: string,
): Promise<{ id: string; url: string; environment: string }> {
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  form.append("branch", branch);
  const res = await fetch(
    `${CF_API_BASE}/accounts/${accountId}/pages/projects/${projectName}/deployments`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    },
  );
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(json.errors?.[0]?.message ?? `HTTP ${res.status}`);
  }
  return json.result;
}

// 轮询部署状态（对齐 edgeone 的 40×5s 上限）
async function pollDeployment(
  token: string,
  accountId: string,
  projectName: string,
  deploymentId: string,
  pollIntervalMs = 5000,
): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const dep = await cfApi(
      token,
      `/accounts/${accountId}/pages/projects/${projectName}/deployments/${deploymentId}`,
    ) as { latest_stage?: { name?: string; status?: string } };
    const stage = dep.latest_stage;
    if (stage?.name === "deploy" && stage.status === "success") return;
    if (stage?.status === "failure") throw new Error("Cloudflare 部署失败");
  }
  throw new Error("Cloudflare 部署超时");
}

export async function deployToCloudflare(
  opts: CloudflareShareOptions,
): Promise<CloudflareDeployResult> {
  const { token, accountId, files } = opts;
  if (!token) throw new Error("未配置 Cloudflare API Token");
  if (!accountId) throw new Error("未配置 Cloudflare Account ID");
  const projectName = opts.projectName ?? CF_SHARE_PROJECT_NAME;
  const branch = opts.branch ?? "main";

  const project = await getOrCreateProject(token, accountId, projectName);
  opts.onProgress?.({ phase: "uploading", percent: 0, loaded: 0, total: 0 });
  const manifest = await uploadFiles(token, accountId, projectName, files, opts.onProgress);
  opts.onProgress?.({ phase: "deploying" });
  const deployment = await createDeployment(token, accountId, projectName, manifest, branch);
  await pollDeployment(token, accountId, projectName, deployment.id, opts.pollIntervalMs);
  return {
    projectName,
    projectId: project.id,
    url: `https://${projectName}.pages.dev`,
    deploymentId: deployment.id,
    deploymentUrl: deployment.url,
  };
}
```

> `opts.pollIntervalMs` 为可选测试注入参数（同 edgeone-client 模式），类型上加 `pollIntervalMs?: number`。

- [ ] **步骤 1：编写失败的测试**

创建 `packages/kernel/tests/cloudflare-pages-client.test.ts`。用 mock 全局 fetch 模拟 API（模式参考 `edgeone-client.test.ts`）：

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CF_API_BASE,
  deployToCloudflare,
  getOrCreateProject,
} from "../src/share/cloudflare-pages-client";

// 可配置的 fetch mock：按 URL 段返回预设 JSON
function installFetchMock() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const handler = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (u.includes("/upload-token")) return json({ result: { jwt: "JWT_TEST" }, success: true });
    if (u.includes("/pages/assets/check-missing")) return json(["hash-a", "hash-b"]);
    if (u.includes("/pages/assets/upload")) return json({ success: true });
    if (u.includes("/deployments/") && u.includes("latest")) {
      return json({ result: { latest_stage: { name: "deploy", status: "success" } }, success: true });
    }
    if (u.includes("/deployments")) return json({ result: { id: "dep-1", url: "https://abc.wapi-shares.pages.dev", environment: "production" }, success: true });
    if (u.endsWith("/pages/projects/wapi-shares")) {
      return json({ result: { id: "proj-1" }, success: true });
    }
    throw new Error(`unhandled mock URL: ${u}`);
  };
  // @ts-ignore 覆盖全局 fetch
  globalThis.fetch = handler as typeof fetch;
  return calls;
}

beforeEach(() => { installFetchMock(); });
afterEach(() => { delete (globalThis as any).fetch; });

describe("getOrCreateProject", () => {
  test("项目不存在时创建（POST）", async () => {
    const calls = installFetchMock();
    // 先让 GET 404，再让 POST 成功
    let n = 0;
    globalThis.fetch = (async (url: any, init?: any) => {
      n++;
      const u = String(url);
      if (u.endsWith("/pages/projects/wapi-shares") && n === 1) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: "not found" }] }), { status: 404 });
      }
      if (u.endsWith("/pages/projects") && init?.method === "POST") {
        return new Response(JSON.stringify({ result: { id: "proj-new" }, success: true }));
      }
      throw new Error(`unhandled: ${u} #${n}`);
    }) as typeof fetch;
    const proj = await getOrCreateProject("tk", "acc-1", "wapi-shares");
    expect(proj.id).toBe("proj-new");
  });
});

describe("deployToCloudflare", () => {
  test("完整流程：上传 → 部署 → 轮询 → 返回 pages.dev URL", async () => {
    const calls = installFetchMock();
    const result = await deployToCloudflare({
      token: "tk",
      accountId: "acc-1",
      files: { "index.html": new TextEncoder().encode("<h1>hi</h1>"), "demo/app.js": new TextEncoder().encode("console.log(1)") },
      pollIntervalMs: 1,
    });
    expect(result.url).toBe("https://wapi-shares.pages.dev");
    expect(result.deploymentId).toBe("dep-1");
    // 上传流程按顺序发生
    const urls = calls.map((c) => c.url);
    expect(urls.some((u) => u.includes("/upload-token"))).toBe(true);
    expect(urls.some((u) => u.includes("/pages/assets/check-missing"))).toBe(true);
    expect(urls.some((u) => u.includes("/pages/assets/upload"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/deployments") && !u.includes("/deployments/"))).toBe(true);
  });

  test("缺少 accountId 抛错", async () => {
    expect(
      deployToCloudflare({ token: "tk", accountId: "", files: {} }),
    ).rejects.toThrow("Account ID");
  });
});
```

> mock 注意：`installFetchMock` 里 `/deployments/` 的轮询判断需要在创建部署之前命中——测试顺序里创建部署先调 `POST .../deployments`（不含尾部 id），轮询调 `GET .../deployments/{id}`（含尾部 id）。若实现里轮询与创建判断冲突，按 URL 精确匹配调整 mock 分支顺序。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/cloudflare-pages-client.test.ts`
预期：FAIL，`Cannot find module '../src/share/cloudflare-pages-client'`

- [ ] **步骤 3：实现客户端**

按上文「完整流程函数」创建 `packages/kernel/src/share/cloudflare-pages-client.ts`（含 `opts.pollIntervalMs?: number`）。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/cloudflare-pages-client.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
cd /Users/pipi/work/HiAgent
git add packages/kernel/src/share/cloudflare-pages-client.ts packages/kernel/tests/cloudflare-pages-client.test.ts
git commit -m "feat(share): add Cloudflare Pages direct-upload client"
```

---

## 任务 3：settings 扩展（accountId）+ 类型更新

**文件：**
- 修改：`packages/shared/src/types.ts`（`ShareSettings`）
- 修改：`packages/kernel/src/settings-store.ts`（`SHARE_DEFAULTS`）
- 修改：`packages/kernel/src/routes/settings.ts`（透传 accountId）
- 测试：`packages/kernel/tests/settings-share.test.ts`、`packages/kernel/tests/settings-share-route.test.ts`

- [ ] **步骤 1：编写失败的测试（settings-store 默认值）**

在 `packages/kernel/tests/settings-share.test.ts` 现有断言处补充：

```ts
test("默认分享设置含 accountId 且为空", () => {
  const defaults = (await import("../src/settings-store")).SHARE_DEFAULTS;
  expect(defaults).toMatchObject({
    token: "",
    channel: "edgeone",
    customDomain: "",
    accountId: "",
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/settings-share.test.ts`
预期：FAIL，`accountId` 不存在

- [ ] **步骤 3：实现**

在 `packages/kernel/src/settings-store.ts` 的 `SHARE_DEFAULTS`（约 303-310 行）加 `accountId: ""`：

```ts
export const SHARE_DEFAULTS = {
  token: "",
  channel: "edgeone" as "edgeone" | "cloudflare",
  customDomain: "",
  accountId: "",
};
```

在 `packages/shared/src/types.ts` 的 ShareSettings 类型加字段：

```ts
export interface ShareSettings {
  token?: string;
  channel?: "edgeone" | "cloudflare";
  customDomain?: string;
  accountId?: string;
}
```

在 `packages/kernel/src/routes/settings.ts`（GET/PUT share 段）把 `accountId` 与 `customDomain` 一样透传（PUT 收明文、GET 下发；token 继续脱敏为 `hasToken`）。参考现有 customDomain 的处理代码逐行对齐。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/settings-share.test.ts tests/settings-share-route.test.ts`
预期：PASS（含新增断言与既有 roundtrip 用例）

- [ ] **步骤 5：Commit**

```bash
cd /Users/pipi/work/HiAgent
git add packages/shared/src/types.ts packages/kernel/src/settings-store.ts packages/kernel/src/routes/settings.ts packages/kernel/tests/settings-share.test.ts packages/kernel/tests/settings-share-route.test.ts
git commit -m "feat(share): add accountId to share settings for Cloudflare channel"
```

---

## 任务 4：routes/share.ts 按 channel 分派部署

**文件：**
- 修改：`packages/kernel/src/routes/share.ts`
- 测试：`packages/kernel/tests/share-routes.test.ts`

- [ ] **步骤 1：编写失败的测试（cloudflare 渠道用例）**

在 `packages/kernel/tests/share-routes.test.ts` 增加 mock 与用例。复用该文件现有 `mockEdgeOne` 模式，新增 `mockCloudflare`：

```ts
function mockCloudflare() {
  const handler = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("/upload-token")) return json({ result: { jwt: "J" }, success: true });
    if (u.includes("/pages/assets/check-missing")) return json([]);
    if (u.includes("/pages/assets/upload")) return json({ success: true });
    if (u.includes("/deployments/")) return json({ result: { latest_stage: { name: "deploy", status: "success" } }, success: true });
    if (u.endsWith("/deployments")) return json({ result: { id: "dep-cf", url: "https://abc.wapi-shares.pages.dev", environment: "production" }, success: true });
    if (u.endsWith("/pages/projects/wapi-shares")) return json({ result: { id: "proj-cf" }, success: true });
    if (u.endsWith("/pages/projects") && init?.method === "POST") return json({ result: { id: "proj-cf" }, success: true });
    throw new Error(`unhandled CF mock: ${u}`);
  };
  // @ts-ignore
  globalThis.fetch = handler as typeof fetch;
}
```

新增用例：

```ts
test("channel=cloudflare 时部署走 CF 客户端，返回公开 URL 且 expiresAt=0", async () => {
  // 前提：settings.json 里 share.channel = "cloudflare"、accountId = "acc-cf"
  // 通过既有 saveShareSettings 或直接写 settings 文件准备
  mockCloudflare();
  const res = await fetch("http://localhost/api/share/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "demo", files: [{ name: "index.html", data: "aGVsbG8=" }] }),
  });
  const body = await res.json();
  expect(body.channel).toBe("cloudflare");
  expect(body.url).toBe("https://wapi-shares.pages.dev/demo/");
  expect(body.expiresAt).toBe(0);
});
```

> 若 share-routes.test.ts 现有 mock 结构是「每 Action 一个分支」的 dispatch 形式，请把 CF 分支并入同一 handler；`files` 的请求格式与现有测试保持一致（参考现有 upload 用例的入参形状）。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/share-routes.test.ts`
预期：FAIL（当前 channel 固定 edgeone，CF 分支不存在）

- [ ] **步骤 3：实现 channel 分派**

修改 `packages/kernel/src/routes/share.ts`：

1. 顶部导入：`import { unzipSync } from "fflate";`、`import { deployToCloudflare } from "../share/cloudflare-pages-client";`、`import { loadShareSettings } from "../settings-store";`
2. `deployNow` 内（约 51-69 行）改造：

```ts
async function deployNow(): Promise<{ url: string; expiresAt: number; channel: string }> {
  const settings = loadShareSettings();
  const zip = await buildDeployZip(workspaceDir);
  const onProgress = (p: ShareProgress) => broadcastProgress(p);

  if (settings.channel === "cloudflare") {
    const files = unzipToFiles(zip); // 见下方 helper
    const result = await deployToCloudflare({
      token: settings.token,
      accountId: settings.accountId ?? "",
      files,
      onProgress,
    });
    return { url: result.url, expiresAt: 0, channel: "cloudflare" };
  }

  // 原 edgeone 逻辑不变
  const result = await deployWorkspace({
    token: settings.token,
    zip,
    customDomain: settings.customDomain,
    onProgress,
  });
  return { url: result.rootUrl, expiresAt: result.expiresAt, channel: "edgeone" };
}

// fflate 解压 zip 为 路径 -> Uint8Array（过滤目录条目）
function unzipToFiles(zip: Uint8Array): Record<string, Uint8Array> {
  const unzipped = unzipSync(zip);
  const files: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(unzipped)) {
    if (path.endsWith("/")) continue; // 目录
    files[path] = data;
  }
  return files;
}
```

3. `POST /api/share/upload` 返回值里的 `expiresAt` 前端处理：0 表示永久（前端任务 5 处理）。
4. 检查 `shareUpload` 的校验：`requireToken` 逻辑对 CF 渠道同样要求 token 非空（CF API Token 必填）；accountId 为空时在 `deployToCloudflare` 抛「未配置 Account ID」。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/share-routes.test.ts`
预期：PASS（原 edgeone 用例 + 新 CF 用例全过）

- [ ] **步骤 5：Commit**

```bash
cd /Users/pipi/work/HiAgent
git add packages/kernel/src/routes/share.ts packages/kernel/tests/share-routes.test.ts
git commit -m "feat(share): dispatch deploy by channel to Cloudflare Pages"
```

---

## 任务 5：ws-server channel 动态化

**文件：**
- 修改：`packages/kernel/src/ws-server.ts`

- [ ] **步骤 1：修改实现**

`packages/kernel/src/ws-server.ts` 约 514-525 行注册 `createShareRoutes` 处，当前 `channel: "edgeone"` 硬编码。改为在 `createShareRoutes` 内部按 `loadShareSettings().channel` 取值（或把 channel 从 route 层读取，不在注册处写死）：

```ts
createShareRoutes({
  // channel 由 route 层从 settings 读取，注册处不再传死值
  workspaceDir: join(WA_PI_DIR, "share-workspace"),
});
```

确认 `createShareRoutes` 内部所有读 `channel` 的地方（默认值注入、响应）都改为运行时从 `loadShareSettings()` 读取。

- [ ] **步骤 2：运行相关测试**

运行：`cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/share-routes.test.ts tests/settings-share-route.test.ts`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
cd /Users/pipi/work/HiAgent
git add packages/kernel/src/ws-server.ts
git commit -m "refactor(share): read share channel from settings at runtime"
```

---

## 任务 6：前端 ShareSection 渠道切换 UI

**文件：**
- 修改：`packages/frontend/src/components/settings/ShareSection.tsx`
- 修改：`packages/frontend/src/share-client.ts`（如类型需要）
- 测试：`packages/frontend/src/components/settings/ShareSection.test.tsx`

- [ ] **步骤 1：编写失败的测试**

在 `packages/frontend/src/components/settings/ShareSection.test.tsx` 增加用例：

```tsx
test("可切换到 Cloudflare 渠道，显示 token 与 Account ID 输入，保存时带 accountId", async () => {
  // 渲染设置面板，选 cloudflare 渠道，输入 token/accountId，断言保存请求体
  // 断言渠道下拉/单选存在；选 cloudflare 后出现 "Account ID" 输入框
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /Users/pipi/work/HiAgent/packages/frontend && npx vitest run src/components/settings/ShareSection.test.tsx`
预期：FAIL（无 cloudflare 选项）

- [ ] **步骤 3：实现**

修改 `ShareSection.tsx`：

1. 渠道选择：将「腾讯 EdgeOne（只读）」改为可切换的渠道控件（`edgeone` / `cloudflare`），沿用现有表单保存流程，保存时 `channel` 取当前选中值。
2. `channel === "cloudflare"` 时渲染：
   - API Token 输入框（label「Cloudflare API Token」，placeholder 提示在 Cloudflare 控制台创建，权限 `Account → Cloudflare Pages → Edit`）
   - Account ID 输入框（label「Account ID」，placeholder 提示在 `dash.cloudflare.com` URL 中）
   - 注册/说明链接：`https://dash.cloudflare.com/sign-up`（文本「注册 Cloudflare」）
   - 提示文案：「Cloudflare 分享链接永久公开，国内访问速度约 0.5~2s；单文件 ≤ 25MB」
3. `channel === "edgeone"` 时保留现有内容（注册入口 edgeone.ai、customDomain 等）。
4. 保存请求体：`{ channel, token, accountId, customDomain }` 全量提交（token 为空时不覆盖已保存的 token，与现有 PUT 脱敏行为一致——沿用现有逻辑）。

若 `packages/frontend/src/share-client.ts` 的 `saveShareSettings` 参数类型未含 accountId，一并补充。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /Users/pipi/work/HiAgent/packages/frontend && npx vitest run src/components/settings/ShareSection.test.tsx`
预期：PASS（既有用例 + 新用例）

- [ ] **步骤 5：前端全量测试**

运行：`cd /Users/pipi/work/HiAgent/packages/frontend && npx vitest run`
预期：PASS（回归基线 1589 pass 基础上新增用例通过）

- [ ] **步骤 6：Commit**

```bash
cd /Users/pipi/work/HiAgent
git add packages/frontend/src/components/settings/ShareSection.tsx packages/frontend/src/components/settings/ShareSection.test.tsx packages/frontend/src/share-client.ts
git commit -m "feat(share): add Cloudflare channel selection in share settings UI"
```

---

## 任务 7：E2E + 文档 + CHANGELOG

**文件：**
- 创建：`docs/superpowers/specs/2026-08-18-share-cloudflare-channel-design.md`
- 修改：`CHANGELOG.md`

- [ ] **步骤 1：写设计文档**

创建 `docs/superpowers/specs/2026-08-18-share-cloudflare-channel-design.md`，内容包含：渠道选择模型（edgeone/cloudflare）、CF Direct Upload 流程时序、hash 算法、免费限制（25MB 单文件、无限带宽）、与 edgeone 的差异表（公开 vs 3h token、expiresAt=0 语义）、已知取舍（国内速度 0.5~2s、customDomain 需在 CF 控制台配置）。

- [ ] **步骤 2：E2E 补充（UI 层）**

`packages/frontend/e2e/share-management.spec.ts` 增加用例：打开设置 → 切到 Cloudflare → 断言 Account ID 输入框与注册链接可见 → 切回 EdgeOne 断言注册链接恢复。**不跑真实部署**（需要真实 CF 凭证，留给手动验证清单）。

- [ ] **步骤 3：CHANGELOG**

在 `CHANGELOG.md` 顶部加：

```markdown
## 2026-08-18
- 新增功能：分享渠道支持 Cloudflare Pages（设置 → 分享 → 渠道切换）。公开链接、无 token 时效；配置 Cloudflare API Token + Account ID 即可部署到 pages.dev。后端新增 cloudflare-pages-client（内容寻址上传 + multipart 部署），部署按 channel 分派。
```

- [ ] **步骤 4：全量测试回归**

运行：`cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/ 2>&1 | tail -5 && cd packages/frontend && npx vitest run 2>&1 | tail -5`
预期：kernel + frontend 全部 PASS

- [ ] **步骤 5：Commit**

```bash
cd /Users/pipi/work/HiAgent
git add docs/superpowers/specs/2026-08-18-share-cloudflare-channel-design.md CHANGELOG.md packages/frontend/e2e/share-management.spec.ts
git commit -m "docs(share): cloudflare channel design doc + changelog + e2e"
```

---

## 手动验证清单（需要真实 CF 凭证，上线前执行）

1. 在 Cloudflare 控制台创建 API Token（权限 `Account → Cloudflare Pages → Edit`），取得 Account ID。
2. 应用内「设置 → 分享」切到 Cloudflare，填入 token + accountId，保存。
3. 分享一个文件 → 拿到 `https://wapi-shares.pages.dev/<name>/...` 链接。
4. 无痕窗口直接打开链接，确认 **HTTP 200、无需任何 token、内容正确**。
5. 分享一个多文件条目，确认 `<name>/` 目录能渲染 `index.html`。
6. 再切回 EdgeOne 渠道，确认原 token 分享链路不受影响。

## 自检

- **规格覆盖度：** 渠道选择（任务 6）、后端分派（任务 4）、设置字段（任务 3、6）、公开链接语义（任务 4 expiresAt=0）、免费限制提示（任务 6 文案）、E2E（任务 7）。
- **占位符扫描：** 所有步骤均含具体文件、代码或运行命令；无 TODO/待定。
- **类型一致性：** `channel: "edgeone" | "cloudflare"` 全程一致；`accountId` 在 settings-store/types/routes/前端命名一致；`deployToCloudflare` 返回 `{ url, expiresAt: 0, channel: "cloudflare" }` 与 routes 返回值对齐。
