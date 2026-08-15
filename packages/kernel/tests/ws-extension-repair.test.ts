/**
 * 任务 2（API 层 TDD）：extension:repair 事件链路。
 *
 * 前端 POST /api/extensions/repair → callApi({type:"extension:repair"}) →
 * ws-server case（ExtensionManager.repair）→ SSE 广播：
 *   - extension:repair:progress（经 reply，类型含 "progress" 由 callApi 自动广播）
 *   - extension:changed / extension:repair:done / skill:changed（显式 broadcast）
 *   - 失败时 extension:error（name=repair，fire-and-forget 语义，与 install 一致）
 *
 * 真实服务模式：WSServer 起真服务 port:0 + fetch 触发 + SSE 流读事件，
 * helpers 照抄 ws-extension-skill-refresh.test.ts。
 */
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { SkillManager } from "../src/skill-manager";
import { WSServer } from "../src/ws-server";
import type { PackageInfo } from "@wa-pi/shared";

// ---------------------------------------------------------------------------
// helpers（照抄 ws-extension-skill-refresh.test.ts，仅 repair 相关改动）
// ---------------------------------------------------------------------------

function tmp(s: string) {
	return join(
		import.meta.dir,
		".tmp-er-" + s + Math.random().toString(36).slice(2),
	);
}

/** 构造一个总是成功的 ExtensionManager 桩（repair 实现可注入，默认成功版） */
function stubExtensionManager(
	packages: PackageInfo[] = [],
	repairImpl?: (onProgress?: (line: string) => void) => Promise<void>,
) {
	return {
		install: async (
			_name: string,
			_onProgress?: (line: string) => void,
		): Promise<PackageInfo> => {
			const pkg: PackageInfo = {
				name: _name,
				source: "npm",
				version: "1.0.0",
				enabled: true,
			};
			packages.push(pkg);
			return pkg;
		},
		uninstall: async (_name: string) => {
			const idx = packages.findIndex((p) => p.name === _name);
			if (idx >= 0) packages.splice(idx, 1);
		},
		upgrade: async (
			_name: string,
			_onProgress?: (line: string) => void,
		): Promise<PackageInfo> => {
			return { name: _name, source: "npm", version: "2.0.0", enabled: true };
		},
		repair:
			repairImpl ??
			(async (onProgress?: (line: string) => void) => {
				onProgress?.("bun install 输出行");
			}),
		enable: async (_name: string) => {
			const pkg = packages.find((p) => p.name === _name);
			if (pkg) pkg.enabled = true;
		},
		disable: async (_name: string) => {
			const pkg = packages.find((p) => p.name === _name);
			if (pkg) pkg.enabled = false;
		},
		list: async () => ({ packages: [...packages] }),
		getEnabledExtensionSkillPaths: async () =>
			[] as { path: string; packageName: string }[],
	};
}

/** 连接 WSServer 的 SSE 端点，返回可逐帧消费的 reader。
 *  关键：必须消费掉首帧（": connected" 注释）后才能返回。
 *  ReadableStream 的 start 回调（把 write 注册到 SseBus）是惰性触发的——
 *  只有消费者开始读取时才会执行。若不在发请求前触发首读，
 *  后续 broadcast 时 bus.clients 仍为空，事件被永久丢弃
 *  （SSE 无缓冲、无重放），导致测试随机超时失败。 */
async function connectSse(
	base: string,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
	const res = await fetch(`${base}/api/events`);
	if (!res.ok || !res.body) throw new Error(`SSE 连接失败: ${res.status}`);
	const reader = res.body.getReader();
	// 首读触发 stream.start → bus.add(write)，确保后续广播能送达本连接
	await reader.read();
	return reader;
}

/** 每个 reader 的跨调用残留 buffer：一次 read 可能返回多帧，
 *  残留帧必须优先于新 read 被解析，否则会挂死等待新数据 */
const sseBuffers = new WeakMap<
	ReadableStreamDefaultReader<Uint8Array>,
	string
>();

/** 从 SSE reader 读取一帧 JSON data（先解析残留 buffer，无完整帧才 read） */
async function readSseFrame(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ type: string } & Record<string, unknown>> {
	const dec = new TextDecoder();
	let buffer = sseBuffers.get(reader) ?? "";
	for (;;) {
		// 1. 先解析 buffer 中已有的完整帧（上次 read 的残留，可能多帧）
		let idx: number;
		while ((idx = buffer.indexOf("\n\n")) !== -1) {
			const raw = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			if (raw.trim().startsWith(":")) continue; // 心跳/注释帧
			const line = raw.split("\n").find((l) => l.startsWith("data:"));
			if (!line) continue;
			sseBuffers.set(reader, buffer); // 未消费帧留给下次调用
			return JSON.parse(line.slice(5).trim());
		}
		sseBuffers.set(reader, buffer);
		// 2. buffer 无完整帧，才从流读取新数据
		const { value, done } = await reader.read();
		if (done) throw new Error("SSE 流已关闭");
		buffer += dec.decode(value, { stream: true });
	}
}

