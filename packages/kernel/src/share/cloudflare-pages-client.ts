// Cloudflare Pages Direct Upload 核心客户端
// 流程：创建/获取项目 → 计算内容寻址 hash（与 wrangler hashFile 一致）→ 拿 JWT →
//      check-missing 跳过已上传 → 分桶上传 → multipart 创建部署 → 轮询到成功
import { hashFileContent } from "./file-hash";
import { KernelError } from "../kernel-error";

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";
export const CF_SHARE_PROJECT_NAME = "wapi-shares"; // 与 edgeone 固定项目同名，互不冲突（不同平台）

export interface CloudflareShareOptions {
  token: string; // CF API Token（设置页配置）
  accountId?: string; // CF Account ID；留空时用 token 调 GET /accounts 自动获取
  files: Record<string, Uint8Array>; // 相对路径 -> 内容（zip 解压产物）
  projectName?: string; // 默认 CF_SHARE_PROJECT_NAME
  branch?: string; // 默认 "main"（生产分支）
  pollIntervalMs?: number; // 轮询间隔（测试注入用，默认 5000）
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
  url: string; // https://{projectName}.pages.dev（公开访问根链接）
  deploymentId: string;
  deploymentUrl: string; // https://{deploymentId}.{projectName}.pages.dev
}

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    pdf: "application/pdf",
    zip: "application/zip",
    wasm: "application/wasm",
  };
  return map[ext] ?? "application/octet-stream";
}

async function cfApi<T = any>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${CF_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const json = await res.json().catch(() => ({
    success: false,
    errors: [{ message: "json parse failed" }],
  }));
  if (!res.ok || json.success === false) {
    const msg = (json.errors?.[0]?.message ?? `HTTP ${res.status}`) as string;
    throw new KernelError("share.cloudflareApiFailed", undefined, msg);
  }
  return json.result as T;
}

export async function getOrCreateProject(
  token: string,
  accountId: string,
  projectName: string,
): Promise<{ id: string; subdomain: string }> {
  const existing = await cfApi<{
    id: string;
    subdomain?: string;
    domains?: string[];
  }>(token, `/accounts/${accountId}/pages/projects/${projectName}`).catch(
    () => null,
  );
  if (existing) {
    return { id: existing.id, subdomain: resolveSubdomain(existing) };
  }
  const created = await cfApi<{
    id: string;
    subdomain?: string;
    domains?: string[];
  }>(token, `/accounts/${accountId}/pages/projects`, {
    method: "POST",
    body: JSON.stringify({ name: projectName, production_branch: "main" }),
  });
  return { id: created.id, subdomain: resolveSubdomain(created) };
}

/** 从项目对象取真实 pages.dev 子域：subdomain 优先，fallback domains[0]。
 *  .pages.dev 子域全局唯一——同名项目在不同账号可能分到不同子域（如 wapi-shares-abc.pages.dev），
 *  绝不能硬编码 https://{projectName}.pages.dev 拼链接。 */
function resolveSubdomain(p: {
  subdomain?: string;
  domains?: string[];
}): string {
  const sub = p.subdomain || p.domains?.[0];
  if (!sub)
    throw new KernelError("share.domainUnavailable", { channel: "Cloudflare" });
  return sub;
}

/** 查询项目真实 pages.dev 子域（refresh-link 等场景复用；与 edgeone getPresetDomain 对齐） */
export async function getProjectSubdomain(
  token: string,
  accountId: string,
  projectName: string,
): Promise<string> {
  const proj = await cfApi<{ subdomain?: string; domains?: string[] }>(
    token,
    `/accounts/${accountId}/pages/projects/${projectName}`,
  );
  return resolveSubdomain(proj);
}

