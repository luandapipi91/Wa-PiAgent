#!/usr/bin/env bun
// eval-memory-write.ts — 记忆写入冒烟评测
//
// 目标：验证在日常使用（真实 pi 进程 + 真实系统提示词 + wa-pi-bridge 扩展注册的
// memory_* 工具）下，agent 能主动把「用户记忆」与「项目记忆」正确写入：
// - 用户记忆：target=user → 全局记忆（scope=global，kind=profile）
// - 项目记忆：target=memory → 项目记忆（scope=project，project_id=<cwd basename>）
//
// 与 eval-delegate-trigger.ts 同构（同一评测骨架）：
// - 系统提示词：composePrompt(prompts.json segments, { defaultBasePrompt, delegateRoster, builtinSkillsDir })
// - 工具面：默认排除式（不传 --tools，仅 -xt subagent）+ 全套扩展（provider-extension + wa-pi-bridge）
// - 与生产一致的部分（保证测的就是线上行为）：memory 工具由 wa-pi-bridge 扩展注册，
//   agent 调用 memory_add 经 HTTP 回调 bridge；本脚本的 bridge stub 直接复用 kernel 的
//   memory/tools 工具集（createMemoryTools + MemoryDao），与 makeDefaultBridgeContext 同源
//   ——写入的是隔离 memRoot 下的 memories.db，不污染真实记忆。
//
// 用法：
//   bun run scripts/eval-memory-write.ts [--limit N] [--sample N] [--category user,project,mixed]
//     [--repeat N] [--model slug/modelId] [--thinking off|low|medium|high|xhigh]
//     [--dry-run] [--out path] [--timeout sec] [--mem-root path]
//   --sample N：每类各取前 N 条（冒烟推荐 --sample 1）；--mem-root：隔离记忆库所在目录
//   （memories.db 落在其下；默认 <WA_PI_DIR>/tmp/eval-memory-write/<uuid>，自动清理）
//
// 判定标准（每个用例）：
//   1. agent 调用了 memory_add（写入动作发生）
//   2. 路由正确：user 类用例 target=user；project 类用例 target=memory；mixed 类两类都有
//   3. 落库生效：隔离记忆库中存在对应 scope/target 的条目
// 汇总时给出「写入通过率」，任何用例 3 项全过才算 PASS。

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
// ---- 用例集（正例 32 条 + 反例 12 条）----
// user：应写 target=user（默认 → 全局）——用户偏好 / 身份与环境
// project：应写 target=memory（默认 → 项目）——项目决策与约定
// mixed：应同时写用户信息 + 项目信息（两类都要落盘）
// implicit（隐形记忆）：用户未说「记住」，但对话中自然透露了值得跨会话保留的信息，
//   agent 应主动识别并写入（这是本评测的核心场景——自动判断而不是等显式指令）
// negative（反例）：正常对话但**不该**写记忆——闲聊 / 纯查询与操作请求 / 一次性细节 /
//   用户明确说不用记 / 临时状态。反例一律 expectUser=false + expectProject=false，
//   只要出现任何 memory_add 就算误触发。
// 执行流水（已完成动作 + 结论）：expectKind="execution"，要求至少一条写入带 kind=execution
//   （系统提示词规定「完成一件有跨会话价值的事 → memory_add(kind=execution)」）。
type Category = "user" | "project" | "mixed" | "implicit" | "negative";

/** 用例意图标签：仅用于 --dry-run 的意图分布自检，不参与判定 */
type Intent = "preference" | "identity" | "decision" | "execution" | "none";

interface MemoryCase {
	category: Category;
	prompt: string;
	/** 期望出现 target=user 的 memory_add */
	expectUser: boolean;
	/** 期望出现 target=memory 的 memory_add */
	expectProject: boolean;
	/** 期望出现 kind=execution 的 memory_add（执行流水类用例） */
	expectKind?: "execution";
	/** 意图标签（偏好 / 身份环境 / 项目决策 / 执行流水 / 反例） */
	intent?: Intent;
}

