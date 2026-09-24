// tui-host 端点集成测试（真实 HTTP）：
// - POST /bridge/tui-host/frames（流式请求体 NDJSON：首行鉴权 + 后续帧）
// - POST /bridge/tui-host/subscribe（流式响应 NDJSON：kernel 回推输入）
// - POST /api/extensions/tui-input（前端输入入口）
//
// 启动方式：进程内起真实 WSServer（端口 0）+ mock agentManager（只需 getSessionMeta
// 提供 sdk:event 信封上下文），与 tests/file-changes-endpoint.test.ts 同款。
// 简报的「spawn desktop-server + 读 kernel.json 取 token」不可行：kernel.json 只含
// {port,pid,startedAt}（src/index.ts:393），bridge token 是进程内 getBridgeToken()
// 惰性生成的 uuid——token 直接从这里取，HTTP 层与生产同一份实现。
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WSServer, type WSServerOpts } from "../src/ws-server";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { getBridgeToken } from "../src/bridge-registry";
import { tuiHostRegistry } from "../src/tui-host-registry";
// 真实的 pi 侧客户端（扩展进程里用的就是这两个）：验证上行/下行协议握手在两侧代码间真的对得上
import {
	connectInputChannel,
	createFrameSink,
	createFrameStream,
	type TuiHostInputEvent,
} from "../src/tui-host/host.ts";
import { openSse, readSseFrame } from "./helpers/http-api-kit";

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "tui-host-routes-"));
});
afterEach(() => {
	// 单例注册表是跨用例共享的：清掉本文件的会话，避免状态泄漏到下一个用例
	tuiHostRegistry.clearSession("s1");
	rmSync(tmpDir, { recursive: true, force: true });
});

const rand = () => join(tmpDir, "x-" + Math.random().toString(36).slice(2));

async function start(extraOpts: Partial<WSServerOpts> = {}) {
	const server = new WSServer({
		configStore: new ConfigStore(rand()),
		projectStore: new ProjectStore(rand() + ".json"),
		providerStore: new ProviderStore(rand() + ".json"),
		skillManager: new SkillManager(rand()),
		extensionManager: new ExtensionManager(rand()),
		memoryStore: null as any,
		mcpStore: null as any,
		dataDir: rand(),
		agentManager: {
			disposeAll: async () => {},
			getSessionMeta: (sid: string) =>
				sid === "s1"
					? { projectId: "p1", agentName: "default" as const }
					: undefined,
		} as any,
		channelManager: null,
		port: 0,
		...extraOpts,
	});
	await server.start();
	return { server, base: `http://127.0.0.1:${server.actualPort}` };
}

const jsonPost = (
	base: string,
	path: string,
	body: unknown,
	init: RequestInit = {},
) =>
	fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		...init,
	});

/**
 * 按行读 NDJSON 响应（跨 read 保留半行缓冲）。
 * 默认跳过 ping 行：订阅流会周期性发心跳保活，扩展侧（host.ts 的 handleInput）收到即丢。
 */
function ndjsonReader(
	body: ReadableStream<Uint8Array>,
	opts: { skipPing?: boolean } = {},
) {
	const skipPing = opts.skipPing ?? true;
	const reader = body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	return {
		async next(): Promise<string> {
			for (;;) {
				const nl = buf.indexOf("\n");
				if (nl >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (!line.trim()) continue;
					if (skipPing && (JSON.parse(line) as { type?: string }).type === "ping")
						continue;
					return line;
				}
				const { value, done } = await reader.read();
				if (done) throw new Error("流已关闭");
				buf += dec.decode(value, { stream: true });
			}
		},
	};
}

/** 读 SSE 直到拿到 sdk:event 帧（跳过内核 5s 一次的 heartbeat 帧） */
async function readSdkEvent(
	sse: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{
	type: string;
	projectId: string;
	sessionId: string;
	agentName: string;
	event: Record<string, unknown>;
}> {
	// 高负载下真实 pi 出首帧慢（心跳帧 5s 一发，10 帧 ≈ 50s 可能全是心跳），
	// 放宽到 40 帧；整体仍有用例级 60s 超时兜底
	for (let i = 0; i < 40; i++) {
		const frame = await readSseFrame(sse);
		if (frame.data?.type === "sdk:event") return frame.data;
	}
	throw new Error("未收到 sdk:event 帧（40 帧内）");
}

/**
 * 打开帧流：首行鉴权随流建立立即写出，之后用返回的 write 推帧；
 * body 保持开启（扩展的长连接语义：流结束才返回响应）。
 */
function openFrameStream(base: string, head: Record<string, unknown>) {
	const enc = new TextEncoder();
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			ctrl = c;
			c.enqueue(enc.encode(JSON.stringify(head) + "\n"));
		},
	});
	const resP = fetch(`${base}/bridge/tui-host/frames`, {
		method: "POST",
		headers: { "content-type": "application/x-ndjson" },
		body,
		// 流式请求体的规范要求（DOM 类型未收录），与扩展侧 host.ts 同款
		duplex: "half",
	} as RequestInit);
	return {
		resP,
		write: (frame: unknown) =>
			ctrl.enqueue(enc.encode(JSON.stringify(frame) + "\n")),
		close: () => ctrl.close(),
	};
}

