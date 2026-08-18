// EdgeOne REST 客户端（产物分享用）：纯 REST + API Token 注入，无 CLI/浏览器登录。
// 从 POC（~/poc-edgeone-share/poc-share.mjs）移植的可单测纯函数。
import COS from "cos-nodejs-sdk-v5";
export const API_ENDPOINTS = {
  china: "https://pages-api.cloud.tencent.com/v1",
  global: "https://pages-api.edgeone.ai/v1",
};

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/** 遍历 china/global 两个端点，取第一个 Code===0 的可用端点 */
export async function detectBaseUrl(token: string): Promise<string> {
  for (const url of Object.values(API_ENDPOINTS)) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          Action: "DescribePagesProjects",
          PageNumber: 1,
          PageSize: 1,
        }),
      });
      const json = await res.json().catch(() => ({ Code: -1 }));
      if (json.Code === 0) return url;
    } catch {
      /* 尝试下一个端点 */
    }
  }
  throw new Error("EdgeOne API 端点均不可用：请检查 token 与网络");
}

/** 通用 API 调用：校验 HTTP 状态与业务 Code，返回完整 JSON */
export async function apiCall<T = any>(
  baseUrl: string,
  token: string,
  action: string,
  body: Record<string, any> = {},
): Promise<T> {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ Action: action, ...body }),
  });
  if (!res.ok) throw new Error(`[${action}] HTTP ${res.status}`);
  const json = await res.json();
  if (json.Code !== 0)
    throw new Error(`[${action}] Code ${json.Code}: ${json.Message}`);
  // Pages API 的另一套错误形态：顶层 Code=0，错误嵌在 Data.Response.Error
  // （如 CreatePagesProject 名称长度校验失败）。不拦截会静默流向下游，
  // 表现为 ProjectId/DeploymentId undefined → 轮询永不命中 → 部署超时。
  const nested = json?.Data?.Response?.Error;
  if (nested) throw new Error(`[${action}] ${nested.Code}: ${nested.Message}`);
  return json;
}

/** 按项目名查询；存在返回 ProjectId，不存在则创建后返回（重查兜底） */
export async function getOrCreateProject(
  baseUrl: string,
  token: string,
  projectName: string,
): Promise<string> {
  const list = await apiCall<any>(baseUrl, token, "DescribePagesProjects", {
    Filters: [{ Name: "Name", Values: [projectName] }],
    Offset: 0,
    Limit: 10,
  });
  const existing = list?.Data?.Response?.Projects ?? [];
  if (existing.length > 0) return existing[0].ProjectId;

  const created = await apiCall<any>(baseUrl, token, "CreatePagesProject", {
    Name: projectName,
    Provider: "Upload",
    Source: "mcp",
    Channel: "Custom",
    Area: "global",
  });
  const createdId = created?.Data?.Response?.ProjectId;
  if (createdId) return createdId;

  // 创建响应未回带 ProjectId 时，回查确认
  const requery = await apiCall<any>(baseUrl, token, "DescribePagesProjects", {
    Filters: [{ Name: "Name", Values: [projectName] }],
    Offset: 0,
    Limit: 10,
  });
  const requeryId = requery?.Data?.Response?.Projects?.[0]?.ProjectId;
  // 拿不到 ProjectId 必须抛错：静默返回 undefined 会让下游 COS 路径/部署
  // 全部带 undefined，最终表现为「部署超时」而不是真实原因
  if (!requeryId) throw new Error(`获取/创建 Pages 项目失败: ${projectName}`);
  return requeryId;
}

/** 取项目的预设域名（PresetDomain）。拿不到就抛错，不再静默降级用项目名 */
export async function getPresetDomain(
  baseUrl: string,
  token: string,
  projectId: string,
): Promise<string> {
  const res = await apiCall<any>(baseUrl, token, "DescribePagesProjects", {
    Filters: [{ Name: "ProjectId", Values: [projectId] }],
    Offset: 0,
    Limit: 10,
  });
  const p = res?.Data?.Response?.Projects?.[0];
  // PresetDomain 为空（如项目创建后尚未分配）时 Name 不是域名，拼不出可访问链接
  // → 直接抛错，让上层返回明确失败，而不是产出打不开的分享链接
  if (!p?.PresetDomain) throw new Error("无法获取项目域名");
  return p.PresetDomain;
}

/** 用 encipher token 拼接可分享 URL */
export async function encipherUrl(
  baseUrl: string,
  token: string,
  domain: string,
): Promise<string> {
  const res = await apiCall<any>(baseUrl, token, "DescribePagesEncipherToken", {
    Text: domain,
  });
  const { Token, Timestamp } = res.Data.Response;
  return `https://${domain}?eo_token=${Token}&eo_time=${Timestamp}`;
}

/** COS 客户端最小接口（putObject/uploadFiles），供 cosFactory 注入的 fake 实现 */
export type CosClient = Pick<COS, "putObject" | "uploadFiles">;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 固定分享项目名：所有分享共存于该项目的子路径，规避 40 个项目上限。
 * 注意 EdgeOne 项目名长度限制 5-63（"wapi" 4 字符会被 InvalidParameter.Security 拒绝） */
export const SHARE_PROJECT_NAME = "wapi-shares";

