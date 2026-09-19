#!/usr/bin/env bun
// eval-memory-trigger.ts — 记忆检索触发评测
//
// 目标：量化 agent 在「知识类 / 过程类提问」下是否**先查记忆（memory_search）再行动**。
//   - 正例（expect="memory"）：问题属于项目结构/依赖/接口/历史决策/约定/变更/构建/踩坑
//     ——答案可能已存在记忆里且不在已注入快照中 ⇒ 应当先 memory_search 检索。
//     通过条件：调用过 memory_search，且**首次检索发生在任何 delegate/fleet 委派之前**。
//   - 反例（expect="no-memory"）：单点事实查询（常量值/文件位置/脚本命令）或常识问答
//     ——直接读代码或直接回答即可，检索记忆属多余动作。通过条件：全程未调 memory_search。
//
// 与生产一致的组装（否则测得没意义）：
// - 系统提示词：composePrompt(prompts.json segments, { defaultBasePrompt, delegateRoster,
//   builtinSkillsDir, memoryPolicy, memorySnapshot })
//   · memoryPolicy 按 --policy（full 默认 = DEFAULT_MEMORY_POLICY_PROMPT / compact / none="")
//   · memorySnapshot 传固定假快照（模拟生产把 L1 近期记忆注入的效果），内容与被测问题无关
// - 工具面：默认排除式（不传 --tools，仅 -xt subagent）+ 全套扩展（provider-extension + wa-pi-bridge）
// - memory_* 工具由 wa-pi-bridge 扩展注册、经 HTTP 回调 bridge；本脚本内置 stub bridge 直接复用
//   kernel 的 memory/tools（createMemoryTools + MemoryDao）在隔离 memRoot 上真实应答
//   ——不污染真实记忆；delegate/fleet 只记录调用不真 spawn（压成本）。
//
// cwd 隔离（硬约束）：被测 pi 进程的 cwd 默认指向 .worktrees/eval-memory-trigger（不存在则
//   用 git worktree add --detach 创建）；**绝不静默回退到主工作区**（agent 可能真的改文件）。
//
// 用法：
//   bun run scripts/eval-memory-trigger.ts [--limit N] [--sample N]
//     [--category structure,deps,...] [--repeat N] [--model slug/modelId]
//     [--thinking off|low|medium|high|xhigh] [--threshold 0.8] [--policy full|compact|none]
//     [--cwd path] [--dry-run] [--selftest] [--out path] [--timeout sec]
//   --dry-run：只打印用例清单（序号/类别/expect/prompt）并断言用例总数恰为 20，不调模型
//   --selftest：用合成 CaseResult 自检判定/统计/门禁，不调模型
//
// 判定口径（casePassed）：
//   · toolsCalled 按调用先后顺序收集（pi 事件 tool_execution_start 为主序 + bridge stub 增量补漏）。
//   · memorySearchIdx = 首次出现 memory_search 的下标（无则 -1）；
//     delegateIdx = 首次出现 delegate / fleet 的下标（无则 -1）。
//   · expect="memory"：pass ⇔ memorySearchIdx >= 0 且（delegateIdx < 0 或 memorySearchIdx < delegateIdx）。
//     即「查过记忆，且查记忆早于任何委派」；直接委派、或先派后查、或全程不查 → 失败。
//   · expect="no-memory"：pass ⇔ memorySearchIdx < 0（一次都没查才通过）。
//   · 超时 / pi 进程异常退出 → 记失败并写明原因（进程「启动即退出」重试 1 次）。
//
// 汇总与门禁：
//   passRate = 通过数 / 总数（正例+反例合计）；posRate / negRate 分别为正例 / 反例通过率。
//   混淆矩阵单列「该查却直接委派」（核心症状）/「该查却没查」/「先派后查」/「不该查却查了」。
//   passRate < --threshold（默认 0.8）→ 报告先落盘，再 process.exit(1) 拦截。
//
// ── 调研结论（同类场景方案 + 本仓库可复用资产）──────────────────────────────
// A. 业界同类做法（证据以实践博客/论坛为主，非同行评审结论，仅作方法参考）
//   1) 工具选择类评测必须真跑 agent、看调用轨迹，而非只做提示词快照断言
//      — https://www.langchain.com/resources/agent-evals
//   2) 评测按「工具使用 / 检索 / 记忆 / 沙箱」分层已成常见框架
//      — https://www.braintrust.dev/blog/six-generations-ai-agents
//   3) 起步工具链建议 Promptfoo，按需再加 Ragas / LangSmith（单一论坛回答，未做基准对比）
//      — https://discuss.huggingface.co/t/looking-for-simple-ways-to-evaluate-an-ai-agent/175062
//   4) 中文实践：跑记忆方案对比时先只验证「流程跑通 + 接口被正确调用」，此阶段不看分数
//      — https://bbs.csdn.net/weixin_29042035/article/details/100267666
//   5) 分阶段喂输入，用后续提问验证是否真的用了先前经验，并与无记忆基线做对比
//      — https://www.yuanjianliu.net/posts/how-to-judge-a-memory-system/
// B. 本仓库可复用资产
//   1) eval-memory-write.ts：casePassed（:853）/ computeStats（:905）/ gateFails（:922）/
//      runSelftest（:928）——「逐条判定 + 通过率 + 硬门禁 + --selftest 不调模型」骨架，本脚本仿此
//   2) eval-delegate-trigger.ts：stub bridge 只记录 delegate/fleet 不真 spawn、工具调用收集、
//      首派轮次与混淆矩阵——本脚本的「工具序列判定」沿用同一机制
//   3) tool-schemas.ts 的分层设计：判定细则收敛到工具描述（DELEGATE_DESCRIPTION），
//      系统提示词只留入口级概述——本次文案改动遵守同一分层，不新增第三处重复
// C. 本次落点与不做的事
//   · 落点：MEM_SEARCH_DESC（判定细则）+ DELEGATE_DESCRIPTION（例外边界）+ Memory Policy 段（概述）
//   · 不做：不改记忆存储与检索算法；不改 delegate/fleet 核心路由；文案达标即不加运行时预取机制

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
	WA_PI_DIR,
	BUILTIN_SKILLS_DIR,
	PROMPTS_FILE,
	slugifyProviderName,
} from "@wa-pi/shared";
import {
	RpcClient,
	buildPiArgs,
	resolvePiCliPath,
	resolvePiRuntime,
	type RpcEvent,
} from "../src/rpc-client";
import {
	composePrompt,
	ensurePromptsConfig,
	loadPromptSegments,
	DEFAULT_PROMPT_SEGMENTS,
	DEFAULT_MEMORY_POLICY_PROMPT,
	COMPACT_MEMORY_POLICY_PROMPT,
	WA_PI_DEFAULT_BASE_PROMPT,
} from "../src/system-prompt";
import { buildDelegateRoster } from "../src/delegate-tool";
import { ensureBridgeExtension } from "../src/bridge-extension";
import { ensureProviderExtensionRegistered } from "../src/provider-extension";
import { ProviderStore } from "../src/provider-store";
import { buildAdditionalExtensionPaths } from "../src/extensions";
import {
	createMemoryTools,
	MemoryDao,
	openMemoryDb,
	projectNameFromCwd,
} from "../src/memory";