test("frames 端点：无效 token → 401（完整 JSON body 也能识别，不要求整行 JSON 有换行）", async () => {
	const { server, base } = await start();
	try {
		const res = await jsonPost(base, "/bridge/tui-host/frames", {
			token: "wrong",
			sessionId: "s-unknown",
		});
		expect(res.status).toBe(401);
	} finally {
		await server.stop();
	}
});

test("frames/bridge 端点：非 POST → 405", async () => {
	const { server, base } = await start();
	try {
		expect((await fetch(`${base}/bridge/tui-host/frames`)).status).toBe(405);
		expect((await fetch(`${base}/bridge/tui-host/subscribe`)).status).toBe(405);
	} finally {
		await server.stop();
	}
});

test("subscribe 端点：无效 token → 401；缺 sessionId → 400", async () => {
	const { server, base } = await start();
	try {
		expect(
			(
				await jsonPost(base, "/bridge/tui-host/subscribe", {
					token: "wrong",
					sessionId: "s1",
				})
			).status,
		).toBe(401);
		expect(
			(
				await jsonPost(base, "/bridge/tui-host/subscribe", {
					token: getBridgeToken(),
				})
			).status,
		).toBe(400);
	} finally {
		await server.stop();
	}
});

test("tui-input 缺参数时返回参数错误（400）", async () => {
	const { server, base } = await start();
	try {
		const res = await jsonPost(base, "/api/extensions/tui-input", {});
		expect(res.status).toBe(400);
		expect((await res.json()).failure?.code).toBe("common.missingParam");
	} finally {
		await server.stop();
	}
});

test("tui-snapshot：缺 sessionId → 400", async () => {
	const { server, base } = await start();
	try {
		const res = await fetch(`${base}/api/extensions/tui-snapshot`);
		expect(res.status).toBe(400);
		expect((await res.json()).failure?.code).toBe("common.missingParam");
	} finally {
		await server.stop();
	}
});

test("tui-snapshot：无面板的会话返回空结构（200，不是 404）", async () => {
	const { server, base } = await start();
	try {
		const res = await fetch(`${base}/api/extensions/tui-snapshot?sessionId=s2`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			type: "extension:tui:snapshot",
			panels: [],
		});
	} finally {
		await server.stop();
	}
});

// 补发端点（规格 §5.4）：会话切换/前端重连时前端拉取 registry 里缓存的元数据 + 最后一帧。
// 端点透传 registry 快照（含 widget 面板，它们的帧走 extension_widget 通道、由前端过滤），
// 因此这里种子数据里带一个 widget 面板。
test("tui-snapshot：返回会话面板元数据 + 最新缓存帧", async () => {
	const { server, base } = await start();
	try {
		tuiHostRegistry.applyFrame("s1", {
			type: "open",
			panelId: "p1",
			kind: "custom",
			title: "pi-goal-x · Confirm",
			cols: 85,
			rows: 24,
			pending: 1,
		});
		tuiHostRegistry.applyFrame("s1", {
			type: "frame",
			panelId: "p1",
			lines: ["a", "b"],
			cursor: { row: 1, col: 0 },
		});
		tuiHostRegistry.applyFrame("s1", {
			type: "open",
			panelId: "w:goal",
			kind: "widget",
			widgetKey: "goal",
			title: "goal",
			cols: 80,
			rows: 10,
			pending: 1,
			placement: "belowEditor",
		});

		const res = await fetch(`${base}/api/extensions/tui-snapshot?sessionId=s1`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.type).toBe("extension:tui:snapshot");
		expect(body.panels[0]).toEqual({
			panelId: "p1",
			kind: "custom",
			title: "pi-goal-x · Confirm",
			cols: 85,
			rows: 24,
			pending: 1,
			lastFrame: { lines: ["a", "b"], cursor: { row: 1, col: 0 } },
		});
		// widget 面板也在快照里（端点只透传；前端 store 自行过滤，见修正 B）
		expect(body.panels[1]).toMatchObject({
			panelId: "w:goal",
			kind: "widget",
			widgetKey: "goal",
		});

		// 尚未收到帧的面板：lastFrame 为 null（前端据此保持空白而非渲染旧内容）
		tuiHostRegistry.applyFrame("s1", {
			type: "open",
			panelId: "p2",
			kind: "custom",
			title: "T2",
		});
		const body2 = await (
			await fetch(`${base}/api/extensions/tui-snapshot?sessionId=s1`)
		).json();
		const p2 = body2.panels.find((p: { panelId?: string }) => p.panelId === "p2");
		expect(p2?.lastFrame).toBeNull();
	} finally {
		await server.stop();
	}
});

