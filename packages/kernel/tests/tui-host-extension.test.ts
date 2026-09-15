// tui-host-extension.test.ts —— wa-pi-tui-host 扩展入口的会话重建（reload）回归测试
//
// 覆盖任务 9 审查的关键项 K1：pi 的 reload 先发 session_shutdown，再用**同一个 uiContext
// 对象**发 session_start（agent-session.js:2052-2075）。此时扩展必须换新 bridge 并重新接管
// ui，否则 ui.custom 仍指向已 disposeAll（不可逆）的旧 bridge → 所有 custom() 静默返回
// undefined、无帧无报错，而 wa-pi-bridge 的 notify+throw 兜底又因 __waPiTuiHost 继续让位。
//
// 手法：mock globalThis.fetch 充当 kernel（/frames 读流式 NDJSON 且连接结束才响应，
// /subscribe 返回可推送的输入流），注入 WA_PI_BRIDGE_* 后加载真实扩展入口。
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { splitNdjson } from "../src/tui-host/host.ts";

const ENV_KEYS = [
	"WA_PI_BRIDGE_URL",
	"WA_PI_BRIDGE_TOKEN",
	"WA_PI_SESSION_ID",
] as const;
const savedEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);
afterAll(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

type Handler = (event: unknown, ctx: unknown) => void;

/** 模拟 kernel：帧流读走 NDJSON 行（连接结束才回响应），输入流可被测试推送 */
function installKernelStub() {
	const encoder = new TextEncoder();
	const orig = globalThis.fetch;
	const frames: Record<string, unknown>[] = [];
	let rest = "";
	const finishes: Array<() => void> = [];
	let pushInput: ((line: string) => void) | null = null;

	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const target = String(url);
		if (target.endsWith("/bridge/tui-host/frames")) {
			const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			void (async () => {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					const chunk = splitNdjson(rest, decoder.decode(value, { stream: true }));
					rest = chunk.rest;
					for (const line of chunk.lines)
						frames.push(JSON.parse(line) as Record<string, unknown>);
				}
				for (const finish of finishes.splice(0, finishes.length)) finish();
			})();
			await new Promise<void>((resolve) => finishes.push(resolve));
			return new Response("");
		}
		if (target.endsWith("/bridge/tui-host/subscribe")) {
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
				},
			});
			pushInput = (line) => {
				try {
					controller.enqueue(encoder.encode(`${line}\n`));
				} catch {
					/* 流已关 */
				}
			};
			// 真实 fetch 在 abort 时会 reject 读取；模拟出来，否则旧连接永远不 settle
			init?.signal?.addEventListener("abort", () => {
				try {
					controller.error(new Error("aborted"));
				} catch {
					/* 已结束 */
				}
			});
			return new Response(body);
		}
		throw new Error(`未预期的请求：${target}`);
	}) as unknown as typeof fetch;

	return {
		frames,
		send: (event: Record<string, unknown>) => pushInput?.(JSON.stringify(event)),
		restore: () => {
			globalThis.fetch = orig;
		},
	};
}

/** 仿 rpc-mode 的 uiContext（reload 时 pi 复用的就是同一个对象） */
function makeUi() {
	const calls: string[] = [];
	const ui = {
		theme: undefined,
		custom: async (..._args: unknown[]) => {
			calls.push("orig-custom");
			return "orig";
		},
		setWidget: (key: string) => {
			calls.push(`setWidget:${key}`);
		},
		onTerminalInput: (_cb: (data: string) => void) => () => {},
	};
	return ui as typeof ui & Record<string, unknown>;
}

/** 可控测试组件：记录收到的按键 */
function makeComponent(label: string) {
	const keys: string[] = [];
	return {
		keys,
		component: {
			render: () => [label],
			invalidate: () => {},
			handleInput: (data: string) => {
				keys.push(data);
			},
		},
	};
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond() && Date.now() < deadline) await Bun.sleep(10);
}

const ENTRY = join(import.meta.dir, "..", "src", "wa-pi-tui-host.extension.ts");