// 上传文件（内容寻址，返回 路径 -> hash 的 manifest）
async function uploadFiles(
  token: string,
  accountId: string,
  projectName: string,
  files: Record<string, Uint8Array>,
  onProgress?: CloudflareShareOptions["onProgress"],
): Promise<Record<string, string>> {
  // 1. 计算每个文件的 hash 与 manifest（key 带前导 /，与 wrangler manifest 格式一致）
  const entries = Object.entries(files);
  const manifest: Record<string, string> = {};
  const byHash = new Map<string, { path: string; content: Uint8Array }>();
  for (const [path, content] of entries) {
    const ext = path.includes(".") ? path.split(".").pop()! : "";
    const h = hashFileContent(content, ext);
    manifest[`/${path}`] = h;
    if (!byHash.has(h)) byHash.set(h, { path, content });
  }

  // 2. 拿 JWT
  const { jwt } = await cfApi<{ jwt: string }>(
    token,
    `/accounts/${accountId}/pages/projects/${projectName}/upload-token`,
  );

  // 3. check-missing（跳过已上传的）
  const hashes = [...byHash.keys()];
  const missingRes = await fetch(`${CF_API_BASE}/pages/assets/check-missing`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ hashes }),
  });
  const missingJson: any = await missingRes.json().catch(() => ({}));
  if (!missingRes.ok) {
    // JWT 失效或 4xx 时，错误 JSON 不能被当成 string[] 用，抛出带状态/信息的错误
    const msg = missingJson.errors?.[0]?.message;
    throw new KernelError(
      "share.assetCheckFailed",
      undefined,
      `HTTP ${missingRes.status}${msg ? ` ${msg}` : ""}`,
    );
  }
  // HTTP 200：真实 CF API 返回 {success, result: string[]}（wrangler fetchResult 解包 result 字段），
  // 兼容裸数组两种形态；两者都不是 → 抛明确错误，避免下游 missing.includes TypeError
  const missing = Array.isArray(missingJson)
    ? (missingJson as string[])
    : (missingJson?.result as unknown as string[] | undefined);
  if (!Array.isArray(missing)) {
    const msg = missingJson?.errors?.[0]?.message;
    throw new KernelError(
      "share.assetCheckFailed",
      undefined,
      `响应格式异常${msg ? ` ${msg}` : ""}`,
    );
  }

  // 4. 分桶上传（单桶 ≤ 40MiB / ≤ 2000 文件，串行即可，分享文件量小）
  const uploadHashes = hashes.filter((h) => missing.includes(h));
  const totalBytes = uploadHashes.reduce(
    (sum, h) => sum + byHash.get(h)!.content.byteLength,
    0,
  );
  let uploadedBytes = 0;

  for (const h of uploadHashes) {
    const { content } = byHash.get(h)!;
    const payload = [
      {
        key: h,
        value: Buffer.from(content).toString("base64"),
        metadata: { contentType: contentTypeFor(byHash.get(h)!.path) },
        base64: true,
      },
    ];
    const upRes = await fetch(`${CF_API_BASE}/pages/assets/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(payload),
    });
    const upJson: any = await upRes.json().catch(() => ({}));
    if (!upRes.ok || upJson.success === false) {
      // 同时校验 HTTP 状态与业务 success 字段，避免 success:false 被当作成功静默跳过
      const msg = upJson.errors?.[0]?.message;
      throw new KernelError(
        "share.assetUploadFailed",
        undefined,
        `HTTP ${upRes.status}${msg ? ` ${msg}` : ""}`,
      );
    }
    uploadedBytes += content.byteLength;
    onProgress?.({
      phase: "uploading",
      percent:
        totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 100,
      loaded: uploadedBytes,
      total: totalBytes,
    });
  }

  // 4.5 上传后 upsert hashes（把 hash 注册到项目，部署时 manifest 才能引用；wrangler 同款）
  // 失败不致命（仅影响下次部署去重），警告后继续
  try {
    const upsertRes = await fetch(`${CF_API_BASE}/pages/assets/upsert-hashes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ hashes }),
    });
    if (!upsertRes.ok) {
      console.warn(
        `[cloudflare] upsert-hashes failed: HTTP ${upsertRes.status}（仅影响下次部署去重）`,
      );
    }
  } catch (e) {
    console.warn(
      `[cloudflare] upsert-hashes 异常: ${e instanceof Error ? e.message : String(e)}`,
    );
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
    throw new KernelError(
      "share.cloudflareApiFailed",
      undefined,
      json.errors?.[0]?.message ?? `HTTP ${res.status}`,
    );
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
    const dep = (await cfApi(
      token,
      `/accounts/${accountId}/pages/projects/${projectName}/deployments/${deploymentId}`,
    )) as { latest_stage?: { name?: string; status?: string } };
    const stage = dep.latest_stage;
    if (stage?.name === "deploy" && stage.status === "success") return;
    if (stage?.status === "failure")
      throw new KernelError("share.deployFailed", { channel: "Cloudflare" });
  }
  throw new KernelError("share.deployTimeout", { channel: "Cloudflare" });
}

/** 用 API Token 自动获取 Account ID（用户无需手动填写）
 *  GET /client/v4/accounts 返回当前 token 可访问的账号列表，取第一个。 */
export async function getCloudflareAccountId(token: string): Promise<string> {
  const accounts = await cfApi<{ id: string }[]>(token, `/accounts?per_page=5`);
  if (!accounts?.length)
    throw new KernelError("share.cloudflareAccountEmpty");
  return accounts[0].id;
}

export async function deployToCloudflare(
  opts: CloudflareShareOptions,
): Promise<CloudflareDeployResult> {
  const { token, files } = opts;
  if (!token) throw new KernelError("share.tokenMissing");
  // Account ID 可通过接口获取：未配置时用 token 自动拉取，用户无需手动填写
  const accountId = opts.accountId || (await getCloudflareAccountId(token));
  const projectName = opts.projectName ?? CF_SHARE_PROJECT_NAME;
  const branch = opts.branch ?? "main";

  const project = await getOrCreateProject(token, accountId, projectName);
  opts.onProgress?.({ phase: "uploading", percent: 0, loaded: 0, total: 0 });
  const manifest = await uploadFiles(
    token,
    accountId,
    projectName,
    files,
    opts.onProgress,
  );
  opts.onProgress?.({ phase: "deploying" });
  const deployment = await createDeployment(
    token,
    accountId,
    projectName,
    manifest,
    branch,
  );
  await pollDeployment(
    token,
    accountId,
    projectName,
    deployment.id,
    opts.pollIntervalMs,
  );
  return {
    projectName,
    projectId: project.id,
    // 用项目真实 pages.dev 子域（全局唯一，同名项目在不同账号子域可能不同），不硬编码 projectName
    url: `https://${project.subdomain}`,
    deploymentId: deployment.id,
    deploymentUrl: deployment.url,
  };
}