test("帧流：首行鉴权 + open/frame/close 落到注册表并广播 SSE（ping 心跳静默忽略）", async () => {
	const { server, base } = await start();
	const sse = await openSse(base);
	const { resP, write, close } = openFrameStream(base, {
		token: getBridgeToken(),
		sessionId: "s1",
	});
	try {
		await Bun.sleep(50); // 等首行被服务端读走
		write({
			type: "open",
			panelId: "p1",
			kind: "custom",
			title: "pi-goal-x · Confirm",
			cols: 85,
			rows: 24,
			pending: 1,
		});
		const opened = await readSdkEvent(sse);
		expect(opened).toMatchObject({
			type: "sdk:event",
			projectId: "p1",
			sessionId: "s1",
			agentName: "default",
		});
		expect(opened.event).toEqual({
			type: "extension_tui_open",
			panelId: "p1",
			kind: "custom",
			title: "pi-goal-x · Confirm",
			cols: 85,
			rows: 24,
			pending: 1,
		});

		// ping 在下一帧之前：心跳若被当成事件广播，下一读拿到的就不是 extension_tui_frame
		write({ type: "ping" });
		write({
			type: "frame",
			panelId: "p1",
			lines: ["a", "b"],
			cursor: { row: 1, col: 0 },
		});
		const framed = await readSdkEvent(sse);
		expect(framed.event).toEqual({
			type: "extension_tui_frame",
			panelId: "p1",
			lines: ["a", "b"],
			cursor: { row: 1, col: 0 },
		});
		expect(tuiHostRegistry.snapshot("s1")?.panels[0]?.lastFrame?.lines).toEqual([
			"a",
			"b",
		]);

		write({ type: "close", panelId: "p1", reason: "done" });
		const closed = await readSdkEvent(sse);
		expect(closed.event).toEqual({
			type: "extension_tui_close",
			panelId: "p1",
			reason: "done",
		});
		expect(tuiHostRegistry.snapshot("s1")?.panels).toHaveLength(0);

		// 流结束（扩展进程退出）后响应才回来：HTTP 状态 200
		close();
		expect((await resP).status).toBe(200);
	} finally {
		await sse.cancel().catch(() => {});
		await server.stop();
	}
});

test("帧流：读循环结束前不返回响应（提前返回会让扩展误判断连而重连）", async () => {
	const { server, base } = await start();
	const { resP, write, close } = openFrameStream(base, {
		token: getBridgeToken(),
		sessionId: "s1",
	});
	try {
		write({ type: "open", panelId: "p1", kind: "custom" });
		const raced = await Promise.race([
			resP.then(() => "resolved" as const),
			Bun.sleep(300).then(() => "pending" as const),
		]);
		expect(raced).toBe("pending");
		close();
		expect((await resP).status).toBe(200);
	} finally {
		await server.stop();
	}
});

test("帧流：widget 帧走既有 extension_widget 通道（widgetKey + placement），不占用面板浮窗", async () => {
	const { server, base } = await start();
	const sse = await openSse(base);
	const { resP, write, close } = openFrameStream(base, {
		token: getBridgeToken(),
		sessionId: "s1",
	});
	try {
		await Bun.sleep(50);
		write({
			type: "open",
			panelId: "w:goal",
			kind: "widget",
			widgetKey: "goal",
			title: "goal",
			cols: 80,
			rows: 10,
			pending: 1,
			placement: "belowEditor",
		});
		write({
			type: "frame",
			panelId: "w:goal",
			kind: "widget",
			widgetKey: "goal",
			lines: ["w1"],
		});
		const framed = await readSdkEvent(sse);
		expect(framed.event).toEqual({
			type: "extension_widget",
			widgetKey: "goal",
			widgetLines: ["w1"],
			widgetPlacement: "belowEditor",
		});
		expect(tuiHostRegistry.snapshot("s1")?.panels[0]?.panelId).toBe("w:goal");
		close();
		await resP;
	} finally {
		await sse.cancel().catch(() => {});
		await server.stop();
	}
});