describe("wa-pi-tui-host 扩展入口", () => {
	test("无 WA_PI_BRIDGE_* 环境变量时不接管（子代理环境）", async () => {
		for (const key of ENV_KEYS) delete process.env[key];
		const mod = await import(pathToFileURL(ENTRY).href);
		const handlers = new Map<string, Handler>();
		mod.default({
			on: (type: string, handler: Handler) => void handlers.set(type, handler),
		});
		expect(handlers.size).toBe(0);
	});

	test("reload（同一 ui 对象）后仍能接管：custom 照常出帧并结算", async () => {
		process.env.WA_PI_BRIDGE_URL = "http://kernel.test";
		process.env.WA_PI_BRIDGE_TOKEN = "tok";
		process.env.WA_PI_SESSION_ID = "s1";
		const kernel = installKernelStub();
		try {
			const mod = await import(pathToFileURL(ENTRY).href);
			const handlers = new Map<string, Handler>();
			mod.default({
				on: (type: string, handler: Handler) => void handlers.set(type, handler),
			});
			const sessionStart = handlers.get("session_start")!;
			const sessionShutdown = handlers.get("session_shutdown")!;
			const ui = makeUi();
			const ctx = { mode: "rpc", ui };

			// 第一个会话
			sessionStart({ reason: "startup" }, ctx);
			expect(ui.__waPiTuiHost).toBe(true);
			// 插件的 onTerminalInput 监听器：reload 后必须还在
			const pluginKeys: string[] = [];
			ui.onTerminalInput((data: string) => {
				pluginKeys.push(data);
			});
			const first = ui.custom(
				() => makeComponent("第一个会话").component,
				undefined,
				undefined,
			);
			await waitFor(() => kernel.frames.some((f) => f.type === "frame"));
			expect(kernel.frames.filter((f) => f.type === "open")).toHaveLength(1);

			// teardown（pi 的 reload 会先 shutdown 再用同一个 uiContext 对象 start）
			sessionShutdown({ reason: "reload" }, ctx);
			await expect(first).resolves.toBeUndefined();

			// reload：同一个 ui 对象 + 新 bridge 必须重新接管
			sessionStart({ reason: "reload" }, ctx);
			const probe = makeComponent("reload 后");
			const second = ui.custom(() => probe.component, undefined, undefined);
			await waitFor(
				() => kernel.frames.filter((f) => f.type === "open").length === 2,
			);
			const opens = kernel.frames.filter((f) => f.type === "open");
			expect(opens).toHaveLength(2);
			expect(opens.at(-1)?.panelId).toBe("p1"); // 新 bridge 的编号重新开始，说明确实是新 bridge
			// 会话销毁的 close 帧标 dispose（规格 §4.8：与用户取消是两条终止路径）。
			// 它会在 shutdown 时先入 sink 队列（disposeAll 的 settle 是微任务，此时帧流已 detach），
			// 下一个会话 attach 时按序补发——所以断言放在这里。
			expect(
				kernel.frames.some(
					(f) => f.type === "close" && f.panelId === "p1" && f.reason === "dispose",
				),
			).toBe(true);

			// 输入经订阅流回到新面板，并结算
			kernel.send({ type: "key", panelId: "p1", data: "\u001b[B" });
			await waitFor(() => probe.keys.length > 0);
			expect(probe.keys).toEqual(["\u001b[B"]);
			// reload 前注册的插件监听器仍然收到输入（监听器集合跨 patch 存续）
			expect(pluginKeys).toEqual(["\u001b[B"]);
			kernel.send({ type: "cancel", panelId: "p1" });
			await expect(second).resolves.toBeUndefined();
			await waitFor(() => kernel.frames.at(-1)?.type === "close");
			expect(kernel.frames.at(-1)?.reason).toBe("cancel");

			// 收尾：停流（不再有重连定时器残留）
			sessionShutdown({ reason: "quit" }, ctx);
		} finally {
			kernel.restore();
		}
	});
});