const CASES: MemoryCase[] = [
	// --- user (9)：用户记忆 → 全局作用域（偏好 4 + 身份/环境 5）---
	{
		category: "user",
		prompt:
			"请记住我的用户信息：我叫 Alex，是 wa-pi 项目的维护者，日常使用中文沟通。请把这条用户画像保存到记忆里。",
		expectUser: true,
		expectProject: false,
		intent: "identity",
	},
	{
		category: "user",
		prompt:
			"用户刚才告诉我：他喜欢用 pnpm 而不是 npm。请把这条用户偏好写入记忆。",
		expectUser: true,
		expectProject: false,
		intent: "preference",
	},
	{
		category: "user",
		prompt: "记住用户的偏好：回复要简洁直接，不要长篇大论。",
		expectUser: true,
		expectProject: false,
		intent: "preference",
	},
	{
		category: "user",
		prompt:
			"用户是 Windows 环境开发者，使用 VS Code 作为编辑器。请记住这条用户信息。",
		expectUser: true,
		expectProject: false,
		intent: "identity",
	},
	{
		category: "user",
		prompt: "我习惯用 fd 代替 find，以后给我命令都按 fd 的写法来。",
		expectUser: true,
		expectProject: false,
		intent: "preference",
	},
	{
		category: "user",
		prompt: "我写 TypeScript 喜欢用 tab 缩进（宽度算 2），格式化就按这个风格来。",
		expectUser: true,
		expectProject: false,
		intent: "preference",
	},
	{
		category: "user",
		prompt: "我叫 co，GitHub 上也是这个 ID，shell 用 zsh + starship。",
		expectUser: true,
		expectProject: false,
		intent: "identity",
	},
	{
		category: "user",
		prompt: "我这边是 M2 MacBook，16G 内存，别建议我跑太重的并行任务。",
		expectUser: true,
		expectProject: false,
		intent: "identity",
	},
	{
		category: "user",
		prompt: "我的仓库都放在 ~/Documents/work 下面，编辑器主要用 Cursor。",
		expectUser: true,
		expectProject: false,
		intent: "identity",
	},
	// --- project (8)：项目记忆 → 项目作用域（决策/约定）---
	{
		category: "project",
		prompt: "记住这个项目的约定：所有测试必须覆盖单元、组件、API、E2E 四层。",
		expectUser: false,
		expectProject: true,
		intent: "decision",
	},
	{
		category: "project",
		prompt: "记住本项目使用 Bun 作为运行时和包管理器，测试用 bun:test。",
		expectUser: false,
		expectProject: true,
		intent: "decision",
	},
	{
		category: "project",
		prompt:
			"项目约定：新增功能必须更新 CHANGELOG.md，提交信息遵循 Conventional Commits。请记住。",
		expectUser: false,
		expectProject: true,
		intent: "decision",
	},
	{
		category: "project",
		prompt:
			"记住：这个仓库是 monorepo，前端在 packages/frontend，内核在 packages/kernel。",
		expectUser: false,
		expectProject: true,
		intent: "decision",
	},
	{
		category: "project",
		prompt: "我们讨论后定了：日志统一走 pino，不再用 console.log 打点。",
		expectUser: false,
		expectProject: true,
		intent: "decision",
	},
	{
		category: "project",
		prompt: "项目约定：所有对外接口的参数都用 typebox 写 schema 校验。",
		expectUser: false,
		expectProject: true,
		intent: "decision",
	},
	{
		category: "project",
		prompt: "前端状态管理最终定了 zustand，不引入 Redux。",
		expectUser: false,
		expectProject: true,
		intent: "decision",
	},
	{
		category: "project",
		prompt: "这个项目里 commit 信息统一用中文写。",
		expectUser: false,
		expectProject: true,
		intent: "decision",
	},
	// --- mixed (4)：一次会话同时写用户记忆 + 项目记忆 ---
	{
		category: "mixed",
		prompt:
			"用户说他是这个项目的主力开发者，同时让我记住：本项目部署用 Electron + Vite。请把用户信息和项目信息分别写入记忆。",
		expectUser: true,
		expectProject: true,
		intent: "identity",
	},
	{
		category: "mixed",
		prompt:
			"请记住：用户希望所有文档用中文撰写；另外记住本项目的约定：代码注释使用中文。请分别保存到合适的记忆文件。",
		expectUser: true,
		expectProject: true,
		intent: "decision",
	},
	{
		category: "mixed",
		prompt:
			"我这个人在代码里不留 TODO，看到就顺手清掉；项目这边刚统一了 lint 走 biome。",
		expectUser: true,
		expectProject: true,
		intent: "preference",
	},
	{
		category: "mixed",
		prompt:
			"用户说他常用 fish shell；另外我刚把 kernel 的构建脚本从 tsc 换成 bun build 了。",
		expectUser: true,
		expectProject: true,
		expectKind: "execution",
		intent: "execution",
	},
	// --- implicit (11)：隐形记忆——无「记住」指令，agent 应根据对话内容自动判断写入 ---
	// implicit-user：对话中自然透露用户偏好/身份/工具链
	{
		category: "implicit",
		prompt: "我平时都用 pnpm 装依赖，npm 用得少。",
		expectUser: true,
		expectProject: false,
		intent: "preference",
	},
	{
		category: "implicit",
		prompt: "这个报错帮我看看——对了，我这边是 macOS，Node 20。",
		expectUser: true,
		expectProject: false,
		intent: "identity",
	},
	// implicit-project：对话中确认项目技术选型/约定/决策
	{
		category: "implicit",
		prompt:
			"我们决定用 Vitest 替代 Jest 跑组件测试，统一走 @testing-library/react。",
		expectUser: false,
		expectProject: true,
		intent: "decision",
	},
	{
		category: "implicit",
		prompt:
			"CI 用的是 GitHub Actions，打包走 Electron Builder，发布到 GitHub Releases。",
		expectUser: false,
		expectProject: true,
		intent: "decision",
	},
	// implicit-mixed：同一段对话同时透露用户信息 + 项目信息
	{
		category: "implicit",
		prompt:
			"我是这个项目的主力，平时用 Windows 开发。项目这边刚定了用 Bun 替代 Node 作为运行时。",
		expectUser: true,
		expectProject: true,
		intent: "identity",
	},
	{
		category: "implicit",
		prompt:
			"用户希望回复简洁直接；另外这次明确了项目约定：commit 信息必须用中文写。",
		expectUser: true,
		expectProject: true,
		intent: "decision",
	},
	// implicit-execution（执行流水）：已完成的动作 + 结论，期望 kind=execution 的项目记忆
	{
		category: "implicit",
		prompt:
			"我刚把 kernel 的 SQLite 连接改成 WAL 模式了，并发写不再报 SQLITE_BUSY。",
		expectUser: false,
		expectProject: true,
		expectKind: "execution",
		intent: "execution",
	},
	{
		category: "implicit",
		prompt:
			"这次排查出根因是 stub bridge 没注册 sessionId 映射，改完已经验证通过了。",
		expectUser: false,
		expectProject: true,
		expectKind: "execution",
		intent: "execution",
	},
	{
		category: "implicit",
		prompt: "刚把前端记忆面板的层标签加上，L1/L2/L3 现在能区分显示了。",
		expectUser: false,
		expectProject: true,
		expectKind: "execution",
		intent: "execution",
	},
	// implicit 补充：偏好/身份 + 约定
	{
		category: "implicit",
		prompt: "我用的是 fish shell，路径都习惯用 ~ 简写。",
		expectUser: true,
		expectProject: false,
		intent: "identity",
	},
	{
		category: "implicit",
		prompt: "我们这边定了个规矩：新接口先写测试再写实现。",
		expectUser: false,
		expectProject: true,
		intent: "decision",
	},
	// --- negative (12)：反例——正常对话但不该写记忆（任何 memory_add 都算误触发）---
	// 闲聊
	{
		category: "negative",
		prompt: "今天天气不错啊，随便聊聊。",
		expectUser: false,
		expectProject: false,
		intent: "none",
	},
	{
		category: "negative",
		prompt: "你觉得程序员这个职业未来几年会怎么变？",
		expectUser: false,
		expectProject: false,
		intent: "none",
	},
	// 纯查询请求
	{
		category: "negative",
		prompt: "帮我读一下 packages/kernel/src/memory/dao.ts 的前 50 行。",
		expectUser: false,
		expectProject: false,
		intent: "none",
	},
	{
		category: "negative",
		prompt: "dao.ts 里 list 这个方法在哪定义的？",
		expectUser: false,
		expectProject: false,
		intent: "none",
	},
	// 纯操作请求
	{
		category: "negative",
		prompt: "把 README.md 里写错的「修该」改成「修改」。",
		expectUser: false,
		expectProject: false,
		intent: "none",
	},
	{
		category: "negative",
		prompt: '帮我把这段 JSON 格式化成 2 空格缩进：{"a":1,"b":[1,2,3]}',
		expectUser: false,
		expectProject: false,
		intent: "none",
	},
	// 一次性细节
	{
		category: "negative",
		prompt:
			"这次报错的堆栈是 TypeError: Cannot read properties of undefined (reading 'port')，在 desktop-server.ts 第 412 行。",
		expectUser: false,
		expectProject: false,
		intent: "none",
	},
	{
		category: "negative",
		prompt: "临时文件我放 /tmp/wa-pi-scratch-20260916 了，用完可以直接删。",
		expectUser: false,
		expectProject: false,
		intent: "none",
	},
	{
		category: "negative",
		prompt: "这个文件我刚改了两行，你 diff 一下看看对不对。",
		expectUser: false,
		expectProject: false,
		intent: "none",
	},
	// 用户明确表示不需要记
	{
		category: "negative",
		prompt: "这个不用记，我就随口问一句。",
		expectUser: false,
		expectProject: false,
		intent: "none",
	},
	{
		category: "negative",
		prompt: "别把这条写进记忆，我只是临时试一下。",
		expectUser: false,
		expectProject: false,
		intent: "none",
	},
	// 临时状态
	{
		category: "negative",
		prompt: "我先重启一下服务，你稍等我一下。",
		expectUser: false,
		expectProject: false,
		intent: "none",
	},
];