// ---- 用例集（正例 14 + 反例 6 = 20，逐条显式 expect）----
type Category =
	| "structure"
	| "deps"
	| "api"
	| "history"
	| "convention"
	| "change"
	| "build"
	| "env"
	| "pitfall"
	| "pinpoint"
	| "known"
	| "off-topic";

/** 判定期望：memory = 应先查记忆；no-memory = 不该查记忆 */
type Expect = "memory" | "no-memory";

interface Case {
	category: Category;
	prompt: string;
	expect: Expect;
}

/** 类别展示顺序（--sample 按此序每类取样；汇总按此序输出） */
const CATEGORY_ORDER: Category[] = [
	"structure",
	"deps",
	"api",
	"history",
	"convention",
	"change",
	"build",
	"env",
	"pitfall",
	"pinpoint",
	"known",
	"off-topic",
];

/** 用例总数硬约束（--dry-run 据此断言，防止为「让测试通过」而减用例） */
const EXPECTED_CASES = 20;

const CASES: Case[] = [
	// --- 正例（expect: "memory"，14 条）---
	{ category: "structure", prompt: "这个项目的结构是怎么组织的？", expect: "memory" },
	{ category: "structure", prompt: "项目目录结构是什么", expect: "memory" },
	{
		category: "structure",
		prompt: "这个项目跟记忆相关的部分都包含哪些文件？",
		expect: "memory",
	},
	{ category: "deps", prompt: "这个项目用到了哪些依赖？", expect: "memory" },
	{ category: "api", prompt: "这个项目里有哪些方法？", expect: "memory" },
	{ category: "api", prompt: "这个项目的对外接口都有哪些？", expect: "memory" },
	{
		category: "history",
		prompt: "我们之前是怎么决定用 SQLite 存记忆的？",
		expect: "memory",
	},
	{
		category: "history",
		prompt: "委派优化的判定细则最后是怎么收敛的？",
		expect: "memory",
	},
	{ category: "history", prompt: "之前那个 CDN 选型最后定的是哪家？", expect: "memory" },
	{
		category: "convention",
		prompt: "这个项目的约定是什么？提交日志和变更记录有什么要求？",
		expect: "memory",
	},
	{
		category: "convention",
		prompt: "多版本 Go 是怎么管理的？升级流程是什么？",
		expect: "memory",
	},
	{ category: "change", prompt: "上一轮我让你改了什么？", expect: "memory" },
	{ category: "build", prompt: "这个项目怎么跑测试和打包？", expect: "memory" },
	{
		category: "pitfall",
		prompt: "之前踩过哪些坑？有什么已知的注意事项？",
		expect: "memory",
	},
	// --- 反例（expect: "no-memory"，6 条）---
	{
		category: "pinpoint",
		prompt: "WA_PI_DIR 默认指向哪个目录？",
		expect: "no-memory",
	},
	{
		category: "pinpoint",
		prompt: "FLEET_MAX_CONCURRENCY 的值是多少？",
		expect: "no-memory",
	},
	{
		category: "pinpoint",
		prompt: "COMPACT_MEMORY_POLICY_PROMPT 导出在哪个文件？",
		expect: "no-memory",
	},
	{
		category: "pinpoint",
		prompt: "packages/kernel/package.json 里 test 脚本对应的命令是什么？",
		expect: "no-memory",
	},
	{
		// 「当前会话内已知信息」类：信息已由用户在本条消息里给出 ⇒ 不必去翻记忆库（防 agent 对任何提问都先检索一遍）
		category: "known",
		prompt:
			"我要重构 payment 模块，拆成三个子模块。请复述我的目标，并列出你动手前要先确认的三个问题。",
		expect: "no-memory",
	},
	{
		category: "off-topic",
		prompt: "用一句话解释什么是 RICE 优先级排序。",
		expect: "no-memory",
	},
];

// ---- 假记忆快照（模拟生产把 L1 近期记忆注入系统提示词的效果）----
// 3 条条目均与被测问题**无关**——保证「答案不在已注入快照里 ⇒ 应当主动检索」这个前提成立。
const MEMORY_SNAPSHOT_HEADER = "## Memory Snapshot（近期记忆，仅注入这部分）";
const MEMORY_SNAPSHOT = [
	MEMORY_SNAPSHOT_HEADER,
	"- [project/execution] 2026-09-12：修复 IM 渠道图片下载超时，改为流式落盘，已回归验证",
	"- [user/profile] 用户偏好中文回复、措辞简洁，不喜欢长篇解释",
	"- [project/knowledge] 企微机器人回调地址必须使用 HTTPS，HTTP 会被服务端拒绝",
].join("\n");

// ---- CLI 参数 ----
interface CliOpts {
	limit: number;
	/** 每类各取 N 条（冒烟用，优先于 --limit） */
	sample: number;
	/** 只跑指定类别（逗号分隔） */
	categories: Category[] | null;
	repeat: number;
	model: string | null;
	thinking: string | null;
	threshold: number;
	policy: "full" | "compact" | "none";
	/** 被测 pi 进程的 cwd（必须与本仓库同源的检出；默认 .worktrees/eval-memory-trigger） */
	cwd: string | null;
	dryRun: boolean;
	selftest: boolean;
	out: string | null;
	timeoutSec: number;
}

