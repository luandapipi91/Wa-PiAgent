import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { WSServer } from "../src/ws-server";

// 测试：向空标题会话注入 steer 引导消息 → 自动补全标题
// 背景：标题补全原先只绑定在 agent:prompt（正常发送消息）时刻；steer:message / steer:immediate-message
// 注入消息时不补全，导致 getCommands 兜底创建的空标题会话（title: ""）经 steer 首次发送后标题仍为空。
// 修复：steer 两条路径注入成功后，若会话标题为空则用消息前 20 字补全并广播 projects:list。

const tmp = (s: string) =>
	join(
		import.meta.dir,
		".tmp-steer-title-" + s + Math.random().toString(36).slice(2),
	);

function makeAgentManager(steerLog: string[]) {
	return {
		steerMessage: async (_sid: string, text: string) => {
			steerLog.push(text);
		},
		abort: async () => {},
		ensureStarted: async () => ({
			messages: [],
			prompt: async () => {},
			abort: async () => {},
			dispose: () => {},
		}),
		prompt: async () => {},
		disposeSession: async () => {},
		disposeAll: async () => {},
		isSessionBusy: () => false,
		getThinkingSince: () => null,
	} as any;
}

async function setup() {
	const cfgDir = tmp("cfg");
	const projFile = tmp("proj.json");
	const configStore = new ConfigStore(cfgDir);
	const projectStore = new ProjectStore(projFile);
	const providerStore = new ProviderStore(
		join(projFile, "..", "providers.json"),
	);
	const skillManager = new SkillManager(join(projFile, "..", "skills"));
	const project = await projectStore.createProject({ name: "P", cwd: "/tmp" });
	const steerLog: string[] = [];
	const agentManager = makeAgentManager(steerLog);
	const server = new WSServer({
		configStore,
		projectStore,
		providerStore,
		skillManager,
		extensionManager: new ExtensionManager(join(projFile, "..")),
		memoryStore: null as any,
		mcpStore: null as any,
		agentManager,
		channelManager: null,
		port: 0,
	});
	await server.start();
	const base = `http://127.0.0.1:${server.actualPort}`;
	return {
		cfgDir,
		projFile,
		projectStore,
		steerLog,
		server,
		base,
		project,
	};
}

async function teardown(ctx: Awaited<ReturnType<typeof setup>>) {
	await ctx.server.stop();
	rmSync(ctx.cfgDir, { recursive: true, force: true });
	rmSync(ctx.projFile, { force: true });
}

test("[第三层] steer:message 注入消息后自动补全空标题会话", async () => {
	const ctx = await setup();
	const { projectStore, project, steerLog, base } = ctx;
	try {
		// 模拟 getCommands 兜底创建的空标题会话
		const session = await projectStore.createSession({
			projectId: project.id,
			primaryAgent: "dev",
			title: "",
			id: "s-steer-empty",
		});
		expect(session.title).toBe("");

		const res = await fetch(`${base}/api/sessions/${session.id}/steer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "帮我修复这个登录 bug" }),
		});
		expect(res.status).toBe(200);
		expect(steerLog).toHaveLength(1);
		// 标题被补全为消息前 20 字
		const { sessions } = await projectStore.load();
		expect(sessions.find((s) => s.id === session.id)?.title).toBe(
			"帮我修复这个登录 bug",
		);
	} finally {
		await teardown(ctx);
	}
});

test("[第三层] steer:immediate-message 注入消息后自动补全空标题会话", async () => {
	const ctx = await setup();
	const { projectStore, project, steerLog, base } = ctx;
	try {
		const session = await projectStore.createSession({
			projectId: project.id,
			primaryAgent: "dev",
			title: "",
			id: "s-steer-immediate",
		});
		const res = await fetch(
			`${base}/api/sessions/${session.id}/steer/immediate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text: "立即停止并重新执行" }),
			},
		);
		expect(res.status).toBe(200);
		expect(steerLog).toHaveLength(1);
		const { sessions } = await projectStore.load();
		expect(sessions.find((s) => s.id === session.id)?.title).toBe(
			"立即停止并重新执行",
		);
	} finally {
		await teardown(ctx);
	}
});

test("[第三层] steer 已有标题的会话不覆盖标题", async () => {
	const ctx = await setup();
	const { projectStore, project, base } = ctx;
	try {
		const session = await projectStore.createSession({
			projectId: project.id,
			primaryAgent: "dev",
			title: "已有标题",
			id: "s-steer-has-title",
		});
		const res = await fetch(`${base}/api/sessions/${session.id}/steer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "新消息内容" }),
		});
		expect(res.status).toBe(200);
		const { sessions } = await projectStore.load();
		expect(sessions.find((s) => s.id === session.id)?.title).toBe("已有标题");
	} finally {
		await teardown(ctx);
	}
});
