/**
 * HTTP API 测试套件（阶段二·去 WS 化）
 *
 * 为对话控制域等路由测试提供一个最小、自包含的真实 HTTP 服务：
 * - 复用真实 HttpRouter + registerChatRoutes（端点定义不重复）
 * - 复用真实 SseBus + /api/events 端点（SSE 广播语义与生产一致）
 * - 复用真实 askRegistry（answer/cancel-ask 的真实行为）
 * - callApi 内联 chat 域事件分派，与 ws-server.handle() 的对应 case 逐字对齐；
 *   不复用整个 WSServer（其 handle 深度耦合 configStore / projectStore 等大量 store，
 *   测试只需 chat 域 6 个事件的 HTTP 契约）
 *
 * 导出：
 * - stubAgentManager：满足 chat 域所需接口的最小桩（用例可用 chatStub 叠加 override）
 * - withServer(am, fn)：随机端口起服务，fn 收到 base URL，结束自动 stop
 * - openSse(base) / readSseFrame(reader)：消费 /api/events 的 SSE 帧
 */
import { HttpRouter } from "../../src/http-router";
import { registerChatRoutes } from "../../src/routes/chat";
import { SseBus } from "../../src/sse-bus";
import { askRegistry } from "../../src/ask-registry";
import type { WSClientEvent, WSServerEvent } from "@wa-pi/shared";

/** chat 域事件涉及的 agentManager 方法集（用例经 chatStub 叠加 override） */
export const stubAgentManager = {
	isSessionStreaming: (_sessionId: string) => false,
	abort: async (_sessionId: string) => {},
	steerMessage: async (_sessionId: string, _text: string) => {},
	clearFollowUpList: (_sessionId: string) => {},
};

type AgentManagerStub = typeof stubAgentManager;

/**
 * 随机端口起 HTTP 服务，挂载 chat 域路由 + SSE 总线；
 * fn 结束（含抛错）后自动停止服务。
 */
export async function withServer<T>(
	am: AgentManagerStub,
	fn: (base: string) => Promise<T>,
): Promise<T> {
	const sseBus = new SseBus();
	// broadcast：与 WSServer.broadcast 一致——经 SSE 总线广播一帧
	const broadcast = (e: WSServerEvent) => sseBus.broadcast((e as any).type, e);

	const router = new HttpRouter();
	// callApi：复刻 WSServer.callApi + handle() 对 chat 域事件的分派。
	// fire-and-forget 事件（无 reply）→ 200 {ok:true}；error 帧 → 400（与生产一致）。
	const callApi = async (event: WSClientEvent): Promise<Response> => {
		switch (event.type) {
			case "agent:abort":
				await am.abort(event.sessionId!);
				break;
			case "agent:answer": {
				// askRegistry 直达 resolve（幂等）；未命中（stale ask）→ 400（同生产 WSServer 的 error reply）
				const ok = askRegistry.resolve(event.sessionId!, event.toolCallId!, event.reply);
				if (!ok) {
					return Response.json(
						{
							code: "session.promptStale",
							error: "该提问已失效（可能已取消或会话已切换），请重新发起",
						},
						{ status: 400 },
					);
				}
				break;
			}
			case "agent:cancel-ask": {
				// 未命中（stale ask：取消必然是 no-op、也不会有 toolResult）→ 400，
				// 前端据此本地关闭失效卡片
				const ok = askRegistry.cancel(event.sessionId!, event.toolCallId!);
				if (!ok) {
					return Response.json(
						{
							code: "session.promptStale",
							error: "该提问已失效（可能已被取消或会话已切换）",
						},
						{ status: 400 },
					);
				}
				break;
			}
			case "steer:message":
				try {
					await am.steerMessage(event.sessionId!, event.text!);
				} catch (err) {
					broadcast({ type: "error", message: `引导失败: ${(err as Error).message}` });
				}
				break;
			case "steer:immediate-message":
				try {
					await am.abort(event.sessionId!);
					await am.steerMessage(event.sessionId!, event.text!);
				} catch (err) {
					broadcast({ type: "error", message: `立即执行失败: ${(err as Error).message}` });
				}
				break;
			case "clear-queue":
				am.clearFollowUpList(event.sessionId!);
				break;
			default:
				return Response.json({ error: "not_found" }, { status: 404 });
		}
		return Response.json({ ok: true });
	};
	registerChatRoutes(router, callApi, { projectStore: null as any });

	const server = Bun.serve({
		port: 0,
		idleTimeout: 255, // 与生产一致：放宽空闲断连，SSE 长连接不被杀
		fetch: async (req) => {
			const url = new URL(req.url);
			// SSE 事件总线：与 /api/events 端点逐字对齐
			if (url.pathname === "/api/events") {
				let write: ((chunk: string) => void) | null = null;
				const stream = new ReadableStream<Uint8Array>({
					start: (controller) => {
						const enc = new TextEncoder();
						write = (chunk) => controller.enqueue(enc.encode(chunk));
						write(": connected\n\n");
						sseBus.add(write);
					},
					cancel: () => { if (write) sseBus.remove(write); },
				});
				return new Response(stream, {
					headers: {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						"connection": "keep-alive",
					},
				});
			}
			if (url.pathname.startsWith("/api/")) {
				const res = await router.handle(req);
				return res ?? Response.json({ error: "not_found" }, { status: 404 });
			}
			return new Response("Not Found", { status: 404 });
		},
	});

	try {
		return await fn(`http://127.0.0.1:${server.port}`);
	} finally {
		server.stop(true);
	}
}