/** 规范化用户配置的自定义域名：去空白、去协议、去尾斜杠 */
export function normalizeDomain(input: string | undefined): string {
  return (input ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

export interface DeployWorkspaceOptions {
  token: string;
  /** 工作区整体 zip（workspace.buildDeployZip 产物） */
  zip: Uint8Array;
  /** 设置里的自定义域名（可选，优先于预设域名） */
  customDomain?: string;
  /** 进度回调：uploading（COS 真实百分比）→ deploying（EdgeOne 无百分比） */
  onProgress?: (p: {
    phase: "uploading" | "deploying";
    percent?: number;
    loaded?: number;
    total?: number;
  }) => void;
  /** 测试注入：替代 new COS(...) 构造真实客户端 */
  cosFactory?: (creds: {
    SecretId: string;
    SecretKey: string;
    Token: string;
  }) => CosClient;
  /** 部署状态轮询间隔（ms）。测试可传小值；缺省 5000 */
  pollIntervalMs?: number;
}

export interface DeployWorkspaceResult {
  /** 最终使用的域名（自定义优先，否则预设域名） */
  domain: string;
  /** 根链接（含 eo_token），各分享子路径由 itemShareUrl 拼接 */
  rootUrl: string;
  projectName: string;
  projectId: string;
  expiresAt: number;
}

/**
 * 部署工作区到固定项目：探测端点 → 建/取 wapi 项目 → COS 传 zip →
 * 创建部署 → 轮询终态 → 自定义/预设域名 → encipher 根链接。
 */
export async function deployWorkspace(
  opts: DeployWorkspaceOptions,
): Promise<DeployWorkspaceResult> {
  const { token, zip } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const baseUrl = await detectBaseUrl(token);
  const projectId = await getOrCreateProject(
    baseUrl,
    token,
    SHARE_PROJECT_NAME,
  );

  // COS 临时上传凭证
  const tokenRes = await apiCall<any>(
    baseUrl,
    token,
    "DescribePagesCosTempToken",
    {
      ProjectId: projectId,
    },
  );
  const resp = tokenRes.Data.Response;
  const cos = opts.cosFactory
    ? opts.cosFactory({
        SecretId: resp.Credentials.TmpSecretId,
        SecretKey: resp.Credentials.TmpSecretKey,
        Token: resp.Credentials.Token,
      })
    : new COS({
        SecretId: resp.Credentials.TmpSecretId,
        SecretKey: resp.Credentials.TmpSecretKey,
        SecurityToken: resp.Credentials.Token,
      });

  const zipKey = `${resp.TargetPath}/bundle.zip`;
  await new Promise<void>((res, rej) =>
    cos.putObject(
      {
        Bucket: resp.Bucket,
        Region: resp.Region,
        Key: zipKey,
        Body: Buffer.from(zip),
        ContentLength: zip.byteLength,
        // COS 的 percent 是 0-1 小数，换算成 0-100
        onProgress: (d: {
          loaded?: number;
          total?: number;
          percent?: number;
        }) =>
          opts.onProgress?.({
            phase: "uploading",
            percent: Math.round((d.percent ?? 0) * 100),
            loaded: d.loaded,
            total: d.total,
          }),
      },
      (e) => (e ? rej(e) : res()),
    ),
  );

  opts.onProgress?.({ phase: "deploying" });
  const dep = await apiCall<any>(baseUrl, token, "CreatePagesDeployment", {
    ProjectId: projectId,
    ViaMeta: "Upload",
    Provider: "Upload",
    Env: "Production",
    DistType: "Zip",
    // DistType=Zip 时 TempBucketPath 必须指向 zip 文件本身（只给目录会 Failed Code 26）
    TempBucketPath: zipKey,
  });
  const deploymentId = dep.Data.Response.DeploymentId;

  // 轮询部署状态至终态；终态必须为 Success
  let finalStatus: string | undefined;
  for (let i = 0; i < 40; i++) {
    await sleep(pollIntervalMs);
    const list = await apiCall<any>(
      baseUrl,
      token,
      "DescribePagesDeployments",
      {
        ProjectId: projectId,
        Offset: 0,
        Limit: 50,
        OrderBy: "CreatedOn",
        Order: "Desc",
      },
    );
    const d = (list?.Data?.Response?.Deployments ?? []).find(
      (x: any) => x.DeploymentId === deploymentId,
    );
    if (d) {
      finalStatus = d.Status;
      if (d.Status !== "Process") break;
    }
    if (i === 39) throw new Error("EdgeOne 部署超时");
  }
  if (finalStatus !== "Success")
    throw new Error(`EdgeOne 部署失败: ${finalStatus}`);

  const preset = await getPresetDomain(baseUrl, token, projectId);
  const domain = normalizeDomain(opts.customDomain) || preset;
  const rootUrl = await encipherUrl(baseUrl, token, domain);
  return {
    domain,
    rootUrl,
    projectName: SHARE_PROJECT_NAME,
    projectId,
    expiresAt: Date.now() + 3 * 3600_000,
  };
}

/** 拼单条分享链接：rootUrl（含 eo_token）+ 子路径；多文件条目指向目录（静态托管目录索引）。
 *  子路径用分享名（<name>/），与文件夹名穿透一致。 */
export function itemShareUrl(
  rootUrl: string,
  item: { id: string; name: string; files: string[] },
): string {
  let u: URL;
  try {
    u = new URL(rootUrl);
  } catch {
    // rootUrl 由内部 encipherUrl 生成，正常不会非法；异常时兜底避免裸抛
    throw new Error(`无法解析分享链接: ${rootUrl}`);
  }
  u.pathname =
    item.files.length === 1
      ? `/${item.name}/${item.files[0]}`
      : `/${item.name}/`;
  return u.toString();
}