test("订阅流：连接即写一行 ping（Bun 需有数据才发响应头，空流会让扩展的 fetch 挂住）", async () => {
	const { server, base } = await start();
	try {
		const sub = await jsonPost(base, "/bridge/tui-host/subscribe", {
			token: getBridgeToken(),
			sessionId: "s1",
		});
		expect(sub.status).toBe(200);
		const lines = ndjsonReader(sub.body!, { skipPing: false });
		expect(JSON.parse(await lines.next())).toEqual({ type: "ping" });
		await sub.body!.cancel().catch(() => {});
	} finally {
		await server.stop();
	}
});

test("输入链路：无订阅者时入队 → 订阅后立即补发；已连接时直推", async () => {
	const { server, base } = await start();
	try {
		// 1) 前端先输入（扩展的订阅流尚未建立）→ kernel 入队
		const posted = await jsonPost(base, "/api/extensions/tui-input", {
			sessionId: "s1",
			panelId: "p1",
			type: "key",
			data: "\u001b[A",
		});
		expect(posted.status).toBe(200);

		// 2) 扩展订阅 → 队列里的按键立即补发
		const sub = await jsonPost(base, "/bridge/tui-host/subscribe", {
			token: getBridgeToken(),
			sessionId: "s1",
		});
		expect(sub.status).toBe(200);
		expect(sub.headers.get("content-type")).toContain("application/x-ndjson");
		const lines = ndjsonReader(sub.body!);
		expect(JSON.parse(await lines.next())).toEqual({
			type: "key",
			panelId: "p1",
			data: "\u001b[A",
		});

		// 3) 已连接 → 直推（不必等重连）
		await jsonPost(base, "/api/extensions/tui-input", {
			sessionId: "s1",
			panelId: "p1",
			type: "resize",
			cols: 100,
			rows: 30,
		});
		expect(JSON.parse(await lines.next())).toEqual({
			type: "resize",
			panelId: "p1",
			cols: 100,
			rows: 30,
		});

		// 4) 鼠标也走同一条通道（回归锁定）：面板的点击靠它到达插件，
		//    点击回退（未实现 handleMouse 的对话框）只在 pi 侧生效，不另开接口
		const click = "\u001b[<0;8;3M\u001b[<0;8;3m";
		await jsonPost(base, "/api/extensions/tui-input", {
			sessionId: "s1",
			panelId: "p1",
			type: "mouse",
			data: click,
		});
		expect(JSON.parse(await lines.next())).toEqual({
			type: "mouse",
			panelId: "p1",
			data: click,
		});
		await sub.body!.cancel().catch(() => {});
	} finally {
		await server.stop();
	}
});

test("订阅流断开后输入回到排队（扩展重连补发，按键不丢）", async () => {
	const { server, base } = await start();
	try {
		const ctrl = new AbortController();
		const sub = await jsonPost(
			base,
			"/bridge/tui-host/subscribe",
			{ token: getBridgeToken(), sessionId: "s1" },
			{ signal: ctrl.signal },
		);
		const lines = ndjsonReader(sub.body!);
		await jsonPost(base, "/api/extensions/tui-input", {
			sessionId: "s1",
			panelId: "p1",
			type: "key",
			data: "a",
		});
		expect(JSON.parse(await lines.next()).data).toBe("a");

		// 断开订阅流：kernel 必须感知（stream cancel → detach），否则后续输入写向已死连接被丢掉
		ctrl.abort();
		await Bun.sleep(300);
		await jsonPost(base, "/api/extensions/tui-input", {
			sessionId: "s1",
			panelId: "p1",
			type: "paste",
			data: "b",
		});

		const sub2 = await jsonPost(base, "/bridge/tui-host/subscribe", {
			token: getBridgeToken(),
			sessionId: "s1",
		});
		expect(JSON.parse(await ndjsonReader(sub2.body!).next())).toEqual({
			type: "paste",
			panelId: "p1",
			data: "b",
		});
		await sub2.body!.cancel().catch(() => {});
	} finally {
		await server.stop();
	}
});

