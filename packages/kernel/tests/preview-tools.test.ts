// preview-tools.test.ts —— preview_open 工具（把网址/项目内 html 送到内置预览面板）
//
// 覆盖两层：
// 1) resolvePreviewTarget 纯函数：全部校验错误码 + url / local 两条成功分支；
// 2) createPreviewOpenTool.execute：成功时 broadcast 出正确的 preview:open 事件、
//    失败时不 broadcast、异常兜底转文本（绝不抛）。

import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createPreviewOpenTool,
	resolvePreviewTarget,
	type ResolvePreviewResult,
} from "../src/preview-tools";

// ── 临时目录：projectDir 为「项目内」，otherDir 为「项目外」──

const root = mkdtempSync(join(tmpdir(), "wa-pi-preview-tools-"));
const projectDir = join(root, "project");
const otherDir = join(root, "outside");
mkdirSync(projectDir, { recursive: true });
mkdirSync(otherDir, { recursive: true });

/** 项目内存在的 html 文件 */
const htmlPath = join(projectDir, "index.html");
writeFileSync(htmlPath, "<html><body>hi</body></html>", "utf8");
/** 项目外存在的 html 文件 */
const outsideHtml = join(otherDir, "outside.html");
writeFileSync(outsideHtml, "<html></html>", "utf8");
/** 项目内不存在的 html 文件（父目录存在 → 归属可判定） */
const missingHtml = join(projectDir, "missing.html");
/** 项目内的非 html 文件 */
const txtPath = join(projectDir, "note.txt");
writeFileSync(txtPath, "x", "utf8");

const selfOrigins = [
	"http://127.0.0.1:4173",
	"http://localhost:4173",
];
const opts = { projectCwds: [projectDir], selfOrigins };

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** 断言失败分支的错误码（并收窄类型） */
function expectError(r: ResolvePreviewResult, code: string): void {
	expect(r.ok).toBe(false);
	if (r.ok) return;
	expect(r.error).toBe(code);
	expect(r.message.length).toBeGreaterThan(0);
}

// ===== resolvePreviewTarget：目标缺失 / 冲突 =====

describe("resolvePreviewTarget：目标缺失 / 冲突", () => {
	test("url 与 path 都缺 → missing_target", () => {
		expectError(resolvePreviewTarget({}, opts), "missing_target");
	});

	test("空字符串视为缺失 → missing_target", () => {
		expectError(resolvePreviewTarget({ url: "", path: "" }, opts), "missing_target");
	});

	test("url 与 path 都给 → ambiguous_target", () => {
		expectError(
			resolvePreviewTarget({ url: "http://example.com", path: htmlPath }, opts),
			"ambiguous_target",
		);
	});
});

// ===== resolvePreviewTarget：url 分支 =====

describe("resolvePreviewTarget：url 分支", () => {
	test("http url → 成功，target.kind=url", () => {
		const r = resolvePreviewTarget({ url: "http://example.com/a/b?c=1" }, opts);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.target).toEqual({
			kind: "url",
			url: "http://example.com/a/b?c=1",
		});
	});

	test("https url → 成功", () => {
		const r = resolvePreviewTarget({ url: "https://example.com/" }, opts);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.target).toEqual({ kind: "url", url: "https://example.com/" });
	});

	test("前后空白被裁剪", () => {
		const r = resolvePreviewTarget({ url: "  http://example.com/  " }, opts);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.target).toEqual({ kind: "url", url: "http://example.com/" });
	});

	test("非 http/https 协议 → invalid_url", () => {
		expectError(resolvePreviewTarget({ url: "ftp://example.com" }, opts), "invalid_url");
	});

	test("无法解析的字符串 → invalid_url", () => {
		expectError(resolvePreviewTarget({ url: "not a url" }, opts), "invalid_url");
	});

	// 注：WHATWG URL 解析器对 http/https 保证 host 非空（"http:///x" 会解析为 host="x"，
	// 真正空 host 的输入一律 THROW），故实现里的 host 非空校验是防御性的、无法从外部触发。

	test("命中应用自身 origin（127.0.0.1）→ host_origin_forbidden", () => {
		const r = resolvePreviewTarget(
			{ url: "http://127.0.0.1:4173/index.html" },
			opts,
		);
		expectError(r, "host_origin_forbidden");
		if (r.ok) return;
		expect(r.message).toContain("不能打开应用自身地址");
	});

	test("命中应用自身 origin（localhost）→ host_origin_forbidden", () => {
		expectError(
			resolvePreviewTarget({ url: "http://localhost:4173/x" }, opts),
			"host_origin_forbidden",
		);
	});

	test("端口不同不视为自身 origin → 成功", () => {
		const r = resolvePreviewTarget({ url: "http://localhost:5173/" }, opts);
		expect(r.ok).toBe(true);
	});
});

