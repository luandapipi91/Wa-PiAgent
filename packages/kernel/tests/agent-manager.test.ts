// agent-manager.test.ts — AgentManager（pi RPC 子进程架构）单元测试
//
// RPC 迁移后 AgentManager 不再 import @earendil-works/pi-coding-agent 的 SDK API：
// 每个会话对应一个 `pi --mode rpc` 子进程（RpcClient 驱动），steer/followUp 队列
// 由 kernel 自管（busy 状态机靠 agent_start/agent_settled/turn_end 事件）。
// 测试经 createClientFn 注入 FakeSessionClient（tests/fixtures/fake-session-client.ts）：
// - prompted/steered/models/thinkingLevels/aborts 记录全部调用供断言；
// - emit(e) 手动注入 pi 事件驱动状态机；autoSettle=false 模拟 agent 运行中（不自动 settled）；
// - simulateCrash() 模拟进程意外退出。
// 系统提示词经 --system-prompt <file> 传入 pi：测试同步读
// WA_PI_DIR/tmp/sysprompts/<sessionId>.md 断言组合结果（afterEach 统一清理）。
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
	AgentManager,
	WA_PI_DEFAULT_SYSTEM_PROMPT,
} from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import {
	FakeSessionClient,
	fakeClientFactory,
} from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import { getBridgeSession } from "../src/bridge-registry";
import { askRegistry } from "../src/ask-registry";
import { extUiRegistry } from "../src/ext-ui-registry";
import { SkillManager } from "../src/skill-manager";
import { getGlobalMemoryStore } from "../src/amaster-memory";
import {
	WA_PI_DIR,
	BUILTIN_SKILLS_DIR,
	DEFAULT_AGENT_TOOLS,
} from "@wa-pi/shared";
import type { AskParams, ThinkingLevel } from "@wa-pi/shared";
import type { RpcClient, RpcClientOpts } from "../src/rpc-client";
import {
	existsSync,
	readFileSync,
	rmSync,
	mkdirSync,
	writeFileSync,
	openSync,
	ftruncateSync,
	closeSync,
} from "node:fs";
import { join } from "node:path";

const MODEL = "anthropic/test-model";

// 测试过程产生的临时文件 / AgentManager / 系统提示词临时文件，afterEach 统一清理
const tmpPaths: string[] = [];
const managers: AgentManager[] = [];
const syspromptSessionIds: string[] = [];

beforeEach(() => {
	askRegistry.reset();
	extUiRegistry.reset();
});

afterEach(async () => {
	for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
	for (const f of tmpPaths.splice(0)) {
		try {
			rmSync(f, { force: true, recursive: true });
		} catch {
			// 尽力清理临时文件，失败静默（不干扰测试结果）
		}
	}
	for (const id of syspromptSessionIds.splice(0)) {
		try {
			rmSync(syspromptPath(id), { force: true });
		} catch {
			// 尽力清理系统提示词临时文件，失败静默
		}
	}
});

