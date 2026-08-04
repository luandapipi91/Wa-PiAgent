// rpc-client.ts — pi --mode rpc 子进程的 JSONL 客户端
//
// 设计要点：
// - 每个 WaPi 会话对应一个 pi rpc 子进程（spawn 时经 --session 绑定会话文件）
// - 命令/响应按 id 关联；type 非 "response"/"extension_ui_request" 的一律视为事件走 onEvent
// - JSONL 严格按 \n 切分（不用 readline：U+2028/U+2029 在 JSON 字符串内合法，
//   readline 会错误断行，见 pi RPC 文档的 strict JSONL 说明）
// - spawn 实现可注入：测试用假进程/假脚本，生产用 node:child_process.spawn
// - extension_ui_request 子协议：onUiRequest 返回值写成 extension_ui_response；
//   未提供 handler 时对话类方法自动回 cancelled，避免 pi 侧无限等待

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export interface RpcEvent {
	type: string;
	[k: string]: any;
}

/**
 * 剥离 ANSI 转义序列（SGR 颜色 / CSI 控制序列）。
 * pi 扩展经 ctx.ui.theme 着色的文本（如 theme.fg("dim", ...)）携带 \x1b[38;5;Nm
 * 这类终端转义码，TUI 下正常，GUI 展示必须剥离，否则原样显示为乱码文本。
 */
export function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

export interface RpcUiRequest {
	type: "extension_ui_request";
	id: string;
	method: string;
	[k: string]: any;
}

/** extension_ui_response 的业务字段（value / confirmed / cancelled 任选其一） */
export interface UiResponseFields {
	value?: unknown;
	confirmed?: boolean;
	cancelled?: boolean;
}

export type SpawnFn = (
	command: string,
	args: string[],
	opts: { cwd: string; env: Record<string, string> },
) => ChildProcess;

export interface RpcClientOpts {
	/** pi CLI 入口（dist/cli.js）绝对路径 */
	cliPath: string;
	/** 运行 cli.js 的运行时（bun / node 可执行文件路径） */
	runtime: string;
	/** 追加在 --mode rpc 之后的启动参数（--session / -e / --skill / --tools 等） */
	args?: string[];
	cwd: string;
	/** 附加环境变量（PI_CODING_AGENT_DIR / bridge 配置等），合并到 process.env 之上 */
	env?: Record<string, string>;
	/** RPC 事件回调（message_update / tool_execution_* / agent_* 等） */
	onEvent: (e: RpcEvent) => void;
	/** extension_ui_request 处理：返回值写成 extension_ui_response 的业务字段 */
	onUiRequest?: (req: RpcUiRequest) => Promise<UiResponseFields>;
	/** 进程退出回调（含 dispose 主动 kill） */
	onExit?: (code: number | null, signal: string | null) => void;
	/** 单条命令超时（ms），默认 60_000；超时只 reject 该命令，不杀进程 */
	commandTimeoutMs?: number;
	/** 测试注入：替换 node:child_process.spawn */
	spawnFn?: SpawnFn;
}

/** 需调 onUiRequest 处理的对话类方法；其余方法直接回 cancelled 兜底（不调 onUiRequest） */
const UI_DIALOG_METHODS = new Set([
	"select",
	"confirm",
	"input",
	"editor",
	"custom",
]);