/** 连接 /api/events SSE 流，返回 reader 供 readSseFrame 消费 */
export async function openSse(base: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
	const res = await fetch(`${base}/api/events`);
	if (!res.ok || !res.body) throw new Error(`SSE 连接失败: ${res.status}`);
	return res.body.getReader();
}

/** SSE 帧读取的等待上限（默认）：本地帧应在毫秒级到达，这个上限只为「真收不到帧时快速失败并报出卡点」，
 *  不参与正常路径。（观测：全链路集成用例正常 2s 内跑完，用例级超时 60s。） */
const DEFAULT_SSE_FRAME_WAIT_MS = 15_000;

/** 每个 reader 的解析状态：缓冲与解码器必须跨调用保留——同一个 TCP chunk 里可能含多帧
 *  （负载下服务端连续广播会被合并进同一 chunk），返回一帧就把其余帧丢掉的话，调用方
 *  会永久等不到后续帧（2026-09-20 定位的 kernel gate 60s 超时根因）。 */
type SseReaderState = { buffer: string; decoder: TextDecoder };
const sseReaderStates = new WeakMap<
	ReadableStreamDefaultReader<Uint8Array>,
	SseReaderState
>();

/** 带截止时间的 read：超时抛错，不再无限等待 */
async function readChunkWithDeadline(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs: number,
	readFrames: number,
) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`SSE 帧读取超时（${timeoutMs}ms 内无新数据；此前已读到 ${readFrames} 帧）`,
							),
						),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** SSE 帧结构：跳过注释帧（: ...），解析 data: <JSON>\n\n */
export async function readSseFrame(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	opts: { timeoutMs?: number } = {},
): Promise<{ data: any }> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_SSE_FRAME_WAIT_MS;
	let state = sseReaderStates.get(reader);
	if (!state) {
		state = { buffer: "", decoder: new TextDecoder() };
		sseReaderStates.set(reader, state);
	}
	let readFrames = 0;
	for (;;) {
		// 先消费缓冲里的完整帧：上一次调用留下的帧在这里被取走（不再随函数返回被丢弃）
		let idx: number;
		while ((idx = state.buffer.indexOf("\n\n")) !== -1) {
			const raw = state.buffer.slice(0, idx);
			state.buffer = state.buffer.slice(idx + 2);
			// 跳过注释帧（: connected / : ping）
			if (raw.trim().startsWith(":")) continue;
			const line = raw.split("\n").find((l) => l.startsWith("data:"));
			if (!line) continue;
			readFrames++;
			return { data: JSON.parse(line.slice(5).trim()) };
		}
		const { value, done } = await readChunkWithDeadline(reader, timeoutMs, readFrames);
		if (done) throw new Error("SSE 流已关闭");
		state.buffer += state.decoder.decode(value, { stream: true });
	}
}
