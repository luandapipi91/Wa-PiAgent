import { test, expect } from "bun:test";
import { HttpRouter } from "../src/http-router";
import { registerVersionHistoryRoutes } from "../src/routes/version-history";

test("GET /api/version-history 翻译为 version-history:get 事件", async () => {
	const calls: any[] = [];
	const callApi = (async (event: any) => {
		calls.push(event);
		return Response.json({
			type: "version-history:get",
			history: [{ version: "0.6.10", date: "2026-09-24", sections: { 修复: ["a"] } }],
			source: "remote",
		});
	}) as any;
	const router = new HttpRouter();
	registerVersionHistoryRoutes(router, callApi, {} as any);
	const res = await router.handle(new Request("http://x/api/version-history"));
	expect(calls[0]).toEqual({ type: "version-history:get" });
	expect(res).not.toBeNull();
	const body = await res!.json();
	expect(body.source).toBe("remote");
	expect(body.history[0].version).toBe("0.6.10");
});

test("线上不可用时透传空数组 + source=unavailable，不 500", async () => {
	const calls: any[] = [];
	const callApi = (async (event: any) => {
		calls.push(event);
		return Response.json({
			type: "version-history:get",
			history: [],
			source: "unavailable",
		});
	}) as any;
	const router = new HttpRouter();
	registerVersionHistoryRoutes(router, callApi, {} as any);
	const res = await router.handle(new Request("http://x/api/version-history"));
	expect(calls[0]).toEqual({ type: "version-history:get" });
	expect(res).not.toBeNull();
	expect(res!.status).toBe(200);
	const body = await res!.json();
	expect(body.history).toEqual([]);
	expect(body.source).toBe("unavailable");
});
