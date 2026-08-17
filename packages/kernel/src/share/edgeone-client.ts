// EdgeOne REST 客户端（产物分享用）：纯 REST + API Token 注入，无 CLI/浏览器登录。
// 从 POC（~/poc-edgeone-share/poc-share.mjs）移植的可单测纯函数。
import COS from "cos-nodejs-sdk-v5";
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { hashPaths } from "./pack";
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
  return requery?.Data?.Response?.Projects?.[0]?.ProjectId;
}

/** 取项目的预设域名（PresetDomain，兜底用项目名） */
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
  return p?.PresetDomain ?? p?.Name ?? "";
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

export interface DeployShareOptions {
  token: string;
  paths: string[];
  baseDir: string;
  zip?: Uint8Array;
  isZip: boolean;
  channel?: string;
  /** 测试注入：替代 new COS(...) 构造真实客户端 */
  cosFactory?: (creds: {
    SecretId: string;
    SecretKey: string;
    Token: string;
  }) => CosClient;
  /** 部署状态轮询间隔（ms）。测试可传小值让单测秒级完成；缺省 5000 */
  pollIntervalMs?: number;
}

export interface DeployShareResult {
  url: string;
  projectName: string;
  projectId: string;
  expiresAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 分享总入口：探测端点 → 建/取项目 → 拿 COS 临时凭证 → 上传（zip/单文件）
 * → 创建部署 → 轮询至非 Process → 拼分享 URL。
 * 可单测：EdgeOne API 走全局 fetch，COS 客户端经 cosFactory 注入 fake。
 */
export async function deployShare(
  opts: DeployShareOptions,
): Promise<DeployShareResult> {
  const { token, paths, zip, isZip } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const projectName = `share-${hashPaths(paths)}`;
  const baseUrl = await detectBaseUrl(token);
  const projectId = await getOrCreateProject(baseUrl, token, projectName);

  // 1) COS 临时上传凭证
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

  // 2) 上传 zip 或单文件到目标路径
  const targetPath = resp.TargetPath;
  if (isZip) {
    await new Promise<void>((res, rej) =>
      cos.putObject(
        {
          Bucket: resp.Bucket,
          Region: resp.Region,
          Key: `${targetPath}/bundle.zip`,
          Body: Buffer.from(zip!),
          ContentLength: zip!.byteLength,
        },
        (e) => (e ? rej(e) : res()),
      ),
    );
  } else {
    const single = paths[0];
    const name = basename(single);
    const data = readFileSync(single);
    await new Promise<void>((res, rej) =>
      cos.putObject(
        {
          Bucket: resp.Bucket,
          Region: resp.Region,
          Key: `${targetPath}/${name}`,
          Body: data,
        },
        (e) => (e ? rej(e) : res()),
      ),
    );
  }

  // 3) 创建部署
  const dep = await apiCall<any>(baseUrl, token, "CreatePagesDeployment", {
    ProjectId: projectId,
    ViaMeta: "Upload",
    Provider: "Upload",
    Env: "Production",
    DistType: isZip ? "Zip" : "Folder",
    TempBucketPath: targetPath,
  });
  const deploymentId = dep.Data.Response.DeploymentId;

  // 4) 轮询部署状态至终态（每 pollIntervalMs，最多 40 次）
  //    终态必须为 Success，Failed/Error 等失败终态一律抛错，不返回失败链接
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

  // 5) 项目域名 + encipher 分享链接
  const domain = await getPresetDomain(baseUrl, token, projectId);
  const url = await encipherUrl(baseUrl, token, domain);
  return {
    url,
    projectName,
    projectId,
    expiresAt: Date.now() + 3 * 3600_000,
  };
}

// 分享总入口 deployShare（上传/部署/轮询，复用 POC 的 COS 逻辑）已在本文件实现。
// 本文件同时落地可单测纯函数（detectBaseUrl/getOrCreateProject/getPresetDomain/encipherUrl/apiCall）。