// ===== resolvePreviewTarget：local path 分支 =====

describe("resolvePreviewTarget：local path 分支", () => {
	test("项目内存在的 .html → 成功，target.kind=local", () => {
		const r = resolvePreviewTarget({ path: htmlPath }, opts);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.target).toEqual({ kind: "local", path: htmlPath });
	});

	test("相对路径 → invalid_path", () => {
		expectError(resolvePreviewTarget({ path: "index.html" }, opts), "invalid_path");
	});

	test("非 .html/.htm 后缀 → invalid_path", () => {
		expectError(resolvePreviewTarget({ path: txtPath }, opts), "invalid_path");
	});

	test("项目外绝对路径 → path_forbidden", () => {
		expectError(resolvePreviewTarget({ path: outsideHtml }, opts), "path_forbidden");
	});

	test("项目内但文件不存在 → file_not_found", () => {
		expectError(resolvePreviewTarget({ path: missingHtml }, opts), "file_not_found");
	});
});

// ===== createPreviewOpenTool =====

/** fake projectStore：load() 返回单个项目 cwd */
function fakeProjectStore(cwd: string) {
	return {
		load: mock(async () => ({ projects: [{ id: "p1", cwd }], sessions: [] })),
	};
}

function makeTool(overrides?: {
	projectStore?: { load: () => Promise<any> };
	broadcast?: (e: any) => void;
}) {
	const broadcast: any = overrides?.broadcast ?? mock(() => {});
	const tool = createPreviewOpenTool({
		projectStore:
			overrides?.projectStore ?? (fakeProjectStore(projectDir) as any),
		selfOrigins: () => selfOrigins,
		broadcast,
	});
	return { tool, broadcast };
}

describe("createPreviewOpenTool：工具定义", () => {
	test("名称为 preview_open，参数含可选 url / path", () => {
		const { tool } = makeTool();
		expect(tool.name).toBe("preview_open");
		const props = (tool.inputSchema as any).properties;
		expect(props.url).toBeTruthy();
		expect(props.path).toBeTruthy();
		expect((tool.inputSchema as any).required ?? []).toEqual([]);
	});
});

describe("createPreviewOpenTool：execute", () => {
	test("url 成功 → broadcast preview:open（payload 形状正确）+ 文本带目标", async () => {
		const { tool, broadcast } = makeTool();
		const r = await tool.execute({ url: "http://example.com/demo" }, "sess-1");

		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(broadcast.mock.calls[0][0]).toEqual({
			type: "preview:open",
			sessionId: "sess-1",
			target: { kind: "url", url: "http://example.com/demo" },
		});
		expect((r.content[0] as { text: string }).text).toContain(
			"http://example.com/demo",
		);
		expect((r.content[0] as { text: string }).text).toContain("切回");
		expect(r.details).toEqual({
			ok: true,
			target: { kind: "url", url: "http://example.com/demo" },
		});
	});

	test("local 成功 → broadcast target.kind=local（path 原样透传）", async () => {
		const { tool, broadcast } = makeTool();
		const r = await tool.execute({ path: htmlPath }, "sess-2");

		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(broadcast.mock.calls[0][0]).toEqual({
			type: "preview:open",
			sessionId: "sess-2",
			target: { kind: "local", path: htmlPath },
		});
		expect((r.content[0] as { text: string }).text).toContain(htmlPath);
		expect(r.details).toEqual({
			ok: true,
			target: { kind: "local", path: htmlPath },
		});
	});

	test("校验失败 → 不 broadcast，返回错误文本 + details.error", async () => {
		const { tool, broadcast } = makeTool();
		const r = await tool.execute({}, "sess-3");

		expect(broadcast).not.toHaveBeenCalled();
		expect((r.content[0] as { text: string }).text).toContain("打开预览失败");
		expect((r.details as { error?: string }).error).toBe("missing_target");
	});

	test("项目外路径失败 → 不 broadcast，error=path_forbidden", async () => {
		const { tool, broadcast } = makeTool();
		const r = await tool.execute({ path: outsideHtml }, "sess-4");

		expect(broadcast).not.toHaveBeenCalled();
		expect((r.details as { error?: string }).error).toBe("path_forbidden");
	});

	test("projectStore.load 抛错 → 文本兜底，不抛，不 broadcast", async () => {
		const { tool, broadcast } = makeTool({
			projectStore: {
				load: mock(async () => {
					throw new Error("磁盘坏了");
				}),
			},
		});
		const r = await tool.execute({ url: "http://example.com" }, "sess-5");

		expect(broadcast).not.toHaveBeenCalled();
		expect((r.content[0] as { text: string }).text).toBe("打开预览失败：磁盘坏了");
		expect((r.details as { error?: string }).error).toBe("磁盘坏了");
	});

	test("broadcast 抛错 → 文本兜底，不抛给 pi", async () => {
		const { tool } = makeTool({
			broadcast: mock(() => {
				throw new Error("广播失败");
			}),
		});
		const r = await tool.execute({ url: "http://example.com" }, "sess-6");

		expect((r.content[0] as { text: string }).text).toBe("打开预览失败：广播失败");
		expect((r.details as { error?: string }).error).toBe("广播失败");
	});
});

