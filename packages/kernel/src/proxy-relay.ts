// proxy-relay.ts — 本地 HTTP 代理中继：上游代理不可用时**直接失败**，不回退直连。
//
// 背景：开启系统代理后，kernel 把 HTTP_PROXY/HTTPS_PROXY 写进进程环境，pi 子进程
// spawn 时继承。若代理软件在会话进行中被关掉，运行中的子进程 env 改不了，所有
// 请求仍发往死掉的代理端口。
//
// 方案：env 里的代理地址不直接指向上游代理，而是指向本中继（127.0.0.1 环回）。
// 中继把请求转给上游；上游连不通/超时则直接返回 502 并上报状态（前端弹提示），
// **不偷偷改走直连**——开着代理的用户要的是代理，静默直连会让请求白等超时后又失败，
// 还掩盖了「代理软件没开」这个真正的原因。回环/内网目标如本地 bridge、私网服务
// 绕过上游始终直连——那是路由，不是回退（见 isDirectHost）。
// 上游恢复后下一条连接立刻自动切回（**不做冷却/熔断**：每条请求都真的试一次上游，
// 否则代理软件重开后还要干等；代价是上游「半死」时每条请求都要等满 connectTimeout）。
//
// 生命周期：中继随 applySystemProxy 启动后不关停，env 始终指向中继——
// 开代理 = 中继上游指向用户代理；关代理 = 上游清空（直连转发）。
// 开关代理只改中继上游，存量子进程 env 不用变，逻辑统一。
//
// 实现要点：整体为纯 TCP 转发（CONNECT 隧道与普通 HTTP 都在 socket 层处理）。
// 刻意不用 node:http 客户端做出站——Bun 的 node:http 客户端会读 env 里的
// HTTP_PROXY，而 kernel 的 env 代理正是本中继自己，用它会造成出站回环/死锁。

import { createServer, type Server, type Socket } from "node:net";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { getNetLogger, formatBytes, sanitizeUrlForLog } from "./net-log";

export interface ProxyRelayOpts {
	/** 上游代理地址（http:// / https://，可带 user:pass@）；空串 = 直连 */
	upstream: string;
	/** 上游连接超时（ms），默认 5000 */
	connectTimeoutMs?: number;
	/** 网络请求日志（net-log）：每行一条，调用方保证不含敏感信息 */
	logger?: (line: string) => void;
	/** 上游可用性翻转回调（只在状态变化时触发，用于前端提示；直连模式不触发） */
	onStatus?: (s: ProxyStatus) => void;
	/** 上游连接失败时回调（kernel 侧接「重读系统代理」；由调用方自行节流） */
	onUpstreamFail?: () => void;
}

/** 上游代理可用性（ok=能建立连接；unreachable=连不上/被拒/出口疑似不可用） */
export interface ProxyStatus {
	state: "ok" | "unreachable";
	/** 上游地址 origin（不含 userinfo）；空串 = 已切回直连模式 */
	upstream: string;
	/** unreachable 时的原始原因（如 connect ECONNREFUSED 127.0.0.1:7890） */
	reason?: string;
}

/** 数据面判死门槛：隧道里发出过请求数据、却零回应、且持续超过该时长才算出口死 */
const DATA_FAIL_MIN_MS = 1000;

/** 解析 host:port 形式的 CONNECT 目标（IPv6 形如 [::1]:443 暂不支持，LLM API 用不到） */
function parseConnectTarget(
	url: string,
): { host: string; port: number } | null {
	const idx = url.lastIndexOf(":");
	if (idx <= 0) return null;
	const host = url.slice(0, idx);
	const port = Number.parseInt(url.slice(idx + 1), 10);
	if (!host || !Number.isFinite(port) || port <= 0) return null;
	return { host, port };
}

/**
 * 直连目标判定：回环 / 内网地址不应经过上游代理——本地服务（如 bridge）和
 * 内网资源走代理既慢又可能被代理软件直接拒绝（CONNECT 隧道与普通 HTTP 共用）。
 */