// ---- CLI 参数 ----
interface CliOpts {
	limit: number;
	sample: number;
	categories: Category[] | null;
	repeat: number;
	model: string | null;
	thinking: string | null;
	dryRun: boolean;
	out: string | null;
	timeoutSec: number;
	memRoot: string | null;
	policy: "full" | "compact" | "none";
}

function parseArgs(argv: string[]): CliOpts {
	const opts: CliOpts = {
		limit: CASES.length,
		sample: 0,
		categories: null,
		repeat: 1,
		model: null,
		thinking: null,
		dryRun: false,
		out: null,
		timeoutSec: 180,
		memRoot: null,
		policy: "full",
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
			case "--dry-run":
				opts.dryRun = true;
				break;
			case "--out":
				opts.out = argv[++i]!;
				break;
			case "--timeout":
				opts.timeoutSec = parseInt(argv[++i]!, 10);
				break;
			case "--mem-root":
				opts.memRoot = argv[++i]!;
				break;
			case "--policy": {
				const v = argv[++i]!;
				if (v !== "full" && v !== "compact" && v !== "none") {
					console.error(`--policy 需要 full/compact/none`);
					process.exit(2);
				}
				opts.policy = v;
				break;
			}
			default:
				console.error(`未知参数: ${argv[i]}`);
				process.exit(2);
		}
	}
	return opts;
}

