import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	buildSchedulerPrompt,
	parseImPushMentions,
	createImPushTool,
} from "../src/tools/robot-push";

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

// ===== buildSchedulerPrompt（executeTask 发送给 agent 的 prompt 构造）=====

describe("buildSchedulerPrompt（@im-push-to 版）", () => {
	test("无标记原样返回", () => {
		expect(buildSchedulerPrompt("普通指令", [])).toBe("普通指令");
	});

	test("有联系人标记：追加系统提示，含 id、工具名与 delegate 澄清", () => {
		const out = buildSchedulerPrompt("整理日报 @im-push-to(ch_aaa,ct_p01)", [
			"ct_p01",
		]);
		expect(out.startsWith("整理日报 @im-push-to(ch_aaa,ct_p01)")).toBe(true);
		expect(out).toContain("ct_p01");
		expect(out).toContain("im_push_to");
		expect(out).toContain("不要对其调用 delegate");
	});
});
