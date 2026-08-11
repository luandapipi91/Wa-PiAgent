/**
 * fs 域「打开外部浏览器 URL」端点测试
 *
 * 覆盖：
 * - resolveOpenUrlCommand 纯函数：三平台命令选择（win32/darwin/linux）
 * - POST /api/fs/open-url 端点：参数校验（400）与成功路径（spawn 被调用）
 *
 * spawn 用 mock.module 替换，避免测试真打开系统浏览器。
 */
import { test, expect, mock, describe, beforeEach } from "bun:test";
import { HttpRouter } from "../src/http-router";

const spawnCalls: { cmd: string; args: string[]; opts?: unknown }[] = [];
const spawnMock = mock((cmd: string, args: string[], opts?: unknown) => {
	spawnCalls.push({ cmd, args, opts });
	return {} as any;
});

// 必须在 import fs.ts 之前替换 node:child_process，让 fs.ts 顶层 import 拿到 mock；
// 保留真实模块其余导出（如 spawnSync），只覆盖 spawn
mock.module("node:child_process", async () => {
	const actual = await import("node:child_process");
	return { ...actual, spawn: spawnMock };
});

const { registerFsRoutes, resolveOpenUrlCommand } = await import(
	"../src/routes/fs"
);

function makeRouter(): HttpRouter {
	const router = new HttpRouter();
	registerFsRoutes(router, (async () => new Response("{}")) as any, {
		projectStore: null as any,
	});
	return router;
}

async function post(router: HttpRouter, url: string, body?: unknown): Promise<Response> {
	const res = await router.handle(
		new Request(`http://test.local${url}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	if (!res) throw new Error(`路由未匹配: POST ${url}`);
	return res;
}

beforeEach(() => {
	spawnCalls.length = 0;
});

describe("resolveOpenUrlCommand", () => {
	test("win32 用 cmd /d /c start（shell 内建，命令参数化避免注入）", () => {
		const r = resolveOpenUrlCommand("https://pi.dev/packages", "win32");
		expect(r.cmd).toBe("cmd");
		expect(r.args).toEqual(["/d", "/c", "start", "", "https://pi.dev/packages"]);
	});

	test("darwin 用 open", () => {
		const r = resolveOpenUrlCommand("https://pi.dev/packages", "darwin");
		expect(r).toEqual({ cmd: "open", args: ["https://pi.dev/packages"] });
	});

	test("linux 及其他平台用 xdg-open", () => {
		const r = resolveOpenUrlCommand("https://pi.dev/packages", "linux");
		expect(r).toEqual({ cmd: "xdg-open", args: ["https://pi.dev/packages"] });
	});
});

describe("POST /api/fs/open-url", () => {
	test("合法 http 链接：spawn 默认浏览器并返回 fs:open-url", async () => {
		const router = makeRouter();
		const res = await post(router, "/api/fs/open-url", {
			url: "https://pi.dev/packages",
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			type: "fs:open-url",
			url: "https://pi.dev/packages",
		});
		// spawn 被调用（cmd 随平台而定，参数里带 URL）
		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0].args.join(" ")).toContain("https://pi.dev/packages");
	});

	test("缺少 url 返回 400", async () => {
		const router = makeRouter();
		const res = await post(router, "/api/fs/open-url", {});
		expect(res.status).toBe(400);
		expect(spawnCalls.length).toBe(0);
	});

	test("url 非字符串返回 400", async () => {
		const router = makeRouter();
		const res = await post(router, "/api/fs/open-url", { url: 123 });
		expect(res.status).toBe(400);
		expect(spawnCalls.length).toBe(0);
	});

	test("非 http/https 协议（file://、javascript:）返回 400", async () => {
		const router = makeRouter();
		for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "ftp://x"]) {
			const res = await post(router, "/api/fs/open-url", { url: bad });
			expect(res.status).toBe(400);
		}
		expect(spawnCalls.length).toBe(0);
	});
});
