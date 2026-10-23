import { test, expect } from "bun:test";
import { HttpRouter } from "../src/http-router";
import { registerAgentRoutes } from "../src/routes/agents";

/** 假 callApi：记录事件，按类型返回假响应 */
function fakeCallApi(impl: (event: any) => any) {
  const calls: any[] = [];
  const fn = async (event: any) => {
    calls.push(event);
    const r = impl(event);
    return Response.json(r.body, { status: r.status ?? 200 });
  };
  return { fn, calls };
}

test("GET /api/agents/presets 翻译为 agent:presets 事件", async () => {
  const { fn, calls } = fakeCallApi(() => ({ body: { type: "agent:presets", presets: [] } }));
  const router = new HttpRouter();
  registerAgentRoutes(router, fn as any, {} as any);
  const res = await router.handle(new Request("http://x/api/agents/presets"));
  expect(calls[0]).toEqual({ type: "agent:presets" });
  expect(res).not.toBeNull();
  expect((await res!.json()).presets).toEqual([]);
});

test("POST /api/agents/from-preset 翻译为 agent:create-from-preset 事件", async () => {
  const { fn, calls } = fakeCallApi(() => ({ body: { type: "agent:created", agent: {} } }));
  const router = new HttpRouter();
  registerAgentRoutes(router, fn as any, {} as any);
  const res = await router.handle(
    new Request("http://x/api/agents/from-preset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "engineering-code-reviewer", displayName: "林晓岚" }),
    }),
  );
  expect(calls[0]).toEqual({
    type: "agent:create-from-preset",
    id: "engineering-code-reviewer",
    displayName: "林晓岚",
  });
  expect(res!.status).toBe(200);
});

test("POST /api/agents/from-preset 错误状态码透传（409）", async () => {
  const { fn } = fakeCallApi(() => ({ body: { error: "名称已被占用: 林晓岚" }, status: 409 }));
  const router = new HttpRouter();
  registerAgentRoutes(router, fn as any, {} as any);
  const res = await router.handle(
    new Request("http://x/api/agents/from-preset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x", displayName: "林晓岚" }),
    }),
  );
  expect(res!.status).toBe(409);
});

test("GET /api/agents/presets/:id 翻译为 agent:preset:get 事件", async () => {
  const { fn, calls } = fakeCallApi(() => ({ body: { type: "agent:preset", preset: {} } }));
  const router = new HttpRouter();
  registerAgentRoutes(router, fn as any, {} as any);
  const res = await router.handle(new Request("http://x/api/agents/presets/engineering-code-reviewer"));
  expect(calls[0]).toEqual({ type: "agent:preset:get", id: "engineering-code-reviewer" });
  expect(res!.status).toBe(200);
});

test("GET /api/agents/presets/:id 未知 id 透传 404", async () => {
  const { fn } = fakeCallApi(() => ({ body: { error: "预设不存在: x" }, status: 404 }));
  const router = new HttpRouter();
  registerAgentRoutes(router, fn as any, {} as any);
  const res = await router.handle(new Request("http://x/api/agents/presets/not-exist"));
  expect(res!.status).toBe(404);
});