function parseArgs(argv: string[]): CliOpts {
	const opts: CliOpts = {
		limit: CASES.length,
		sample: 0,
		categories: null,
		repeat: 1,
		model: null,
		thinking: null,
		threshold: 0.8,
		policy: "full",
		cwd: null,
		dryRun: false,
		selftest: false,
		out: null,
		timeoutSec: 180,
	};
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--limit":
				opts.limit = parseInt(argv[++i]!, 10);
				break;
			case "--sample":
				opts.sample = parseInt(argv[++i]!, 10);
				break;
			case "--category":
				opts.categories = argv[++i]!.split(",").map((s) => s.trim()) as Category[];
				break;
			case "--repeat":
				opts.repeat = Math.max(1, parseInt(argv[++i]!, 10));
				break;
			case "--model":
				opts.model = argv[++i]!;
				break;
			case "--thinking":
				opts.thinking = argv[++i]!;
				break;
			case "--threshold": {
				const v = Number(argv[++i]);
				if (!Number.isFinite(v) || v < 0 || v > 1) {
					console.error("--threshold 需要 0..1 之间的小数（如 0.8 / 1.0）");
					process.exit(2);
				}
				opts.threshold = v;
				break;
			}
			case "--policy": {
				const v = argv[++i]!;
				if (v !== "full" && v !== "compact" && v !== "none") {
					console.error("--policy 需要 full/compact/none");
					process.exit(2);
				}
				opts.policy = v;
				break;
			}
			case "--cwd":
				opts.cwd = argv[++i]!;
				break;
			case "--dry-run":
				opts.dryRun = true;
				break;
			case "--selftest":
				opts.selftest = true;
				break;
			case "--out":
				opts.out = argv[++i]!;
				break;
			case "--timeout":
				opts.timeoutSec = parseInt(argv[++i]!, 10);
				break;
			default:
				console.error(`未知参数: ${argv[i]}`);
				process.exit(2);
		}
	}
	return opts;
}

/** 选用例：--category 过滤类别；--sample N = 每类前 N 条；否则前 --limit 条 */
function selectCases(opts: CliOpts): Case[] {
	let pool = CASES;
	if (opts.categories && opts.categories.length > 0) {
		pool = pool.filter((c) => opts.categories!.includes(c.category));
	}
	if (opts.sample > 0) {
		const picked: Case[] = [];
		for (const cat of CATEGORY_ORDER) {
			picked.push(...pool.filter((c) => c.category === cat).slice(0, opts.sample));
		}
		return picked;
	}
	return pool.slice(0, Math.max(0, Math.min(opts.limit, pool.length)));
}

// ---- stub bridge server：memory_* 走真实记忆工具集（隔离 memRoot），delegate/fleet 只记录 ----
interface StubCall {
	tool: string;
	params: unknown;
	at: string;
}

interface StubBridge {
	server: Server;
	port: number;
	token: string;
	calls: StubCall[];
}

/**
 * 真实处理一次 memory_* 调用：与 kernel makeDefaultBridgeContext 同源——直接跑 memory/tools
 * 的工具集（同一份实现），按 target+scope 路由读写隔离目录下的 memories.db。
 */
async function handleMemoryTool(
	tool: string,
	params: any,
	memRoot: string,
	cwd: string,
): Promise<{ ok: boolean; text: string }> {
	const tools = createMemoryTools({
		dao: new MemoryDao(openMemoryDb(memRoot)),
		projectId: projectNameFromCwd(cwd),
	});
	const def = tools.find((t) => t.name === tool);
	if (!def) return { ok: true, text: "（评测桩：ok）" };
	const res: any = await def.execute(tool, params);
	const text = String(res?.content?.[0]?.text ?? "");
	let ok = true;
	try {
		ok = JSON.parse(text)?.success !== false;
	} catch {
		/* 非 JSON 返回按成功处理 */
	}
	return { ok, text };
}

function startStubBridge(cwd: string, memRoot: string): Promise<StubBridge> {
	const token = randomUUID();
	const calls: StubCall[] = [];
	const server = createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/bridge/tool") {
			res.writeHead(404).end("{}");
			return;
		}
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let msg: any = null;
			try {
				msg = JSON.parse(body);
			} catch (e) {
				void e; /* 非法 JSON 按 400 处理 */
			}
			if (!msg || msg.token !== token) {
				res
					.writeHead(403, { "content-type": "application/json" })
					.end(JSON.stringify({ error: "bad_token" }));
				return;
			}
			const tool = String(msg.tool ?? "");
			calls.push({ tool, params: msg.params, at: new Date().toISOString() });
			// memory_* 真实应答（隔离库）；delegate/fleet 只记录不真 spawn；其余直接 ok
			Promise.resolve(
				tool.startsWith("memory_")
					? handleMemoryTool(tool, msg.params ?? {}, memRoot, cwd)
					: {
							ok: true,
							text:
								tool === "delegate" || tool === "fleet"
									? "（评测桩：子代理已完成任务，结果略）"
									: "（评测桩：ok）",
						},
			)
				.then(({ ok, text }) => {
					res.writeHead(200, { "content-type": "application/json" }).end(
						JSON.stringify({
							content: [{ type: "text", text }],
							details: ok ? undefined : { error: "memory_op_failed" },
						}),
					);
				})
				.catch((err) => {
					res.writeHead(200, { "content-type": "application/json" }).end(
						JSON.stringify({
							content: [
								{
									type: "text",
									text:
										"记忆操作失败: " + (err instanceof Error ? err.message : String(err)),
								},
							],
							details: { error: "memory_op_failed" },
						}),
					);
				});
		});
	});
	return new Promise((resolvePort) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			resolvePort({
				server,
				port: typeof addr === "object" && addr ? addr.port : 0,
				token,
				calls,
			});
		});
	});
}

