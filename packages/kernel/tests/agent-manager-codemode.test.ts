// agent-manager-codemode.test.ts — Codemode 三档 → 会话 spawn --tools 组装。
// WA_PI_DIR 已被 tests/setup.ts 隔离到临时目录：不注入 loader 时走生产默认
// loadCodemodeLevel → 空 settings.json → 默认 compat，正好锁定「默认档」行为。
import { test, expect, mock, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import {
	FakeSessionClient,
	fakeClientFactory,
} from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import { makeFakeMcpAdmin } from "./helpers/fake-mcp-admin";
import type { McpServerReport } from "../src/mcp-admin";
import type { CodemodeLevel } from "@wa-pi/shared";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpPaths: string[] = [];
const managers: AgentManager[] = [];

afterEach(async () => {
	for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
	for (const p of tmpPaths.splice(0)) {
		try {
			rmSync(p, { force: true, recursive: true });
		} catch {
			// 清理失败静默
		}
	}
});

function mcpReport(exposure: McpServerReport["exposure"]): McpServerReport {
	return {
		name: "srv",
		scope: "global",
		enabled: true,
		exposure,
		state: "connected",
		tools: [],
	};
}

async function setup(
	opts: {
		level?: CodemodeLevel;
		servers?: McpServerReport[];
		configStore?: any;
	} = {},
) {
	const storeFile = join(
		tmpdir(),
		`wa-pi-cm-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
	);
	tmpPaths.push(storeFile);
	const projectStore = new ProjectStore(storeFile);
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
		configStore: opts.configStore ?? null,
		onEvent: () => {},
		createClientFn: fakeClientFactory(fakes),
		browserManager: NOOP_BROWSER_MANAGER,
		mcpAdmin: makeFakeMcpAdmin(opts.servers ?? []),
		...(opts.level
			? { codemodeLevelLoader: async () => opts.level as CodemodeLevel }
			: {}),
	});
	managers.push(am);
	return { project, session, am, fakes };
}

function argValues(args: string[], flag: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
	}
	return out;
}

test("默认档（compat）：排除式会话传 --tools +codemode，仍 --exclude-tools subagent", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);
	const args = fakes[0].opts.args ?? [];
	expect(argValues(args, "--tools")).toEqual(["+codemode"]);
	const excluded = argValues(args, "--exclude-tools").flatMap((v) =>
		v.split(","),
	);
	expect(excluded).toContain("subagent");
});

test("off 档：不传 --tools（现状行为）", async () => {
	const { project, session, am, fakes } = await setup({ level: "off" });
	await am.ensureStarted(project.id, "dev", session.id);
	const args = fakes[0].opts.args ?? [];
	expect(args).not.toContain("--tools");
});

test("off 档 + 存在 codemode 曝光 MCP：--tools +tool_search 兜底", async () => {
	const { project, session, am, fakes } = await setup({
		level: "off",
		servers: [mcpReport("codemode")],
	});
	await am.ensureStarted(project.id, "dev", session.id);
	expect(argValues(fakes[0].opts.args ?? [], "--tools")).toEqual([
		"+tool_search",
	]);
});

test("off 档 + 存在 deferred 曝光 MCP：同样兜底", async () => {
	const { project, session, am, fakes } = await setup({
		level: "off",
		servers: [mcpReport("deferred")],
	});
	await am.ensureStarted(project.id, "dev", session.id);
	expect(argValues(fakes[0].opts.args ?? [], "--tools")).toEqual([
		"+tool_search",
	]);
});

test("off 档 + direct 曝光 MCP：不兜底（direct 工具本来就直接声明）", async () => {
	const { project, session, am, fakes } = await setup({
		level: "off",
		servers: [mcpReport("direct")],
	});
	await am.ensureStarted(project.id, "dev", session.id);
	expect(fakes[0].opts.args ?? []).not.toContain("--tools");
});

test("compat 档 + 受限白名单：--tools 含 read 与 codemode（普通名追加，不混 +name）", async () => {
	const configStore = {
		getAgent: mock(async () => ({ displayName: "dev", tools: ["read"] })),
	} as any;
	const { project, session, am, fakes } = await setup({ configStore });
	await am.ensureStarted(project.id, "dev", session.id);
	const tools = argValues(fakes[0].opts.args ?? [], "--tools").flatMap((v) =>
		v.split(","),
	);
	expect(tools).toContain("read");
	expect(tools).toContain("codemode");
	expect(tools).toContain("im_push_to");
	expect(tools).not.toContain("+codemode");
});