function newProjectStore() {
	const tmpFile = `/tmp/wa-pi-am-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	tmpPaths.push(tmpFile);
	return new ProjectStore(tmpFile);
}

/** 组合系统提示词的临时文件路径（pi --system-prompt 的入参） */
function syspromptPath(sessionId: string) {
	return join(WA_PI_DIR, "tmp", "sysprompts", `${sessionId}.md`);
}

function readSysprompt(sessionId: string): string {
	return readFileSync(syspromptPath(sessionId), "utf8");
}

/** 轮询等待条件满足（发送前自动压缩检查引入异步延迟，drain 需异步等待） */
async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!fn()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
		await new Promise((r) => setTimeout(r, 5));
	}
}

type CapturedEvent = {
	sessionId: string;
	projectId: string;
	agentName: string;
	e: any;
};

interface SetupOpts {
	configStore?: any;
	memoryStore?: { getConfig(): Promise<any> };
	skillManager?: SkillManager;
	/** 注入 extensionManager 桩（getCommands 合并命令开关状态用；any 便于测试桩） */
	extensionManager?: any;
	events?: CapturedEvent[];
	/** 覆盖默认 fakeClientFactory（如慢启动 / 启动失败 / 预置消息） */
	createClientFn?: (opts: RpcClientOpts) => RpcClient;
	/** abort RPC 无响应的兜底超时（ms），透传 AgentManagerOpts.abortTimeoutMs */
	abortTimeoutMs?: number;
	agentName?: string;
}

/** 造测试项目 + 会话实体 + 注入 fake client 的 AgentManager */
async function setup(opts: SetupOpts = {}) {
	const projectStore = newProjectStore();
	const project = await projectStore.createProject({
		name: "测试",
		cwd: "/tmp",
	});
	const agentName = opts.agentName ?? "dev";
	const session = await projectStore.createSession({
		projectId: project.id,
		primaryAgent: agentName,
		title: "测试",
	});
	const fakes: FakeSessionClient[] = [];
	const am = new AgentManager({
		projectStore,
		configStore: opts.configStore ?? null,
		onEvent: (sid, pid, name, e) =>
			opts.events?.push({ sessionId: sid, projectId: pid, agentName: name, e }),
		createClientFn: opts.createClientFn ?? fakeClientFactory(fakes),
		browserManager: NOOP_BROWSER_MANAGER,
		...(opts.memoryStore ? { memoryStore: opts.memoryStore } : {}),
		...(opts.skillManager ? { skillManager: opts.skillManager } : {}),
		...(opts.extensionManager ? { extensionManager: opts.extensionManager } : {}),
		...(opts.abortTimeoutMs !== undefined
			? { abortTimeoutMs: opts.abortTimeoutMs }
			: {}),
	});
	managers.push(am);
	syspromptSessionIds.push(session.id);
	return { projectStore, project, session, am, fakes };
}

/** 取参数数组中某 flag 的全部值（如 --skill a --skill b → [a, b]） */
function argValues(args: string[], flag: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
	}
	return out;
}

/** 慢启动工厂：start 延迟 ms 毫秒（并发 / dispose 竞态 / pendingAborts 用） */
function slowFactory(fakes: FakeSessionClient[], ms: number) {
	return (o: RpcClientOpts) => {
		const fake = new FakeSessionClient(o);
		fake.start = async () => {
			await new Promise((r) => setTimeout(r, ms));
			fake.started = true;
		};
		fakes.push(fake);
		return fake as unknown as RpcClient;
	};
}

// ─── 创建 / 缓存 / 生命周期 ─────────────────────────────────────────────────

test("ensureStarted 创建 pi rpc client 并传入会话参数（--session / --system-prompt）", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	expect(fakes).toHaveLength(1);
	expect(fakes[0].started).toBe(true);
	const args = fakes[0].opts.args ?? [];
	expect(argValues(args, "--session")).toEqual([session.piSessionFile]);
	expect(argValues(args, "--system-prompt")).toEqual([
		syspromptPath(session.id),
	]);
	expect(args).toContain("--offline");
	// bridge 上下文已注册（宿主工具经 wa-pi-bridge 扩展回调 kernel）
	expect(getBridgeSession(session.id)).toBeDefined();
});

test("ensureStarted 无显式 tools 时不传 --tools、用 --exclude-tools 排除 subagent", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	const args = fakes[0].opts.args ?? [];
	expect(args).not.toContain("--tools");
	const excluded = argValues(args, "--exclude-tools").flatMap((v) =>
		v.split(","),
	);
	expect(excluded).toContain("subagent");
});

test("ensureStarted 使用 agent 显式配置的 tools（--tools 白名单）", async () => {
	const configStore = {
		getAgent: mock(async () => ({ displayName: "dev", tools: ["read"] })),
	} as any;
	const { project, session, am, fakes } = await setup({ configStore });
	await am.ensureStarted(project.id, "dev", session.id);

	const args = fakes[0].opts.args ?? [];
	const tools = argValues(args, "--tools").flatMap((v) => v.split(","));
	expect(tools).toContain("read");
});

test("ensureStarted 复用已存在的会话（同 sessionId 不重复创建 client）", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	await am.ensureStarted(project.id, "dev", session.id);

	expect(fakes).toHaveLength(1);
});

test("ensureStarted 同 sessionId 但 agentName 变化时拆除旧进程并按新 agent 重建（不错误复用旧 agent）", async () => {
	const { project, session, am, fakes } = await setup();
	// 场景：新会话页挂载时 getCommands 兜底已用默认 agent（dev）启动进程
	await am.ensureStarted(project.id, "dev", session.id);
	expect(fakes).toHaveLength(1);
	expect((am as any).sessions.get(session.id).meta.agentName).toBe("dev");

	// 用户在 dropdown 切到 qa 后发送 → agent:prompt → ensureStarted(projectId, "qa", sessionId)
	await am.ensureStarted(project.id, "qa", session.id);

	// 旧进程必须被拆除，按新 agent 重建；绝不能复用 dev 进程处理 qa 的消息
	expect(fakes).toHaveLength(2);
	expect((am as any).sessions.get(session.id).meta.agentName).toBe("qa");
});

test("ensureStarted 并发调用同 sessionId 只创建一次（共享创建 Promise）", async () => {
	const fakes: FakeSessionClient[] = [];
	const { project, session, am } = await setup({
		createClientFn: slowFactory(fakes, 60),
	});

	const [a, b] = await Promise.all([
		am.ensureStarted(project.id, "dev", session.id),
		am.ensureStarted(project.id, "dev", session.id),
	]);

	expect(a).toBe(b);
	expect(fakes).toHaveLength(1);
});

test("ensureStarted 创建失败时清理 starting 锁并允许重试", async () => {
	// 第一阶段：工厂始终失败，并发调用共享同一个失败 Promise
	const failFakes: FakeSessionClient[] = [];
	let calls = 0;
	const failingFactory = (o: RpcClientOpts) => {
		calls++;
		const fake = new FakeSessionClient(o);
		fake.start = async () => {
			await new Promise((r) => setTimeout(r, 30));
			throw new Error("创建失败");
		};
		failFakes.push(fake);
		return fake as unknown as RpcClient;
	};
	const { projectStore, project, session, am } = await setup({
		createClientFn: failingFactory,
	});

	const results = await Promise.allSettled([
		am.ensureStarted(project.id, "dev", session.id),
		am.ensureStarted(project.id, "dev", session.id),
	]);
	expect(results[0].status).toBe("rejected");
	expect(results[1].status).toBe("rejected");
	expect(calls).toBe(1);

	// 第二阶段：换正常工厂，同 sessionId 能重新创建（不阻塞在失败的 Promise 上）
	const recoveryFakes: FakeSessionClient[] = [];
	const recovery = new AgentManager({
		projectStore,
		configStore: null,
		onEvent: () => {},
		createClientFn: fakeClientFactory(recoveryFakes),
		browserManager: NOOP_BROWSER_MANAGER,
	});
	managers.push(recovery);
	await recovery.ensureStarted(project.id, "dev", session.id);
	expect(recoveryFakes).toHaveLength(1);
	expect(recoveryFakes[0].started).toBe(true);
});

test("ensureStarted 创建过程中被 dispose 时清理资源并拒绝", async () => {
	const fakes: FakeSessionClient[] = [];
	const { project, session, am } = await setup({
		createClientFn: slowFactory(fakes, 60),
	});

	const startPromise = am.ensureStarted(project.id, "dev", session.id);
	// 在创建完成前 dispose，模拟 session:delete 与 agent:prompt 并发
	await am.disposeSession(session.id);

	await expect(startPromise).rejects.toThrow("会话已清理");
	expect(fakes).toHaveLength(1);
	expect(fakes[0].alive).toBe(false); // client 已被 dispose
});

test("isSessionActive 在 prompt 排队且冷启动期间返回 true（新建会话发送消息场景）", async () => {
	const fakes: FakeSessionClient[] = [];
	const { project, session, am } = await setup({
		createClientFn: slowFactory(fakes, 100),
	});

	// 发起创建但不 await——模拟前端 POST /prompt 后 GET /messages 并发到达 kernel
	const startPromise = am.ensureStarted(project.id, "dev", session.id);

	// 让事件循环进入 _createSession（starting.set 已在 ensureStarted 中同步执行）
	await new Promise((r) => setTimeout(r, 10));

	// 冷启动进行中 + prompt 排队中（agent:prompt 的 _promptLocks 命中）：
	// GET /messages 的 isActive 应返回 true，防止前端 setActiveStatus(false)
	// 错误清除乐观 thinking 状态（新建会话时"正在思考"闪退 bug 的根因）
	expect(am.isSessionActive(session.id, true)).toBe(true);

	// 等待创建完成
	await startPromise;

	// 创建完成后、prompt 之前，busy 恢复 false（_sendPromptNow 尚未调用）
	expect(am.isSessionActive(session.id, true)).toBe(false);
});

test("isSessionActive 在冷启动但无 prompt 排队时返回 false（打开历史会话场景，回归）", async () => {
	const fakes: FakeSessionClient[] = [];
	const { project, session, am } = await setup({
		createClientFn: slowFactory(fakes, 100),
	});

	// 打开历史会话：getCommands / prewarm 触发冷启动（无 prompt 排队），
	// GET /messages 的 isActive 必须为 false——否则前端 setActiveStatus(true)
	// 会把 idle 历史会话误标 thinking，且冷启动完成后无 agent 事件复位，
	// 导致会话列表项永久转圈（回归：da7acb15 用 starting.has 一刀切）
	const startPromise = am.ensureStarted(project.id, "dev", session.id);
	await new Promise((r) => setTimeout(r, 10));

	expect(am.isSessionActive(session.id, false)).toBe(false);

	// 冷启动完成后仍非 busy（无 prompt）
	await startPromise;
	expect(am.isSessionActive(session.id, false)).toBe(false);
});

test("isSessionActive 在 handle.busy 时短路返回 true（即使无 prompt 排队）", async () => {
	const { project, session, am } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	// 手动置 busy 模拟 agent 正在处理（agent_start 后 agent_settled 前）
	const handle = (am as any).sessions.get(session.id);
	handle.busy = true;

	// busy 优先：promptQueued=false 也应返回 true（会话确实在处理中）
	expect(am.isSessionActive(session.id, false)).toBe(true);
	expect(am.isSessionActive(session.id, true)).toBe(true);
});

test("dispose 竞态下 getMessages 失败：不打印「拉取历史消息失败」（预期路径静默）", async () => {
	const fakes: FakeSessionClient[] = [];
	const { project, session, am } = await setup({
		// start 慢 + getMessages 失败：模拟 dispose 打断拉取历史消息的竞态
		createClientFn: (o) => {
			const fake = new FakeSessionClient(o);
			fake.start = async () => {
				await new Promise((r) => setTimeout(r, 60));
				fake.started = true;
			};
			fake.getMessagesError = new Error(
				"pi rpc 进程已退出 (code=null, signal=SIGTERM)",
			);
			fakes.push(fake);
			return fake as unknown as RpcClient;
		},
	});

	const logs: string[] = [];
	const origError = console.error;
	console.error = (...args: unknown[]) => logs.push(String(args[0]));
	try {
		const startPromise = am.ensureStarted(project.id, "dev", session.id);
		await am.disposeSession(session.id);
		await expect(startPromise).rejects.toThrow("会话已清理");
	} finally {
		console.error = origError;
	}

	// 核心断言：dispose 打断 getMessages 是预期路径，不应打印拉取失败日志
	expect(logs.some((l) => l.includes("拉取历史消息失败"))).toBe(false);
});

test("非 dispose 的 getMessages 失败：仍打印「拉取历史消息失败」（真异常保留）", async () => {
	const fakes: FakeSessionClient[] = [];
	const { project, session, am } = await setup({
		createClientFn: (o) => {
			const fake = new FakeSessionClient(o);
			fake.getMessagesError = new Error("进程崩溃");
			fakes.push(fake);
			return fake as unknown as RpcClient;
		},
	});

	const logs: string[] = [];
	const origError = console.error;
	console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
	try {
		// 非 dispose：ensureStarted 应成功（getMessages 兜底 messages=[]），但仍打印拉取失败
		await am.ensureStarted(project.id, "dev", session.id);
	} finally {
		console.error = origError;
	}

	expect(logs.some((l) => l.includes("拉取历史消息失败"))).toBe(true);
	expect(logs.some((l) => l.includes("进程崩溃"))).toBe(true);
});

test("创建期间收到的 abort 在 client 就绪后立即执行（pendingAborts）", async () => {
	const { project, session, am, fakes } = await setup();

	const startPromise = am.ensureStarted(project.id, "dev", session.id);
	// _createSession 尚在 projectStore.load 阶段（client 未注册）→ 走 pendingAborts 标记
	await am.abort(session.id);
	await startPromise;

	expect(fakes).toHaveLength(1);
	expect(fakes[0].aborts).toBe(1);
});

test("disposeSession 清理 client / bridge 上下文 / 系统提示词临时文件 / 脏标记", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	const promptFile = syspromptPath(session.id);
	expect(existsSync(promptFile)).toBe(true);

	am.markSkillsDirty();
	expect((am as any).skillDirty.has(session.id)).toBe(true);

	await am.disposeSession(session.id);

	expect(fakes[0].alive).toBe(false);
	expect(getBridgeSession(session.id)).toBeUndefined();
	expect((am as any).sessions.has(session.id)).toBe(false);
	expect((am as any).skillDirty.has(session.id)).toBe(false);
	// promptFile 的 rm 是 fire-and-forget，轮询等待落地
	const deadline = Date.now() + 2000;
	while (existsSync(promptFile) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 20));
	}
	expect(existsSync(promptFile)).toBe(false);
});

// ─── prompt / 模型 / thinking ───────────────────────────────────────────────

test("prompt — 未选择模型时抛错", async () => {
	const { project, session, am } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	await expect(am.prompt(session.id, "你好")).rejects.toThrow("未选择模型");
});

test("prompt — agent 空闲且无排队 → 直接 prompt", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	await am.prompt(session.id, "你好", { model: MODEL });

	expect(fakes[0].prompted).toEqual(["你好"]);
});

// ─── /compact 压缩上下文命令 ───────────────────────────────────────────────
// 背景：pi RPC 模式不解析内置斜杠命令（只有交互模式解析，见 pi.dev/docs/latest/rpc），
// /compact 文本若按普通 prompt 发出会被当作 user 消息发给 LLM，压缩从不发生。
// kernel 必须拦截 /compact 前缀并显式转 compact RPC。

test("prompt — /compact 文本 → 调 compact RPC 而非 prompt（RPC 模式不解析内置斜杠命令）", async () => {
	const events: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events });
	await am.ensureStarted(project.id, "dev", session.id);

	await am.prompt(session.id, "/compact", { model: MODEL });

	expect(fakes[0].prompted).toEqual([]); // 绝不能当普通消息发给 LLM
	expect(fakes[0].compacted).toEqual([{ customInstructions: undefined }]);
	// 压缩不产生 agent_start/agent_end：kernel 需合成 agent_end 让前端退出思考态 + 刷新 token
	const types = events.map((x) => x.e.type);
	expect(types).toContain("agent_end");
});

test("prompt — /compact 带自定义指令 → customInstructions 透传", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	await am.prompt(session.id, "/compact 只保留关键决策", { model: MODEL });

	expect(fakes[0].prompted).toEqual([]);
	expect(fakes[0].compacted).toEqual([{ customInstructions: "只保留关键决策" }]);
});

test("prompt — 非 /compact 前缀（如 /compactify）不受影响，正常走 prompt", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	await am.prompt(session.id, "/compactify 代码", { model: MODEL });

	expect(fakes[0].compacted).toEqual([]);
	expect(fakes[0].prompted).toEqual(["/compactify 代码"]);
});

test("prompt — 压缩完成后 drain 压缩期间排队消息（合成 agent_settled）", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	const fake = fakes[0];
	// 预热：触发命令清单拉取，避免与 /compact 的 _fetchCommands 竞态
	await am.prompt(session.id, "预热", { model: MODEL });
	fake.compactDelayMs = 30; // 模拟长压缩：挂起 30ms，期间用户消息排队

	const p1 = am.prompt(session.id, "/compact", { model: MODEL });
	await am.prompt(session.id, "压缩完再答", { model: MODEL });
	await p1;
	// 压缩完成后合成 agent_settled 触发 drain（发送前自动压缩检查引入异步延迟，轮询等待）
	await waitFor(() => fake.prompted.length === 2);

	expect(fake.compacted).toEqual([{ customInstructions: undefined }]);
	expect(fake.prompted).toEqual(["预热", "压缩完再答"]);
});

test("prompt — compact 失败 → 只合成 agent_end（退出思考态），失败文案由前端 compaction_end 展示", async () => {
	const events: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events });
	await am.ensureStarted(project.id, "dev", session.id);
	fakes[0].nextCompactError = new Error(
		"Nothing to compact (session too small)",
	);

	await am.prompt(session.id, "/compact", { model: MODEL });

	// 失败详情由 pi 的 compaction_end{errorMessage} 事件负责展示（前端 compaction_end case），
	// kernel 不再合成 message_end 错误（避免同一失败两条消息）
	const msgEnd = events.find(
		(x) => x.e.type === "message_end" && x.e.message?.stopReason === "error",
	);
	expect(msgEnd).toBeUndefined();
	// 仅合成 agent_end 退出思考态
	const types = events.map((x) => x.e.type);
	expect(types).toContain("agent_end");
	expect(types).not.toContain("agent_settled");
	expect(fakes[0].prompted).toEqual([]);
});

test("prompt — 未启动的会话抛错", async () => {
	const { am } = await setup();
	await expect(
		am.prompt("nonexistent", "你好", { model: MODEL }),
	).rejects.toThrow("会话未启动");
});

test("prompt — 「provider/modelId」按第一个 / 拆分调 setModel", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	await am.prompt(session.id, "你好", { model: "anthropic/claude-x" });
	expect(fakes[0].models.at(-1)).toEqual({
		provider: "anthropic",
		modelId: "claude-x",
	});

	// modelId 允许含 "/"
	await am.prompt(session.id, "你好", { model: "openai/gpt-4o/2024" });
	expect(fakes[0].models.at(-1)).toEqual({
		provider: "openai",
		modelId: "gpt-4o/2024",
	});
});

test("prompt — 裸 modelId 经 get_available_models 解析 provider", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	fakes[0].availableModels = [{ id: "deepseek-chat", provider: "deepseek" }];

	await am.prompt(session.id, "你好", { model: "deepseek-chat" });
	expect(fakes[0].models.at(-1)).toEqual({
		provider: "deepseek",
		modelId: "deepseek-chat",
	});

	await expect(
		am.prompt(session.id, "你好", { model: "no-such-model" }),
	).rejects.toThrow("模型解析失败");
});

test("prompt — thinking level 映射（disabled→off，max→xhigh，其余透传）", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	const cases: Array<[ThinkingLevel, string]> = [
		["disabled", "off"],
		["medium", "medium"],
		["high", "high"],
		["max", "xhigh"],
	];
	for (const [input, expected] of cases) {
		await am.prompt(session.id, "你好", { model: MODEL, thinking: input });
		expect(fakes[0].thinkingLevels.at(-1)).toBe(expected);
	}
});

// ─── 附件构建 prompt 文本 ───────────────────────────────────────────────────

test("prompt — 图片附件转为 ImageContent 并经 client.prompt(text, { images }) 发送", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	const imgPath = `/tmp/wa-pi-img-${Date.now()}.png`;
	tmpPaths.push(imgPath);
	writeFileSync(imgPath, Buffer.from("fake-image-bytes"));

	await am.prompt(session.id, "描述这张图", {
		model: MODEL,
		attachments: [{ kind: "image", path: imgPath, name: "示例.png", size: 0 }],
	});

	expect(fakes[0].prompted).toHaveLength(1);
	const text = fakes[0].prompted[0];
	expect(text).toContain("描述这张图");
	expect(text).toContain("Attachments:");
	expect(text).toMatch(/@wa-pi-img-\d+\.png/);
	// 图片必须真正发给 pi：作为 ImageContent 传给 client.prompt(text, { images })
	expect(fakes[0].promptImages).toHaveLength(1);
	expect(fakes[0].promptImages[0]).toEqual([
		{
			type: "image",
			mimeType: "image/png",
			data: Buffer.from("fake-image-bytes").toString("base64"),
		},
	]);
});

test("prompt — 图片附件读取失败时降级为纯文本引用，不阻塞发送", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	const imgPath = `/tmp/wa-pi-img-missing-${Date.now()}.png`;
	tmpPaths.push(imgPath);

	await am.prompt(session.id, "描述这张图", {
		model: MODEL,
		attachments: [{ kind: "image", path: imgPath, name: "示例.png", size: 0 }],
	});

	expect(fakes[0].prompted).toHaveLength(1);
	// 文件不存在：images 为空数组（不传图片），但消息正常发送
	expect(fakes[0].promptImages[0]).toEqual([]);
});

test("prompt — 单张图片超过 3.5MB 上限回退为附件，不内联", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	// 一张 4MB 的图：超过单张 3.5MB 上限
	const imgPath = `/tmp/wa-pi-img-oversize-${Date.now()}.png`;
	tmpPaths.push(imgPath);
	const fd = openSync(imgPath, "w");
	ftruncateSync(fd, 4 * 1024 * 1024);
	closeSync(fd);

	await am.prompt(session.id, "描述这张图", {
		model: MODEL,
		attachments: [{ kind: "image", path: imgPath, name: "大图.png", size: 4 * 1024 * 1024 }],
	});

	expect(fakes[0].prompted).toHaveLength(1);
	// 文本引用保留，但 images 为空（不内联）
	expect(fakes[0].prompted[0]).toContain("@wa-pi-img-oversize");
	expect(fakes[0].promptImages[0]).toEqual([]);
});

test("prompt — 图片累计大小超过上限时，超出部分回退为附件（@路径 引用）", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	// 4 张 3MB 的图：单张 < 3.5MB 上限通过，但累计 12MB > 10MB 总量上限
	const mkImg = (tag: string) => {
		const p = `/tmp/wa-pi-img-${tag}-${Date.now()}.png`;
		tmpPaths.push(p);
		const fd = openSync(p, "w");
		ftruncateSync(fd, 3 * 1024 * 1024);
		closeSync(fd);
		return p;
	};
	const paths = [mkImg("a"), mkImg("b"), mkImg("c"), mkImg("d")];

	await am.prompt(session.id, "看这些图", {
		model: MODEL,
		attachments: paths.map((path, i) => ({
			kind: "image" as const,
			path,
			name: `图${i + 1}.png`,
			size: 3 * 1024 * 1024,
		})),
	});

	expect(fakes[0].prompted).toHaveLength(1);
	// 4 张图全部保留 @路径 文本引用（无论是否内联）
	const text = fakes[0].prompted[0];
	for (const p of paths) {
		expect(text).toMatch(new RegExp(`@${p.split("/").pop()}`));
	}
	// 前三张（9MB ≤ 10MB）内联为 ImageContent，第四张超累计上限回退为附件
	expect(fakes[0].promptImages[0]).toHaveLength(3);
	for (const img of fakes[0].promptImages[0]) {
		expect(img).toEqual({
			type: "image",
			mimeType: "image/png",
			data: expect.any(String),
		});
	}
});

test("prompt — agent 运行中排队消息携带图片，agent_settled 后 drain 仍携带 images", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	const fake = fakes[0];
	fake.autoSettle = false;

	await am.prompt(session.id, "第一条", { model: MODEL });
	expect(fake.prompted).toEqual(["第一条"]);

	const imgPath = `/tmp/wa-pi-img-queue-${Date.now()}.png`;
	tmpPaths.push(imgPath);
	writeFileSync(imgPath, Buffer.from("queue-image"));
	await am.prompt(session.id, "第二条", {
		model: MODEL,
		attachments: [{ kind: "image", path: imgPath, name: "队列图.png", size: 0 }],
	});
	expect(fake.prompted).toEqual(["第一条"]); // busy 中不直接 prompt，进队列

	fake.emit({ type: "agent_settled" });
	await waitFor(() => fake.prompted.length === 2);
	expect(fake.prompted[1]).toContain("第二条");
	expect(fake.promptImages[1]).toEqual([
		{
			type: "image",
			mimeType: "image/png",
			data: Buffer.from("queue-image").toString("base64"),
		},
	]);
});

test("prompt — snippet 附件内容直接内联", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	await am.prompt(session.id, "总结这段代码", {
		model: MODEL,
		attachments: [{ kind: "snippet", name: "代码片段", content: "const x = 1;" }],
	});

	expect(fakes[0].prompted).toHaveLength(1);
	expect(fakes[0].prompted[0]).toContain("[片段: 代码片段]\nconst x = 1;");
	expect(fakes[0].prompted[0]).toContain("总结这段代码");
});

// ─── kernel 队列语义（steer / followUp） ────────────────────────────────────

test("prompt — agent 运行中 → 进本地 followUpList，agent_settled 后 drain", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	const fake = fakes[0];
	fake.autoSettle = false;

	await am.prompt(session.id, "第一条", { model: MODEL });
	expect(fake.prompted).toEqual(["第一条"]);

	await am.prompt(session.id, "第二条", { model: MODEL });
	// busy 中不直接 prompt，进本地 followUpList
	expect(fake.prompted).toEqual(["第一条"]);

	// agent_settled → drain 一条（发送前自动压缩检查引入异步延迟，轮询等待）
	fake.emit({ type: "agent_settled" });
	await waitFor(() => fake.prompted.length === 2);
	expect(fake.prompted).toEqual(["第一条", "第二条"]);
});

test("steerMessage — busy 时调 pi steer()，空闲时降级为 prompt()", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	const fake = fakes[0];

	// 空闲 → prompt()
	await am.steerMessage(session.id, "空闲引导");
	expect(fake.prompted).toEqual(["空闲引导"]);
	expect(fake.steered).toEqual([]);

	// busy → steer()
	fake.autoSettle = false;
	await am.prompt(session.id, "进行中", { model: MODEL });
	await am.steerMessage(session.id, "引导消息");
	expect(fake.steered).toEqual(["引导消息"]);
});

test("abort 清空排队列表 + 中断当前运行", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	const fake = fakes[0];
	fake.autoSettle = false;

	await am.prompt(session.id, "进行中", { model: MODEL });
	// 忙时发送排队消息
	await am.prompt(session.id, "排队A", { model: MODEL });
	await am.prompt(session.id, "排队B", { model: MODEL });

	await am.abort(session.id);
	expect(fake.aborts).toBe(1);
});

test("abort 级联中止登记的子代理（subagentAborts 全部触发并清空）", async () => {
	const { project, session, am } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	const handle = (am as any).sessions.get(session.id);
	// 模拟一个在跑的子代理派发登记
	const controller = new AbortController();
	handle.subagentAborts.add(controller);

	await am.abort(session.id);
	expect(controller.signal.aborted).toBe(true);
	expect(handle.subagentAborts.size).toBe(0);
});

test("steerMessage — busy 时立即调 pi steer()", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	const fake = fakes[0];
	fake.autoSettle = false;

	await am.prompt(session.id, "进行中", { model: MODEL }); // busy
	await am.steerMessage(session.id, "引导一下");

	// 新版 steerMessage 直接调 client.steer()，不再经过 kernel 队列
	expect(fake.steered).toEqual(["引导一下"]);
});

test("steerMessage — idle 时直接 prompt 生效", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	am.steerMessage(session.id, "引导一下");
	await new Promise((r) => setTimeout(r, 0)); // client.prompt 为异步调用

	expect(fakes[0].prompted).toEqual(["引导一下"]);
});

test("abort 清空 followUpList 并中断当前运行", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	const fake = fakes[0];
	fake.autoSettle = false;

	await am.prompt(session.id, "进行中", { model: MODEL });
	await am.prompt(session.id, "排队", { model: MODEL });
	expect(am.isSessionStreaming(session.id)).toBe(true);

	await am.abort(session.id);

	expect(fake.aborts).toBe(1);
	expect(am.isSessionStreaming(session.id)).toBe(false);
	// 新版 abort 清空本地 followUpList
	const handle = (am as any).sessions.get(session.id);
	expect(handle.followUpList).toEqual([]);
});

test("abort 无响应超时 → 强杀进程兜底：会话拆除、前端收到终态事件", async () => {
	const events: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({
		events,
		abortTimeoutMs: 50,
	});
	await am.ensureStarted(project.id, "dev", session.id);
	const fake = fakes[0];
	fake.autoSettle = false;
	fake.hangAbort = true; // 模拟 pi agent loop 卡死：abort RPC 永不响应

	await am.prompt(session.id, "进行中", { model: MODEL });
	expect(am.isSessionStreaming(session.id)).toBe(true);

	await am.abort(session.id); // 应在 abortTimeoutMs 后兜底返回，不挂死

	expect(fake.aborts).toBe(1);
	// 进程被强杀 + 会话从 Map 拆除（下次 ensureStarted 由 jsonl 重建）
	expect(fake.alive).toBe(false);
	expect((am as any).sessions.has(session.id)).toBe(false);
	expect(am.isSessionStreaming(session.id)).toBe(false);
	// 前端收到终态事件退出思考态（强杀后 pi 不会再发任何 agent 事件）
	expect(events.map((c) => c.e.type)).toContain("agent_end");
});

// ─── 事件转发 ───────────────────────────────────────────────────────────────

test("onEvent 把 pi 事件转发给上层并携带 sessionId/projectId/agentName 上下文", async () => {
	const received: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events: received });
	await am.ensureStarted(project.id, "dev", session.id);

	fakes[0].emit({ type: "turn_start" });

	expect(received).toHaveLength(1);
	expect(received[0]).toMatchObject({
		sessionId: session.id,
		projectId: project.id,
		agentName: "dev",
	});
	expect(received[0].e).toEqual({ type: "turn_start" });
});

test("message_end 事件把消息追加进历史快照", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	fakes[0].emit({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "回复" }] },
	});

	const msgs = am.getMessages(session.id);
	expect(msgs).toHaveLength(1);
	expect(msgs[0].role).toBe("assistant");
});

test("agent_end 附加整轮耗时（成功轮：user 落盘 → agent_end 真实时间）", async () => {
	const received: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events: received });
	await am.ensureStarted(project.id, "dev", session.id);

	// user 经 message_end 落进 handle.messages 时记录 turnUserAt（kernel 侧 Date.now()）；
	// agent_end 时 elapsedMs = Date.now() − turnUserAt。真实流逝约 50ms。
	fakes[0].emit({
		type: "message_end",
		message: {
			role: "user",
			content: [{ type: "text", text: "问题" }],
			timestamp: 1000,
		},
	});
	await new Promise((r) => setTimeout(r, 50));
	fakes[0].emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "回答" }],
			timestamp: 5000,
			stopReason: "end_turn",
		},
	});
	fakes[0].emit({
		type: "agent_end",
		willRetry: false,
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "回答" }],
				timestamp: 5000,
				stopReason: "end_turn",
			},
		],
	});

	const ae = received.find((x) => x.e.type === "agent_end");
	expect(typeof ae?.e.elapsedMs).toBe("number");
	expect(ae!.e.elapsedMs).toBeGreaterThanOrEqual(40); // ≥ 实际流逝的 50ms（宽松下限）
	expect(ae!.e.elapsedMs).toBeLessThan(5000);
});

test("agent_end 失败回合不附加 elapsedMs", async () => {
	const received: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events: received });
	await am.ensureStarted(project.id, "dev", session.id);

	fakes[0].emit({
		type: "message_end",
		message: {
			role: "user",
			content: [{ type: "text", text: "问题" }],
			timestamp: 1000,
		},
	});
	fakes[0].emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "报错" }],
			timestamp: 2000,
			stopReason: "error",
		},
	});
	fakes[0].emit({
		type: "agent_end",
		willRetry: false,
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "报错" }],
				timestamp: 2000,
				stopReason: "error",
			},
		],
	});

	const ae = received.find((x) => x.e.type === "agent_end");
	expect(ae?.e.elapsedMs).toBeUndefined();
});

test("handle.messages 无 user 时不附加 elapsedMs", async () => {
	const received: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events: received });
	await am.ensureStarted(project.id, "dev", session.id);

	// 只有 assistant（无 user 消息进入 handle.messages）：找不到起点，不附加
	fakes[0].emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "回答" }],
			timestamp: 2000,
			stopReason: "end_turn",
		},
	});
	fakes[0].emit({
		type: "agent_end",
		willRetry: false,
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "回答" }],
				timestamp: 2000,
				stopReason: "end_turn",
			},
		],
	});

	const ae = received.find((x) => x.e.type === "agent_end");
	expect(ae?.e.elapsedMs).toBeUndefined();
});

test("agent_end 结算后重置 turnUserAt：下一无 user 轮不附加跨轮耗时", async () => {
	const received: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events: received });
	await am.ensureStarted(project.id, "dev", session.id);

	// 第一轮：user → assistant → agent_end（成功，附加 elapsedMs）
	fakes[0].emit({
		type: "message_end",
		message: {
			role: "user",
			content: [{ type: "text", text: "问题" }],
			timestamp: 1000,
		},
	});
	fakes[0].emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "回答一" }],
			timestamp: 2000,
			stopReason: "end_turn",
		},
	});
	fakes[0].emit({
		type: "agent_end",
		willRetry: false,
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "回答一" }],
				timestamp: 2000,
				stopReason: "end_turn",
			},
		],
	});

	// 第二轮：只有 assistant（无 user）→ agent_end。若 turnUserAt 未在结算后重置，
	// 会拿第一轮的旧值算出跨轮时长——不应附加。
	fakes[0].emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "回答二" }],
			timestamp: 3000,
			stopReason: "end_turn",
		},
	});
	fakes[0].emit({
		type: "agent_end",
		willRetry: false,
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "回答二" }],
				timestamp: 3000,
				stopReason: "end_turn",
			},
		],
	});

	const ends = received.filter((x) => x.e.type === "agent_end");
	expect(ends).toHaveLength(2);
	expect(typeof ends[0].e.elapsedMs).toBe("number"); // 第一轮正常附加
	expect(ends[1].e.elapsedMs).toBeUndefined(); // 第二轮不附加跨轮时长
});

test("getMessages 在 session 不存在时返回空数组", async () => {
	const { am } = await setup();
	expect(am.getMessages("不存在的-session")).toEqual([]);
});

// ─── dirty / skillDirty 标脏重建 ────────────────────────────────────────────

test("markAllDirty 后 idle 命中缓存 → 热重载（不重建进程、调 reloadExtensions、同 handle），并清脏", async () => {
	const { project, session, am, fakes } = await setup();
	const first = await am.ensureStarted(project.id, "dev", session.id);
	expect(fakes).toHaveLength(1);
	fakes[0].commandsToReturn = [{ name: "__!wa_pi_reload", source: "extension" }];

	am.markAllDirty();
	const second = await am.ensureStarted(project.id, "dev", session.id);

	// 扩展 dirty 走热重载：进程不重建，reloadExtensions 被调，返回同 handle
	expect(fakes).toHaveLength(1);
	expect(fakes[0].alive).toBe(true);
	expect(fakes[0].reloaded).toBe(1);
	expect(second).toBe(first);

	// 清脏后再次命中不再热重载
	await am.ensureStarted(project.id, "dev", session.id);
	expect(fakes[0].reloaded).toBe(1);
});

test("未标脏的会话命中缓存时不重建", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	await am.ensureStarted(project.id, "dev", session.id);
	expect(fakes).toHaveLength(1);
});

test("markSkillsDirty 后 idle 命中缓存 → 整进程重建（skillDirty 改 agent 定义层，热重载不够）", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	am.markSkillsDirty();
	await am.ensureStarted(project.id, "dev", session.id);

	// skillDirty：整进程重建，不走热重载
	expect(fakes).toHaveLength(2);
	expect(fakes[0].alive).toBe(false);
	expect(fakes[0].reloaded).toBe(0); // 未走热重载路径

	// 清脏后不再重建
	await am.ensureStarted(project.id, "dev", session.id);
	expect(fakes).toHaveLength(2);
});

test("markProvidersDirty 后 idle 命中缓存 → 整进程重建（provider-extension 经 -e 固化，热重载不重读）", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	am.markProvidersDirty();
	await am.ensureStarted(project.id, "dev", session.id);

	// provider 变更走 skillDirty 通道：整进程重建，不走热重载（否则旧模型注册表残留 → Model not found）
	expect(fakes).toHaveLength(2);
	expect(fakes[0].alive).toBe(false);
	expect(fakes[0].reloaded).toBe(0);

	// 清脏后不再重建
	await am.ensureStarted(project.id, "dev", session.id);
	expect(fakes).toHaveLength(2);
});

test("busy 时标脏不热重载，agent_settled（对话结束）后自动补热重载", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	const fake = fakes[0];
	fake.autoSettle = false;
	fake.commandsToReturn = [{ name: "__!wa_pi_reload", source: "extension" }];
	await am.prompt(session.id, "进行中", { model: MODEL }); // busy

	am.markAllDirty();
	await am.ensureStarted(project.id, "dev", session.id); // busy → 跳过
	expect(fakes[0].reloaded).toBe(0);

	// 对话结束（agent_settled）：无排队消息 → 自动补热重载
	fake.emit({ type: "agent_settled" });
	await new Promise((r) => setTimeout(r, 10));
	expect(fakes[0].reloaded).toBe(1);
	expect(fakes).toHaveLength(1); // 仍未重建进程
	expect(fakes[0].alive).toBe(true);
});

test("扩展 dirty 热重载前发 extension_ui_reset 清前端残留（活跃插件由 session_start 重放恢复）", async () => {
	const events: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events });
	await am.ensureStarted(project.id, "dev", session.id);
	fakes[0].commandsToReturn = [{ name: "__!wa_pi_reload", source: "extension" }];
	events.length = 0;

	am.markAllDirty();
	await am.ensureStarted(project.id, "dev", session.id);

	// 热重载前发 extension_ui_reset 清前端 UI 残留（含被卸载插件的 widget/status）；
	// 随后 session.reload 重放 session_start，仍活跃的扩展重发 UI 自动恢复
	const resets = events.filter((x) => x.e.type === "extension_ui_reset");
	expect(resets).toHaveLength(1);
	expect(resets[0].sessionId).toBe(session.id);

	// 未标脏的再次命中不重载、也不再发 reset
	events.length = 0;
	await am.ensureStarted(project.id, "dev", session.id);
	expect(events.filter((x) => x.e.type === "extension_ui_reset")).toHaveLength(
		0,
	);
});

test("热重载失败（reloadExtensions 抛错）→ 回退整进程重建 + 合成 extension_ui_reset", async () => {
	const events: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events });
	await am.ensureStarted(project.id, "dev", session.id);
	fakes[0].reloadExtensionsError = new Error("命令未注册"); // 注入热重载失败
	events.length = 0;

	am.markAllDirty();
	await am.ensureStarted(project.id, "dev", session.id);

	// 回退整进程重建：旧 client dispose、新建 fakes[1]
	expect(fakes).toHaveLength(2);
	expect(fakes[0].alive).toBe(false);
	const resets = events.filter((x) => x.e.type === "extension_ui_reset");
	expect(resets.length).toBeGreaterThanOrEqual(1);
});

test("__!wa_pi_reload 命令未注册时 → 不调 reloadExtensions（防泄漏），回退整进程重建", async () => {
	const events: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events });
	await am.ensureStarted(project.id, "dev", session.id);
	// commandsToReturn 默认为空——模拟 __!wa_pi_reload 未注册的场景
	events.length = 0;

	am.markAllDirty();
	await am.ensureStarted(project.id, "dev", session.id);

	// 未注册 __!wa_pi_reload → 不能走热重载（否则 prompt("/__!wa_pi_reload")
	// 被 pi 当普通消息发给 LLM，泄漏到会话 transcript）。
	// 应回退整进程重建：旧 client dispose、新建 fakes[1]
	expect(fakes).toHaveLength(2);
	expect(fakes[0].alive).toBe(false);
	expect(fakes[0].reloaded).toBe(0); // 未调 reloadExtensions
});

test("__!wa_pi_reload 命令已注册时 → 走热重载（不重建进程）", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	// 模拟命令已注册
	fakes[0].commandsToReturn = [{ name: "__!wa_pi_reload", source: "extension" }];

	am.markAllDirty();
	await am.ensureStarted(project.id, "dev", session.id);

	// 命令已注册 → 安全走热重载
	expect(fakes).toHaveLength(1); // 未重建
	expect(fakes[0].reloaded).toBe(1);
	expect(fakes[0].alive).toBe(true);
});

// ─── switchAgent / renameAgentSessions ──────────────────────────────────────

test("switchAgent: 换体重建，sessionId 不变且 config 取新 agent", async () => {
	const getAgent = mock(async (n: string) => ({
		displayName: n,
		partners: { askTo: [] },
	}));
	const configStore = { getAgent } as any;
	const { projectStore, project, session, am, fakes } = await setup({
		configStore,
	});

	await am.ensureStarted(project.id, "dev", session.id);
	expect(fakes).toHaveLength(1);

	await am.switchAgent(session.id, "pm");

	// 拆除旧 client + 同一 sessionId 重建
	expect(fakes).toHaveLength(2);
	expect(fakes[0].alive).toBe(false);
	expect(getAgent).toHaveBeenCalledWith("pm");
	// ProjectStore 已更新
	const { sessions } = await projectStore.load();
	expect(sessions.find((s) => s.id === session.id)!.primaryAgent).toBe("pm");
	// 重建后命中缓存返回新 handle，不再创建
	await am.ensureStarted(project.id, "pm", session.id);
	expect(fakes).toHaveLength(2);
});

test("switchAgent: 运行中先 abort，abort 失败吞掉不阻塞切换", async () => {
	const { projectStore, project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	const fake = fakes[0];
	fake.autoSettle = false;
	await am.prompt(session.id, "进行中", { model: MODEL }); // busy
	fake.abort = async () => {
		throw new Error("abort 失败");
	};

	await am.switchAgent(session.id, "pm"); // abort 失败不应抛错阻塞

	expect(fakes).toHaveLength(2);
	const { sessions } = await projectStore.load();
	expect(sessions.find((s) => s.id === session.id)!.primaryAgent).toBe("pm");
});

test("switchAgent: 会话未启动时从 projectStore 降级取 projectId 并直接建会话", async () => {
	const { projectStore, session, am, fakes } = await setup();
	// 未 ensureStarted，直接切换
	await am.switchAgent(session.id, "pm");

	expect(fakes).toHaveLength(1);
	const { sessions } = await projectStore.load();
	expect(sessions.find((s) => s.id === session.id)!.primaryAgent).toBe("pm");
});

test("switchAgent: 会话不存在时抛错", async () => {
	const { am } = await setup();
	await expect(am.switchAgent("nope", "pm")).rejects.toThrow("会话不存在");
});

test("switchAgent: 持久化更新在拆除前完成，挂起期间 sessions 不为空（消除并发 ensureStarted 竞态）", async () => {
	const { projectStore, project, session, am } = await setup();

	await am.ensureStarted(project.id, "dev", session.id);
	expect((am as any).sessions.get(session.id)).toBeDefined();

	// 用 deferred 挂起 setSessionAgent，复现「切换角色后立即发消息」的竞态窗口
	let resolveSetAgent!: () => void;
	const deferred = new Promise<void>((r) => {
		resolveSetAgent = r;
	});
	(projectStore as any).setSessionAgent = mock(async () => {
		await deferred;
	});

	// 不 await：switchAgent 同步执行到 setSessionAgent 挂起点
	const switchPromise = am.switchAgent(session.id, "pm");

	// 修复后：setSessionAgent 移到 teardown 之前，挂起期间旧 handle 仍在 sessions；
	// 修复前：teardown 已同步删除 sessions，此处拿到 undefined → 并发 ensureStarted 会二次创建
	expect((am as any).sessions.get(session.id)).toBeDefined();

	resolveSetAgent();
	await switchPromise;
	expect((am as any).sessions.get(session.id).meta.agentName).toBe("pm");
});

test("renameAgentSessions: meta 更新 + 标 skillDirty，下次 ensureStarted 用新名重建", async () => {
	const { project, session, am, fakes } = await setup({ agentName: "旧名" });
	await am.ensureStarted(project.id, "旧名", session.id);
	expect(fakes).toHaveLength(1);

	am.renameAgentSessions("旧名", "新名");

	expect((am as any).sessions.get(session.id).meta.agentName).toBe("新名");
	expect((am as any).skillDirty.has(session.id)).toBe(true);

	await am.ensureStarted(project.id, "新名", session.id);
	expect(fakes).toHaveLength(2);
	expect(fakes[0].alive).toBe(false);
	expect((am as any).sessions.get(session.id).meta.agentName).toBe("新名");
});

test("renameAgentSessions: 不匹配旧名的活跃会话不受影响", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	am.renameAgentSessions("旧名", "新名");

	expect((am as any).sessions.get(session.id).meta.agentName).toBe("dev");
	expect((am as any).skillDirty.has(session.id)).toBe(false);
	// 未标脏：命中缓存不重建
	await am.ensureStarted(project.id, "dev", session.id);
	expect(fakes).toHaveLength(1);
});

// ─── listGlobalTools ────────────────────────────────────────────────────────

test("listGlobalTools 返回内置工具集（含 grep/find/ls 与网络工具），不含 subagent", async () => {
	const { am } = await setup();
	const tools = await am.listGlobalTools();
	const names = tools.map((t) => t.name);

	expect(names).toEqual(
		expect.arrayContaining([
			"read",
			"bash",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
			"web_search",
			"fetch_content",
			"get_search_content",
		]),
	);
	expect(names).not.toContain("subagent");
});

test("listGlobalTools 内置工具 source='内置'，非内置工具不应显示泛化'扩展'", async () => {
	const { am } = await setup();
	const tools = await am.listGlobalTools();

	// 所有 DEFAULT_AGENT_TOOLS 中的工具 source 应为 "内置"
	for (const t of tools) {
		if (DEFAULT_AGENT_TOOLS.includes(t.name as any)) {
			expect(t.source).toBe("内置");
		}
	}

	// web_search 是内置工具，不应显示 "扩展" 或 "插件"
	const ws = tools.find((t) => t.name === "web_search");
	expect(ws?.source).toBe("内置");

	// 非内置工具（MCP/动态插件）的 source 应为具体名称，不再是泛化 "扩展"
	const extTools = tools.filter(
		(t) => !DEFAULT_AGENT_TOOLS.includes(t.name as any),
	);
	for (const t of extTools) {
		expect(t.source).not.toBe("扩展");
	}
});

test("listGlobalTools 含 4 个 browser_* 工具（source='内置'，供 ToolsTab 显示开关）", async () => {
	const { am } = await setup();
	const tools = await am.listGlobalTools();
	const names = tools.map((t) => t.name);

	const browserTools = [
		"browser_navigate",
		"browser_evaluate",
		"browser_screenshot",
		"browser_close",
	];
	expect(names).toEqual(expect.arrayContaining(browserTools));
	// 4 个 browser_* 均来自 DEFAULT_AGENT_TOOLS → source 应为 "内置"
	for (const n of browserTools) {
		expect(tools.find((t) => t.name === n)?.source).toBe("内置");
	}
});

// ─── 系统提示词（读 sysprompts/<id>.md 断言组合结果） ───────────────────────

test("系统提示词写入 sysprompts 文件：含 base / delegateRoster / env 约束段", async () => {
	const { project, session, am } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	const prompt = readSysprompt(session.id);
	expect(prompt).toContain("You are an expert coding assistant"); // base 段默认兜底
	expect(prompt).toContain("## Available Subagents"); // delegate-roster 段（内置类型始终列出）
	expect(prompt).toContain(`Built-in directory: ${BUILTIN_SKILLS_DIR}`); // env-constraints 段
	expect(prompt).toMatch(/internal terminology/i);
});

test("系统提示词注入记忆快照（经 --append-system-prompt 独立文件）", async () => {
	// 先向真实全局记忆写入一条唯一内容，验证快照写入独立 memory 文件而非 composePrompt。
	// composePrompt 静态化以最大化 LLM 缓存命中率。
	const unique = `测试记忆-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const globalStore = getGlobalMemoryStore(WA_PI_DIR);
	await globalStore.add("memory", unique);
	try {
		const { project, session, am } = await setup();
		await am.ensureStarted(project.id, "dev", session.id);

		// composePrompt（--system-prompt）不应包含记忆快照
		const prompt = readSysprompt(session.id);
		expect(prompt).not.toContain(unique);

		// 记忆快照应在 --append-system-prompt 独立文件中
		const memoryFile = join(
			WA_PI_DIR,
			"tmp",
			"sysprompts",
			`${session.id}-memory.md`,
		);
		expect(existsSync(memoryFile)).toBe(true);
		const memoryContent = readFileSync(memoryFile, "utf8");
		expect(memoryContent).toContain(unique);
	} finally {
		await globalStore.remove("memory", unique).catch(() => {});
	}
});