// ---- 单用例执行 ----
interface CaseResult {
	index: number;
	category: Category;
	prompt: string;
	expect: Expect;
	/** 本用例的工具调用顺序（pi 事件为主序 + bridge stub 增量补漏；保留重复） */
	toolsCalled: string[];
	/** bridge 侧本用例增量收到的工具名（交叉核对事件是否漏记） */
	bridgeTools: string[];
	/** 首次 memory_search 的下标（无则 -1） */
	memorySearchIdx: number;
	/** 首次 delegate / fleet 的下标（无则 -1） */
	delegateIdx: number;
	/** 首次委派轮次：toolsCalled 中首个 delegate/fleet 的序号（1 起）；未派为 null */
	firstDelegateRound: number | null;
	/** assistant 轮次数（agent_end 事件数） */
	rounds: number;
	/** token 用量（getSessionStats().tokens.total，字段缺失降级为 0） */
	tokens: number;
	elapsedMs: number;
	/** 重试次数（0 = 首次即成功；进程启动即退出会重试 1 次） */
	retries: number;
	/** 超时标记 */
	timeout: boolean;
	error?: string;
}

/** 首次出现任一名字的下标（无则 -1） */
function firstIndexOf(list: string[], names: string[]): number {
	for (let i = 0; i < list.length; i++) {
		if (names.includes(list[i]!)) return i;
	}
	return -1;
}

async function runOneCase(
	index: number,
	c: Case,
	ctx: {
		promptFile: string;
		extensionPaths: string[];
		bridgeUrl: string;
		bridgeToken: string;
		stubCalls: StubCall[];
		provider: string;
		modelId: string;
		thinking: string | null;
		timeoutSec: number;
		cwd: string;
		ensureExtensions: () => Promise<void>;
	},
	attempt = 0,
): Promise<CaseResult> {
	const startedAt = Date.now();
	const result: CaseResult = {
		index,
		category: c.category,
		prompt: c.prompt,
		expect: c.expect,
		toolsCalled: [],
		bridgeTools: [],
		memorySearchIdx: -1,
		delegateIdx: -1,
		firstDelegateRound: null,
		rounds: 0,
		tokens: 0,
		elapsedMs: 0,
		retries: attempt,
		timeout: false,
	};
	const sessionId = `eval-mem-trigger-${randomUUID()}`;
	const stubMark = ctx.stubCalls.length; // 本用例前的 stub 调用数，用例后取增量

	const eventTools: string[] = [];
	let settled!: () => void;
	const settledPromise = new Promise<void>((resolveSettled) => {
		settled = resolveSettled;
	});
	const onEvent = (e: RpcEvent) => {
		if (e.type === "tool_execution_start" && typeof (e as any).toolName === "string") {
			eventTools.push((e as any).toolName);
		}
		// 每个 agent_end = 一轮 assistant 回合（rounds 口径）
		if (e.type === "agent_end") result.rounds++;
		if (e.type === "agent_settled") settled();
	};

	const client = new RpcClient({
		cliPath: resolvePiCliPath(),
		runtime: resolvePiRuntime(),
		args: buildPiArgs({
			noSession: true,
			systemPromptFile: ctx.promptFile,
			extensionPaths: ctx.extensionPaths,
			noSkills: true,
			excludeTools: ["subagent"], // 与生产默认排除式一致
			name: sessionId,
		}),
		cwd: ctx.cwd, // 隔离检出：agent 即便真改文件也只落在 worktree
		env: {
			PI_CODING_AGENT_DIR: WA_PI_DIR,
			WA_PI_BRIDGE_URL: ctx.bridgeUrl,
			WA_PI_BRIDGE_TOKEN: ctx.bridgeToken,
			WA_PI_SESSION_ID: sessionId,
		},
		onEvent,
		onExit: () => {},
	});

	try {
		await ctx.ensureExtensions();
		await client.start();
		await client.setModel(ctx.provider, ctx.modelId);
		if (ctx.thinking) await client.setThinkingLevel(ctx.thinking);
		await client.prompt(c.prompt);
		await Promise.race([
			settledPromise,
			new Promise<void>((_, reject) =>
				setTimeout(
					() => reject(new Error(`用例超时 (${ctx.timeoutSec}s)`)),
					ctx.timeoutSec * 1000,
				),
			),
		]);
		// settle 后抓取会话统计：token 用量（旧版 pi 无 tokens 字段 → 降级为 0）
		try {
			const st = await client.getSessionStats();
			const t = st?.tokens;
			result.tokens =
				typeof t?.total === "number" ? t.total : (t?.input ?? 0) + (t?.output ?? 0);
		} catch {
			result.tokens = 0;
		}
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		if (result.error.includes("用例超时")) result.timeout = true;
		try {
			await client.abort();
		} catch (e) {
			void e; /* 忽略：进程已退出时 abort 失败不影响结果上报 */
		}
	} finally {
		await client.dispose().catch(() => {});
	}

	// pi 进程启动即退出（多为 .generated 被外部并发清理）→ 重试一次
	if (result.error?.includes("pi rpc 进程已退出") && attempt < 1) {
		return runOneCase(index, c, ctx, attempt + 1);
	}

	// bridge 侧增量：本用例真实发生的桥接工具调用
	result.bridgeTools = ctx.stubCalls.slice(stubMark).map((call) => call.tool);
	// 合并：pi 事件为主序；bridge 侧有、事件未记录的工具补在末尾（防御事件漏记）
	// ——补漏只会「更保守」（可能把先查判成未查/后查），不会把失败放宽成通过。
	result.toolsCalled = [...eventTools];
	for (const t of result.bridgeTools) {
		if (!result.toolsCalled.includes(t)) result.toolsCalled.push(t);
	}
	result.memorySearchIdx = firstIndexOf(result.toolsCalled, ["memory_search"]);
	result.delegateIdx = firstIndexOf(result.toolsCalled, ["delegate", "fleet"]);
	result.firstDelegateRound =
		result.delegateIdx >= 0 ? result.delegateIdx + 1 : null;
	result.elapsedMs = Date.now() - startedAt;
	return result;
}

/** 单用例判定（口径见文件头「判定口径」）。
 *  - 异常/超时优先判失败（无论工具序列如何，本轮证据不完整）。
 *  - expect="memory"：查过且早于委派 → 通过；直接委派 / 先派后查 / 全程不查 → 失败。
 *  - expect="no-memory"：全程未查 → 通过；查了 → 失败。 */