/** 选用例：--category 过滤类别；--sample N = 每类前 N 条；否则前 --limit 条 */
function selectCases(opts: CliOpts): typeof CASES {
	let pool = CASES;
	if (opts.categories && opts.categories.length > 0) {
		pool = pool.filter((c) => opts.categories!.includes(c.category));
	}
	if (opts.sample > 0) {
		const picked: typeof CASES = [];
		for (const cat of ["user", "project", "mixed", "implicit"] as const) {
			picked.push(...pool.filter((c) => c.category === cat).slice(0, opts.sample));
		}
		return picked;
	}
	return pool.slice(0, Math.max(0, Math.min(opts.limit, pool.length)));
}

// ---- stub bridge server：memory_* 调用走真实记忆工具集，写入隔离记忆库 ----
interface MemoryCall {
	tool: string;
	params: any;
	at: string;
}

interface StubBridge {
	server: Server;
	port: number;
	token: string;
	calls: MemoryCall[];
	/** 注册 sessionId → 用例记忆根目录（每个用例独立目录，避免互相污染） */
	setCaseRoot: (sessionId: string, root: string) => void;
}

/**
 * 真实处理一次 memory_* 调用：与 kernel makeDefaultBridgeContext 同源——直接跑 memory/tools
 * 的工具集（同一份实现），按 target+scope 路由写入隔离目录下的 memories.db。
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
		/* 非 JSON 返回（理论上不会出现）按成功处理 */
	}
	return { ok, text };
}

