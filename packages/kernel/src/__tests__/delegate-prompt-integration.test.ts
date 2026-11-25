/**
 * prompt 委派字段透传集成测试
 *
 * 验证：POST /api/agents/:projectId/:sessionId/prompt 携带的
 * delegateModel / delegateThinking 经 routes/chat.ts 透传到 agent:prompt 事件；
 * 不携带时事件字段保持 undefined（透传层不得补默认值）。
 * 语义约定见 SessionHandle：undefined=不变更句柄记录，null=显式重置为跟随。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { HttpRouter } from "../http-router";
import type { RouteContext } from "../routes/types";

// callApi mock：捕获 agent:prompt 事件供断言（不需要真实 WS server）
let capturedEvent: any = null;
const mockCallApi = (async (event: any) => {
	capturedEvent = event;
	return Response.json({ ok: true });
}) as any;

async function setupRouter() {
	const { registerChatRoutes } = await import("../routes/chat");
	const router = new HttpRouter();
	// chat.ts 的 prompt 路由只做透传，不读 projectStore，ctx 传最小对象即可
	registerChatRoutes(router, mockCallApi, {} as RouteContext);
	return router;
}

async function postPrompt(body: Record<string, unknown>): Promise<Response | null> {
	const router = await setupRouter();
	const req = new Request("http://localhost/api/agents/p1/s1/prompt", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return router.handle(req);
}

describe("prompt delegate 字段透传", () => {
	beforeEach(() => {
		capturedEvent = null;
	});

	test("携带 delegateModel/delegateThinking → 事件透传两字段", async () => {
		const res = await postPrompt({
			agentName: "coder",
			text: "你好",
			model: "prov/m0",
			thinking: "default",
			delegateModel: "prov/m1",
			delegateThinking: "max",
		});
		expect(res).not.toBeNull();
		expect(res!.status).toBe(200);
		expect(capturedEvent.type).toBe("agent:prompt");
		expect(capturedEvent.delegateModel).toBe("prov/m1");
		expect(capturedEvent.delegateThinking).toBe("max");
	});

	test("不携带 delegate 字段 → 事件字段为 undefined（透传层不补默认值）", async () => {
		const res = await postPrompt({
			agentName: "coder",
			text: "你好",
			model: "prov/m0",
			thinking: "default",
		});
		expect(res).not.toBeNull();
		expect(res!.status).toBe(200);
		expect(capturedEvent.delegateModel).toBeUndefined();
		expect(capturedEvent.delegateThinking).toBeUndefined();
	});
});
