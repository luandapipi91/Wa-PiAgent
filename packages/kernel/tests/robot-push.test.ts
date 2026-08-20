import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	buildImPushSystemPrompt,
	GENERIC_IM_PUSH_PROMPT,
	parseImPushMentions,
	createImPushTool,
} from "../src/tools/robot-push";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { WA_PI_DIR } from "@wa-pi/shared";

// ===== parseImPushMentions（@im-push-to 函数式标记，重构后唯一格式）=====

describe("parseImPushMentions", () => {
	test("提取单个标记的联系人 id", () => {
		expect(
			parseImPushMentions("推送结果给 @im-push-to(ch_aaa,ct_p01) 谢谢"),
		).toEqual(["ct_p01"]);
	});

	test("多个标记去重", () => {
		const prompt =
			"@im-push-to(ch_aaa,ct_p01) 和 @im-push-to(ch_bbb,ct_p02) 再推 @im-push-to(ch_aaa,ct_p01)";
		expect(parseImPushMentions(prompt)).toEqual(["ct_p01", "ct_p02"]);
	});

	test("无标记返回空数组", () => {
		expect(parseImPushMentions("普通指令没有标记")).toEqual([]);
	});

	test("旧 @ct_xxx / @ch_xxx 裸格式不再被识别（已废弃）", () => {
		expect(parseImPushMentions("推送 @ct_p01 @ch_aaa")).toEqual([]);
	});

	test("标记格式残缺不匹配（缺括号/缺 bot 段）", () => {
		expect(
			parseImPushMentions("@im-push-to(ch_aaa) 和 @im-push-to ct_p01"),
		).toEqual([]);
	});

	test("带连字符的 id 正常提取", () => {
		expect(parseImPushMentions("@im-push-to(ch_wecom-2,ct_li-4-5)")).toEqual([
			"ct_li-4-5",
		]);
	});
});

// ===== createImPushTool（联系人推送工具，任务 2 接入链路后替换 roch_push）=====

describe("createImPushTool：工具定义", () => {
	test("名称为 im_push_to，enum 为联系人 id 列表，参数名 contact", () => {
		const tool = createImPushTool({
			channelManager: { pushToContact: mock(async () => {}) } as any,
			contactIds: ["ct_p01", "ct_p02"],
			onPushResult: mock(),
		});
		expect(tool.name).toBe("im_push_to");
		expect((tool.inputSchema as any).properties.contact.enum).toEqual([
			"ct_p01",
			"ct_p02",
		]);
		expect((tool.inputSchema as any).required).toEqual(["contact", "message"]);
		expect(tool.description).toContain("ct_p01");
		expect(tool.description).toContain("@im-push-to");
	});
});

describe("createImPushTool：execute", () => {
	test("成功推送：走 pushToContact 且回调成功结果", async () => {
		const pushToContact = mock(async () => {});
		const onPushResult = mock();
		const tool = createImPushTool({
			channelManager: { pushToContact } as any,
			contactIds: ["ct_p01"],
			onPushResult,
		});
		const ret = await tool.execute({ contact: "ct_p01", message: "hi" });
		expect(ret).toContain("已成功推送给 ct_p01");
		expect(pushToContact).toHaveBeenCalledWith("ct_p01", "hi");
		expect(onPushResult).toHaveBeenCalledWith({
			targetId: "ct_p01",
			success: true,
		});
	});

	test("目标不在列表：拒绝且不推送", async () => {
		const pushToContact = mock(async () => {});
		const tool = createImPushTool({
			channelManager: { pushToContact } as any,
			contactIds: ["ct_p01"],
			onPushResult: mock(),
		});
		const ret = await tool.execute({ contact: "ct_其他", message: "hi" });
		expect(ret).toContain("不在可用列表中");
		expect(pushToContact).not.toHaveBeenCalled();
	});

	test("pushToContact 抛错：返回失败文本并回填失败结果", async () => {
		const tool = createImPushTool({
			channelManager: {
				pushToContact: mock(async () => {
					throw new Error("未连接");
				}),
			} as any,
			contactIds: ["ct_p01"],
			onPushResult: mock(),
		});
		const ret = await tool.execute({ contact: "ct_p01", message: "hi" });
		expect(ret).toContain("推送失败：未连接");
	});
});
// ===== C1：im_push_to 会话注入（ensureStarted opts → spawn env / bridge 分发）=====

