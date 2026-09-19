/**
 * 记忆 / 指令域路由（阶段二·去 WS 化）
 */
import type { MemoryKind, MemoryScope } from "@wa-pi/shared";
import type { RouteRegistrar, RouteContext } from "./types";
import { readJsonBody } from "./types";

/** since/until：毫秒时间戳；非法/非正数 → undefined */
function toMsParam(raw: string | null): number | undefined {
  const n = Number(raw ?? "");
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
/** offset：正整数；非法 → undefined（缺省 0 由 store 层兜底） */
function toOffsetParam(raw: string | null): number | undefined {
  const n = Number(raw ?? "");
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export const registerMemoryRoutes: RouteRegistrar = (
  r,
  callApi,
  ctx: RouteContext,
) => {
  // 列表：GET 无 body，projectId 走 query。带正整数 limit 即分页模式（memory:list:page）
  r.add("GET", "/api/memories", async (req) => {
    const q = new URL(req.url).searchParams;
    const limit = Number(q.get("limit") ?? "");
    if (Number.isInteger(limit) && limit > 0) {
      return callApi({
        type: "memory:list:page",
        scope: (q.get("scope") || "global") as MemoryScope,
        projectId: q.get("projectId") ?? undefined,
        tab: q.get("tab") === "archived" ? "archived" : "active",
        // MemoryListPageEvent.kind 不容空串：未传直接归一 undefined（分发层再兜底）
        kind: (q.get("kind") || undefined) as MemoryKind | undefined,
        since: toMsParam(q.get("since")),
        until: toMsParam(q.get("until")),
        offset: toOffsetParam(q.get("offset")),
        limit,
      });
    }
    return callApi({
      type: "memory:list",
      projectId: q.get("projectId") ?? "",
    });
  });
  r.add("POST", "/api/memories", async (req) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "memory:add",
      scope: b.scope,
      projectId: b.projectId,
      text: b.text,
    });
  });
  r.add("POST", "/api/memories/update", async (req) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "memory:update",
      projectId: b.projectId,
      entryId: b.entryId,
      text: b.text,
    });
  });
  r.add("POST", "/api/memories/archive", async (req) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "memory:archive",
      projectId: b.projectId,
      entryId: b.entryId,
    });
  });
  r.add("POST", "/api/memories/restore", async (req) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "memory:restore",
      projectId: b.projectId,
      entryId: b.entryId,
    });
  });
  // 彻底删除：entryId 含 "/"，客户端需整体 encodeURIComponent 后放入路径；projectId 走 query
  r.add("DELETE", "/api/memories/:id", async (req, p) => {
    const q = new URL(req.url).searchParams;
    return callApi({
      type: "memory:purge",
      projectId: q.get("projectId") ?? "",
      entryId: p.id,
    });
  });
  r.add("GET", "/api/instructions", async (req) => {
    const q = new URL(req.url).searchParams;
    return callApi({
      type: "instruction:list",
      projectId: q.get("projectId") ?? "",
    });
  });
  // 全文检索：BM25 + 时间衰减综合排序（spec §5）
  r.add("GET", "/api/memories/search", async (req) => {
    const q = new URL(req.url).searchParams;
    // 缺参回空串（分发处把空串归一为 undefined）；limit 非法/非正数回落到默认 10，
    // 否则 Number("abc") 会把 NaN 传下去，slice(0, NaN) 静默返回空结果
    const limit = Number(q.get("limit") ?? "");
    return callApi({
      type: "memory:search",
      query: q.get("q") ?? "",
      // query 参数是未校验字面量：非法取值原样下传，由 DAO 按该值过滤（零命中）
      scope: (q.get("scope") ?? "") as MemoryScope | "",
      kind: (q.get("kind") ?? "") as MemoryKind | "",
      projectId: q.get("projectId") ?? "",
      limit: Number.isInteger(limit) && limit > 0 ? limit : 10,
      includeArchived: q.get("includeArchived") === "true",
      archivedOnly: q.get("archivedOnly") === "true",
      since: toMsParam(q.get("since")),
      until: toMsParam(q.get("until")),
      offset: toOffsetParam(q.get("offset")),
    });
  });
  r.add("GET", "/api/memories/config", async () =>
    callApi({ type: "memory:config:get" }),
  );
  r.add("PUT", "/api/memories/config", async (req) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "memory:config:set",
      reviewEnabled: b.reviewEnabled,
      memoryPolicyStyle: b.memoryPolicyStyle,
    });
  });
};