function casePassed(r: CaseResult): { pass: boolean; reasons: string[] } {
	const reasons: string[] = [];

	if (r.error) {
		reasons.push(
			r.timeout
				? `用例超时（${(r.elapsedMs / 1000).toFixed(0)}s）：pi 未在时限内 settle`
				: `pi 进程异常/执行失败：${r.error}`,
		);
		return { pass: false, reasons };
	}

	if (r.expect === "memory") {
		if (r.memorySearchIdx < 0) {
			if (r.delegateIdx >= 0) {
				reasons.push(
					`该查记忆却直接委派：第 ${r.delegateIdx + 1} 次工具调用是 ${r.toolsCalled[r.delegateIdx]}，全程未调 memory_search`,
				);
			} else {
				reasons.push("该查记忆却全程未调 memory_search");
			}
			return { pass: false, reasons };
		}
		if (r.delegateIdx >= 0 && r.memorySearchIdx > r.delegateIdx) {
			reasons.push(
				`先派后查：第 ${r.delegateIdx + 1} 次工具调用先委派（${r.toolsCalled[r.delegateIdx]}），第 ${r.memorySearchIdx + 1} 次才查记忆`,
			);
			return { pass: false, reasons };
		}
		return { pass: true, reasons };
	}

	// expect === "no-memory"
	if (r.memorySearchIdx >= 0) {
		reasons.push(
			`反例：不该查记忆，却在第 ${r.memorySearchIdx + 1} 次工具调用调用了 memory_search`,
		);
		return { pass: false, reasons };
	}
	return { pass: true, reasons };
}

// ---- 统计与门禁 ----
interface EvalStats {
	total: number;
	passed: number;
	passRate: number;
	posTotal: number;
	posPassed: number;
	posRate: number;
	negTotal: number;
	negPassed: number;
	negRate: number;
	/** 混淆矩阵（本次要治的核心症状单列） */
	confusion: {
		/** 该查却直接委派（未查记忆就先 delegate/fleet）——核心症状 */
		missThenDelegate: number;
		/** 该查却没查（也没委派） */
		missNoLookup: number;
		/** 先派后查（查了但排在委派之后） */
		delegateBeforeSearch: number;
		/** 不该查却查了 */
		wrongLookup: number;
		/** 超时/异常退出 */
		errors: number;
	};
}

function computeStats(all: CaseResult[]): EvalStats {
	const positives = all.filter((r) => r.expect === "memory");
	const negatives = all.filter((r) => r.expect === "no-memory");
	const passed = all.filter((r) => casePassed(r).pass).length;
	const posPassed = positives.filter((r) => casePassed(r).pass).length;
	const negPassed = negatives.filter((r) => casePassed(r).pass).length;
	const confusion = {
		missThenDelegate: 0,
		missNoLookup: 0,
		delegateBeforeSearch: 0,
		wrongLookup: 0,
		errors: 0,
	};
	for (const r of all) {
		if (r.error) {
			confusion.errors++;
			continue;
		}
		if (r.expect === "memory") {
			if (r.memorySearchIdx < 0) {
				if (r.delegateIdx >= 0) confusion.missThenDelegate++;
				else confusion.missNoLookup++;
			} else if (r.delegateIdx >= 0 && r.memorySearchIdx > r.delegateIdx) {
				confusion.delegateBeforeSearch++;
			}
		} else if (r.memorySearchIdx >= 0) {
			confusion.wrongLookup++;
		}
	}
	return {
		total: all.length,
		passed,
		passRate: all.length > 0 ? passed / all.length : 1,
		posTotal: positives.length,
		posPassed,
		posRate: positives.length > 0 ? posPassed / positives.length : 1,
		negTotal: negatives.length,
		negPassed,
		negRate: negatives.length > 0 ? negPassed / negatives.length : 1,
		confusion,
	};
}

/** 硬门禁：passRate 低于阈值 → 非零退出（无用例时视为不适用，不拦） */
function gateFails(stats: EvalStats, threshold: number): boolean {
	return stats.total > 0 && stats.passRate < threshold;
}

