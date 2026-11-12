// MCP 工具描述索引：注册名（`mcp__<server>__<tool>`）→ 服务器官方 description。
//
// 工具清单（agent:tools:list）要展示每个工具「是干什么的」。MCP 工具的 description 只有
// 服务器自己知道（MCP `tools/list` 的原文，多为英文），kernel 启动时不连服务器，
// 故需要一份带 TTL 的惰性缓存：清单请求先拿缓存立即回包，缓存过期时后台重探并广播。
//
// 为什么不复用 McpAdmin（`pi mcp list --json`）：它只输出工具**名**，没有 description；
// 且一台 server 卡住会把整批拖死。这里用 mcp-probe 的逐台独立探测（http 3s / stdio 10s，
// 与 routes/mcp.ts 的列表探测同口径），一台失败只丢它自己的描述。
//
// 注册名不是朴素拼接：非法字符替换 + 超长/撞名退化为 hash 变体，统一由
// {@link createMcpToolName} 给出（与 pi 注册名一致，描述按注册名索引才对得上清单）。
import type { McpServerConfig } from "@wa-pi/shared";
import type { McpProbeResult } from "./mcp-probe";
import { probeMcpServer } from "./mcp-probe";
import { createMcpToolName } from "./mcp-tool-names";

/** 描述缓存的默认有效期：30 分钟（工具集合变化不频繁，重探要真连每台 server） */
const DEFAULT_TTL_MS = 30 * 60 * 1000;
/** 探测并发池：台与台完全独立，一台卡死只影响它自己（与 routes/mcp.ts 同值） */
const PROBE_CONCURRENCY = 10;
/** 单台总截止时间：http（含缺省按 url 推断）3s、stdio 10s（与 routes/mcp.ts 的 probeTimeoutFor 同口径） */
const PROBE_TIMEOUT_HTTP_MS = 3_000;
const PROBE_TIMEOUT_STDIO_MS = 10_000;

function probeTimeoutFor(config: McpServerConfig): number {
	const type =
		config.type ?? (config.url ? "http" : config.command ? "stdio" : undefined);
	return type === "stdio" ? PROBE_TIMEOUT_STDIO_MS : PROBE_TIMEOUT_HTTP_MS;
}

/** 只用到 list 的配置读取面（McpFile 满足；测试注入 fake） */
export interface McpListSource {
	list(projectId?: string): Promise<McpServerConfig[]>;
}

export type McpProbeFn = (
	config: McpServerConfig,
	opts: { timeoutMs?: number; agentDir?: string; cwd?: string },
) => Promise<McpProbeResult>;

export interface McpToolDescriptionIndexOpts {
	/** MCP 服务器配置来源（只调 list，无 projectId = 全局作用域） */
	mcpFile: McpListSource;
	/** mcp-auth.json 所在目录（探测读 OAuth token 用；不写日志） */
	agentDir: string;
	/** stdio 子进程兜底 cwd（与 pi spawn MCP 子进程同源，不要继承 kernel 进程 cwd） */
	cwd: string;
	/** 探测器（缺省 probeMcpServer；测试注入 fake 避免真连） */
	probe?: McpProbeFn;
	/** 缓存有效期（毫秒），缺省 30 分钟 */
	ttlMs?: number;
}

export class McpToolDescriptionIndex {
	private readonly opts: McpToolDescriptionIndexOpts;
	private readonly ttlMs: number;
	/** 注册名 → description（服务器原文，不截断；展示端截断） */
	private cache = new Map<string, string>();
	/** 上次**成功**重建缓存的时间戳；null = 从未成功加载过 */
	private loadedAt: number | null = null;
	/** 单飞：并发 refresh 共享同一轮探测（多客户端同时拉清单只探一次） */
	private inflight: Promise<void> | null = null;

	constructor(opts: McpToolDescriptionIndexOpts) {
		this.opts = opts;
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	}

	/** 当前缓存（注册名 → description）。调用方只读，不要修改返回的 Map。 */
	descriptions(): Map<string, string> {
		return this.cache;
	}

	/** 未成功加载过，或距上次成功加载已超过 TTL */
	needsRefresh(): boolean {
		if (this.loadedAt === null) return true;
		return Date.now() - this.loadedAt >= this.ttlMs;
	}

	/**
	 * 重探全部启用的服务器并重建缓存。
	 *
	 * 失败策略：单台失败静默跳过（只丢它自己的描述）；**一台都没成功**（或没有启用的
	 * 服务器）时保留旧缓存 —— 一次网络抖动不该把已有描述永久抹掉，`loadedAt` 也不动，
	 * 下次清单请求会再试。
	 *
	 * 日志与异常：本方法不打印任何 server 内容（headers/env/token 不落日志），也不抛
	 * （调用方是后台任务）；探测异常按失败处理。
	 */
	async refresh(): Promise<void> {
		if (this.inflight) return this.inflight;
		this.inflight = this._refresh().finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}

	private async _refresh(): Promise<void> {
		let configs: McpServerConfig[];
		try {
			configs = await this.opts.mcpFile.list();
		} catch {
			return; // 读配置失败：保留旧缓存
		}
		const targets = configs.filter((c) => c.enabled !== false);
		if (targets.length === 0) return;

		const probe = this.opts.probe ?? probeMcpServer;
		const collected = new Map<string, string>();
		let succeeded = 0;
		let cursor = 0;
		const worker = async () => {
			for (;;) {
				const i = cursor++;
				if (i >= targets.length) return;
				const config = targets[i]!;
				try {
					const probed = await probe(config, {
						timeoutMs: probeTimeoutFor(config),
						agentDir: this.opts.agentDir,
						cwd: this.opts.cwd,
					});
					if (probed.state !== "connected") continue;
					succeeded++;
					for (const tool of probed.toolSummaries) {
						if (!tool.description) continue;
						collected.set(createMcpToolName(config.name, tool.name), tool.description);
					}
				} catch {
					// 单台失败静默跳过（探测器内部一般不抛，抛了也不该拖垮整批）
				}
			}
		};
		await Promise.all(
			Array.from(
				{ length: Math.max(1, Math.min(PROBE_CONCURRENCY, targets.length)) },
				worker,
			),
		);

		if (succeeded === 0) return; // 全失败：保留旧缓存
		this.cache = collected;
		this.loadedAt = Date.now();
	}
}