test("注入提示关闭（memoryPolicyStyle=none）时系统提示词不追加记忆快照", async () => {
	const unique = `测试记忆-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const globalStore = getGlobalMemoryStore(WA_PI_DIR);
	await globalStore.add("memory", unique);
	try {
		const { project, session, am } = await setup({
			memoryStore: {
				getConfig: async () => ({
					reviewEnabled: true,
					memoryPolicyStyle: "none" as const,
				}),
			},
		});
		await am.ensureStarted(project.id, "dev", session.id);

		const prompt = readSysprompt(session.id);
		expect(prompt).not.toContain(unique);
		// memory-snapshot 段为空被过滤；im-push 通用常驻段（工具始终注册后对所有
		// 普通会话注入，本功能有意变更）成为最后一段，不再以 env-constraints 结尾
		expect(prompt.trimEnd().endsWith("不要调用 im_push_to。")).toBe(true);
	} finally {
		await globalStore.remove("memory", unique).catch(() => {});
	}
});

test("config 有 systemPromptBody 时替代默认 base 提示词", async () => {
	const configStore = {
		getAgent: mock(async () => ({
			displayName: "dev",
			systemPromptBody: "你是前端开发者角色提示词",
		})),
	} as any;
	const { project, session, am } = await setup({ configStore });
	await am.ensureStarted(project.id, "dev", session.id);

	const prompt = readSysprompt(session.id);
	expect(prompt).toContain("你是前端开发者角色提示词");
	// replace：默认 base 兜底文案不再出现
	expect(prompt).not.toContain("You are an expert coding assistant");
});

test("askTo 非空时 delegate-roster 段含命名智能体与委托引导", async () => {
	const configs: Record<string, unknown> = {
		dev: { displayName: "dev", partners: { askTo: ["代码审查"] } },
		代码审查: {
			displayName: "代码审查",
			description: "评审改动",
			partners: { askTo: [] },
			delegationHints: {
				whenToDelegate: "代码变更需要评审时",
				benefit: "结构化审查反馈",
			},
		},
	};
	const configStore = {
		getAgent: mock(async (n: string) => configs[n] ?? null),
	} as any;
	const { project, session, am } = await setup({ configStore });
	await am.ensureStarted(project.id, "dev", session.id);

	const prompt = readSysprompt(session.id);
	expect(prompt).toContain("代码审查");
	expect(prompt).toContain("评审改动");
	expect(prompt).toContain("代码变更需要评审时");
	expect(prompt).toContain("结构化审查反馈");
});

test("askTo 为空时 roster 段仍含内置 subagent 类型", async () => {
	const configStore = {
		getAgent: mock(async () => ({
			displayName: "dev",
			partners: { askTo: [] },
		})),
	} as any;
	const { project, session, am } = await setup({ configStore });
	await am.ensureStarted(project.id, "dev", session.id);

	const prompt = readSysprompt(session.id);
	expect(prompt).toContain("## Available Subagents");
	expect(prompt).toContain("general-purpose");
});

// ─── 宿主工具（bridge ctx） ─────────────────────────────────────────────────

test("bridge ctx 的 delegate 工具：不在可调起列表时返回错误", async () => {
	const configStore = {
		getAgent: mock(async () => ({
			displayName: "dev",
			partners: { askTo: [] },
		})),
	} as any;
	const { project, session, am } = await setup({ configStore });
	await am.ensureStarted(project.id, "dev", session.id);

	const ctx = getBridgeSession(session.id)!;
	const result = await ctx.handleTool(
		"delegate",
		"tc1",
		{ agent: "不存在的智能体", task: "做点什么" },
		new AbortController().signal,
	);
	expect(result.content[0].text).toContain("不在可调起列表中");
});

test("skills 白名单下 delegate 工具仍可用（不因 skill 过滤误关 bridge 扩展）", async () => {
	// agent 有 skills 白名单 → 只排除技能 extension，bridge 扩展应照常加载
	const configStore = {
		getAgent: mock(async () => ({
			displayName: "pm",
			skills: ["chinese-code-review"], // 有白名单
			partners: { askTo: ["代码审查"] },
		})),
	} as any;
	const { project, session, am } = await setup({ configStore });
	await am.ensureStarted(project.id, "pm", session.id);

	// bridge session 应存在（bridge 扩展未被排除）
	const ctx = getBridgeSession(session.id)!;
	expect(ctx).toBeTruthy();

	// delegate 工具应可用
	const result = await ctx.handleTool(
		"delegate",
		"tc1",
		{ agent: "代码审查", task: "review this" },
		new AbortController().signal,
	);
	// 即使 spawn 失败（测试环境无真实子进程），也不应报"工具不存在"
	expect(result.content[0].text).not.toContain("not found");
});

test("自动学习关闭（reviewEnabled=false）时记忆工具返回关闭提示", async () => {
	const { project, session, am } = await setup({
		memoryStore: {
			getConfig: async () => ({
				reviewEnabled: false,
				memoryPolicyStyle: "full" as const,
			}),
		},
	});
	await am.ensureStarted(project.id, "dev", session.id);

	const ctx = getBridgeSession(session.id)!;
	const result = await ctx.handleTool(
		"memory_read",
		"tc1",
		{ target: "memory", scope: "global" },
		new AbortController().signal,
	);
	expect(result.content[0].text).toContain("记忆功能已关闭");
	expect((result.details as any).error).toBe("memory_disabled");
});

test("默认（不传 memoryStore）记忆工具可用", async () => {
	const { project, session, am } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	const ctx = getBridgeSession(session.id)!;
	const result = await ctx.handleTool(
		"memory_read",
		"tc1",
		{ target: "memory", scope: "global" },
		new AbortController().signal,
	);
	expect(result.content[0].text).not.toContain("记忆功能已关闭");
});

// ─── 中断清理（askRegistry.cancelAll）接线 ──────────────────────────────────

const askParams: AskParams = {
	questions: [
		{
			question: "Q?",
			header: "h",
			options: [
				{ label: "A", description: "x" },
				{ label: "B", description: "y" },
			],
		},
	],
};

test("abort 取消该 session 的 pending ask（同步 cancelAll）", async () => {
	const { project, session, am } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	const p = askRegistry.ask(
		session.id,
		"tc1",
		askParams,
		new AbortController().signal,
	);
	await am.abort(session.id);
	expect((await p).cancelled).toBe(true);
});

test("abort 取消 pending ask", async () => {
	const { project, session, am } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	const p = askRegistry.ask(
		session.id,
		"tc1",
		askParams,
		new AbortController().signal,
	);
	await am.abort(session.id);
	expect((await p).cancelled).toBe(true);
});

test("disposeSession 取消 pending ask", async () => {
	const { project, session, am } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	const p = askRegistry.ask(
		session.id,
		"tc1",
		askParams,
		new AbortController().signal,
	);
	await am.disposeSession(session.id);
	expect((await p).cancelled).toBe(true);
});

// ─── 历史消息 reconcile 兜底 ────────────────────────────────────────────────

test("ensureStarted 对 dangling ask 调用注入 cancelled toolResult（重启兜底）", async () => {
	// 构造一条 dangling ask 调用的历史：assistant 消息含 ask_user_question toolCall，无对应 toolResult
	const danglingMessages = [
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "tc-dangling",
					name: "ask_user_question",
					arguments: askParams,
				},
			],
			model: "test-model",
			stopReason: "tool_use",
			timestamp: 1,
		},
	];
	const fakes: FakeSessionClient[] = [];
	const factory = (o: RpcClientOpts) => {
		const fake = new FakeSessionClient(o);
		fake.messagesToReturn = danglingMessages;
		fakes.push(fake);
		return fake as unknown as RpcClient;
	};
	const { project, session, am } = await setup({ createClientFn: factory });
	await am.ensureStarted(project.id, "dev", session.id);

	const msgs = am.getMessages(session.id);
	expect(msgs.length).toBe(danglingMessages.length + 1);
	const last = msgs[msgs.length - 1];
	expect(last.role).toBe("toolResult");
	expect(last.isError).toBe(false);
	expect(last.toolCallId).toBe("tc-dangling");
});

// ─── skill 路径（--skill 参数） ─────────────────────────────────────────────

function tmpSkillRoot() {
	const root = `/tmp/wa-pi-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	mkdirSync(join(root, "skills"), { recursive: true }); // builtin（空）
	return root;
}
function createSkillAt(dir: string, name: string, desc: string) {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(
		join(dir, name, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`,
	);
}

test("ensureStarted 把启用 skill 路径作为 --skill 传给 pi", async () => {
	const skillRoot = tmpSkillRoot();
	tmpPaths.push(skillRoot);
	const userDir = join(skillRoot, "user-skills");
	mkdirSync(userDir, { recursive: true });
	createSkillAt(userDir, "my-skill", "测试技能");
	const skillManager = new SkillManager(skillRoot);
	await skillManager.addDir(userDir);

	const { project, session, am, fakes } = await setup({ skillManager });
	await am.ensureStarted(project.id, "dev", session.id);

	const skills = argValues(fakes[0].opts.args ?? [], "--skill");
	expect(skills).toContain(join(userDir, "my-skill"));
});

test("--skill 包含 builtin 来源的 skill（因为已禁用 Pi 默认扫描，必须由 WaPi 显式传入）", async () => {
	const skillRoot = tmpSkillRoot();
	tmpPaths.push(skillRoot);
	createSkillAt(join(skillRoot, "skills"), "builtin-skill", "内置"); // builtin
	const userDir = join(skillRoot, "user-skills");
	mkdirSync(userDir, { recursive: true });
	createSkillAt(userDir, "user-skill", "用户");
	const skillManager = new SkillManager(skillRoot);
	await skillManager.addDir(userDir);

	const { project, session, am, fakes } = await setup({ skillManager });
	await am.ensureStarted(project.id, "dev", session.id);

	const args = fakes[0].opts.args ?? [];
	expect(args).toContain("--no-skills");
	const skills = argValues(args, "--skill");
	expect(skills).toContain(join(userDir, "user-skill"));
	expect(skills).toContain(join(join(skillRoot, "skills"), "builtin-skill"));
});

test("skillManager 为空时仍传 --no-skills 但不传 --skill", async () => {
	const { project, session, am, fakes } = await setup(); // 不传 skillManager
	await am.ensureStarted(project.id, "dev", session.id);

	const args = fakes[0].opts.args ?? [];
	expect(args).toContain("--no-skills");
	expect(args).not.toContain("--skill");
});

test("skillsAllOff=true 时不传任何 --skill（显式全不选，仍传 --no-skills）", async () => {
	const skillRoot = tmpSkillRoot();
	tmpPaths.push(skillRoot);
	const userDir = join(skillRoot, "user-skills");
	mkdirSync(userDir, { recursive: true });
	createSkillAt(userDir, "my-skill", "测试技能");
	const skillManager = new SkillManager(skillRoot);
	await skillManager.addDir(userDir);

	const configStore = {
		getAgent: mock(async () => ({
			displayName: "dev",
			skills: [],
			skillsAllOff: true, // 显式全不选
			partners: { askTo: [] },
		})),
	} as any;
	const { project, session, am, fakes } = await setup({
		skillManager,
		configStore,
	});
	await am.ensureStarted(project.id, "dev", session.id);

	const args = fakes[0].opts.args ?? [];
	expect(args).toContain("--no-skills");
	const skills = argValues(args, "--skill");
	// 全不选：即使全局有启用的技能，也不应传入任何 --skill
	expect(skills).toEqual([]);
});

// ─── 进程崩溃 ───────────────────────────────────────────────────────────────

test("进程意外退出 → 合成 message_end 错误事件 + 下次 ensureStarted 重建新 client", async () => {
	const events: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events });
	// 该会话已发过消息（piSessionFile 存在），是正常会话崩溃而非孤儿——不会被回滚删除
	writeFileSync(session.piSessionFile, '{"role":"user","content":"hi"}\n');
	await am.ensureStarted(project.id, "dev", session.id);
	expect(fakes).toHaveLength(1);

	fakes[0].simulateCrash(3);

	// 合成错误事件（前端 ⚠️ 渲染管线）
	const crashEvent = events.find(
		(x) => x.e.type === "message_end" && x.e.message?.stopReason === "error",
	);
	expect(crashEvent).toBeDefined();
	expect(crashEvent!.sessionId).toBe(session.id);
	expect(crashEvent!.e.message.errorMessage).toContain("agent 进程意外退出");
	expect(crashEvent!.e.message.errorMessage).toContain("code=3");

	// 崩溃后下次 ensureStarted 拆除重建
	await am.ensureStarted(project.id, "dev", session.id);
	expect(fakes).toHaveLength(2);
	expect(fakes[1]).not.toBe(fakes[0]);
	expect(fakes[1].started).toBe(true);
});

// ─── 孤儿会话回滚（getCommands 兜底创建的 session 无消息文件，进程退出时删除记录）──

test("孤儿会话（piSessionFile 不存在）进程退出 → 删除 session 记录 + 触发回滚回调", async () => {
	const rollbacks: string[] = [];
	const projectStore = newProjectStore();
	const project = await projectStore.createProject({
		name: "测试",
		cwd: "/tmp",
	});
	const session = await projectStore.createSession({
		projectId: project.id,
		primaryAgent: "dev",
		title: "dev",
	});
	// 故意不创建 piSessionFile 文件（模拟孤儿：getCommands 创建了记录但从未 prompt）
	expect(existsSync(session.piSessionFile)).toBe(false);

	const fakes: FakeSessionClient[] = [];
	const am = new AgentManager({
		projectStore,
		configStore: null,
		onEvent: () => {},
		createClientFn: fakeClientFactory(fakes),
		browserManager: NOOP_BROWSER_MANAGER,
		onSessionRollback: (sid) => rollbacks.push(sid),
	});
	managers.push(am);
	syspromptSessionIds.push(session.id);

	await am.ensureStarted(project.id, "dev", session.id);
	// 模拟进程崩溃退出（非主动 dispose）
	fakes[0].simulateCrash(1);

	// 回滚：session 记录应被删除
	await new Promise((r) => setTimeout(r, 50)); // 等 fire-and-forget deleteSession 落盘
	// deleteSession 是软删除（设 deletedAt），loadActive 过滤已删除的会话
	const { sessions } = await projectStore.loadActive();
	expect(sessions.find((s) => s.id === session.id)).toBeUndefined();
	expect(rollbacks).toEqual([session.id]);
});

test("正常会话（piSessionFile 存在）进程崩溃退出 → 不删除 session 记录", async () => {
	const rollbacks: string[] = [];
	const projectStore = newProjectStore();
	const project = await projectStore.createProject({
		name: "测试",
		cwd: "/tmp",
	});
	const session = await projectStore.createSession({
		projectId: project.id,
		primaryAgent: "dev",
		title: "测试",
	});
	// 创建 piSessionFile 文件（模拟正常会话：已发过消息，pi 落盘了 jsonl）
	writeFileSync(session.piSessionFile, '{"role":"user","content":"hi"}\n');

	const fakes: FakeSessionClient[] = [];
	const am = new AgentManager({
		projectStore,
		configStore: null,
		onEvent: () => {},
		createClientFn: fakeClientFactory(fakes),
		browserManager: NOOP_BROWSER_MANAGER,
		onSessionRollback: (sid) => rollbacks.push(sid),
	});
	managers.push(am);
	syspromptSessionIds.push(session.id);

	await am.ensureStarted(project.id, "dev", session.id);
	fakes[0].simulateCrash(1);

	await new Promise((r) => setTimeout(r, 50));
	const { sessions } = await projectStore.load();
	// 正常会话崩溃不删除（只标记 crashed 待重建）
	expect(sessions.find((s) => s.id === session.id)).toBeDefined();
	expect(rollbacks).toEqual([]);
});

// ─── 静态断言 ───────────────────────────────────────────────────────────────

test("WA_PI_DEFAULT_SYSTEM_PROMPT 含 @[agentName] 委托规则文案", () => {
	// 委托规则在 delegate-mechanism 段（DEFAULT_DELEGATE_MECHANISM_PROMPT）
	const { DEFAULT_DELEGATE_MECHANISM_PROMPT } = require("../src/system-prompt");
	const fullDefault = `${WA_PI_DEFAULT_SYSTEM_PROMPT}\n\n${DEFAULT_DELEGATE_MECHANISM_PROMPT}`;
	expect(fullDefault).toContain("@[agentName]");
	expect(fullDefault).toContain("delegate");
	expect(fullDefault).toContain("Task Contract");
});

// ─── 队列：followUpList / steerMessage / abort ────────────────────────────

test("prompt 在 busy 时追加到 followUpList（不直接发送）", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	// 模拟 agent 运行中
	fakes[0].autoSettle = false;
	fakes[0].prompted = [];

	await am.prompt(session.id, "测试消息1", { model: MODEL });

	// 第一条消息直接发送（agent 尚未 busy）
	expect(fakes[0].prompted).toHaveLength(1);
	expect(fakes[0].prompted[0]).toContain("测试消息1");

	// 模拟 agent 开始运行（busy=true），再发第二条
	fakes[0].emit({ type: "agent_start" });
	fakes[0].prompted = [];

	await am.prompt(session.id, "排队消息2", { model: MODEL });

	// busy 状态时追加到本地列表，不调 prompt
	expect(fakes[0].prompted).toHaveLength(0);

	// 验证 followUpList 内容（对象条目，含文本与可选 images）
	const handle = (am as any).sessions.get(session.id);
	expect(handle.followUpList).toEqual([{ text: "排队消息2", images: [] }]);
});

test("agent_settled 自动 drain followUpList", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	// 手动设置 followUpList 内容
	const handle = (am as any).sessions.get(session.id);
	handle.followUpList = [
		{ text: "消息1", images: [] },
		{ text: "消息2", images: [] },
	];
	handle.busy = true;
	fakes[0].autoSettle = false;

	// 注入 agent_settled 事件
	fakes[0].prompted = [];
	fakes[0].emit({ type: "agent_settled" });

	// 第一条消息已被 drain（_sendPromptNow 重设 busy=true；发送前自动压缩检查引入异步延迟，轮询等待）
	await waitFor(() => fakes[0].prompted.length === 1);
	expect(fakes[0].prompted).toHaveLength(1);
	expect(fakes[0].prompted[0]).toBe("消息1");

	// 第二条还在列表
	expect(handle.followUpList).toEqual([{ text: "消息2", images: [] }]);
});

test("steerMessage 空闲时降级为 prompt", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	// agent 空闲（默认 autoSettle=true 已 settled）
	fakes[0].steered = [];
	fakes[0].prompted = [];

	await am.steerMessage(session.id, "引导消息");

	// 空闲时降级为 prompt，不走 steer
	expect(fakes[0].steered).toHaveLength(0);
	expect(fakes[0].prompted).toHaveLength(1);
	expect(fakes[0].prompted[0]).toBe("引导消息");
});

test("steerMessage 运行中时调用 pi steer", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	// agent 运行中
	fakes[0].autoSettle = false;
	fakes[0].emit({ type: "agent_start" });
	fakes[0].steered = [];
	fakes[0].prompted = [];

	await am.steerMessage(session.id, "运行中引导");

	// 运行中时走 pi 原生 steer
	expect(fakes[0].steered).toHaveLength(1);
	expect(fakes[0].steered[0]).toBe("运行中引导");
	expect(fakes[0].prompted).toHaveLength(0);
});

test("abort 清空 followUpList 并调用 client.abort", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	const handle = (am as any).sessions.get(session.id);
	handle.followUpList = ["排队消息"];
	handle.busy = true;

	await am.abort(session.id);

	// abort 后清空本地列表
	expect(handle.followUpList).toEqual([]);
	// busy 归 false
	expect(handle.busy).toBe(false);
	// 调用了 client.abort
	expect(fakes[0].aborts).toBe(1);
});

test("agent skills 白名单：只传 config.skills 指定的技能路径给 pi", async () => {
	const skillRoot = tmpSkillRoot();
	tmpPaths.push(skillRoot);
	createSkillAt(join(skillRoot, "skills"), "skill-a", "A");
	createSkillAt(join(skillRoot, "skills"), "skill-b", "B");
	const userDir = join(skillRoot, "user-skills");
	mkdirSync(userDir, { recursive: true });
	createSkillAt(userDir, "skill-c", "C");
	const skillManager = new SkillManager(skillRoot);
	await skillManager.addDir(userDir);

	// agent 配置只允许 skill-a 和 skill-c
	const configStore = {
		getAgent: mock(async () => ({
			displayName: "pm",
			skills: ["skill-a", "skill-c"],
			partners: { askTo: [] },
		})),
	} as any;

	const { project, session, am, fakes } = await setup({
		skillManager,
		configStore,
	});
	await am.ensureStarted(project.id, "pm", session.id);

	const skills = argValues(fakes[0].opts.args ?? [], "--skill");
	// skill-a 和 skill-c 在列表中，skill-b 不在
	expect(skills.some((s) => s.includes("skill-a"))).toBe(true);
	expect(skills.some((s) => s.includes("skill-c"))).toBe(true);
	expect(skills.some((s) => s.includes("skill-b"))).toBe(false);
});

test("agent skills 空数组 = 全量（不传白名单时所有启用技能都传给 pi）", async () => {
	const skillRoot = tmpSkillRoot();
	tmpPaths.push(skillRoot);
	createSkillAt(join(skillRoot, "skills"), "skill-a", "A");
	createSkillAt(join(skillRoot, "skills"), "skill-b", "B");
	const skillManager = new SkillManager(skillRoot);

	// agent 配置 skills 为空数组 → 全量
	const configStore = {
		getAgent: mock(async () => ({
			displayName: "dev",
			skills: [],
			partners: { askTo: [] },
		})),
	} as any;

	const { project, session, am, fakes } = await setup({
		skillManager,
		configStore,
	});
	await am.ensureStarted(project.id, "dev", session.id);

	const skills = argValues(fakes[0].opts.args ?? [], "--skill");
	expect(skills.some((s) => s.includes("skill-a"))).toBe(true);
	expect(skills.some((s) => s.includes("skill-b"))).toBe(true);
});

test("message_end 透传 usage 字段到消息历史", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	// 模拟 Pi 的 message_end 事件，携带 usage
	const usageData = {
		input: 3200,
		output: 1100,
		cacheRead: 1500,
		cacheWrite: 200,
		totalTokens: 4300,
	};
	fakes[0].emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			model: "test-model",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: usageData,
		},
	});

	// usage 应被保留在消息历史中
	const messages = am.getMessages(session.id);
	expect(messages.length).toBe(1);
	expect(messages[0].usage).toEqual(usageData);
});

// ─── getCommands：拉取 pi 运行时 slash 命令 ─────────────────────────────────

test("getCommands 转发 pi get_commands 并返回合并的命令清单", async () => {
	const { am, project, session, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	// 预置 pi 返回三类命令（模拟插件 / prompt / skill）
	fakes[0].commandsToReturn = [
		{ name: "goal", description: "设定目标", source: "extension" },
		{ name: "review", description: "代码审查模板", source: "prompt" },
		{ name: "skill:writer", description: "写作技能", source: "skill" },
	];

	const commands = await am.getCommands(session.id);

	// 应原样返回 pi 的三类命令（过滤 skill 是前端 store 的职责，kernel 不过滤）
	expect(commands).toHaveLength(3);
	expect(commands.map((c) => c.name)).toEqual([
		"goal",
		"review",
		"skill:writer",
	]);
	expect(commands[0]).toEqual({
		name: "goal",
		description: "设定目标",
		source: "extension",
	});
});

test("getCommands 无活跃进程时触发冷启动守卫", async () => {
	const { am, session, fakes } = await setup();
	// 不先 ensureStarted，直接调 getCommands → 应触发冷启动（同 reloadSession 守卫）
	// 冷启动是异步的，且 getCommands 在 ensureStarted 完成后立即读 commandsToReturn；
	// 这里只验证冷启动被触发（fake.started=true），命令返回值不依赖时序断言。
	await am.getCommands(session.id).catch(() => {}); // commandsToReturn 默认空，返回 []
	expect(fakes[0].started).toBe(true);
});

test("getCommands 会话不存在时返回空数组（未提供 projectId/agentName）", async () => {
	const { am } = await setup();
	// 无 projectId/agentName 时无法自动创建 session，返回空数组
	const commands = await am.getCommands("不存在的session");
	expect(commands).toEqual([]);
});

test("getCommands 会话不存在时自动创建 session 并返回命令", async () => {
	// 自定义工厂：让新创建的 fake client 预设 commandsToReturn
	const fakes2: FakeSessionClient[] = [];
	const customFactory = (opts: RpcClientOpts) => {
		const fake = new FakeSessionClient(opts);
		fake.commandsToReturn = [
			{ name: "goal", description: "设定目标", source: "extension" },
		];
		fakes2.push(fake);
		return fake as unknown as RpcClient;
	};

	const { am, project } = await setup({ createClientFn: customFactory });

	// session 不存在但有 projectId+agentName → 自动创建 + 启动 pi 进程 + 返回命令
	const commands = await am.getCommands("new-session-id", project.id, "dev");

	expect(commands).toHaveLength(1);
	expect(commands[0].name).toBe("goal");

	// session 已被创建并存到 ProjectStore（预热占位记录：不进侧栏，首条消息时转正）
	const { sessions } = await (am as any).opts.projectStore.load();
	const created = sessions.find((s: any) => s.id === "new-session-id");
	expect(created).toBeTruthy();
	expect(created.placeholder).toBe(true);
});

test("getCommands 附加 packageName 且不产生 tuiOnly 字段", async () => {
	// 造两个临时扩展包：goal-ext / plain-ext（package.json name 即 packageName 来源）
	const root = join(WA_PI_DIR, "tmp", `pkg-name-${Date.now()}`);
	tmpPaths.push(root);
	const goalDir = join(root, "goal-ext");
	mkdirSync(goalDir, { recursive: true });
	writeFileSync(
		join(goalDir, "package.json"),
		JSON.stringify({ name: "goal-ext" }),
	);
	writeFileSync(join(goalDir, "index.ts"), `export const x = 1;\n`);
	const plainDir = join(root, "plain-ext");
	mkdirSync(plainDir, { recursive: true });
	writeFileSync(
		join(plainDir, "package.json"),
		JSON.stringify({ name: "plain-ext" }),
	);
	writeFileSync(join(plainDir, "index.ts"), `export const y = 2;\n`);

	const { am, project, session, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	fakes[0].commandsToReturn = [
		{
			name: "goal",
			source: "extension",
			sourceInfo: { path: join(goalDir, "index.ts") },
		},
		{
			name: "hello",
			source: "extension",
			sourceInfo: { path: join(plainDir, "index.ts") },
		},
		{ name: "orphan", source: "extension" }, // 无 sourceInfo → 原样保留
	];

	const commands = await am.getCommands(session.id);
	expect(commands.map((c) => c.name)).toEqual(["goal", "hello", "orphan"]);
	expect(commands.find((c) => c.name === "goal")?.packageName).toBe("goal-ext");
	expect(commands.find((c) => c.name === "hello")?.packageName).toBe(
		"plain-ext",
	);
	// 无 sourceInfo 的命令原样返回（不附加 packageName）
	expect(commands.find((c) => c.name === "orphan")?.packageName).toBeUndefined();
	// tuiOnly 静态扫描已删除：不再产生 tuiOnly 字段
	expect(commands.every((c) => !("tuiOnly" in c))).toBe(true);
});

test("getCommands 合并 extension 命令开关状态（enabled：命中 toggles 用开关值，未记录缺省 true）", async () => {
	// 造一个临时扩展包：resolvePackageName 从 sourceInfo.path 读 package.json 解析包名
	const root = join(WA_PI_DIR, "tmp", `toggles-merge-${Date.now()}`);
	tmpPaths.push(root);
	const extDir = join(root, "goal-ext");
	mkdirSync(extDir, { recursive: true });
	writeFileSync(
		join(extDir, "package.json"),
		JSON.stringify({ name: "goal-ext" }),
	);
	writeFileSync(join(extDir, "index.ts"), `export const y = 1;\n`);

	const { am, project, session, fakes } = await setup({
		extensionManager: {
			// ensureStarted 会调 listEnabledPackageNames 决定 -e 扩展路径
			listEnabledPackageNames: async () => [],
			getCommandToggles: async () => ({ "goal-ext": { goal: true } }),
		},
	});
	await am.ensureStarted(project.id, "dev", session.id);
	fakes[0].commandsToReturn = [
		{
			name: "goal",
			source: "extension",
			sourceInfo: { path: join(extDir, "index.ts") },
		},
		{
			name: "hello",
			source: "extension",
			sourceInfo: { path: join(extDir, "index.ts") },
		},
		{ name: "review", description: "代码审查模板", source: "prompt" },
	];

	const commands = await am.getCommands(session.id);

	expect(commands).toHaveLength(3);
	// 开启的命令 → enabled: true
	expect(commands.find((c) => c.name === "goal")?.enabled).toBe(true);
	// 未记录开关的命令 → 缺省 true（附加命令默认全部开启）
	expect(commands.find((c) => c.name === "hello")?.enabled).toBe(true);
	// 非 extension 命令（prompt 来源）→ 不附加 enabled（保持 kernel 不填 enabled 的语义）
	expect(commands.find((c) => c.name === "review")?.enabled).toBeUndefined();
});

// ─── getCommands：dirty 进程（扩展/技能变更待重建）处理 ─────────────────────

test("getCommands 命中 dirty 进程先热重载再取（安装扩展后清单不过期）", async () => {
	const { am, project, session, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	fakes[0].commandsToReturn = [
		{ name: "old-cmd", source: "extension" },
		{ name: "__!wa_pi_reload", source: "extension" },
	];
	expect((await am.getCommands(session.id)).map((c) => c.name)).toEqual([
		"old-cmd",
		"__!wa_pi_reload",
	]);

	am.markAllDirty(); // 模拟安装/卸载扩展
	await am.getCommands(session.id);
	// 扩展 dirty 走热重载：进程不重建，reloadExtensions 被调（真实环境下命令由 session.reload 刷新）
	expect(fakes).toHaveLength(1);
	expect(fakes[0].reloaded).toBe(1);
});

test("getCommands 借用进程时热重载 dirty 进程再取", async () => {
	const { am, project, session, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	fakes[0].commandsToReturn = [
		{ name: "old-cmd", source: "extension" },
		{ name: "__!wa_pi_reload", source: "extension" },
	];

	am.markAllDirty();
	// 「附加命令」弹窗链路：getCommands("") 借用活跃进程
	await am.getCommands("不存在的session");
	// 扩展 dirty 走热重载：进程不重建，reloadExtensions 被调
	expect(fakes).toHaveLength(1);
	expect(fakes[0].reloaded).toBe(1);
});

test("getCommands 借用干净进程不触发重建", async () => {
	const { am, project, session, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	fakes[0].commandsToReturn = [{ name: "goal", source: "extension" }];

	const commands = await am.getCommands("不存在的session");
	expect(fakes).toHaveLength(1); // 无 dirty 标记：直接借用，不重建
	expect(commands.map((c) => c.name)).toEqual(["goal"]);
});

// ─── 扩展命令拦截 prompt 时不卡在 thinking 状态 ─────────────────────────────
// 当扩展命令（如 /goal）拦截 prompt 时，agent_start 不会触发，
// _sendPromptNow 的乐观 busy=true 必须能复位，否则前端永远显示"思考中"。
test("扩展命令拦截 prompt 时不卡在 busy 状态", async () => {
	const events: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events });
	await am.ensureStarted(project.id, "dev", session.id);

	// 模拟扩展命令拦截：prompt 返回成功但 agent_start 不触发
	fakes[0].autoSettle = false;

	await am.prompt(session.id, "/goal", { model: MODEL });

	// prompt 返回后乐观 busy=true，等待 _sendPromptNow 内延迟检查复位
	await new Promise((r) => setTimeout(r, 60));

	// session 不应 busy（扩展命令已处理完毕，agent 未启动）
	expect(am.isSessionBusy(session.id)).toBe(false);

	// thinkingSince 也应为 null（没有 agent_start）
	expect(am.getThinkingSince(session.id)).toBeNull();

	// 合成 agent_end：让前端退出 thinking / 清掉 loading 占位
	expect(events.find((x) => x.e.type === "agent_end")).toBeTruthy();
});

// ─── 扩展 dialog 子协议：_onExtUiRequest 广播契约（前端 Task 4 消费的字段名）───

test("extension dialog 请求广播 extension_dialog 事件，载荷字段齐全（requestId/method/title/message/options/placeholder/prefill）", async () => {
	const events: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events });
	await am.ensureStarted(project.id, "dev", session.id);

	// 模拟 pi 扩展发起 select 对话：onUiRequest 挂起等前端应答
	const pending = fakes[0].opts.onUiRequest!({
		type: "extension_ui_request",
		id: "req-1",
		method: "select",
		title: "选择方案",
		message: "请选一个",
		options: ["A", "B"],
		placeholder: "输入…",
		prefill: "预填",
		timeout: 30000,
	});

	const ev = events.find((x) => x.e.type === "extension_dialog");
	expect(ev).toBeTruthy();
	expect(ev!.sessionId).toBe(session.id);
	expect(ev!.projectId).toBe(project.id);
	// 前端 ExtensionDialog 依赖的字段名契约：改名/漏字段会让弹窗拿不到数据
	expect(ev!.e).toEqual({
		type: "extension_dialog",
		requestId: "req-1",
		method: "select",
		title: "选择方案",
		message: "请选一个",
		options: ["A", "B"],
		placeholder: "输入…",
		prefill: "预填",
		timeout: 30000,
	});

	// 前端应答（POST /api/extensions/dialog/respond → extUiRegistry.respond）后 promise 落地
	expect(extUiRegistry.respond("req-1", { value: "A" })).toBe(true);
	await expect(pending).resolves.toEqual({ value: "A" });
});

test("extension dialog 请求 title/message/options 剥离 ANSI 转义；缺省字段为 undefined", async () => {
	const events: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events });
	await am.ensureStarted(project.id, "dev", session.id);

	const pending = fakes[0].opts.onUiRequest!({
		type: "extension_ui_request",
		id: "req-2",
		method: "confirm",
		title: "[31m确认删除[0m",
		message: "[1m确定吗？[0m",
	});

	const ev = events.find((x) => x.e.type === "extension_dialog");
	expect(ev!.e.requestId).toBe("req-2");
	expect(ev!.e.method).toBe("confirm");
	expect(ev!.e.title).toBe("确认删除");
	expect(ev!.e.message).toBe("确定吗？");
	// 未提供的字段为 undefined（前端按可选渲染）
	expect(ev!.e.options).toBeUndefined();
	expect(ev!.e.placeholder).toBeUndefined();
	expect(ev!.e.prefill).toBeUndefined();

	extUiRegistry.respond("req-2", { confirmed: true });
	await pending;
});

// ─── 回合看门狗（任务 3：pi 假死自动恢复）───────────────────────────────
// 背景：主会话 busy 复位完全依赖 pi 发 agent_settled。pi 假死（MCP 工具卡死 /
// LLM 流停滞但 TCP 未断 / 扩展死锁）时不退出也不发事件 → busy 永真：前端永久
// 「思考中」、排队消息永不 drain。回合看门狗：busy 期间无任何 pi 事件超过 idleMs
// 强杀进程走崩溃恢复路径。等待用户回答（ask / 扩展 dialog）是正常的长无事件状态，
// 看门狗触发时检查 pending 并跳过重新武装。

test("移除回合看门狗：busy 后无任何事件不再强杀主代理（主代理异常由 pi 自身兑底）", async () => {
	const events: CapturedEvent[] = [];
	const { project, session, am, fakes } = await setup({ events });
	await am.ensureStarted(project.id, "dev", session.id);
	const fake = fakes[0];
	fake.autoSettle = false;
	await am.prompt(session.id, "你好", { model: MODEL });
	// agent_start 置位 thinkingSince，防 _sendPromptNow 的 50ms 乐观复位清掉 busy
	fake.emit({ type: "agent_start" } as any);
	// 之后无任何事件（模拟 pi 静默/长等待）→ 主代理进程必须保持存活：
	// 回合看门狗已移除，主代理异常由 pi 自身有界重试兑底，不再由 kernel 强杀。
	await new Promise((r) => setTimeout(r, 400));
	expect(fake.alive).toBe(true); // 主代理不被看门狗强杀
	fake.emit({ type: "agent_settled" } as any);
});