// 中文整串注入（第三层 API 集成验证）：前端一次 POST 的整串中文必须整体到达 pi 侧输入通道，
// 不能在 kernel 或协议层被拆成逐字符/逐字节——拆成多帧会把一次输入变成多次独立插入，
// 破坏 IME/粘贴语义（pi-tui 的 Input/Editor 按整串插入，见 tests/tui-host-ime-text.test.ts）。
// 这里用扩展进程实际跑的那份客户端（host.ts 的 connectInputChannel）收事件，与生产同源。
test("输入链路：中文整串不被拆分（POST tui-input → pi 输入通道收到整串）", async () => {
	const { server, base } = await start();
	const inputEvents: TuiHostInputEvent[] = [];
	const inputs = connectInputChannel({
		bridgeUrl: base,
		token: getBridgeToken(),
		sessionId: "s1",
		onEvent: (e) => inputEvents.push(e),
		retryMs: 20,
		log: () => {},
	});
	const waitFor = async (pred: () => boolean, ms = 3000) => {
		const deadline = Date.now() + ms;
		while (!pred() && Date.now() < deadline) await Bun.sleep(20);
	};
	try {
		inputs.start();
		// 订阅流一建立 kernel 就写首行 ping：收到即表示通道就绪
		await waitFor(() => inputEvents.length > 0);
		expect(inputEvents.map((e) => e.type)).toEqual(["ping"]);

		const res = await jsonPost(base, "/api/extensions/tui-input", {
			sessionId: "s1",
			panelId: "p1",
			type: "key",
			data: "你好世界",
		});
		expect(res.status).toBe(200);

		await waitFor(() => inputEvents.some((e) => e.type === "key"));
		const keys = inputEvents.filter((e) => e.type === "key");
		// 恰好一个事件：整串一次投递，而不是四个汉字四帧
		expect(keys).toHaveLength(1);
		expect(keys[0]).toEqual({ type: "key", panelId: "p1", data: "你好世界" });
	} finally {
		inputs.stop();
		await server.stop();
	}
});

// 两个方向都用扩展进程实际跑的那份客户端代码（host.ts）：这是本任务最关键的一条
// 端到端证据——首行鉴权、帧行格式、输入行格式、心跳容错在两侧代码间真的对得上。
test("真实扩展客户端（host.ts）↔ kernel：帧上行、输入下行全链路对齐", async () => {
	const { server, base } = await start();
	const sse = await openSse(base);
	const sink = createFrameSink();
	const inputEvents: TuiHostInputEvent[] = [];
	const frames = createFrameStream({
		bridgeUrl: base,
		token: getBridgeToken(),
		sessionId: "s1",
		sink,
		retryMs: 20,
		log: () => {},
	});
	const inputs = connectInputChannel({
		bridgeUrl: base,
		token: getBridgeToken(),
		sessionId: "s1",
		onEvent: (e) => inputEvents.push(e),
		retryMs: 20,
		log: () => {},
	});
	const waitFor = async (pred: () => boolean, ms = 3000) => {
		const deadline = Date.now() + ms;
		while (!pred() && Date.now() < deadline) await Bun.sleep(20);
	};
	try {
		frames.start();
		inputs.start();
		// 订阅流一建立 kernel 就写首行 ping：扩展侧收到即丢（host.ts 的 handleInput 无 panelId 即返回），
		// 也证明两侧握手完成（Bun 要有数据才发响应头，空流会让 fetch 挂住）
		await waitFor(() => inputEvents.length > 0);
		expect(inputEvents.map((e) => e.type)).toEqual(["ping"]);

		// 上行：扩展侧推 open + frame → kernel 注册表 + SSE
		sink.push({
			type: "open",
			panelId: "p1",
			kind: "custom",
			title: "扩展面板",
			cols: 85,
			rows: 24,
			pending: 1,
		});
		sink.push({
			type: "frame",
			panelId: "p1",
			lines: ["a"],
			cursor: { row: 0, col: 1 },
		});
		const opened = await readSdkEvent(sse);
		expect(opened.event).toMatchObject({
			type: "extension_tui_open",
			panelId: "p1",
			title: "扩展面板",
		});
		const framed = await readSdkEvent(sse);
		expect(framed.event).toEqual({
			type: "extension_tui_frame",
			panelId: "p1",
			lines: ["a"],
			cursor: { row: 0, col: 1 },
		});

		// 下行：前端输入 → kernel 入队 → 扩展的订阅流收到（真实 client 的解析结果）
		await jsonPost(base, "/api/extensions/tui-input", {
			sessionId: "s1",
			panelId: "p1",
			type: "key",
			data: "\u001b[A",
		});
		await waitFor(() => inputEvents.some((e) => e.type === "key"));
		expect(inputEvents.find((e) => e.type === "key")).toEqual({
			type: "key",
			panelId: "p1",
			data: "\u001b[A",
		});
	} finally {
		frames.stop();
		inputs.stop();
		await sse.cancel().catch(() => {});
		await server.stop();
	}
});
