import { test, expect } from "bun:test";
import { HttpRouter } from "../src/http-router";
import { registerContactRoutes } from "../src/routes/contacts";
import type { WSClientEvent } from "@wa-pi/shared";

/** 起临时 HTTP 服务，捕获 callApi 收到的 event */
async function capture(path: string, init?: RequestInit) {
	const router = new HttpRouter();
	const calls: any[] = [];
	const callApi = async (e: WSClientEvent) => {
		calls.push(e);
		return Response.json({ ok: true });
	};
	registerContactRoutes(router, callApi as any, {} as any);
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => (await router.handle(req)) ?? new Response("nf", { status: 404 }),
	});
	try {
		await fetch(`http://localhost:${server.port}${path}`, {
			...init,
			headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
		});
	} finally {
		server.stop();
	}
	return calls[0];
}

test("GET /api/contacts 带 channelId → contacts:list", async () => {
	const e = await capture("/api/contacts?channelId=ch_abc");
	expect(e.type).toBe("contacts:list");
	expect(e.channelId).toBe("ch_abc");
});

test("PUT /api/contacts/:id → contacts:rename", async () => {
	const e = await capture("/api/contacts/ct_123", {
		method: "PUT",
		body: JSON.stringify({ remark: "张三" }),
	});
	expect(e.type).toBe("contacts:rename");
	expect(e.id).toBe("ct_123");
	expect(e.remark).toBe("张三");
});