/** 判定/统计/门禁自检（--selftest）：合成 CaseResult 跑真函数，不调模型。 */
function runSelftest(): boolean {
	const mk = (over: Partial<CaseResult> = {}): CaseResult => ({
		index: 0,
		category: "structure",
		prompt: "（自检）",
		expect: "memory",
		toolsCalled: [],
		bridgeTools: [],
		memorySearchIdx: -1,
		delegateIdx: -1,
		firstDelegateRound: null,
		rounds: 1,
		tokens: 0,
		elapsedMs: 0,
		retries: 0,
		timeout: false,
		...over,
	});

	// ① 先查后派 → 通过
	const searchThenDelegate = mk({
		toolsCalled: ["memory_search", "delegate"],
		memorySearchIdx: 0,
		delegateIdx: 1,
	});
	// ② 直接委派未查 → 失败
	const delegateOnly = mk({
		toolsCalled: ["delegate"],
		memorySearchIdx: -1,
		delegateIdx: 0,
	});
	// ②b 先派后查 → 失败
	const delegateThenSearch = mk({
		toolsCalled: ["fleet", "memory_search"],
		memorySearchIdx: 1,
		delegateIdx: 0,
	});
	// ③ 超时 → 失败
	const timedOut = mk({
		error: "用例超时 (180s)",
		timeout: true,
		elapsedMs: 180_000,
	});
	// ③b 进程异常 → 失败
	const crashed = mk({ error: "pi rpc 进程已退出 (code=1)" });
	// ④ 反例查了记忆 → 失败 / 反例未查 → 通过
	const negWrong = mk({
		expect: "no-memory",
		toolsCalled: ["memory_search"],
		memorySearchIdx: 0,
	});
	const negOk = mk({ expect: "no-memory", toolsCalled: ["powershell"] });
	// 正例未查也未派 → 失败
	const missing = mk({ toolsCalled: ["powershell"], memorySearchIdx: -1 });

	const checks: Array<[string, boolean]> = [
		["① 先查后派 → 通过", casePassed(searchThenDelegate).pass === true],
		[
			"② 直接委派未查 → 失败（理由含「直接委派」）",
			casePassed(delegateOnly).pass === false &&
				casePassed(delegateOnly).reasons.some((s) => s.includes("直接委派")),
		],
		[
			"②b 先派后查 → 失败（理由含「先派后查」）",
			casePassed(delegateThenSearch).pass === false &&
				casePassed(delegateThenSearch).reasons.some((s) => s.includes("先派后查")),
		],
		["③ 超时 → 失败", casePassed(timedOut).pass === false],
		["③b 进程异常 → 失败", casePassed(crashed).pass === false],
		["正例未查也未派 → 失败", casePassed(missing).pass === false],
		["④ 反例查了记忆 → 失败", casePassed(negWrong).pass === false],
		["反例全程未查 → 通过", casePassed(negOk).pass === true],
	];

	// ⑤ 统计算对：正例 1 通过 / 反例 1 通过 / 总 2 通过（共 4 条）
	const stats = computeStats([
		searchThenDelegate, // 正例通过
		delegateOnly, // 正例失败
		negOk, // 反例通过
		negWrong, // 反例失败
	]);
	checks.push(
		[
			"⑤ passRate = 2/4 = 0.5",
			stats.total === 4 && stats.passed === 2 && stats.passRate === 0.5,
		],
		[
			"⑤ posRate = 1/2 = 0.5",
			stats.posTotal === 2 && stats.posPassed === 1 && stats.posRate === 0.5,
		],
		[
			"⑤ negRate = 1/2 = 0.5",
			stats.negTotal === 2 && stats.negPassed === 1 && stats.negRate === 0.5,
		],
		[
			"⑤ 混淆矩阵计数对（直接委派 1 / 不该查却查 1 / 异常 0）",
			stats.confusion.missThenDelegate === 1 &&
				stats.confusion.wrongLookup === 1 &&
				stats.confusion.missNoLookup === 0 &&
				stats.confusion.delegateBeforeSearch === 0 &&
				stats.confusion.errors === 0,
		],
		[
			"⑤ 异常用例计入 errors（超时 + 进程异常 = 2）",
			computeStats([timedOut, crashed]).confusion.errors === 2,
		],
	);

	// ⑥ 门禁：构造 passRate = 0.3（3 通过 / 10 条）与达标场景
	const failCases: CaseResult[] = [
		...Array.from({ length: 3 }, () => searchThenDelegate),
		...Array.from({ length: 7 }, () => delegateOnly),
	];
	const failStats = computeStats(failCases);
	const okStats = computeStats([
		...Array.from({ length: 9 }, () => searchThenDelegate),
		delegateOnly,
	]);
	checks.push(
		[
			"⑥ passRate = 0.3 时 gateFails(0.8) === true（核心症状拦截）",
			failStats.passRate === 0.3 && gateFails(failStats, 0.8) === true,
		],
		[
			"⑥ passRate = 0.3 时 gateFails(0.3) === false（阈值恰等不拦）",
			gateFails(failStats, 0.3) === false,
		],
		[
			"⑥ passRate = 0.9 时 gateFails(0.8) === false（达标放行）",
			okStats.passRate === 0.9 && gateFails(okStats, 0.8) === false,
		],
		[
			"⑥ 无用例时不适用 → 不拦",
			gateFails(computeStats([]), 1.0) === false,
		],
	);

	let failed = 0;
	for (const [name, ok] of checks) {
		if (!ok) failed++;
		console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
	}
	console.log(`\n自检: ${checks.length - failed}/${checks.length} 通过`);
	return failed === 0;
}

