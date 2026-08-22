/**
 * TDD 红灯：扩展操作（install/uninstall/upgrade/toggle）成功后应广播 skill:changed。
 *
 * 当前实现只调用了 markAllDirty()，未重新扫描技能也未广播 skill:changed，
 * 导致前端技能面板不实时刷新。本测试先验证缺失行为（预期失败），
 * 绿灯阶段补齐 scanSkillsWithExtensions() + broadcast("skill:changed")。
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
// helpers
// ---------------------------------------------------------------------------

function tmp(s: string) {
	return join(
		import.meta.dir,
		`.tmp-esr-${s}${Math.random().toString(36).slice(2)}`,
	);
}

/** 构造一个总是成功的 ExtensionManager 桩 */
function stubExtensionManager(packages: PackageInfo[] = []) {
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
 *  后续 broadcast skill:changed 时 bus.clients 仍为空，事件被永久丢弃
 *  （SSE 无缓冲、无重放），导致测试随机超时失败。 */
async function connectSse(
	base: string,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
	// 注：此前这里对本地请求加 connection: close 规避 Bun fetch 连接池同 host 多 server
	// 错误复用连接（SSE/POST 被路由到先前测试的 server）；该 bug 已在 bun 1.4 修复，已移除。
	const res = await fetch(`${base}/api/events`);
	if (!res.ok || !res.body) throw new Error(`SSE 连接失败: ${res.status}`);
	const reader = res.body.getReader();
	// 首读触发 stream.start → bus.add(write)，确保后续广播能送达本连接
	await reader.read();
	return reader;
}

/**
 * SSE 收集器：连接后由 pump 持续把帧推入数组，查询方只轮询数组。
 * 解决历史 flaky：waitForSseEvent 用 Promise.race 包 reader.read()，超时后 read 仍
 * 挂起（悬空读），且事件可能在 race 超时返回 null 后才到达 → 永久丢帧 → 随机超时失败。
 * pump 模式下 reader 始终在后台消费，事件一到立即入数组，查询永不丢帧。
 */
async function collectSse(
	base: string,
): Promise<{
	wait: (type: string, timeoutMs?: number) => Promise<Record<string, unknown> | null>;
}> {
	const reader = await connectSse(base);
	const frames: (Record<string, unknown> & { type: string })[] = [];
	const pump = (async () => {
		try {
			for (;;) frames.push(await readSseFrame(reader));
		} catch {
			/* 流关闭：静默 */
		}
	})();
	return {
		async wait(type: string, timeoutMs = 3000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const f = frames.find((x) => x.type === type);
				if (f) return f;
				await new Promise((r) => setTimeout(r, 20));
			}
			return null;
		},
	};
}

/**
 * SSE 事件可能因 Bun 流调度偶发丢失（历史 flaky，见文件头注释）：
 * 扩展操作（install/uninstall/upgrade/toggle）幂等，超时后重试触发再等，
 * 广播会在每次操作后重新发生，显著降低偶发丢帧导致的随机失败。
 */
async function waitEventWithRetry(
	trigger: () => Promise<void>,
	sse: { wait: (type: string, timeoutMs?: number) => Promise<Record<string, unknown> | null> },
	type: string,
	attempts = 3,
): Promise<Record<string, unknown> | null> {
	for (let i = 0; i < attempts; i++) {
		await trigger();
		const evt = await sse.wait(type, 4000);
		if (evt) return evt;
	}
	return null;
}

/** 从 SSE reader 读取一帧 JSON data */
async function readSseFrame(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ type: string } & Record<string, unknown>> {
	const dec = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) throw new Error("SSE 流已关闭");
		buffer += dec.decode(value, { stream: true });
		let idx = buffer.indexOf("\n\n");
		while (idx !== -1) {
			const raw = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			if (raw.trim().startsWith(":")) {
				idx = buffer.indexOf("\n\n");
				continue; // 心跳/注释帧
			}
			const line = raw.split("\n").find((l) => l.startsWith("data:"));
			if (line) return JSON.parse(line.slice(5).trim());
			idx = buffer.indexOf("\n\n");
		}
	}
}

// ---------------------------------------------------------------------------
// setup / teardown
// ---------------------------------------------------------------------------

async function setup() {
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
	const extManager = stubExtensionManager(extPackages) as any;

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
		agentManager,
		channelManager: null,
		port: 0,
	});
	await server.start();
	const base = `http://127.0.0.1:${server.actualPort}`;

	return {
		base,
		scanCalls: () => scanCalls,
		cleanup: async () => {
			await server.stop();
			rmSync(cfgDir, { recursive: true, force: true });
			rmSync(projFile, { force: true });
		},
	};
}

// ---------------------------------------------------------------------------
// 红灯测试：当前实现缺少 skill:changed 广播，这些测试应失败
// ---------------------------------------------------------------------------

test("extension:install 成功后应广播 skill:changed", async () => {
	const ctx = await setup();
	const sse = await collectSse(ctx.base);
	try {
		// 触发安装 + 断言：应收到 skill:changed 事件（SSE 偶发丢帧时重试触发）
		const evt = await waitEventWithRetry(
			() =>
				fetch(`${ctx.base}/api/extensions/install`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "test-plugin" }),
				}).then(() => {}),
			sse,
			"skill:changed",
		);
		expect(evt).not.toBeNull();
	} finally {
		await ctx.cleanup();
	}
}, 15_000); // SSE 等待 10s > bun 默认 5s 单测超时，显式加长

test("extension:uninstall 成功后应广播 skill:changed", async () => {
	const ctx = await setup();
	const sse = await collectSse(ctx.base);
	try {
		const evt = await waitEventWithRetry(
			() =>
				fetch(`${ctx.base}/api/extensions/uninstall`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "test-plugin" }),
				}).then(() => {}),
			sse,
			"skill:changed",
		);
		expect(evt).not.toBeNull();
	} finally {
		await ctx.cleanup();
	}
}, 15_000); // bun 默认 5s 单测超时 < SSE 等待 10s，显式加长（否则负载下必超时）

test("extension:upgrade 成功后应广播 skill:changed", async () => {
	const ctx = await setup();
	const sse = await collectSse(ctx.base);
	try {
		const evt = await waitEventWithRetry(
			() =>
				fetch(`${ctx.base}/api/extensions/upgrade`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "test-plugin" }),
				}).then(() => {}),
			sse,
			"skill:changed",
		);
		expect(evt).not.toBeNull();
	} finally {
		await ctx.cleanup();
	}
}, 15_000); // SSE 等待 10s > bun 默认 5s 单测超时，显式加长

test("extension:toggle 成功后应广播 skill:changed", async () => {
	const ctx = await setup();
	const sse = await collectSse(ctx.base);
	try {
		const evt = await waitEventWithRetry(
			() =>
				fetch(`${ctx.base}/api/extensions/toggle`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "test-plugin", enabled: false }),
				}).then(() => {}),
			sse,
			"skill:changed",
		);
		expect(evt).not.toBeNull();
	} finally {
		await ctx.cleanup();
	}
}, 15_000); // SSE 等待 10s > bun 默认 5s 单测超时，显式加长

test("扩展操作成功后 scanSkillsWithExtensions 应被调用（间接验证：skillManager.scan 调用次数递增）", async () => {
	const ctx = await setup();
	try {
		const before = ctx.scanCalls();

		await fetch(`${ctx.base}/api/extensions/install`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "test-plugin" }),
		});

		// 安装成功后 scan 应至少多调用 1 次
		expect(ctx.scanCalls()).toBeGreaterThan(before);
	} finally {
		await ctx.cleanup();
	}
});
