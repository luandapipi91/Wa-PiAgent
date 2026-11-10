/**
 * 内置知识库域路由（任务 10）
 *
 * 8 条 REST 端点映射到 knowledge:* WS 事件，经 callApi 复用 ws-server.handle() 业务逻辑
 * （与 routes/memory.ts 同款模式）。索引进度不经 HTTP 响应体——runIndex 的进度经
 * KbContext.sse 直接广播 SSE（knowledge:progress），前端按 kbId 过滤渲染。
 */
import type { RouteRegistrar } from "./types";
import { readJsonBody } from "./types";

export const registerKnowledgeRoutes: RouteRegistrar = (r, callApi) => {
  // 列出登记库（含每库实时 progress，读 indexing_jobs）
  r.add("GET", "/api/knowledge", async () => callApi({ type: "knowledge:list" }));
  // 首次扫描预览（临时夹具目录也可用——只扫不建库）
  r.add("POST", "/api/knowledge/preview", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "knowledge:preview", folderPath: b.folderPath });
  });
  // 创建并触发索引（异步 void runIndex，不阻塞响应；进度走 SSE）
  r.add("POST", "/api/knowledge", async (req) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "knowledge:create",
      folderPath: b.folderPath,
      name: b.name,
      description: b.description,
      // 预览计划令牌：仅用于回报「预览后目录有变化」，不阻断创建
      planToken: b.planToken,
    });
  });
  // 深度重排（rerank）开关：GET 状态、PUT 开关（开启后由 kernel 后台下载模型）、POST 重试下载
  r.add("GET", "/api/knowledge/rerank", async () => callApi({ type: "knowledge:rerank" }));
  r.add("PUT", "/api/knowledge/rerank", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "knowledge:rerank:save", enabled: b.enabled === true });
  });
  r.add("POST", "/api/knowledge/rerank/retry", async () =>
    callApi({ type: "knowledge:rerank:retry" }),
  );
  // 单库诊断 / 全库体检（医生报告）
  r.add("GET", "/api/knowledge/doctor", async () => callApi({ type: "knowledge:doctor" }));
  r.add("GET", "/api/knowledge/:id/health", async (_req, p) =>
    callApi({ type: "knowledge:health", kbId: p.id }),
  );

  // 手动重索引
  r.add("POST", "/api/knowledge/:id/index", async (_req, p) =>
    callApi({ type: "knowledge:index", kbId: p.id }),
  );
  // 取消进行中的索引
  r.add("POST", "/api/knowledge/:id/cancel", async (_req, p) =>
    callApi({ type: "knowledge:cancel", kbId: p.id }),
  );
  // 删除登记库并级联清理（job 行 + 每库 db 文件 + 悬挂绑定清理）
  r.add("DELETE", "/api/knowledge/:id", async (_req, p) =>
    callApi({ type: "knowledge:delete", kbId: p.id }),
  );
  // 更新名称/描述/autoWatch
  r.add("PUT", "/api/knowledge/:id", async (req, p) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "knowledge:update",
      kbId: p.id,
      name: b.name,
      description: b.description,
      autoWatch: b.autoWatch,
    });
  });
  // 最近一轮索引的失败文件清单
  r.add("GET", "/api/knowledge/:id/failed", async (_req, p) =>
    callApi({ type: "knowledge:failed", kbId: p.id }),
  );
};
