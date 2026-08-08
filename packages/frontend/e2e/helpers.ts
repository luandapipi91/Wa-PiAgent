// E2E 共享 REST 辅助函数（kernel 去 WS 化后的通信层）
//
// kernel 已不再提供 WebSocket 服务，前端/测试一律走 REST（/api/*）+ SSE（/api/events）。
// 这些 helper 在 Playwright worker 的 Node 侧直接 fetch kernel（不经 page.evaluate），
// 替代旧 spec 里「开 WS 发命令等广播应答」的模式：
// - 写操作成功返回 200 {ok:true} 或末个 reply JSON；{type:"error"} reply → 400 {error}
// - 旧 WS 的广播应答（project:created / provider:changed / skill:changed 等）在 REST 下
//   走 SSE 总线，HTTP 响应不携带 → 需要结果对象时轮询对应的 GET 列表端点
import { E2E_WS_PORT } from "../playwright.config";

const BASE = `http://127.0.0.1:${E2E_WS_PORT}`;

/** 底层 REST 调用：非 2xx 抛错（带服务端 error 字段），返回解析后的 body */
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`REST ${method} ${path} 失败(${res.status}): ${data?.error ?? JSON.stringify(data)}`);
  }
  return data as T;
}

/** 轮询直到 fn 返回真值（替代旧 WS 等广播应答），超时抛错。
 *  默认 10s：全量跑时前面用例遗留的假 provider 会话会拖慢 kernel 事件循环，
 *  5s 偶发不够（composer 文件附件用例的 createProject 曾因此超时） */
async function pollUntil<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 10_000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("pollUntil 超时");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 建项目（旧 WS project:create + 等 project:created）：POST 只回 {ok:true}，轮询列表拿项目对象。
 *  同名同目录已存在时（serial 用例重复确保项目存在）不报错，直接返回已建项目。 */
export async function createProject(name: string, cwd: string): Promise<any> {
  // projects.json 的读-改-写无锁：kernel 并发会话写入（发送 prompt 派生的 pi 子进程仍在异步写）
  // 可能覆盖刚建的项目（lost update）——POST 返回 200 但项目从列表消失，轮询永不命中。
  // 处理：轮询短超时不见 → 幂等重 POST（同名同目录已存在则容忍）→ 再轮询，最多 3 轮。
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await api("POST", "/api/projects", { name, cwd });
    } catch (e) {
      if (!String(e).includes("已存在")) throw e;
    }
    // 首轮短超时快速发现丢失，避免干等 10s；后续轮用完整超时等 kernel 事件循环平稳
    const found = await pollUntil(
      async () => {
        const data = await api("GET", "/api/projects");
        return data.projects?.find((p: any) => p.name === name && p.cwd === cwd);
      },
      attempt === 0 ? 3_000 : 10_000,
    ).catch(() => undefined);
    if (found) return found;
  }
  throw new Error(`createProject 失败: ${name} 重 POST 3 轮后仍未出现在项目列表`);
}

/** 预置模型供应商（旧 WS provider:save + 等 provider:changed：POST 返回时落盘已完成） */
export async function saveProvider(provider: object): Promise<void> {
  await api("POST", "/api/providers", { provider });
}

/** 清空全部模型供应商（onboarding 向导测试的前置条件）。
 *  DELETE /api/providers/:name 路由参数名虽叫 name，实现按 id 删除（provider:delete 的 id 字段）。 */
export async function deleteAllProviders(): Promise<void> {
  const data = await api("GET", "/api/providers");
  for (const p of (data.providers ?? []) as { id: string }[]) {
    await api("DELETE", `/api/providers/${encodeURIComponent(p.id)}`).catch(() => {});
  }
}

/** 新建智能体（旧 WS agent:create + 等 agent:created）：POST 直接回 agent:created reply */
export async function createAgent(displayName: string): Promise<any> {
  const res = await api("POST", "/api/agents", { displayName });
  return res.agent;
}

/** 清理用删除：忽略智能体不存在的报错，永不抛出 */
export async function deleteAgentQuiet(name: string): Promise<void> {
  try {
    await api("DELETE", `/api/agents/${encodeURIComponent(name)}`);
  } catch { /* 忽略 */ }
}

/** 读智能体配置（旧 WS agent:config:get + 等 agent:config） */
export async function getAgentConfig(agentName: string): Promise<any> {
  const res = await api("GET", `/api/agents/${encodeURIComponent(agentName)}/config`);
  return res.config;
}

/** 存智能体配置（旧 WS agent:config:save + 等 agent:list 广播：PUT 返回时保存与广播均已完成） */
export async function saveAgentConfig(agentName: string, config: object): Promise<void> {
  await api("PUT", `/api/agents/${encodeURIComponent(agentName)}/config`, { config });
}

/** 添加技能目录（旧 WS skillDir:add + 等 skill:changed：POST 返回时重扫已完成） */
export async function addSkillDir(path: string): Promise<void> {
  await api("POST", "/api/skills/dirs", { path });
}

/** 移除技能目录（旧 WS skillDir:remove） */
export async function removeSkillDir(path: string): Promise<void> {
  await api("DELETE", "/api/skills/dirs", { path });
}

/**
 * 经 prompt 建会话（旧 WS agent:prompt + 等 session:created，绕过真实 LLM 的用法）：
 * POST 返回时 session 记录已落盘（ensureStarted 的模型错误走 SSE 广播，不影响建会话），
 * 轮询 GET /api/projects 拿 session 对象。调用方自定 sessionId 以保证前后端一致。
 */
export async function createSessionViaPrompt(
  projectId: string,
  opts: { agentName: string; text: string; model?: string; sessionId?: string },
): Promise<any> {
  const sessionId = opts.sessionId ?? "s-e2e-" + Math.random().toString(36).slice(2);
  await api("POST", `/api/agents/${projectId}/${sessionId}/prompt`, {
    agentName: opts.agentName,
    text: opts.text,
    model: opts.model,
  });
  return pollUntil(async () => {
    const data = await api("GET", "/api/projects");
    return data.sessions?.find((s: any) => s.id === sessionId);
  });
}