export class RpcClient {
	private proc: ChildProcess | null = null;
	private seq = 0;
	private pending = new Map<
		string,
		{
			resolve: (data: any) => void;
			reject: (err: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private stderrTail: string[] = [];
	private exited = false;

	constructor(private opts: RpcClientOpts) {}

	/** spawn 子进程并接管 stdio。进程启动失败（如运行时缺失）时 reject。 */
	async start(): Promise<void> {
		if (this.proc) throw new Error("RpcClient 已启动");
		const spawnFn: SpawnFn =
			this.opts.spawnFn ??
			((cmd, args, o) =>
				nodeSpawn(cmd, args, { ...o, stdio: ["pipe", "pipe", "pipe"] }));
		const env = { ...process.env, ...this.opts.env } as Record<string, string>;
		const proc = spawnFn(
			this.opts.runtime,
			[this.opts.cliPath, "--mode", "rpc", ...(this.opts.args ?? [])],
			{ cwd: this.opts.cwd, env },
		);
		this.proc = proc;

		proc.stdout!.setEncoding?.("utf8");
		this.attachStdout(proc);
		proc.stderr?.on("data", (chunk: Buffer | string) => {
			const text = chunk.toString();
			for (const line of text.split(/\r?\n/)) {
				if (!line.trim()) continue;
				this.stderrTail.push(line);
				if (this.stderrTail.length > 50) this.stderrTail.shift();
			}
		});
		proc.on("exit", (code, signal) => {
			this.exited = true;
			const err = new Error(
				`pi rpc 进程已退出 (code=${code}, signal=${signal})${this.formatStderrTail()}`,
			);
			for (const [id, p] of this.pending) {
				clearTimeout(p.timer);
				p.reject(err);
				this.pending.delete(id);
			}
			this.opts.onExit?.(code, signal);
		});
		proc.on("error", () => {
			/* 由 start 的 race 与 exit 处理 */
		});

		// spawn 成功事件先到即就绪；error 先到即失败；500ms 兜底视为存活（某些运行时可能不发 spawn 事件）
		await Promise.race([
			once(proc, "spawn").then(() => undefined),
			once(proc, "error").then(([err]) => {
				throw err instanceof Error ? err : new Error(String(err));
			}),
			new Promise<void>((resolve) => setTimeout(resolve, 500)),
		]);
	}

	/** 进程是否仍存活 */
	isAlive(): boolean {
		return !!this.proc && !this.exited && this.proc.exitCode === null;
	}

	/** 发送任意 RPC 命令，resolve 为 response.data（无 data 时为 undefined）；success:false 时 reject */
	async command(cmd: Record<string, any>): Promise<any> {
		const proc = this.proc;
		if (!proc || !this.isAlive()) {
			throw new Error(`pi rpc 进程不可用${this.formatStderrTail()}`);
		}
		const id = cmd.id ?? `req-${++this.seq}`;
		// per-command 超时覆盖（compact 等长耗时 LLM 命令），timeoutMs 不进 wire
		const { timeoutMs: cmdTimeoutMs, ...rest } = cmd;
		const payload = { ...rest, id };
		return await new Promise((resolve, reject) => {
			const timeoutMs = cmdTimeoutMs ?? this.opts.commandTimeoutMs ?? 60_000;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC 命令超时 (${timeoutMs}ms): ${cmd.type}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				proc.stdin!.write(JSON.stringify(payload) + "\n");
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	// ---- 常用命令的便捷封装 ----

	getState(): Promise<any> {
		return this.command({ type: "get_state" });
	}

	getMessages(): Promise<any[]> {
		return this.command({ type: "get_messages" }).then(
			(d) => d?.messages ?? [],
		);
	}

	/** 拉取当前会话可用的 slash 命令（extension/prompt/skill 三类，由 pi 运行时决定） */
	getCommands(): Promise<{ commands: any[] }> {
		return this.command({ type: "get_commands" });
	}

	/** message 为文本；images 为 ImageContent 数组；streamingBehavior: "steer" | "followUp" */
	prompt(
		message: string,
		opts?: { images?: any[]; streamingBehavior?: "steer" | "followUp" },
	): Promise<any> {
		return this.command({
			type: "prompt",
			message,
			...(opts?.images ? { images: opts.images } : {}),
			...(opts?.streamingBehavior
				? { streamingBehavior: opts.streamingBehavior }
				: {}),
		});
	}

	steer(message: string): Promise<any> {
		return this.command({ type: "steer", message });
	}

	followUp(message: string): Promise<any> {
		return this.command({ type: "follow_up", message });
	}

	abort(): Promise<any> {
		return this.command({ type: "abort" });
	}

	setModel(provider: string, modelId: string): Promise<any> {
		return this.command({ type: "set_model", provider, modelId });
	}

	setThinkingLevel(level: string): Promise<any> {
		return this.command({ type: "set_thinking_level", level });
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): Promise<any> {
		return this.command({ type: "set_steering_mode", mode });
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<any> {
		return this.command({ type: "set_follow_up_mode", mode });
	}

	newSession(parentSession?: string): Promise<any> {
		return this.command({
			type: "new_session",
			...(parentSession ? { parentSession } : {}),
		});
	}

	switchSession(sessionPath: string): Promise<any> {
		return this.command({ type: "switch_session", sessionPath });
	}

	compact(customInstructions?: string): Promise<any> {
		return this.command({
			type: "compact",
			// 压缩摘要生成是 LLM 长调用，可能远超默认 60s 命令超时；给足 10 分钟
			timeoutMs: 10 * 60_000,
			...(customInstructions ? { customInstructions } : {}),
		});
	}

	setAutoCompaction(enabled: boolean): Promise<any> {
		return this.command({ type: "set_auto_compaction", enabled });
	}

	setAutoRetry(enabled: boolean): Promise<any> {
		return this.command({ type: "set_auto_retry", enabled });
	}

	/**
	 * 获取当前会话的统计信息（消息量、token 用量、成本等）。
	 *
	 * 对应 RPC 命令 `get_session_stats`。仅当前已绑定的会话有效，不可跨会话查询。
	 * 需确保 `isAlive()` 为 true 时调用，否则抛 Error。
	 *
	 * 字段可用性说明：
	 * - `sessionFile`、`sessionId`、`userMessages`、`assistantMessages`、
	 *   `toolCalls`、`toolResults`、`totalMessages` 由所有版本 pi 稳定返回。
	 * - `tokens` 整体可选——旧版 pi 可能不统计 token。其内字段也可能缺省，
	 *   调用方应做降级（如 `?? 0`）。
	 * - `cost` 整体可选；返回时可能为 `number` 或 `{ total: number }`，
	 *   调用方需兼容两种形式（建议 `typeof cost === 'number' ? cost : cost?.total`）。
	 * - `contextUsage` 仅 pi >= 0.80 返回，不含时整体为 `undefined`。
	 *
	 * @returns 解析后的服务端响应 data，结构如下：
	 * ```ts
	 * {
	 *   sessionFile?: string;              // 会话文件路径（--no-session 时 undefined）
	 *   sessionId: string;                 // 会话唯一标识
	 *   userMessages: number;              // 用户消息数
	 *   assistantMessages: number;         // 助手消息数
	 *   toolCalls: number;                 // 工具调用次数
	 *   toolResults: number;               // 工具结果条数
	 *   totalMessages: number;             // 消息总数
	 *
	 *   tokens?: {                         // token 统计（整体可选，依 pi 版本）
	 *     input?: number;                  //   输入 token 数
	 *     output?: number;                 //   输出 token 数
	 *     cacheRead?: number;              //   缓存读取 token 数
	 *     cacheWrite?: number;             //   缓存写入 token 数
	 *     total?: number;                  //   总 token 数
	 *   };
	 *
	 *   cost?: number | { total?: number };// 成本（兼容 number / {total} 两种形式）
	 *
	 *   contextUsage?: {                   // 上下文水位（pi >= 0.80，低版本整体 undefined）
	 *     used: number;                    //   已用 token 数
	 *     total: number;                   //   上限 token 数
	 *     ratio: number;                   //   使用率（0 ~ 1）
	 *   };
	 * }
	 * ```
	 */
	getSessionStats(): Promise<any> {
		return this.command({ type: "get_session_stats" });
	}

	/** 终止子进程。先 SIGTERM，3s 未退出则 SIGKILL。 */
	async dispose(): Promise<void> {
		const proc = this.proc;
		if (!proc || !this.isAlive()) return;
		const exitPromise = once(proc, "exit").catch(() => undefined);
		try {
			proc.kill();
		} catch {
			/* 已退出 */
		}
		const killed = await Promise.race([
			exitPromise.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
		]);
		if (!killed) {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* 已退出 */
			}
			await Promise.race([
				exitPromise,
				new Promise((r) => setTimeout(r, 1000)),
			]);
		}
		this.proc = null;
	}

	/** 最近 stderr 行（诊断用） */
	getStderrTail(): string[] {
		return [...this.stderrTail];
	}

	private formatStderrTail(): string {
		const tail = this.stderrTail.slice(-5).join("\n");
		return tail ? `\nstderr: ${tail}` : "";
	}

	/** 按 strict JSONL 切分 stdout：只在 \n 处断行，去掉行尾 \r */
	private attachStdout(proc: ChildProcess): void {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		const onLine = (line: string) => {
			if (!line.trim()) return;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				this.stderrTail.push(
					`[rpc-client] 无法解析的 stdout 行: ${line.slice(0, 200)}`,
				);
				return;
			}
			this.dispatch(msg);
		};
		proc.stdout!.on("data", (chunk: Buffer | string) => {
			buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
			for (;;) {
				const idx = buffer.indexOf("\n");
				if (idx === -1) break;
				let line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				onLine(line);
			}
		});
		proc.stdout!.on("end", () => {
			buffer += decoder.end();
			if (buffer.length > 0) {
				let line = buffer;
				if (line.endsWith("\r")) line = line.slice(0, -1);
				onLine(line);
			}
		});
	}

	private dispatch(msg: any): void {
		if (msg?.type === "response") {
			const id = msg.id;
			const p = id != null ? this.pending.get(id) : undefined;
			if (p) {
				clearTimeout(p.timer);
				this.pending.delete(id);
				if (msg.success) p.resolve(msg.data);
				else p.reject(new Error(msg.error ?? `RPC 命令失败: ${msg.command}`));
			}
			// 无 id 或未知 id 的 response（异常）：忽略
			return;
		}
		if (msg?.type === "extension_ui_request") {
			void this.handleUiRequest(msg as RpcUiRequest);
			return;
		}
		this.opts.onEvent(msg as RpcEvent);
	}

	private async handleUiRequest(req: RpcUiRequest): Promise<void> {
		// 对所有 extension_ui_request 都回复，防止 pi 永久挂起。
		// 对话类方法：有 onUiRequest 则交其处理；无 handler 则自动取消（发 cancelled）。
		// 非对话类方法（notify/setStatus 等）：不调 onUiRequest，但发 cancelled 兜底。
		// notify 是扩展命令的 fire-and-forget 反馈（如 /lens-toggle 用 ctx.ui.notify 报告执行结果），
		// 在 GUI 下若不转发，命令执行成功但用户看不到任何反馈（表现为“发送无响应”）。
		// 这里把 notify 消息转发为 extension_notify 事件，由宿主（桌面端）展示为 toast。
		if (req.method === "notify" && typeof req.message === "string") {
			this.opts.onEvent({
				type: "extension_notify",
				message: stripAnsi(req.message),
				notifyType: req.notifyType,
			} as RpcEvent);
		}
		// fire-and-forget UI 方法（setStatus/setWidget/setTitle）：pi 不期待响应，
		// 但 GUI 宿主需要内容来展示——与 notify 同路径桥接为 sdk:event 转发前端。
		// 文案统一 stripAnsi：扩展经 ctx.ui.theme 着色的文本带终端转义码。
		// set_editor_text 刻意不转发（产品决策：输入框状态归桌面端自己管理）。
		if (req.method === "setStatus" && typeof req.statusKey === "string") {
			this.opts.onEvent({
				type: "extension_status",
				statusKey: req.statusKey,
				statusText:
					typeof req.statusText === "string"
						? stripAnsi(req.statusText)
						: undefined,
			} as RpcEvent);
		}
		if (req.method === "setWidget" && typeof req.widgetKey === "string") {
			this.opts.onEvent({
				type: "extension_widget",
				widgetKey: req.widgetKey,
				widgetLines: Array.isArray(req.widgetLines)
					? req.widgetLines.map((l) => stripAnsi(String(l)))
					: undefined,
				widgetPlacement: req.widgetPlacement,
			} as RpcEvent);
		}
		if (req.method === "setTitle" && typeof req.title === "string") {
			this.opts.onEvent({
				type: "extension_title",
				title: stripAnsi(req.title),
			} as RpcEvent);
		}
		let fields: UiResponseFields = { cancelled: true };
		if (UI_DIALOG_METHODS.has(req.method) && this.opts.onUiRequest) {
			try {
				fields = await this.opts.onUiRequest(req);
			} catch {
				fields = { cancelled: true };
			}
		}
		try {
			this.proc?.stdin?.write(
				JSON.stringify({
					type: "extension_ui_response",
					id: req.id,
					...fields,
				}) + "\n",
			);
		} catch {
			/* 进程已退出 */
		}
	}
}

// ---- pi CLI 路径与启动参数 ----

/**
 * 解析 pi CLI 入口（dist/cli.js）绝对路径。
 * 从 @earendil-works/pi-coding-agent 的 package.json 定位——kernel 只引用其 bin/扩展路径，
 * 不 import 任何 SDK API（RPC 迁移的依赖约定）。
 */
export function resolvePiCliPath(
	req: NodeRequire = createRequire(import.meta.url),
): string {
	const pkgJsonPath = req.resolve(
		"@earendil-works/pi-coding-agent/package.json",
	);
	return join(dirname(pkgJsonPath), "dist", "cli.js");
}

/** 解析运行 pi CLI 的运行时：env 覆盖 > PATH 上的 bun > process.execPath */
export function resolvePiRuntime(): string {
	if (process.env.WA_PI_PI_RUNTIME) return process.env.WA_PI_PI_RUNTIME;
	const which = (globalThis as any).Bun?.which;
	if (typeof which === "function") {
		const bunPath = which("bun");
		// Bun.which 可能返回缓存路径但文件已不存在，加 existsSync 兜底
		if (bunPath && existsSync(bunPath)) return bunPath;
	}
	return process.execPath;
}

export interface PiLaunchSpec {
	/** --session <path>：绑定会话文件（缺省则 pi 自建） */
	sessionFile?: string;
	/** --no-session：临时会话（子代理等一次性运行） */
	noSession?: boolean;
	/** --system-prompt <file>：组合好的系统提示词文件路径（resolvePromptInput 会读文件内容） */
	systemPromptFile?: string;
	/** -e <path>：扩展文件，可多个 */
	extensionPaths?: string[];
	/** --no-skills：禁用 Pi SDK 默认扫描 skill 目录（如 ~/.agents/skills），只加载 --skill 显式传入的 skill */
	noSkills?: boolean;
	/** --skill <path>：技能目录/文件，可多个 */
	skillPaths?: string[];
	/** --tools a,b,c：工具白名单（空数组 = 不传，pi 默认全量） */
	tools?: string[];
	/** --exclude-tools a,b,c：工具黑名单（与白名单可组合） */
	excludeTools?: string[];
	/** --thinking <level> */
	thinking?: string;
	/** --model <pattern> */
	model?: string;
	/** --name <name>：会话显示名 */
	name?: string;
	/** --offline：禁用启动网络操作（测试用） */
	offline?: boolean;
	/** --no-context-files：不读 AGENTS.md/CLAUDE.md（子代理用） */
	noContextFiles?: boolean;
	/** --append-system-prompt <text|file>：追加到系统提示词末尾 */
	appendSystemPrompt?: string;
}

/** 把启动规格翻译成 pi CLI 参数数组（--mode rpc 由 RpcClient 自带，不在此处） */
export function buildPiArgs(spec: PiLaunchSpec): string[] {
	const args: string[] = [];
	if (spec.sessionFile) args.push("--session", spec.sessionFile);
	if (spec.noSession) args.push("--no-session");
	if (spec.systemPromptFile)
		args.push("--system-prompt", spec.systemPromptFile);
	for (const p of spec.extensionPaths ?? []) args.push("-e", p);
	if (spec.noSkills) args.push("--no-skills");
	for (const s of spec.skillPaths ?? []) args.push("--skill", s);
	if (spec.tools && spec.tools.length > 0)
		args.push("--tools", spec.tools.join(","));
	if (spec.excludeTools && spec.excludeTools.length > 0)
		args.push("--exclude-tools", spec.excludeTools.join(","));
	if (spec.thinking) args.push("--thinking", spec.thinking);
	if (spec.model) args.push("--model", spec.model);
	if (spec.name) args.push("--name", spec.name);
	if (spec.offline) args.push("--offline");
	if (spec.noContextFiles) args.push("--no-context-files");
	if (spec.appendSystemPrompt)
		args.push("--append-system-prompt", spec.appendSystemPrompt);
	return args;
}
