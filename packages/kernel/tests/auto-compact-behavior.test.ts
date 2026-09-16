// auto-compact-behavior.test.ts — 发送前自动压缩的数据源行为验证
//
// 修复背景：预压缩原经 pi-ai 模型目录（catalog）查 contextWindow，用户自定义模型
// （自填 baseUrl 的中转）不在目录里 → 预压缩静默失效，pi 在 prompt preflight 里的
// 隐性压缩成为唯一防线，慢模型大会话压缩耗时超 prompt RPC 60s 超时，前端误报
// 「agent 启动失败: RPC 命令超时」。修复后数据源改为 pi 实时返回的
// getSessionStats().contextUsage（tokens + contextWindow，与 pi 内部压缩判断同源）。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import {
	type FakeSessionClient,
	fakeClientFactory,
} from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import { askRegistry } from "../src/ask-registry";
import { WA_PI_DIR } from "@wa-pi/shared";
import { rmSync } from "node:fs";
import { join } from "node:path";

// 不在 pi-ai 目录里的自定义模型 id（模拟用户自填 baseUrl 的中转模型）
const CUSTOM_MODEL = "custom-relay/glm-custom-relay";

const tmpFiles: string[] = [];
const managers: AgentManager[] = [];

beforeEach(() => {
	askRegistry.reset();
});

afterEach(async () => {
	for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
	for (const f of tmpFiles.splice(0)) {
		try {
			rmSync(f, { force: true });
		} catch {
			// 测试收尾清理失败不阻断
		}
	}
});

async function setup() {
	const tmpFile = `/tmp/wa-pi-autocp-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2)}.json`;
	tmpFiles.push(tmpFile);
	const projectStore = new ProjectStore(tmpFile);
	const project = await projectStore.createProject({
		name: "测试",
		cwd: "/tmp",
	});
	const session = await projectStore.createSession({
		projectId: project.id,
		primaryAgent: "dev",
		title: "测试",
	});
	tmpFiles.push(join(WA_PI_DIR, "tmp", "sysprompts", `${session.id}.md`));

	const fakes: FakeSessionClient[] = [];
	const am = new AgentManager({
		projectStore,
		configStore: null,
		onEvent: () => {},
		createClientFn: fakeClientFactory(fakes),
		browserManager: NOOP_BROWSER_MANAGER,
	});
	managers.push(am);
	await am.ensureStarted(project.id, "dev", session.id);
	return { session, am, fake: fakes[0] };
}

test("核心修复：自定义模型（不在 pi-ai 目录）也能按 pi 实时 contextUsage 触发预压缩", async () => {
	const { session, am, fake } = await setup();
	// pi 返回 128K 窗口、已占用 120K（93.75% > 80%）→ 必须触发压缩。
	// 修复前此场景因 catalog 查不到 custom-relay/glm-custom-relay 而静默跳过。
	fake.contextUsageToReturn = { tokens: 120_000, contextWindow: 128_000 };
	await am.prompt(session.id, "继续", { model: CUSTOM_MODEL });
	expect(fake.compacted.length).toBe(1);
});

test("占用低于 80% 时不压缩", async () => {
	const { session, am, fake } = await setup();
	fake.contextUsageToReturn = { tokens: 90_000, contextWindow: 128_000 };
	await am.prompt(session.id, "继续", { model: CUSTOM_MODEL });
	expect(fake.compacted.length).toBe(0);
});

test("tokens 为 null（压缩边界后尚无新 assistant usage）时跳过，与 pi 判断一致", async () => {
	const { session, am, fake } = await setup();
	fake.contextUsageToReturn = { tokens: null, contextWindow: 128_000 };
	await am.prompt(session.id, "继续", { model: CUSTOM_MODEL });
	expect(fake.compacted.length).toBe(0);
});

test("pi 未返回 contextWindow 时跳过（不再回退 catalog 查自定义模型）", async () => {
	const { session, am, fake } = await setup();
	fake.contextUsageToReturn = { tokens: 120_000, contextWindow: undefined };
	await am.prompt(session.id, "继续", { model: CUSTOM_MODEL });
	expect(fake.compacted.length).toBe(0);
});

test("回归：引擎口径低估 CJK 时，内核估算仍触发预压缩（修复长中文会话 400 卡死）", async () => {
	const { session, am, fake } = await setup();
	// 引擎口径：100K 窗口仅占用 50K（50% < 80%）——修复前不会压缩
	fake.contextUsageToReturn = { tokens: 50_000, contextWindow: 100_000 };
	// 消息快照：最后一条 assistant usage 50K（精确锚点）+ 一条 5 万字中文消息。
	// pi 的 chars/4 口径会把它算成 12500；内核 CJK 加权口径算成 50000，×1.15 后越阈值。
	fake.emit({
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			timestamp: 1000,
			content: [],
			usage: {
				input: 50_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 50_000,
			},
		},
	});
	fake.emit({
		type: "message_end",
		message: { role: "user", content: "中".repeat(50_000), timestamp: 2000 },
	});
	await am.prompt(session.id, "继续", { model: CUSTOM_MODEL });
	// 估算 = 50000 + ceil(50000 * 1.15) = 107500 > 80000 → 触发
	expect(fake.compacted.length).toBe(1);
});

test("条件②：占用未超 80%，但输入 + 模型最大输出 + 预留余量越窗口 → 触发", async () => {
	const { session, am, fake } = await setup();
	// set_model 回传真实模型：200K 窗口、64K 最大输出
	fake.modelToReturn = { contextWindow: 200_000, maxTokens: 64_000 };
	// 引擎口径占用 140K（70% < 80%，仅靠比例不压缩）
	fake.contextUsageToReturn = { tokens: 140_000, contextWindow: 200_000 };
	await am.prompt(session.id, "继续", { model: CUSTOM_MODEL });
	// 140000 + 64000 + 4096 = 208096 > 200000 → 触发
	expect(fake.compacted.length).toBe(1);
});

test("条件②：叠加输出预算后仍在窗口内 → 不触发", async () => {
	const { session, am, fake } = await setup();
	fake.modelToReturn = { contextWindow: 200_000, maxTokens: 8_192 };
	fake.contextUsageToReturn = { tokens: 140_000, contextWindow: 200_000 };
	await am.prompt(session.id, "继续", { model: CUSTOM_MODEL });
	// 140000 + 8192 + 4096 = 152288 < 200000 → 不触发
	expect(fake.compacted.length).toBe(0);
});

test("压缩完成（compaction_end 成功）后，下次发送前重拉消息快照", async () => {
	const { session, am, fake } = await setup();
	const before = fake.getMessagesCalls;
	// 模拟 pi 压缩完成事件（手动 / 自动 / pi 内部都会 emit）
	fake.emit({ type: "compaction_end", reason: "manual", aborted: false });
	await am.prompt(session.id, "继续", { model: CUSTOM_MODEL });
	// 压缩后快照过期 → 发送前重拉一次
	expect(fake.getMessagesCalls).toBe(before + 1);
});

test("压缩失败（compaction_end 带 errorMessage）不刷新快照", async () => {
	const { session, am, fake } = await setup();
	const before = fake.getMessagesCalls;
	fake.emit({
		type: "compaction_end",
		reason: "manual",
		aborted: false,
		errorMessage: "Compaction failed: Nothing to compact",
	});
	await am.prompt(session.id, "继续", { model: CUSTOM_MODEL });
	expect(fake.getMessagesCalls).toBe(before);
});
