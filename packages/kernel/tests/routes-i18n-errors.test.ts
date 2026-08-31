/**
 * routes 层 HTTP 错误结构化测试（任务 4 i18n）
 *
 * 契约：非 2xx 响应体为 { error: 旧文案兜底, failure: { code, params?, detail? } }，
 * 新前端按 failure.code 查 kernelMsg 字典渲染，error 字段保留给老渲染路径。
 * 参数校验发生在 callApi 适配之前，故 callApi 用永不调用的 stub。
 */
import { describe, test, expect } from "bun:test";
import { HttpRouter } from "../src/http-router";
import { registerFsRoutes } from "../src/routes/fs";
import { registerFileRoutes } from "../src/routes/files";
import { registerSkillRoutes } from "../src/routes/skills";
import { registerExtensionRoutes } from "../src/routes/extensions";

/** 永不该被调用的 callApi stub（参数校验失败时请求到此为止） */
const callApiNever: Parameters<typeof registerFsRoutes>[1] = async () => {
	throw new Error("参数校验失败时应直接返回 400，不应到达 callApi");
};
const ctxStub: Parameters<typeof registerFsRoutes>[2] = {
	projectStore: {} as any,
};

/** 断言响应体的 error 兜底存在 + failure.code 等于期望值 */
async function expectFailure(
	res: Response,
	status: number,
	code: string,
	params?: Record<string, unknown>,
): Promise<void> {
	expect(res.status).toBe(status);
	const body = (await res.json()) as {
		error?: string;
		failure?: { code?: string; params?: Record<string, unknown> };
	};
	expect(body.error).toBeTruthy(); // 旧渲染兜底字段保留
	expect(body.failure?.code).toBe(code);
	if (params) expect(body.failure?.params).toMatchObject(params);
}

describe("fs 路由参数校验", () => {
	test("list-dir 缺 path → common.missingParam", async () => {
		const r = new HttpRouter();
		registerFsRoutes(r, callApiNever, ctxStub);
		const res = await r.handle(
			new Request("http://x/api/fs/list-dir", {
				method: "POST",
				body: JSON.stringify({}),
			}),
		);
		await expectFailure(res!, 400, "common.missingParam", { name: "path" });
	});

	test("stat 缺 path → common.missingParam", async () => {
		const r = new HttpRouter();
		registerFsRoutes(r, callApiNever, ctxStub);
		const res = await r.handle(
			new Request("http://x/api/fs/stat", {
				method: "POST",
				body: JSON.stringify({}),
			}),
		);
		await expectFailure(res!, 400, "common.missingParam", { name: "path" });
	});
});

describe("files 路由参数校验", () => {
	test("upload 缺 projectId → common.missingParam", async () => {
		const r = new HttpRouter();
		registerFileRoutes(r, callApiNever, ctxStub);
		const res = await r.handle(
			new Request("http://x/api/files/upload", { method: "POST" }),
		);
		await expectFailure(res!, 400, "common.missingParam", {
			name: "projectId",
		});
	});

	test("recording/append 缺参 → common.missingParam", async () => {
		const r = new HttpRouter();
		registerFileRoutes(r, callApiNever, ctxStub);
		const res = await r.handle(
			new Request("http://x/api/files/recording/append", {
				method: "POST",
				body: JSON.stringify({}),
			}),
		);
		await expectFailure(res!, 400, "common.missingParam");
	});
});

describe("skills 路由参数校验", () => {
	test("toggle 缺参 → common.missingParam", async () => {
		const r = new HttpRouter();
		registerSkillRoutes(r, callApiNever, ctxStub);
		const res = await r.handle(
			new Request("http://x/api/skills/toggle", {
				method: "POST",
				body: JSON.stringify({ name: "a" }),
			}),
		);
		await expectFailure(res!, 400, "common.missingParam");
	});
});

describe("extensions 路由参数校验", () => {
	test("commands/toggle 缺参 → common.missingParam", async () => {
		const r = new HttpRouter();
		registerExtensionRoutes(r, callApiNever, ctxStub);
		const res = await r.handle(
			new Request("http://x/api/extensions/commands/toggle", {
				method: "POST",
				body: JSON.stringify({}),
			}),
		);
		await expectFailure(res!, 400, "common.missingParam");
	});

	test("dialog/respond 缺 requestId → common.missingParam", async () => {
		const r = new HttpRouter();
		registerExtensionRoutes(r, callApiNever, ctxStub);
		const res = await r.handle(
			new Request("http://x/api/extensions/dialog/respond", {
				method: "POST",
				body: JSON.stringify({}),
			}),
		);
		await expectFailure(res!, 400, "common.missingParam", {
			name: "requestId",
		});
	});
});