function startStubBridge(cwd: string): Promise<StubBridge> {
	const token = randomUUID();
	const calls: MemoryCall[] = [];
	const caseRoots = new Map<string, string>(); // sessionId → memRoot
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
			const params = msg.params ?? {};
			calls.push({ tool, params, at: new Date().toISOString() });
			// 按 sessionId 定位用例记忆根目录（默认顶层 memRoot，兼容未注册场景）
			const root = caseRoots.get(String(msg.sessionId ?? "")) ?? "";
			// 只对 memory_* 做真实落盘，其余工具（delegate/fleet/ask 等）直接应答
			const isMemory = tool.startsWith("memory_") && root !== "";
			Promise.resolve(
				isMemory
					? handleMemoryTool(tool, params, root, cwd)
					: { ok: true, text: "（评测桩：ok）" },
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
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			resolve({
				server,
				port: typeof addr === "object" && addr ? addr.port : 0,
				token,
				calls,
				setCaseRoot: (sessionId: string, root: string) =>
					caseRoots.set(sessionId, root),
			});
		});
	});
}

/** 真实落库验证：用例结束后查隔离记忆库（memories.db）里是否有该范围的条目 */
function hasEntry(
	memRoot: string,
	scope: "global" | "project",
	target: "user" | "memory",
): boolean {
	const dao = new MemoryDao(openMemoryDb(memRoot));
	return dao.list({ scope }).some((r) => r.target === target);
}

// ---- 单用例执行 ----
interface CaseResult {
	index: number;
	category: Category;
	prompt: string;
	expectUser: boolean;
	expectProject: boolean;
	memoryAdds: Array<{ target: string; scope?: string; content: string }>;
	toolsCalled: string[];
	userEntryExists: boolean;
	projectEntryExists: boolean;
	elapsedMs: number;
	error?: string;
}

