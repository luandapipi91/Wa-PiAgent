// EdgeOne REST 客户端（产物分享用）：纯 REST + API Token 注入，无 CLI/浏览器登录。
// 从 POC（~/poc-edgeone-share/poc-share.mjs）移植的可单测纯函数。
export const API_ENDPOINTS = {
  china: "https://pages-api.cloud.tencent.com/v1",
  global: "https://pages-api.edgeone.ai/v1",
};

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
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
  if (json.Code !== 0) throw new Error(`[${action}] Code ${json.Code}: ${json.Message}`);
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

// 分享总入口 deployShare（上传/部署/轮询，复用 POC 的 COS 逻辑）在任务 5 实现，
// 本文件只落地可单测纯函数（detectBaseUrl/getOrCreateProject/getPresetDomain/encipherUrl/apiCall）。