/** 在超时内从 SSE 流收集到匹配 type 的事件，超时返回 null */
async function waitForSseEvent(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	type: string,
	timeoutMs = 3000,
): Promise<Record<string, unknown> | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		// 用 Promise.race 实现超时
		const frame = await Promise.race([
			readSseFrame(reader),
			new Promise<null>((r) =>
				setTimeout(() => r(null), Math.max(0, deadline - Date.now())),
			),
		]);
		if (!frame) return null;
		if (frame.type === type) return frame;
	}
	return null;
}

// ---------------------------------------------------------------------------
// setup / teardown
// ---------------------------------------------------------------------------

async function setup(
	repairImpl?: (onProgress?: (line: string) => void) => Promise<void>,
) {
	const cfgDir = tmp("cfg");
	const projFile = tmp("proj.json");
	const skillsDir = join(projFile, "..", "skills");

	const configStore = new ConfigStore(cfgDir);
	const projectStore = new ProjectStore(projFile);
	const providerStore = {
		save: async () => {},
		load: async () => ({ providers: [] }),
	} as any;
	const skillManager = new SkillManager(skillsDir);

	const extPackages: PackageInfo[] = [];
	const extManager = stubExtensionManager(extPackages, repairImpl) as any;

	// 记录 skillManager.scan 被调用次数
	let scanCalls = 0;
	const origScan = skillManager.scan.bind(skillManager);
	skillManager.scan = async (...args: any[]) => {
		scanCalls++;
		return origScan(...args);
	};

	const agentManager = {
		markAllDirty: () => {},
		markSkillsDirty: () => {},
		ensureStarted: async () => ({}),
		prompt: async () => {},
		abort: async () => {},
		disposeSession: async () => {},
		disposeAll: async () => {},
		isSessionBusy: () => false,
		isSessionActive: () => false,
		getThinkingSince: () => null,
	} as any;

	const server = new WSServer({
		configStore,
		projectStore,
		providerStore,
		skillManager,
		extensionManager: extManager,
		memoryStore: null as any,
		mcpStore: null as any,
		channelManager: null,
		agentManager,
		port: 0,
	});
	await server.start();
	const base = `http://127.0.0.1:${server.actualPort}`;
	// 先建 SSE 连接再返回，确保后续 broadcast 能送达本连接
	const reader = await connectSse(base);

	return {
		base,
		reader,
		scanCalls: () => scanCalls,
		cleanup: async () => {
			await server.stop();
			rmSync(cfgDir, { recursive: true, force: true });
			rmSync(projFile, { force: true });
		},
	};
}

// ---------------------------------------------------------------------------
// 测试体
// ---------------------------------------------------------------------------

test("extension:repair 成功后广播 changed/repair:done/skill:changed，进度帧自动广播", async () => {
	const ctx = await setup();
	try {
		// 经 HTTP 路由触发（与前端真实链路一致）
		const res = await fetch(`${ctx.base}/api/extensions/repair`, { method: "POST" });
		expect(res.ok).toBe(true);

		const progress = await waitForSseEvent(ctx.reader, "extension:repair:progress");
		expect(progress?.message).toBe("bun install 输出行");
		const changed = await waitForSseEvent(ctx.reader, "extension:changed");
		expect(Array.isArray(changed?.packages)).toBe(true);
		expect(await waitForSseEvent(ctx.reader, "extension:repair:done")).not.toBeNull();
		expect(await waitForSseEvent(ctx.reader, "skill:changed")).not.toBeNull();
	} finally {
		await ctx.cleanup();
	}
});

test("extension:repair 失败广播 extension:error（name=repair）", async () => {
	// setup 接受注入 repair 实现（第二个用例抛错）——给 setup 加可选参数
	const ctx = await setup(async () => {
		throw new Error("删除 node_modules 失败：模拟");
	});
	try {
		const res = await fetch(`${ctx.base}/api/extensions/repair`, { method: "POST" });
		// fire-and-forget 语义：业务错误经 SSE 广播而非 HTTP 错误码（与 install 一致）
		expect(res.ok).toBe(true);

		const err = await waitForSseEvent(ctx.reader, "extension:error");
		expect(err?.name).toBe("repair");
		expect(String(err?.error)).toContain("删除 node_modules 失败");
	} finally {
		await ctx.cleanup();
	}
});