async function runOneCase(
	index: number,
	c: MemoryCase,
	ctx: {
		promptFile: string;
		extensionPaths: string[];
		bridgeUrl: string;
		bridgeToken: string;
		stubCalls: MemoryCall[];
		provider: string;
		modelId: string;
		thinking: string | null;
		timeoutSec: number;
		memRoot: string;
		setCaseRoot: (sessionId: string, root: string) => void;
		ensureExtensions: () => Promise<void>;
	},
	attempt = 0,
): Promise<CaseResult> {
	const startedAt = Date.now();
	const result: CaseResult = {
		index,
		category: c.category,
		prompt: c.prompt,
		expectUser: c.expectUser,
		expectProject: c.expectProject,
		memoryAdds: [],
		toolsCalled: [],
		userEntryExists: false,
		projectEntryExists: false,
		elapsedMs: 0,
	};
	const sessionId = `eval-memory-${randomUUID()}`;
	const stubMark = ctx.stubCalls.length; // 本用例前的 stub 调用数，用例后取增量
	// 注册本用例的记忆根目录，使 stub bridge 的真实落盘落在独立 case 目录
	ctx.setCaseRoot(sessionId, ctx.memRoot);

	let settled!: () => void;
	const settledPromise = new Promise<void>((resolve) => {
		settled = resolve;
	});
	const onEvent = (e: RpcEvent) => {
		if (
			e.type === "tool_execution_start" &&
			typeof (e as any).toolName === "string"
		) {
			result.toolsCalled.push((e as any).toolName);
		}
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
		cwd: join(import.meta.dir, "../../.."), // 仓库根：项目记忆按此 cwd basename 落盘
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
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		try {
			await client.abort();
		} catch (e) {
			void e; /* 忽略 */
		}
	} finally {
		await client.dispose().catch(() => {});
	}

	// pi 进程启动即退出（多为 .generated 被外部并发清理）→ 重试一次
	if (result.error?.includes("pi rpc 进程已退出") && attempt < 1) {
		return runOneCase(index, c, ctx, attempt + 1);
	}

	// 从 stub 增量里提取本用例的 memory_add 调用
	for (const call of ctx.stubCalls.slice(stubMark)) {
		if (call.tool === "memory_add") {
			result.memoryAdds.push({
				target: String(call.params.target ?? ""),
				scope:
					call.params.scope === undefined ? undefined : String(call.params.scope),
				content: String(call.params.content ?? ""),
			});
		}
	}

	// 落库验证：全局 user 条目与项目 memory 条目（每次用例独立库，故不必再按 project_id 过滤）
	result.userEntryExists = hasEntry(ctx.memRoot, "global", "user");
	result.projectEntryExists = hasEntry(ctx.memRoot, "project", "memory");

	result.elapsedMs = Date.now() - startedAt;
	return result;
}

/** 单用例判定：是否通过（写入发生 + 路由正确 + 落盘生效） */
function casePassed(r: CaseResult): { pass: boolean; reasons: string[] } {
	const reasons: string[] = [];
	const hasUser = r.memoryAdds.some((m) => m.target === "user");
	const hasProject = r.memoryAdds.some((m) => m.target === "memory");

	if (r.memoryAdds.length === 0) reasons.push("未调用 memory_add");
	if (r.expectUser && !hasUser) reasons.push("期望 target=user 的写入，未出现");
	if (!r.expectUser && hasUser)
		reasons.push(
			`不期望 target=user，却写入 (${r.memoryAdds.filter((m) => m.target === "user").length} 次)`,
		);
	if (r.expectProject && !hasProject)
		reasons.push("期望 target=memory 的写入，未出现");
	if (!r.expectProject && hasProject)
		reasons.push(
			`不期望 target=memory，却写入 (${r.memoryAdds.filter((m) => m.target === "memory").length} 次)`,
		);

	// 落库：user 类/mixed 类要求全局 user 条目生效；project 类/mixed 类要求项目条目生效
	if (r.expectUser && !r.userEntryExists)
		reasons.push("全局 user 记忆未入库");
	if (r.expectProject && !r.projectEntryExists)
		reasons.push("项目记忆未入库");

	return { pass: reasons.length === 0, reasons };
}