export function isDirectHost(hostname: string): boolean {
	const h = hostname.toLowerCase();
	if (
		h === "localhost" ||
		h === "::1" ||
		h === "[::1]" ||
		h.endsWith(".local") ||
		h.endsWith(".internal")
	) {
		return true;
	}
	// 仅当整体是 IPv4 字面量时按网段判断（避免误伤 "10.example.com" 这类域名）
	const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
	if (ipv4) {
		const a = Number(ipv4[1]);
		const b = Number(ipv4[2]);
		if (a === 127 || a === 10) return true;
		if (a === 192 && b === 168) return true;
		if (a === 169 && b === 254) return true; // 链路本地
		if (a === 172 && b >= 16 && b <= 31) return true;
	}
	// IPv6 ULA（fc00::/7）/ 链路本地（fe80::/10），host 可能带方括号
	const v6 = h.replace(/^\[|\]$/g, "");
	if (/^f[cd]/.test(v6) || v6.startsWith("fe80")) return true;
	return false;
}

/** 请求头文本 → 行数组里剔除代理专用 hop-by-hop 头，返回剩余行 */
function stripProxyHeaders(headLines: string[]): string[] {
	return headLines.filter(
		(l) => !/^(proxy-connection|proxy-authorization)\s*:/i.test(l),
	);
}

/** 隧道关闭时的统计（生命周期 ≈ 请求时长；up = 客户端发出字节，down = 目标返回字节） */
interface TunnelStats {
	durMs: number;
	upBytes: number;
	downBytes: number;
}

export class ProxyRelay {
	private server: Server;
	private upstream: URL | null = null;
	private upstreamAuth: string | null = null;
	/** 上次落日志的上游（去重；undefined = 还没记过） */
	private lastLoggedUpstream: string | null | undefined = undefined;
	private readonly connectTimeoutMs: number;
	private readonly log: (line: string) => void;
	private readonly onStatus?: (s: ProxyStatus) => void;
	private readonly onUpstreamFail?: () => void;
	/** 上次上报的可用性（去重：状态没翻转不重复通知） */
	private lastState: "ok" | "unreachable" | null = null;
	/** 上次上报不可达时的原因（快照查询用） */
	private lastReason: string | undefined;
	/** 当前上游的规范化 URL（含 userinfo，便于外部比对是否真的变了；空串=直连） */
	private upstreamKey = "";
	/** 监听端口（start 后可用） */
	port = 0;

	constructor(opts: ProxyRelayOpts) {
		this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
		this.log = opts.logger ?? (() => {});
		this.onStatus = opts.onStatus;
		this.onUpstreamFail = opts.onUpstreamFail;
		this.setUpstream(opts.upstream);
		this.server = createServer((client) => this.onClientSocket(client));
		this.server.on("error", (err) => {
			console.warn(`[proxy-relay] server error: ${err.message}`);
		});
	}

