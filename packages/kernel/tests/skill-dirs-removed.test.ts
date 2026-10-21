/**
 * 技能目录增删接口下线后的 HTTP 契约测试（任务 2）
 *
 * 技能来源改为自动发现（项目 → 内置 → 扩展），POST/DELETE /api/skills/dirs 整体
 * 下线。用真实 HTTP 服务（Bun.serve + 真实 HttpRouter + registerSkillRoutes）验证
 * 两个方法都落到 404，并守护 GET /api/skills、POST /api/skills/toggle 未受影响。
 *
 * callApi 复刻 ws-server.callApi + handle() 对技能域事件的分派：端点仍存在时会返回
 * 200，否则「404」会因为 callApi 兜底而假绿，失去对下线行为的证明力。
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { HttpRouter } from "../src/http-router";
import { registerSkillRoutes } from "../src/routes/skills";
import type { WSClientEvent } from "@wa-pi/shared";

const EMPTY_SKILL_LIST = {
  type: "skill:list",
  skills: [],
  allSkills: [],
  dirs: [],
  disabledSkills: [],
  builtinDir: "/tmp/skills",
};

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  const router = new HttpRouter();
  const callApi = async (event: WSClientEvent): Promise<Response> => {
    // 事件名按字符串比较：skillDir:* 已从 WSClientEvent 联合中删除，而本用例要在
    // 「端点仍存在」时明确回 200，才能证明 404 来自路由下线而非兜底分支
    const type: string = (event as { type: string }).type;
    if (type === "skillDir:add" || type === "skillDir:remove") {
      return Response.json({ ok: true });
    }
    if (type === "skill:list" || type === "skill:toggle") {
      return Response.json(EMPTY_SKILL_LIST);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  registerSkillRoutes(router, callApi, { projectStore: null as any });

  server = Bun.serve({
    port: 0,
    idleTimeout: 255, // 与生产一致：放宽空闲断连
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) {
        const res = await router.handle(req);
        return res ?? Response.json({ error: "not_found" }, { status: 404 });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

test("POST /api/skills/dirs 已移除（404）", async () => {
  const res = await fetch(`${baseUrl}/api/skills/dirs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "/tmp/whatever" }),
  });
  expect(res.status).toBe(404);
});

test("DELETE /api/skills/dirs 已移除（404）", async () => {
  const res = await fetch(`${baseUrl}/api/skills/dirs`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "/tmp/whatever" }),
  });
  expect(res.status).toBe(404);
});

test("GET /api/skills 行为不变（200）", async () => {
  const res = await fetch(`${baseUrl}/api/skills`);
  expect(res.status).toBe(200);
});

test("POST /api/skills/toggle 行为不变（200）", async () => {
  const res = await fetch(`${baseUrl}/api/skills/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "my-skill", enabled: false }),
  });
  expect(res.status).toBe(200);
});