// ---- main ----
async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const cases = selectCases(opts);
	console.log(`\n=== 记忆写入评测：${cases.length}/${CASES.length} 条用例 ===`);

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
		// 优先读 settings.json 的默认模型（对齐用户实际日常使用），fallback 第一个 provider
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
			// provider 名大小写不敏感匹配（settings.json 的 defaultProvider 可能为小写）
			const provider = providers.find(
				(p) => p.name.toLowerCase() === settingsModel!.provider.toLowerCase(),
			);
			if (
				provider &&
				provider.models.some((m) => m.id === settingsModel!.modelId)
			) {
				providerSlug = slugifyProviderName(provider.name, []);
				modelId = settingsModel.modelId;
			} else {
				console.warn(
					`settings.json 默认模型 ${settingsModel.provider}/${settingsModel.modelId} 不在 providers.json，回退到第一个 provider`,
				);
				const p = providers[0];
				if (!p || p.models.length === 0) {
					console.error(
						"providers.json 无可用 provider/模型，请先配置或用 --model 指定",
					);
					process.exit(2);
				}
				providerSlug = slugifyProviderName(p.name, []);
				modelId = p.models[0]!.id;
			}
		} else {
			const p = providers[0];
			if (!p || p.models.length === 0) {
				console.error(
					"providers.json 无可用 provider/模型，请先配置或用 --model 指定",
				);
				process.exit(2);
			}
			providerSlug = slugifyProviderName(p.name, []);
			modelId = p.models[0]!.id;
		}
	}
	console.log(
		`模型: ${providerSlug}/${modelId}   thinking: ${opts.thinking ?? "(pi 默认)"}   单例超时: ${opts.timeoutSec}s   记忆策略: ${opts.policy}`,
	);

	if (opts.dryRun) {
		for (const [i, c] of cases.entries()) {
			console.log(`[${i + 1}] ${c.category}: ${c.prompt.slice(0, 50)}`);
		}
		return;
	}

	// 隔离记忆库目录：memories.db 落在其下；默认 <WA_PI_DIR>/tmp/eval-memory-write/<uuid>，结束时清理
	const memRoot =
		opts.memRoot ?? join(WA_PI_DIR, "tmp", "eval-memory-write", randomUUID());
	await mkdir(memRoot, { recursive: true });
	console.log(`隔离记忆库目录: ${memRoot}（memories.db，不污染真实记忆）`);

	// 准备：prompts / 系统提示词 / 扩展 / stub bridge
	await ensurePromptsConfig(PROMPTS_FILE);
	const segments =
		(await loadPromptSegments(PROMPTS_FILE)) ?? DEFAULT_PROMPT_SEGMENTS;
	const agentsDir = join(WA_PI_DIR, "agents");
	const delegateRoster = buildDelegateRoster([], {}, agentsDir);
	const composed = composePrompt(segments, {
		defaultBasePrompt: WA_PI_DEFAULT_BASE_PROMPT,
		delegateRoster,
		builtinSkillsDir: BUILTIN_SKILLS_DIR,
		// 与生产一致：按 memoryPolicyStyle 注入记忆写入策略引导（full/compact/none）
		memoryPolicy:
			opts.policy === "compact"
				? COMPACT_MEMORY_POLICY_PROMPT
				: opts.policy === "none"
					? ""
					: DEFAULT_MEMORY_POLICY_PROMPT,
	});
	const tmpDir = join(WA_PI_DIR, "tmp", "eval-memory-write");
	await mkdir(tmpDir, { recursive: true });
	const promptFile = join(tmpDir, `sysprompt-${randomUUID()}.md`);
	await writeFile(promptFile, composed, "utf8");

	await ensureProviderExtensionRegistered(store);
	await ensureBridgeExtension();
	const extensionPaths = buildAdditionalExtensionPaths();

	const stub = await startStubBridge(join(import.meta.dir, "../../.."));
	const bridgeUrl = `http://127.0.0.1:${stub.port}`;

	const runs: CaseResult[][] = [];
	try {
		for (let round = 0; round < opts.repeat; round++) {
			if (opts.repeat > 1)
				console.log(`\n--- 第 ${round + 1}/${opts.repeat} 轮 ---`);
			const results: CaseResult[] = [];
			for (const [i, c] of cases.entries()) {
				// 每个用例独立记忆子目录，避免用例间互相污染
				const caseMemRoot = join(memRoot, `case-${i + 1}`);
				await mkdir(caseMemRoot, { recursive: true });
				// 用例的 sessionId 在 runOneCase 内部生成，无法预知；改为在 runOneCase 里注册。
				// 这里先透传 caseMemRoot，runOneCase 通过 ctx.setCaseRoot 注册映射。
				process.stdout.write(
					`[${i + 1}/${cases.length}] ${c.category}: ${c.prompt.slice(0, 40)}... `,
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
					memRoot: caseMemRoot,
					setCaseRoot: stub.setCaseRoot,
					ensureExtensions: async () => {
						await ensureProviderExtensionRegistered(store);
						await ensureBridgeExtension();
					},
				});
				results.push(r);
				const { pass, reasons } = casePassed(r);
				const adds = r.memoryAdds.length
					? r.memoryAdds
							.map((m) => `${m.target}${m.scope ? `@${m.scope}` : ""}`)
							.join(",")
					: "none";
				const files = `${r.userEntryExists ? "USER✓" : "USER✗"}/${r.projectEntryExists ? "MEM✓" : "MEM✗"}`;
				process.stdout.write(
					`→ ${pass ? "PASS" : "FAIL"} [${adds}] [${files}] (${(r.elapsedMs / 1000).toFixed(1)}s)` +
						(r.error ? " ERR:" + r.error.slice(0, 60) : "") +
						(reasons.length ? " " + reasons.join("; ") : "") +
						"\n",
				);
			}
			runs.push(results);
		}
	} finally {
		stub.server.close();
		await rm(promptFile, { force: true }).catch(() => {});
		// 默认隔离目录自动清理（--mem-root 显式指定时保留供人工检查）
		if (!opts.memRoot) {
			await rm(memRoot, { recursive: true, force: true }).catch(() => {});
		}
	}

	// 汇总
	console.log("\n=== SUMMARY ===");
	const all = runs.flat();
	let passed = 0;
	for (const cat of ["user", "project", "mixed", "implicit"] as const) {
		const catResults = all.filter((r) => r.category === cat);
		if (catResults.length === 0) continue;
		const catPassed = catResults.filter((r) => casePassed(r).pass).length;
		passed += catPassed;
		console.log(`${cat}: ${catPassed}/${catResults.length} 通过`);
	}
	console.log(`合计: ${passed}/${all.length} 通过`);
	const userWrites = all.filter((r) =>
		r.memoryAdds.some((m) => m.target === "user"),
	).length;
	const projectWrites = all.filter((r) =>
		r.memoryAdds.some((m) => m.target === "memory"),
	).length;
	console.log(
		`写入动作统计: 含 user 写入的用例 ${userWrites}，含 memory(项目) 写入的用例 ${projectWrites}`,
	);
	console.log(`错误用例: ${all.filter((r) => r.error).length}`);
	console.log(
		`总耗时: ${(all.reduce((s, r) => s + r.elapsedMs, 0) / 1000).toFixed(1)}s`,
	);

	if (opts.memRoot) {
		console.log(`记忆目录保留: ${memRoot}`);
	}

	const outPath =
		opts.out ?? join(WA_PI_DIR, `eval-memory-write-${Date.now()}.json`);
	await writeFile(
		outPath,
		JSON.stringify(
			{
				model: `${providerSlug}/${modelId}`,
				thinking: opts.thinking,
				at: new Date().toISOString(),
				repeat: opts.repeat,
				memRoot,
				runs,
			},
			null,
			2,
		),
		"utf8",
	);
	console.log(`结果已写入: ${outPath}`);
}

main().catch((e) => {
	console.error("EVAL FAILED:", e);
	process.exit(1);
});