	/** 更新上游代理；空串 = 直连。上游地址带 user:pass 时生成 Proxy-Authorization */
	setUpstream(upstream: string): void {
		if (upstream) {
			try {
				const url = new URL(
					upstream.includes("://") ? upstream : `http://${upstream}`,
				);
				this.upstream = url;
				this.upstreamKey = url.href;
				this.upstreamAuth = url.username
					? `Basic ${Buffer.from(
							`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
						).toString("base64")}`
					: null;
			} catch {
				// 上游地址无效：按直连处理，不抛异常（用户填错地址时不让整个 kernel 挂掉）
				console.warn(`[proxy-relay] 上游地址无效，按直连处理: ${upstream}`);
				this.upstream = null;
				this.upstreamAuth = null;
				this.upstreamKey = "";
			}
		} else {
			this.upstream = null;
			this.upstreamAuth = null;
			this.upstreamKey = "";
		}
		// 旧上游的可用性结论作废。清空上游 = 用户关了代理：若此前报过不可达，
		// 补一次 ok 让前端把告警提示收掉（不再有代理可用性问题）。
		const prevState = this.lastState;
		this.lastState = null;
		if (!this.upstream && prevState === "unreachable") {
			this.onStatus?.({ state: "ok", upstream: "" });
		}
		// 日志去重：值没变不刷行（保存设置会触发多次 applySystemProxy）。
		// origin 不含 userinfo，可安全落日志
		const origin = this.upstream ? this.upstream.origin : null;
		if (origin !== this.lastLoggedUpstream) {
			this.lastLoggedUpstream = origin;
			this.log(`relay 上游变更 → ${origin ?? "直连"}`);
		}
	}

	/** 监听 127.0.0.1 随机端口，返回端口号 */
	start(): Promise<number> {
		return new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", () => {
				const addr = this.server.address();
				this.port = typeof addr === "object" && addr ? addr.port : 0;
				console.log(`[proxy-relay] 已启动: http://127.0.0.1:${this.port}`);
				resolve(this.port);
			});
		});
	}

	close(): Promise<void> {
		return new Promise((resolve) => this.server.close(() => resolve()));
	}

	/** 当前生效上游（诊断/测试用）；null = 直连 */
	getUpstream(): string | null {
		return this.upstream ? this.upstream.origin : null;
	}

	/** 当前上游的规范化标识（含 userinfo；空串=直连），供定时刷新比对用 */
	getUpstreamKey(): string {
		return this.upstreamKey;
	}

	/** 上报可用性翻转（直连模式不上报，未翻转不重复上报） */
	private notifyStatus(
		state: "ok" | "unreachable",
		reason?: string,
	): void {
		if (!this.upstream) return;
		if (this.lastState === state) return;
		this.lastState = state;
		this.lastReason = reason;
		this.onStatus?.({
			state,
			upstream: this.upstream.origin,
			...(reason ? { reason } : {}),
		});
	}

	/**
	 * 当前可用性快照（供前端挂载/重连时补拉）。
	 * null = 直连模式或还没观测过（无代理可报）。
	 */
	getStatus(): ProxyStatus | null {
		if (!this.upstream || !this.lastState) return null;
		return {
			state: this.lastState,
			upstream: this.upstream.origin,
			...(this.lastState === "unreachable" && this.lastReason
				? { reason: this.lastReason }
				: {}),
		};
	}

	// ---- 入口：解析首个请求头，分流 CONNECT 隧道 / 普通 HTTP 转发 ----

	/**
	 * 非转发路径的终结响应（400/502）。
	 * 注意必须先 resume：入口解析后 socket 处于 pause 状态，Bun 下 pause 的
	 * socket 收不到对端 FIN/close 事件，直接 end 会让 server.close() 永远等待。
	 */
	private endClient(client: Socket, response: string): void {
		client.resume();
		client.end(response);
	}

	private onClientSocket(client: Socket): void {
		client.on("error", () => {
			/* 客户端断开，忽略 */
		});
		let buf = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			const end = buf.indexOf("\r\n\r\n");
			if (end === -1) {
				if (buf.length > 64 * 1024) client.destroy(); // 头部异常超大，放弃
				return;
			}
			client.off("data", onData);
			// 暂停流：决定转发去向后由 pipe 恢复，避免 connect 窗口期丢 body 数据
			client.pause();
			const headText = buf.slice(0, end).toString("latin1");
			const rest = buf.slice(end + 4);
			const firstLine = headText.split("\r\n")[0];
			const m = firstLine.match(/^([A-Z]+)\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/i);
			if (!m) {
				client.resume();
				client.destroy();
				return;
			}
			if (m[1].toUpperCase() === "CONNECT") {
				this.handleConnect(m[2], client, rest);
				return;
			}
			this.forwardPlain(m[1], m[2], headText, client, rest);
		};
		client.on("data", onData);
	}

	// ---- CONNECT 隧道（HTTPS 请求走这里） ----

	private handleConnect(url: string, client: Socket, head: Buffer): void {
		const target = parseConnectTarget(url);
		if (!target) {
			this.endClient(client, "HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		// 耗时用真实时钟
		const startedAt = Date.now();
		const tag = `${target.host}:${target.port}`;
		// 失败在发生时立即记；成功等隧道关闭后记（durMs = 隧道生命周期 ≈ 请求时长）
		const fail = (via: string, status: number, err: string) =>
			this.log(
				`CONNECT ${tag} via=${via} result=fail status=${status}` +
					` durMs=${Date.now() - startedAt} err=${JSON.stringify(err)}`,
			);
		const ok = (via: string) => (s: TunnelStats) =>
			this.log(
				`CONNECT ${tag} via=${via} result=ok durMs=${s.durMs}` +
					` up=${formatBytes(s.upBytes)} down=${formatBytes(s.downBytes)}`,
			);
		const direct = (via: string) =>
			this.tunnelDirect(target.host, target.port, client, head, {
				onFail: (status, err) => fail(via, status, err),
				onClose: ok(via),
			});

		if (isDirectHost(target.host)) {
			direct("direct");
			return;
		}
		if (!this.upstream) {
			direct("direct");
			return;
		}
		// 不做冷却/熔断：每条请求都真的试一次上游。代理软件重开后下一条立刻恢复，
		// 代价是上游「半死」（能连上但不回应）时每条请求都要等满 connectTimeout。
		this.tunnelViaUpstream(target.host, target.port, client, head, {
			onFail: (reason) => fail("upstream", 502, reason),
			onSuccess: ok("upstream"),
		});
	}

	/**
	 * 隧道建立后互通：回 200、转发已缓冲的 head、双向 pipe；
	 * 统计上下行字节，隧道关闭时回调 onClose（只调一次）。
	 * preToClient：上游 CONNECT 响应里多读的隧道数据，需转给客户端并计入 down。
	 * dataFailProbe：仅经上游的隧道传入——隧道关闭时目标零回应（downBytes===0，
	 * 连 TLS ServerHello 都没回来）且确实发过请求、持续够久则调用，用于识别
	 * 「上游进程活着但出口已死」的数据面失败（CONNECT 200 之后发生，连接层回退覆盖不到的盲区）。
	 */
	private establishTunnel(
		client: Socket,
		outbound: Socket,
		head: Buffer,
		onClose: (s: TunnelStats) => void,
		preToClient?: Buffer,
		dataFailProbe?: () => void,
	): void {
		const startedAt = Date.now();
		let upBytes = head?.length ?? 0;
		let downBytes = preToClient?.length ?? 0;
		client.on("data", (c: Buffer) => (upBytes += c.length));
		outbound.on("data", (c: Buffer) => (downBytes += c.length));
		client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (preToClient?.length) client.write(preToClient);
		if (head?.length) outbound.write(head);
		outbound.pipe(client).pipe(outbound);
		outbound.on("error", () => client.destroy());
		// 隧道一端关闭时清理对端，避免连接泄漏：
		// bun 1.4 下 server.close() 严格等待全部连接关闭，残留的 outbound 会让
		// relay.close() 永远挂起（bun 1.3 宽松处理不暴露）；真实场景也会泄漏连接。
		client.once("close", () => outbound.destroy());
		outbound.once("close", () => client.destroy());
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			// 上游路径专属：目标零回应即断开 ≈ 上游出口死（正常目标至少回 TLS
			// ServerHello / 响应头）。但浏览器 preconnect（连上不发数据就关）也是
			// 零回应，必须排除：要求确实发过请求数据、且持续超过 DATA_FAIL_MIN_MS。
			if (
				dataFailProbe &&
				downBytes === 0 &&
				upBytes > 0 &&
				Date.now() - startedAt >= DATA_FAIL_MIN_MS
			)
				dataFailProbe();
			onClose({ durMs: Date.now() - startedAt, upBytes, downBytes });
		};
		client.once("close", done);
		outbound.once("close", done);
	}

	/**
	 * 普通 HTTP 转发（forwardPlain）的 pipe 清理：一端关闭时销毁对端。
	 * 与 establishTunnel 同理：bun 1.4 下 server.close() 严格等待全部连接关闭，
	 * 半关闭残留会让 relay.close() 挂起；真实场景也避免连接泄漏。
	 */
	private attachForwardCleanup(client: Socket, outbound: Socket): void {
		client.once("close", () => outbound.destroy());
		outbound.once("close", () => client.destroy());
	}

	/** 直连目标并建立隧道；失败立即 onFail，成功待隧道关闭 onClose */
	private tunnelDirect(
		host: string,
		port: number,
		client: Socket,
		head: Buffer,
		hooks: {
			onFail: (status: number, err: string) => void;
			onClose: (s: TunnelStats) => void;
		},
	): void {
		const target = netConnect(port, host);
		// 直连同样受 connectTimeoutMs 约束：无超时的话，内网目标不可达时连接会无限挂起，
		// 且 client 处于 pause 状态收不到 FIN → relay server.close() 永远等待（连接泄漏）。
		const timer = setTimeout(() => {
			target.destroy();
			console.warn(`[proxy-relay] 直连 ${host}:${port} 超时`);
			hooks.onFail(502, "连接超时");
			this.endClient(client, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
		}, this.connectTimeoutMs);
		target.once("connect", () => {
			clearTimeout(timer);
			this.establishTunnel(client, target, head, hooks.onClose);
		});
		target.once("error", (err) => {
			clearTimeout(timer);
			console.warn(`[proxy-relay] 直连 ${host}:${port} 失败: ${err.message}`);
			hooks.onFail(502, err.message);
			this.endClient(client, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
		});
	}

	/**
	 * 经上游代理建立 CONNECT 隧道；任何失败都直接给客户端 502（不回退直连）。
	 * 任何失败都直接给客户端 502（不回退直连，也不做冷却——恢复靠下一条请求重新试探）。
	 */
	private tunnelViaUpstream(
		host: string,
		port: number,
		client: Socket,
		head: Buffer,
		hooks: {
			onFail: (reason: string) => void;
			onSuccess: (s: TunnelStats) => void;
		},
	): void {
		const upstream = this.upstream!;
		const isTls = upstream.protocol === "https:";
		const uPort = Number.parseInt(upstream.port, 10) || (isTls ? 443 : 80);
		const uHost = upstream.hostname;

		const sock: Socket = isTls
			? (tlsConnect({ host: uHost, port: uPort, servername: uHost }) as Socket)
			: netConnect(uPort, uHost);
		sock.setTimeout(this.connectTimeoutMs);

		let settled = false;
		const failRequest = (reason: string) => {
			if (settled) return;
			settled = true;
			console.warn(
				`[proxy-relay] 上游代理 ${upstream.origin} 不可用（${reason}），请求直接失败（不回退直连）`,
			);
			this.notifyStatus("unreachable", reason);
			// 让 kernel 重读一次系统代理（代理软件换了端口/重启时能自己跟上）
			this.onUpstreamFail?.();
			sock.destroy();
			hooks.onFail(reason);
			if (!client.destroyed)
				this.endClient(client, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
		};

		sock.once(isTls ? "secureConnect" : "connect", () => {
			const auth = this.upstreamAuth
				? `Proxy-Authorization: ${this.upstreamAuth}\r\n`
				: "";
			sock.write(
				`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`,
			);
			// 读上游 CONNECT 响应头（到 \r\n\r\n 为止）
			let buf = Buffer.alloc(0);
			const onData = (chunk: Buffer) => {
				buf = Buffer.concat([buf, chunk]);
				const end = buf.indexOf("\r\n\r\n");
				if (end === -1) {
					if (buf.length > 16 * 1024) {
						sock.off("data", onData);
						failRequest("上游 CONNECT 响应异常");
					}
					return;
				}
				sock.off("data", onData);
				const statusLine = buf.slice(0, end).toString("latin1").split("\r\n")[0];
				const m = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
				if (!m || m[1] !== "200") {
					// 上游在线但拒绝隧道（如 407 鉴权失败）：直接失败
					failRequest(`上游 CONNECT 返回 ${m?.[1] ?? statusLine}`);
					return;
				}
				if (settled) return;
				settled = true;
				sock.setTimeout(0);
				// 上游隧道建立成功：上报恢复
				this.notifyStatus("ok");
				const restFromUpstream = buf.slice(end + 4);
				this.establishTunnel(
					client,
					sock,
					head,
					hooks.onSuccess,
					restFromUpstream.length ? restFromUpstream : undefined,
					// 数据面失败探针：200 之后出口死（节点全挂的常见形态）连接层
					// 感知不到，靠「关闭时零回应」兜底——上报不可达 + 重读系统代理；
					// 本条请求已无法挽救（200 已回给客户端），后续请求会重新试探上游。
					() => {
						console.warn(
							`[proxy-relay] 上游代理 ${upstream.origin} 隧道建立后目标零回应即断开（出口疑似不可用）`,
						);
						this.notifyStatus(
							"unreachable",
							"隧道建立后目标零回应（出口疑似不可用）",
						);
						this.onUpstreamFail?.();
						// 同步落 network.log：排障时可与连接日志对时（desktop.log 轮转较早）
						this.log(
							`CONNECT ${host}:${port} via=upstream result=fail status=502` +
								` err="隧道建立后目标零回应，出口疑似不可用"`,
						);
					},
				);
			};
			sock.on("data", onData);
		});
		sock.once("timeout", () => failRequest("连接超时"));
		sock.once("error", (err) => failRequest(err.message));
	}

	// ---- 普通 HTTP 转发（absolute-form，http:// 目标走这里） ----

	/**
	 * TCP 级转发：解析目标后重写请求行（直连改 origin-form / 经上游保持 absolute-form），
	 * 剔除代理专用头，其余原样透传。出站用裸 socket——不经 node:http 客户端，
	 * 避免 Bun 读 env 代理（env 指向中继自身）造成回环。
	 * 回环目标（如本地 bridge）绕过上游始终直连；与 CONNECT 隧道同策略：
	 * 上游 socket 级失败（连不上/超时）直接 502，不回退直连重发。
	 */
	private forwardPlain(
		method: string,
		url: string,
		headText: string,
		client: Socket,
		rest: Buffer,
	): void {
		const target = (() => {
			try {
				return new URL(url);
			} catch {
				return null;
			}
		})();
		if (!target || target.protocol !== "http:") {
			// https 应走 CONNECT；plain 形式只支持 http
			this.endClient(client, "HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}

		// 日志脱敏：query/hash 可能携带密钥，只记 scheme://host/path
		const safeUrl = sanitizeUrlForLog(url);
		const startedAt = Date.now();

		const attempt = (useUpstream: boolean, via: string): void => {
			const finish = (
				result: "ok" | "fail",
				status: string | number,
				err?: string,
			) => {
				this.log(
					`${method} ${safeUrl} via=${via} result=${result} status=${status}` +
						` durMs=${Date.now() - startedAt}${err ? ` err=${JSON.stringify(err)}` : ""}`,
				);
			};
			const upstreamIsTls = useUpstream && this.upstream!.protocol === "https:";
			const headLines = stripProxyHeaders(headText.split("\r\n").slice(1));
			const authLine =
				useUpstream && this.upstreamAuth
					? [`Proxy-Authorization: ${this.upstreamAuth}`]
					: [];
			const outHead = useUpstream
				? `${method} ${url} HTTP/1.1\r\n${[...headLines, ...authLine].join("\r\n")}\r\n\r\n` // 经上游保持 absolute-form
				: `${method} ${target.pathname + target.search} HTTP/1.1\r\n${headLines.join("\r\n")}\r\n\r\n`; // 直连改 origin-form

			const outbound: Socket = useUpstream
				? upstreamIsTls
					? (tlsConnect({
							host: this.upstream!.hostname,
							port: Number.parseInt(this.upstream!.port, 10) || 443,
							servername: this.upstream!.hostname,
						}) as Socket)
					: netConnect(
							Number.parseInt(this.upstream!.port, 10) || 80,
							this.upstream!.hostname,
						)
				: netConnect(Number.parseInt(target.port, 10) || 80, target.hostname);

			// 与 CONNECT 隧道一致：上游连接加超时，死端口/无响应时及时回退；
			// 连接建立后清除（长响应不受影响）。直连不设超时，保持原有行为。
			if (useUpstream) outbound.setTimeout(this.connectTimeoutMs);
			let settled = false; // 已建立连接或已失败回退

			// TLS socket 先触发 connect 再触发 secureConnect，握手完成才算就绪，
			// 否则会重复写请求头；按 socket 类型挂对应事件
			outbound.once(upstreamIsTls ? "secureConnect" : "connect", () => {
				settled = true;
				outbound.setTimeout(0);
				outbound.write(outHead);
				if (rest.length) outbound.write(rest);
				// 先读响应状态行（拿状态码记日志），再双向 pipe
				let rbuf = Buffer.alloc(0);
				const onRes = (chunk: Buffer) => {
					rbuf = Buffer.concat([rbuf, chunk]);
					const ln = rbuf.indexOf("\r\n");
					if (ln === -1) {
						if (rbuf.length > 16 * 1024) {
							outbound.off("data", onRes);
							finish("fail", "-", "响应状态行异常");
							client.write(rbuf);
							outbound.pipe(client).pipe(outbound);
							this.attachForwardCleanup(client, outbound);
						}
						return;
					}
					outbound.off("data", onRes);
					const m = rbuf
						.slice(0, ln)
						.toString("latin1")
						.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
					finish("ok", m?.[1] ?? "-");
					client.write(rbuf);
					outbound.pipe(client).pipe(outbound);
					this.attachForwardCleanup(client, outbound);
				};
				outbound.on("data", onRes);
			});
			const onFail = (reason: string) => {
				if (useUpstream && !settled) {
					// 连接建立前的上游 socket 级失败：直接失败，不回退直连重发、也不做冷却。
					settled = true;
					console.warn(
						`[proxy-relay] 上游代理 ${this.upstream!.origin} 不可用（${reason}），请求直接失败（不回退直连）`,
					);
					this.notifyStatus("unreachable", reason);
					// 同上：失败时重读系统代理（上层节流）
					this.onUpstreamFail?.();
					finish("fail", 502, reason);
					outbound.destroy();
					this.endClient(client, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
					return;
				}
				console.warn(
					`[proxy-relay] 普通 HTTP 转发失败 (${method} ${url}): ${reason}`,
				);
				finish("fail", 502, reason);
				this.endClient(client, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
			};
			outbound.once("timeout", () => onFail("连接超时"));
			outbound.once("error", (err) => onFail(err.message));
		};

		const wantUpstream = !!(!isDirectHost(target.hostname) && this.upstream);
		attempt(wantUpstream, wantUpstream ? "upstream" : "direct");
	}
}

// ---- kernel 进程内单例 ----

let relay: ProxyRelay | null = null;
/** 上游可用性监听（kernel 启动后接到前端推送通道；可在中继创建后注册） */
let statusListener: ((s: ProxyStatus) => void) | null = null;
/** 上游失败监听（kernel 侧接「重读系统代理」，代理换端口/重启后能自己跟上） */
let upstreamFailListener: (() => void) | null = null;

/** 注册上游可用性变化监听（只有一个消费者：kernel 启动后转发为 SSE 事件） */
export function onProxyStatus(cb: (s: ProxyStatus) => void): void {
	statusListener = cb;
}

/** 注册上游失败监听（只有一个消费者：kernel 启动后接到系统代理重读） */
export function setUpstreamFailHook(cb: () => void): void {
	upstreamFailListener = cb;
}

/** 当前上游可用性快照；null = 直连模式或尚未观测 */
export function getProxyStatus(): ProxyStatus | null {
	return relay?.getStatus() ?? null;
}

/** 当前上游的规范化标识（空串=直连/中继未启动），供定时刷新比对 */
export function getProxyUpstreamKey(): string {
	return relay?.getUpstreamKey() ?? "";
}

/** 把上游地址规范化为可直接比对的 key（与 ProxyRelay.setUpstream 同一套规则） */
export function normalizeUpstreamKey(upstream: string): string {
	if (!upstream) return "";
	try {
		return new URL(
			upstream.includes("://") ? upstream : `http://${upstream}`,
		).href;
	} catch {
		// 无效地址：setUpstream 会按直连处理，因此归一为空串
		return "";
	}
}

/**
 * 确保中继运行并指向上游（空串 = 直连），返回中继地址（http://127.0.0.1:port）。
 * 已运行则只更新上游（端口不变，存量子进程 env 无需变化）。
 * 无论开不开代理都应调用：开 = 指向上游；不开 = 传空串，中继直连转发。
 */
export async function ensureProxyRelay(upstream: string): Promise<string> {
	if (relay) {
		relay.setUpstream(upstream);
	} else {
		relay = new ProxyRelay({
			upstream,
			logger: (line) => getNetLogger().log(line),
			onStatus: (s) => statusListener?.(s),
			onUpstreamFail: () => upstreamFailListener?.(),
		});
		await relay.start();
	}
	return `http://127.0.0.1:${relay.port}`;
}

/** 关停中继（测试清理用；生产不关停，见文件头注释） */
export async function stopProxyRelay(): Promise<void> {
	await relay?.close();
	relay = null;
}
