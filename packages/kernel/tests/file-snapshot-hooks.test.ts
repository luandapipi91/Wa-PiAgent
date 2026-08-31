import { test, expect, afterAll } from "bun:test";
import { writeFileSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 集成测试：验证扩展三个钩子（tool_call / tool_execution_end / agent_end）
// 的真实链路——从工具事件到 POST /bridge/file-changes 的 body。
// 临时文件放在 tests/ 目录（与 bridge.test.ts 一致），保证 typebox 等依赖可解析。

const tmpFiles: string[] = [];
afterAll(() => {
	for (const f of tmpFiles) rmSync(f, { force: true });
});

/** 加载扩展源码（连同依赖复制到 tests/ 临时文件），返回捕获到的 on 事件处理器。 */
async function loadExtensionHooks(): Promise<
	Record<string, ((...args: any[]) => any)[]>
> {
	const extFile = join(
		import.meta.dir,
		`.tmp-fsnapshot-ext-${Math.random().toString(36).slice(2)}.ts`,
	);
	const snapshotFile = join(import.meta.dir, "file-snapshot.ts");
	const schemasFile = join(import.meta.dir, "tool-schemas.ts");
	copyFileSync(
		join(import.meta.dir, "..", "src", "wa-pi-bridge.extension.ts"),
		extFile,
	);
	copyFileSync(
		join(import.meta.dir, "..", "src", "file-snapshot.ts"),
		snapshotFile,
	);
	copyFileSync(
		join(import.meta.dir, "..", "..", "shared", "src", "tool-schemas.ts"),
		schemasFile,
	);
	tmpFiles.push(extFile, snapshotFile, schemasFile);

	const mod = await import(pathToFileURL(extFile).href);
	const handlers: Record<string, ((...args: any[]) => any)[]> = {};
	mod.default({
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (...args: any[]) => any) => {
			(handlers[event] ??= []).push(handler);
		},
	});
	return handlers;
}

test("钩子链路：edit 事件 → agent_end 上报 before/after 快照", async () => {
	// 环境变量须在 import 扩展前设置（模块顶层读取）
	process.env.WA_PI_BRIDGE_URL = "http://127.0.0.1:9999";
	process.env.WA_PI_BRIDGE_TOKEN = "test-token";
	process.env.WA_PI_SESSION_ID = "s1";

	const handlers = await loadExtensionHooks();
	expect(handlers["tool_call"]?.length).toBe(1);
	expect(handlers["tool_execution_end"]?.length).toBe(1);
	expect(handlers["agent_end"]?.length).toBe(1);

	// 创建真实文件（绝对路径，避免 resolve 的相对路径歧义）
	const targetFile = join(import.meta.dir, `.tmp-fsnapshot-target-${Math.random().toString(36).slice(2)}.ts`);
	tmpFiles.push(targetFile);
	writeFileSync(targetFile, "const x = 1\n", "utf8");

	// mock 全局 fetch，捕获 POST body
	let postedBody: any = null;
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async (_url: any, init: any) => {
		postedBody = JSON.parse(init.body);
		return new Response("{}", { status: 200 });
	}) as any;

	try {
		// tool_call（执行前，只处理 edit/write）
		handlers["tool_call"][0]({
			toolName: "edit",
			toolCallId: "c1",
			input: { path: targetFile },
		});
		// 非 edit/write 事件应被忽略
		handlers["tool_call"][0]({
			toolName: "bash",
			toolCallId: "c2",
			input: { command: "rm -rf /" },
		});
		// 模拟 edit 执行后文件变化
		writeFileSync(targetFile, "const x = 2\n", "utf8");
		// tool_execution_end（执行后）
		handlers["tool_execution_end"][0]({ toolName: "edit", toolCallId: "c1" });
		// agent_end（汇总上报）
		await handlers["agent_end"][0]();

		expect(postedBody).not.toBeNull();
		expect(postedBody.token).toBe("test-token");
		expect(postedBody.sessionId).toBe("s1");
		expect(postedBody.files).toHaveLength(1);
		expect(postedBody.files[0].path).toBe(targetFile);
		expect(postedBody.files[0].before).toBe("const x = 1\n");
		expect(postedBody.files[0].after).toBe("const x = 2\n");
	} finally {
		globalThis.fetch = origFetch;
	}
});
