// Cloudflare Pages Direct Upload 核心客户端
// 流程：创建/获取项目 → 计算内容寻址 hash（与 wrangler hashFile 一致）→ 拿 JWT →
//      check-missing 跳过已上传 → 分桶上传 → multipart 创建部署 → 轮询到成功
import { hashFileContent } from "./file-hash";

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";
export const CF_SHARE_PROJECT_NAME = "wapi-shares"; // 与 edgeone 固定项目同名，互不冲突（不同平台）

export interface CloudflareShareOptions {
  token: string;      // CF API Token（设置页配置）
  accountId?: string; // CF Account ID；留空时用 token 调 GET /accounts 自动获取
  files: Record<string, Uint8Array>; // 相对路径 -> 内容（zip 解压产物）
  projectName?: string;              // 默认 CF_SHARE_PROJECT_NAME
  branch?: string;                   // 默认 "main"（生产分支）
  pollIntervalMs?: number;           // 轮询间隔（测试注入用，默认 5000）
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
  const missingRes = await fetch(`${CF_API_BASE}/pages/assets/check-missing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ hashes }),
  });
  const missingJson: any = await missingRes.json().catch(() => ({}));
  if (!missingRes.ok) {
    // JWT 失效或 4xx 时，错误 JSON 不能被当成 string[] 用，抛出带状态/信息的错误
    const msg = missingJson.errors?.[0]?.message;
    throw new Error(`check-missing failed: HTTP ${missingRes.status}${msg ? ` ${msg}` : ""}`);
  }
  const missing = missingJson as string[];

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
    const upRes = await fetch(`${CF_API_BASE}/pages/assets/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(payload),
    });
    const upJson: any = await upRes.json().catch(() => ({}));
    if (!upRes.ok || upJson.success === false) {
      // 同时校验 HTTP 状态与业务 success 字段，避免 success:false 被当作成功静默跳过
      const msg = upJson.errors?.[0]?.message;
      throw new Error(`upload failed: HTTP ${upRes.status}${msg ? ` ${msg}` : ""}`);
    }
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

/** 用 API Token 自动获取 Account ID（用户无需手动填写）
 *  GET /client/v4/accounts 返回当前 token 可访问的账号列表，取第一个。 */
export async function getCloudflareAccountId(
  token: string,
): Promise<string> {
  const accounts = await cfApi<{ id: string }[]>(
    token,
    `/accounts?per_page=5`,
  );
  if (!accounts?.length) throw new Error("Cloudflare 账号列表为空，请检查 Token 权限");
  return accounts[0].id;
}

export async function deployToCloudflare(
  opts: CloudflareShareOptions,
): Promise<CloudflareDeployResult> {
  const { token, files } = opts;
  if (!token) throw new Error("未配置 Cloudflare API Token");
  // Account ID 可通过接口获取：未配置时用 token 自动拉取，用户无需手动填写
  const accountId = opts.accountId || (await getCloudflareAccountId(token));
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