// ===== AgentManager.handleTool 分发 preview_open =====

import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { fakeClientFactory } from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import { getBridgeSession } from "../src/bridge-registry";

describe("handleTool 分发 preview_open", () => {
	const tmpFiles: string[] = [];
	const managers: AgentManager[] = [];

	afterAll(async () => {
		for (const am of managers.splice(0)) {
			await am.disposeAll().catch(() => {});
		}
		for (const f of tmpFiles.splice(0)) rmSync(f, { force: true });
	});

	async function setupAgent(): Promise<{
		project: { id: string };
		session: { id: string };
		am: AgentManager;
	}> {
		const tmpFile = join(
			root,
			`projects-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
		);
		tmpFiles.push(tmpFile);
		const projectStore = new ProjectStore(tmpFile);
		const project = await projectStore.createProject({
			name: "测试",
			cwd: projectDir,
		});
		const session = await projectStore.createSession({
			projectId: project.id,
			primaryAgent: "dev",
			title: "测试",
		});
		const am = new AgentManager({
			projectStore,
			configStore: null as any,
			onEvent: () => {},
			createClientFn: fakeClientFactory([]) as any,
			browserManager: NOOP_BROWSER_MANAGER,
		});
		managers.push(am);
		return { project: project as { id: string }, session, am };
	}

	test("已接线 executor → 透传 sessionId/params，返回其结果", async () => {
		const calls: Array<{ sessionId: string; params: any }> = [];
		const { project, session, am } = await setupAgent();
		am.setPreviewOpenExecutor(async (sessionId, params) => {
			calls.push({ sessionId, params });
			return {
				content: [{ type: "text", text: "已在内置预览中打开 http://example.com" }],
				details: { ok: true },
			};
		});
		await am.ensureStarted(project.id, "dev", session.id);
		const ctx = getBridgeSession(session.id);
		expect(ctx).toBeTruthy();
		const result = await ctx!.handleTool(
			"preview_open",
			"tc-pv-1",
			{ url: "http://example.com" },
			new AbortController().signal,
		);
		expect(calls).toEqual([
			{ sessionId: session.id, params: { url: "http://example.com" } },
		]);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "已在内置预览中打开 http://example.com",
		});
	});

	test("未接线 executor → 返回「预览功能未就绪」+ details.error（不崩溃）", async () => {
		const { project, session, am } = await setupAgent();
		await am.ensureStarted(project.id, "dev", session.id);
		const ctx = getBridgeSession(session.id);
		const result = await ctx!.handleTool(
			"preview_open",
			"tc-pv-2",
			{ url: "http://example.com" },
			new AbortController().signal,
		);
		expect((result.content[0] as { text: string }).text).toContain("未就绪");
		expect((result.details as { error?: string }).error).toBeTruthy();
	});

	test("executor 抛错 → 返回失败文本（不向 pi 进程抛异常）", async () => {
		const { project, session, am } = await setupAgent();
		am.setPreviewOpenExecutor(async () => {
			throw new Error("预览广播失败");
		});
		await am.ensureStarted(project.id, "dev", session.id);
		const ctx = getBridgeSession(session.id);
		const result = await ctx!.handleTool(
			"preview_open",
			"tc-pv-3",
			{},
			new AbortController().signal,
		);
		expect((result.content[0] as { text: string }).text).toBe(
			"打开预览失败：预览广播失败",
		);
		expect((result.details as { error?: string }).error).toBe("预览广播失败");
	});
});

// ===== 端到端：真实 HTTP /bridge/tool → AgentManager → SSE /api/events =====
//
// 覆盖 kernel 侧完整链路（pi 侧扩展除外）：
//   真实 WSServer → /bridge/tool 路由 → bridge-registry 分发到 AgentManager 的
//   preview_open 分支 → createPreviewOpenTool → server.broadcast →
//   /api/events SSE 流收到 preview:open。
// createPreviewOpenTool / AgentManager 执行器接线方式与 index.ts 完全一致。

import { WSServer } from "../src/ws-server";
import { getBridgeToken, unregisterBridgeSession } from "../src/bridge-registry";
import { ConfigStore } from "../src/config-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";

/** 读取 SSE 流直到累积内容命中 needle（或超时）。 */
async function readSseUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	needle: string,
	timeoutMs = 5_000,
): Promise<string> {
	const dec = new TextDecoder();
	let buf = "";
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !buf.includes(needle)) {
		const chunk = await Promise.race([
			reader.read(),
			new Promise<null>((r) =>
				setTimeout(() => r(null), Math.min(deadline - Date.now(), 250)),
			),
		]);
		if (chunk === null) continue;
		if (chunk.done) break;
		if (chunk.value) buf += dec.decode(chunk.value, { stream: true });
	}
	return buf;
}

/** 从 SSE 原文解析出 data 帧（跳过首帧注释与不完整帧）。 */
function parseSseFrames(raw: string): any[] {
	const frames: any[] = [];
	for (const block of raw.split("\n\n")) {
		if (!block.startsWith("data: ")) continue;
		try {
			frames.push(JSON.parse(block.slice("data: ".length)));
		} catch {
			/* 不完整帧：跳过 */
		}
	}
	return frames;
}

describe("preview_open 端到端（真实 HTTP → AgentManager → SSE）", () => {
	test("POST /bridge/tool → 200 成功文本 + /api/events 收到 preview:open", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wa-pi-preview-e2e-"));
		let server: WSServer | undefined;
		let am: AgentManager | undefined;
		let sessionId = "";
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const projectStore = new ProjectStore(join(dir, "projects.json"));
			const project = await projectStore.createProject({
				name: "e2e",
				cwd: projectDir,
			});
			const session = await projectStore.createSession({
				projectId: project.id,
				primaryAgent: "dev",
				title: "e2e",
			});
			sessionId = session.id;

			am = new AgentManager({
				projectStore,
				configStore: null as any,
				onEvent: () => {},
				createClientFn: fakeClientFactory([]) as any,
				browserManager: NOOP_BROWSER_MANAGER,
			});
			// 与 index.ts 同款接线：broadcast 接到 server.broadcast
			const previewOpenTool = createPreviewOpenTool({
				projectStore,
				selfOrigins: () => [],
				broadcast: (e) => server!.broadcast(e),
			});
			am.setPreviewOpenExecutor((sid, params) =>
				previewOpenTool.execute(params, sid),
			);

			await am.ensureStarted(project.id, "dev", session.id);

			server = new WSServer({
				configStore: new ConfigStore(join(dir, "config.json")),
				projectStore,
				providerStore: new ProviderStore(join(dir, "providers.json")),
				skillManager: new SkillManager(join(dir, "skills")),
				extensionManager: new ExtensionManager(join(dir, "data")),
				memoryStore: null as any,
				mcpStore: null as any,
				dataDir: dir,
				agentManager: am,
				channelManager: null,
				port: 0,
			});
			await server.start();
			const port = server.actualPort;

			// 先连上真实 SSE 流，确保后续广播能被捕获
			const sseRes = await fetch(`http://127.0.0.1:${port}/api/events`);
			expect(sseRes.status).toBe(200);
			reader = sseRes.body!.getReader();

			const res = await fetch(`http://127.0.0.1:${port}/bridge/tool`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					token: getBridgeToken(),
					sessionId: session.id,
					toolCallId: "tc-e2e-1",
					tool: "preview_open",
					params: { url: "http://example.com/demo" },
				}),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as any;
			expect(body.content[0].text).toContain("http://example.com/demo");
			expect(body.content[0].text).toContain("切回");

			const raw = await readSseUntil(reader, "preview:open");
			await reader.cancel();
			reader = undefined;

			const evt = parseSseFrames(raw).find((f) => f.type === "preview:open");
			expect(evt, "SSE 应收到 preview:open 帧").toBeTruthy();
			expect(evt).toEqual({
				type: "preview:open",
				sessionId: session.id,
				target: { kind: "url", url: "http://example.com/demo" },
			});
		} finally {
			await reader?.cancel().catch(() => {});
			await server?.stop().catch(() => {});
			await am?.disposeAll().catch(() => {});
			unregisterBridgeSession(sessionId);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