// ---- cwd 隔离：确保被测进程的 cwd 是同仓库的独立检出（绝不回退主工作区）----
function ensureIsolatedCwd(cwd: string, repoRoot: string): void {
	if (cwd === repoRoot || cwd === join(repoRoot)) {
		console.error(
			`[FATAL] --cwd 不能指向主工作区（${repoRoot}）；请指定隔离检出目录。`,
		);
		process.exit(2);
	}
	// worktree 的 .git 是文件（指向主仓库 .git/worktrees/<name>）
	if (existsSync(join(cwd, ".git"))) return; // 已就绪，复用
	if (existsSync(cwd)) {
		console.error(
			`[FATAL] --cwd ${cwd} 已存在但不是 git 检出（缺 .git）。请先删除该目录或改用其他 --cwd。`,
		);
		process.exit(2);
	}
	mkdirSync(dirname(cwd), { recursive: true });
	console.log(`创建隔离检出: git worktree add --detach ${cwd} HEAD`);
	const r = spawnSync("git", ["worktree", "add", "--detach", cwd, "HEAD"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	if (r.status !== 0) {
		console.error(
			`[FATAL] 创建 git worktree 失败（status=${r.status}）：${(r.stderr || r.stdout || "").trim()}`,
		);
		console.error(
			`请手动执行：cd ${repoRoot} && git worktree add --detach ${cwd} HEAD，或用 --cwd 指定一个已存在的同仓库检出。`,
		);
		process.exit(2);
	}
}

// ---- main ----
async function main() {
	const repoRoot = resolve(import.meta.dir, "../../..");
	const opts = parseArgs(process.argv.slice(2));

	if (opts.selftest) {
		process.exit(runSelftest() ? 0 : 1);
	}

	// --dry-run：只打印用例清单（结构自检），不组装提示词、不起进程、不调模型
	if (opts.dryRun) {
		if (CASES.length !== EXPECTED_CASES) {
			console.error(
				`[FATAL] 用例总数应为 ${EXPECTED_CASES}，实际 ${CASES.length}——禁止为通过而增减用例`,
			);
			process.exit(1);
		}
		const cases = selectCases(opts);
		for (const [i, c] of cases.entries()) {
			console.log(`[${i + 1}] ${c.category}\t${c.expect}\t${c.prompt}`);
		}
		console.log(`\n用例集总数: ${CASES.length}`);
		const pos = CASES.filter((c) => c.expect === "memory").length;
		const neg = CASES.filter((c) => c.expect === "no-memory").length;
		console.log(`正例(expect=memory): ${pos} 条   反例(expect=no-memory): ${neg} 条`);
		if (cases.length !== CASES.length) {
			console.log(`（已按过滤条件选用 ${cases.length}/${CASES.length} 条）`);
		}
		return;
	}

	const cases = selectCases(opts);
	console.log(`\n=== 记忆检索触发评测：${cases.length}/${CASES.length} 条用例 ===`);

	// 模型：--model 或 settings.json 的 defaultProvider/defaultModel，最后 fallback providers[0]
	const store = new ProviderStore();
	const providers = await store.load();
	let providerSlug: string;
	let modelId: string;
	if (opts.model) {
		const slash = opts.model.indexOf("/");
		if (slash <= 0) {
			console.error("--model 需要 slug/modelId 形式");
			process.exit(2);
		}
		providerSlug = opts.model.slice(0, slash);
		modelId = opts.model.slice(slash + 1);
	} else {
		const { readFile } = await import("node:fs/promises");
		let settingsModel: { provider: string; modelId: string } | null = null;
		try {
			const settings = JSON.parse(
				await readFile(join(WA_PI_DIR, "settings.json"), "utf8"),
			);
			if (settings.defaultProvider && settings.defaultModel) {
				settingsModel = {
					provider: settings.defaultProvider,
					modelId: settings.defaultModel,
				};
			}
		} catch {
			/* settings.json 缺失/损坏 → fallback */
		}
		if (settingsModel) {
			const provider = providers.find(
				(p) => p.name.toLowerCase() === settingsModel!.provider.toLowerCase(),
			);
			if (provider && provider.models.some((m) => m.id === settingsModel!.modelId)) {
				providerSlug = slugifyProviderName(provider.name, []);
				modelId = settingsModel.modelId;
			} else {
				console.warn(
					`settings.json 默认模型 ${settingsModel.provider}/${settingsModel.modelId} 不在 providers.json，回退到第一个 provider`,
				);
				const p = providers[0];
				if (!p || p.models.length === 0) {
					console.error("providers.json 无可用 provider/模型，请先配置或用 --model 指定");
					process.exit(2);
				}
				providerSlug = slugifyProviderName(p.name, []);
				modelId = p.models[0]!.id;
			}
		} else {
			const p = providers[0];
			if (!p || p.models.length === 0) {
				console.error("providers.json 无可用 provider/模型，请先配置或用 --model 指定");
				process.exit(2);
			}
			providerSlug = slugifyProviderName(p.name, []);
			modelId = p.models[0]!.id;
		}
	}
	console.log(
		`模型: ${providerSlug}/${modelId}   thinking: ${opts.thinking ?? "(pi 默认)"}   单例超时: ${opts.timeoutSec}s   记忆策略: ${opts.policy}`,
	);

	// cwd 隔离（在用例开跑前确保就绪；失败即退出，不回退主工作区）
	const cwd = opts.cwd
		? resolve(opts.cwd)
		: join(repoRoot, ".worktrees", "eval-memory-trigger");
	ensureIsolatedCwd(cwd, repoRoot);
	console.log(`被测 cwd（隔离检出）: ${cwd}`);

	// 准备：prompts / 系统提示词（含 memoryPolicy + memorySnapshot）/ 扩展 / stub bridge
	await ensurePromptsConfig(PROMPTS_FILE);
	const segments =
		(await loadPromptSegments(PROMPTS_FILE)) ?? DEFAULT_PROMPT_SEGMENTS;
	const delegateRoster = buildDelegateRoster([], {}, join(WA_PI_DIR, "agents"));
	const composed = composePrompt(segments, {
		defaultBasePrompt: WA_PI_DEFAULT_BASE_PROMPT,
		delegateRoster,
		builtinSkillsDir: BUILTIN_SKILLS_DIR,
		// 与生产一致：按 memoryPolicyStyle 注入记忆策略引导（full/compact/none）
		memoryPolicy:
			opts.policy === "compact"
				? COMPACT_MEMORY_POLICY_PROMPT
				: opts.policy === "none"
					? ""
					: DEFAULT_MEMORY_POLICY_PROMPT,
		// 固定假快照：模拟生产把 L1 近期记忆注入的效果（答案不在快照里 → 应当主动检索）
		memorySnapshot: MEMORY_SNAPSHOT,
	});

	// 组装自检（重要）：Memory Policy 段必须真的注入，否则「段压根没注入却报通过率」是假结果
	const expectPolicy = opts.policy !== "none";
	const hasPolicy =
		composed.includes("## Memory Policy") && composed.includes("先查再答");
	if (hasPolicy !== expectPolicy) {
		console.error(
			`[FATAL] 系统提示词组装自检失败：policy=${opts.policy} 期望${expectPolicy ? "包含" : "不包含"} Memory Policy 段（含「先查再答」），实际${hasPolicy ? "包含" : "不包含"}。`,
		);
		console.error(
			`可能原因：${PROMPTS_FILE} 里 memory-policy 段被写了 content（用户覆盖会屏蔽 ctx.memoryPolicy）。请检查该文件。`,
		);
		process.exit(2);
	}
	if (!composed.includes(MEMORY_SNAPSHOT_HEADER)) {
		console.error(
			`[FATAL] 系统提示词组装自检失败：假记忆快照未注入（未找到「${MEMORY_SNAPSHOT_HEADER}」），评测前提不成立。`,
		);
		process.exit(2);
	}
	console.log(
		`系统提示词组装自检: Memory Policy 段 ${expectPolicy ? "已注入" : "已关闭（none）"}，假记忆快照已注入（${MEMORY_SNAPSHOT.length} 字符）`,
	);

	const tmpDir = join(WA_PI_DIR, "tmp", "eval-memory-trigger");
	await mkdir(tmpDir, { recursive: true });
	const promptFile = join(tmpDir, `sysprompt-${randomUUID()}.md`);
	await writeFile(promptFile, composed, "utf8");

	// 隔离记忆库目录：memory_* 真实读写落在其下，结束后清理（不污染真实记忆）
	const memRoot = join(WA_PI_DIR, "tmp", "eval-memory-trigger", randomUUID());
	await mkdir(memRoot, { recursive: true });

	await ensureProviderExtensionRegistered(store);
	await ensureBridgeExtension();
	const extensionPaths = buildAdditionalExtensionPaths();

	const stub = await startStubBridge(cwd, memRoot);
	const bridgeUrl = `http://127.0.0.1:${stub.port}`;

	const runs: CaseResult[][] = [];
	try {
		for (let round = 0; round < opts.repeat; round++) {
			if (opts.repeat > 1) console.log(`\n--- 第 ${round + 1}/${opts.repeat} 轮 ---`);
			const results: CaseResult[] = [];
			for (const [i, c] of cases.entries()) {
				process.stdout.write(
					`[${i + 1}/${cases.length}] ${c.category}/${c.expect}: ${c.prompt.slice(0, 30)}... `,
				);
				const r = await runOneCase(i, c, {
					promptFile,
					extensionPaths,
					bridgeUrl,
					bridgeToken: stub.token,
					stubCalls: stub.calls,
					provider: providerSlug,
					modelId,
					timeoutSec: opts.timeoutSec,
					thinking: opts.thinking,
					cwd,
					ensureExtensions: async () => {
						await ensureProviderExtensionRegistered(store);
						await ensureBridgeExtension();
					},
				});
				results.push(r);
				const { pass, reasons } = casePassed(r);
				process.stdout.write(
					`→ ${pass ? "PASS" : "FAIL"} 首查=${r.memorySearchIdx < 0 ? "✗" : r.memorySearchIdx + 1} 首派=${r.firstDelegateRound ?? "✗"} ` +
						`(${(r.elapsedMs / 1000).toFixed(1)}s)` +
						(r.error ? " ERR:" + r.error.slice(0, 50) : "") +
						(reasons.length ? " " + reasons.join("; ") : "") +
						"\n",
				);
			}
			runs.push(results);
		}
	} finally {
		stub.server.close();
		await rm(promptFile, { force: true }).catch(() => {});
		await rm(memRoot, { recursive: true, force: true }).catch(() => {});
	}

	// 汇总
	console.log("\n=== SUMMARY ===");
	const all = runs.flat();
	const stats = computeStats(all);

	// 逐条一行：序号/类别/expect/pass/耗时/首个工具调用
	console.log("\n--- 逐条结果 ---");
	for (const r of all) {
		const { pass } = casePassed(r);
		console.log(
			`[${r.index + 1}] ${r.category}\t${r.expect}\t${pass ? "PASS" : "FAIL"}\t${(r.elapsedMs / 1000).toFixed(1)}s\t首个工具=${r.toolsCalled[0] ?? "no-tools"}`,
		);
	}

	// 分类明细
	console.log("\n--- 分类明细 ---");
	for (const cat of CATEGORY_ORDER) {
		const catResults = all.filter((r) => r.category === cat);
		if (catResults.length === 0) continue;
		const catPassed = catResults.filter((r) => casePassed(r).pass).length;
		console.log(`${cat}: ${catPassed}/${catResults.length} 通过`);
	}

	console.log("\n--- 总表 ---");
	console.log(
		`总通过率 passRate: ${stats.passed}/${stats.total} = ${(stats.passRate * 100).toFixed(1)}%  (门禁阈值 ${(opts.threshold * 100).toFixed(1)}%)`,
	);
	console.log(
		`正例通过率 posRate: ${stats.posPassed}/${stats.posTotal} = ${(stats.posRate * 100).toFixed(1)}%`,
	);
	console.log(
		`反例通过率 negRate: ${stats.negPassed}/${stats.negTotal} = ${(stats.negRate * 100).toFixed(1)}%`,
	);

	console.log("\n--- 混淆矩阵（本次核心症状单列） ---");
	console.log(
		`该查却直接委派（未查记忆就先 delegate/fleet）: ${stats.confusion.missThenDelegate} 条  ← 核心症状`,
	);
	console.log(`该查却没查（也没委派）: ${stats.confusion.missNoLookup} 条`);
	console.log(`先派后查（查了但排在委派之后）: ${stats.confusion.delegateBeforeSearch} 条`);
	console.log(`不该查却查了: ${stats.confusion.wrongLookup} 条`);
	console.log(`超时/异常退出: ${stats.confusion.errors} 条`);

	const tokenVals = all.filter((r) => r.tokens > 0).map((r) => r.tokens);
	console.log(
		`\ntoken（有统计的用例 ${tokenVals.length}/${all.length}）: ` +
			(tokenVals.length > 0
				? `均值 ${(tokenVals.reduce((s, v) => s + v, 0) / tokenVals.length / 1000).toFixed(1)}k`
				: "无"),
	);
	console.log(
		`总耗时: ${(all.reduce((s, r) => s + r.elapsedMs, 0) / 1000).toFixed(1)}s   重试用例: ${all.filter((r) => r.retries > 0).length}`,
	);

	// 报告落盘（门禁失败也要先落盘，保证证据留存）
	const outPath =
		opts.out ?? join(WA_PI_DIR, `eval-memory-trigger-${Date.now()}.json`);
	await writeFile(
		outPath,
		JSON.stringify(
			{
				model: `${providerSlug}/${modelId}`,
				thinking: opts.thinking,
				policy: opts.policy,
				cwd,
				at: new Date().toISOString(),
				repeat: opts.repeat,
				threshold: opts.threshold,
				passRate: stats.passRate,
				posRate: stats.posRate,
				negRate: stats.negRate,
				stats,
				runs,
			},
			null,
			2,
		),
		"utf8",
	);
	console.log(`结果已写入: ${outPath}`);

	// 硬门禁：passRate 低于阈值 → 打印失败原因后非零退出
	if (gateFails(stats, opts.threshold)) {
		console.error(
			`\n[GATE FAILED] 总通过率 ${(stats.passRate * 100).toFixed(1)}% < 阈值 ${(opts.threshold * 100).toFixed(1)}%`,
		);
		for (const r of all.filter((r) => !casePassed(r).pass)) {
			console.error(
				`  - [${r.category}/${r.expect}] ${r.prompt.slice(0, 30)} → ${casePassed(r).reasons.join("; ")}`,
			);
		}
		process.exit(1);
	}
}

// 仅在作为入口直接运行时执行（供临时验证脚本 import 判定/统计/门禁函数做合成验证）
if (import.meta.main) {
	main().catch((e) => {
		console.error("EVAL FAILED:", e);
		process.exit(1);
	});
}

export { casePassed, computeStats, gateFails, CASES, EXPECTED_CASES };
export type { CaseResult, EvalStats, Case, Category, Expect };