import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import {
	type FakeSessionClient,
	fakeClientFactory,
} from "./fixtures/fake-session-client";
import { getBridgeSession } from "../src/bridge-registry";
import type { RpcClient } from "../src/rpc-client";

describe("im_push_to 会话注入", () => {
	const tmpFiles: string[] = [];
	const managers: AgentManager[] = [];

	afterEach(async () => {
		for (const am of managers.splice(0)) {
			await am.disposeAll().catch(() => {});
		}
		for (const f of tmpFiles.splice(0)) {
			try {
				rmSyncStub(f);
			} catch {
				// 尽力清理
			}
		}
	});

	async function setupAgent(opts?: { configStore?: unknown }): Promise<{
		project: { id: string };
		session: { id: string };
		am: AgentManager;
		fakes: FakeSessionClient[];
	}> {
		const tmpFile = `/tmp/wa-pi-robot-push-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
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
		const fakes: FakeSessionClient[] = [];
		const am = new AgentManager({
			projectStore,
			configStore: (opts?.configStore ?? null) as any,
			onEvent: () => {},
			createClientFn: fakeClientFactory(fakes) as (
				o: Parameters<typeof Object>[0] extends never ? never : any,
			) => RpcClient,
		});
		managers.push(am);
		return { project: project as { id: string }, session, am, fakes };
	}

	test("ensureStarted 带 imPush → spawn env 注入联系人列表，默认仍走排除式放行", async () => {
		const { project, session, am, fakes } = await setupAgent();
		await am.ensureStarted(project.id, "dev", session.id, {
			imPush: {
				targets: ["ct_aaa", "ct_bbb"],
				execute: async () => "ok",
			},
		});
		expect(fakes).toHaveLength(1);
		expect(fakes[0].opts.env?.WA_PI_IM_PUSH_TARGETS).toBe("ct_aaa,ct_bbb");
		// 未显式配置 tools：不传 --tools（排除式放行，扩展注册的 im_push_to 可用）
		expect(fakes[0].opts.args ?? []).not.toContain("--tools");
	});

	test("ensureStarted 不带 imPush → env 无联系人列表", async () => {
		const { project, session, am, fakes } = await setupAgent();
		await am.ensureStarted(project.id, "dev", session.id);
		expect(fakes[0].opts.env?.WA_PI_IM_PUSH_TARGETS).toBeUndefined();
	});

	test("受限 agent（显式 tools 白名单）+ imPush → 白名单并入 im_push_to", async () => {
		const configStore = {
			getAgent: async () => ({ displayName: "dev", tools: ["read"] }),
		};
		const { project, session, am, fakes } = await setupAgent({ configStore });
		await am.ensureStarted(project.id, "dev", session.id, {
			imPush: {
				targets: ["ct_aaa"],
				execute: async () => "ok",
			},
		});
		const args = fakes[0].opts.args ?? [];
		const i = args.indexOf("--tools");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1].split(",")).toContain("im_push_to");
	});

	test("bridgeCtx.handleTool 分发 im_push_to → 经注入 execute 执行", async () => {
		const calls: Array<{ contact: string; message: string }> = [];
		const { project, session, am } = await setupAgent();
		await am.ensureStarted(project.id, "dev", session.id, {
			imPush: {
				targets: ["ct_aaa"],
				execute: async (contact, message) => {
					calls.push({ contact, message });
					return `已推送给 ${contact}`;
				},
			},
		});
		const ctx = getBridgeSession(session.id);
		expect(ctx).toBeTruthy();
		const result = await ctx!.handleTool(
			"im_push_to",
			"tc-1",
			{ contact: "ct_aaa", message: "日报完成" },
			new AbortController().signal,
		);
		expect(calls).toEqual([{ contact: "ct_aaa", message: "日报完成" }]);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "已推送给 ct_aaa",
		});
	});

	test("execute 抛错 → 返回失败文本（不向 pi 进程抛异常）", async () => {
		const { project, session, am } = await setupAgent();
		await am.ensureStarted(project.id, "dev", session.id, {
			imPush: {
				targets: ["ct_aaa"],
				execute: async () => {
					throw new Error("渠道未连接");
				},
			},
		});
		const ctx = getBridgeSession(session.id);
		const result = await ctx!.handleTool(
			"im_push_to",
			"tc-2",
			{ contact: "ct_aaa", message: "x" },
			new AbortController().signal,
		);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "推送失败：渠道未连接",
		});
		expect((result.details as { error?: string }).error).toBe("渠道未连接");
	});
});

// rmSync 兜底（node:fs 同步删除，顶部 import 的是 promise 版 rm）
import { rmSync } from "node:fs";
function rmSyncStub(f: string) {
	rmSync(f, { force: true });
}

// ===== buildImPushSystemPrompt（注入 system prompt 的推送目标引导，不拼进 prompt）=====

describe("buildImPushSystemPrompt（@im-push-to 版）", () => {
	test("无联系人 → 空串（段不出现）", () => {
		expect(buildImPushSystemPrompt([])).toBe("");
	});

	test("有联系人：含 id、工具名与 delegate 澄清", () => {
		const out = buildImPushSystemPrompt(["ct_p01"]);
		expect(out).toContain("ct_p01");
		expect(out).toContain("im_push_to");
		expect(out).toContain("不要对其调用 delegate");
	});
});

test("GENERIC_IM_PUSH_PROMPT 常驻引导：含标记语义 / 工具名 / 防 delegate 提示", () => {
	expect(GENERIC_IM_PUSH_PROMPT).toContain("@im-push-to");
	expect(GENERIC_IM_PUSH_PROMPT).toContain("im_push_to");
	expect(GENERIC_IM_PUSH_PROMPT).toContain("delegate");
	expect(GENERIC_IM_PUSH_PROMPT).toContain("ct_xxx");
});

// ===== C2：主聊天 im_push_to 全局执行器（channelManager 全局长连接，无需每会话注册）=====
// 设计：im_push_to 调用时实时按联系人 id 解析，直接走 channelManager 全局长连接推送
// （pushToContact 内部按 contact.channelId 路由 + 校验联系人存在）；不再需要消息标记
// 预激活的会话注册表——进程重建/空闲回收后推送目标天然可用，无生命周期状态。

describe("主聊天 im_push_to 全局执行器", () => {
	const tmpFiles: string[] = [];
	const managers: AgentManager[] = [];

	afterEach(async () => {
		for (const am of managers.splice(0)) {
			await am.disposeAll().catch(() => {});
		}
		for (const f of tmpFiles.splice(0)) {
			try {
				rmSyncStub(f);
			} catch {
				/* 尽力清理 */
			}
		}
	});

	async function setupAgent(opts?: { configStore?: unknown }): Promise<{
		project: { id: string };
		session: { id: string };
		am: AgentManager;
		fakes: FakeSessionClient[];
	}> {
		const tmpFile = `/tmp/wa-pi-robot-push-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
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
		const fakes: FakeSessionClient[] = [];
		const am = new AgentManager({
			projectStore,
			configStore: (opts?.configStore ?? null) as any,
			onEvent: () => {},
			createClientFn: fakeClientFactory(fakes) as any,
		});
		managers.push(am);
		return { project: project as { id: string }, session, am, fakes };
	}

	test("任意会话调用 im_push_to → 经全局 executor 推送（无需消息标记预注册）", async () => {
		const calls: Array<{ contact: string; message: string }> = [];
		const { project, session, am } = await setupAgent();
		am.setImPushExecutor(async (contact, message) => {
			calls.push({ contact, message });
			return `已推送给 ${contact}`;
		});
		await am.ensureStarted(project.id, "dev", session.id);
		// 消息不含 @im-push-to 标记也能推：目标由调用时 contact 实时解析（pushToContact 全局路由）
		await am.prompt(session.id, "普通消息", { model: "p/m" });
		const ctx = getBridgeSession(session.id);
		expect(ctx).toBeTruthy();
		const result = await ctx!.handleTool(
			"im_push_to",
			"tc-9",
			{ contact: "ct_aaa", message: "日报完成" },
			new AbortController().signal,
		);
		expect(calls).toEqual([{ contact: "ct_aaa", message: "日报完成" }]);
		expect(result.content[0]).toEqual({ type: "text", text: "已推送给 ct_aaa" });
	});

	test("定时任务注入（imPush）优先于全局 executor", async () => {
		const globalCalls: string[] = [];
		const taskCalls: string[] = [];
		const { project, session, am } = await setupAgent();
		am.setImPushExecutor(async (contact) => {
			globalCalls.push(contact);
			return "global";
		});
		await am.ensureStarted(project.id, "dev", session.id, {
			imPush: {
				targets: ["ct_aaa"],
				execute: async (contact) => {
					taskCalls.push(contact);
					return "task";
				},
			},
		});
		const ctx = getBridgeSession(session.id);
		const result = await ctx!.handleTool(
			"im_push_to",
			"tc-10",
			{ contact: "ct_aaa", message: "x" },
			new AbortController().signal,
		);
		expect(taskCalls).toEqual(["ct_aaa"]);
		expect(globalCalls).toEqual([]);
		expect(result.content[0]).toEqual({ type: "text", text: "task" });
	});

	test("未接线 executor → 返回明确错误（不崩溃）", async () => {
		const { project, session, am } = await setupAgent();
		await am.ensureStarted(project.id, "dev", session.id);
		const ctx = getBridgeSession(session.id);
		const result = await ctx!.handleTool(
			"im_push_to",
			"tc-11",
			{ contact: "ct_aaa", message: "x" },
			new AbortController().signal,
		);
		expect((result.content[0] as { text: string }).text).toContain("未就绪");
		expect((result.details as { error?: string }).error).toBeTruthy();
	});

	test("全局 executor 抛错 → 返回失败文本（不向 pi 进程抛异常）", async () => {
		const { project, session, am } = await setupAgent();
		am.setImPushExecutor(async () => {
			throw new Error("渠道未连接");
		});
		await am.ensureStarted(project.id, "dev", session.id);
		const ctx = getBridgeSession(session.id);
		const result = await ctx!.handleTool(
			"im_push_to",
			"tc-12",
			{ contact: "ct_aaa", message: "x" },
			new AbortController().signal,
		);
		expect((result.content[0] as { text: string }).text).toBe("推送失败：渠道未连接");
		expect((result.details as { error?: string }).error).toBe("渠道未连接");
	});

	test("受限 agent（显式 tools 白名单）不带 imPush → 白名单仍并入 im_push_to", async () => {
		const configStore = {
			getAgent: async () => ({ displayName: "dev", tools: ["read"] }),
		};
		const { project, session, am, fakes } = await setupAgent({ configStore });
		await am.ensureStarted(project.id, "dev", session.id);
		const args = fakes[0].opts.args ?? [];
		const i = args.indexOf("--tools");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1].split(",")).toContain("im_push_to");
	});

	test("普通会话系统提示词含通用 im-push 常驻引导", async () => {
		const { project, session, am } = await setupAgent();
		await am.ensureStarted(project.id, "dev", session.id);
		const promptFile = join(WA_PI_DIR, "tmp", "sysprompts", `${session.id}.md`);
		const content = readFileSync(promptFile, "utf8");
		expect(content).toContain("im_push_to");
		expect(content).toContain("delegate");
	});
});
