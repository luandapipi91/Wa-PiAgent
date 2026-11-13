// knowledge-tool-visibility.test.ts — knowledge_search 的工具可见性（规格 §6.6）：
// 「没有关联知识库的智能体，对话时不注入知识库工具」——不是禁用，是不可见。
// 覆盖两条 spawn 路径：
//   · 默认（非受限，全放行）→ 未绑定把 knowledge_search 并入 --exclude-tools；
//     绑定则不加排除（全放行天然含）。
//   · 受限（白名单）→ 绑定自动并入白名单；未绑定即使 agent 配置里显式写了也剔除。
// 同时锁定 system prompt 的 knowledge-bases 段只在有绑定时出现。
// WA_PI_DIR 已被 tests/setup.ts 隔离到临时目录，knowledge.db 落在这里，用例间清理。
import { test, expect, mock, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WA_PI_DIR } from "@wa-pi/shared";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { knowledgeDbPath } from "../src/knowledge/paths";
import { KnowledgeStore } from "../src/knowledge/store";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import {
	FakeSessionClient,
	fakeClientFactory,
} from "./fixtures/fake-session-client";
import { makeFakeMcpAdmin } from "./helpers/fake-mcp-admin";

const managers: AgentManager[] = [];
const tmpPaths: string[] = [];

afterEach(async () => {
	for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
	for (const p of tmpPaths.splice(0)) {
		try {
			rmSync(p, { force: true, recursive: true });
		} catch {
			// 清理失败静默
		}
	}
	// 知识库登记库按用例重建，避免绑定清单跨用例串味
	for (const suffix of ["", "-wal", "-shm"]) {
		rmSync(`${knowledgeDbPath(WA_PI_DIR)}${suffix}`, { force: true });
	}
});

/** 在隔离的 knowledge.db 里建一个库并返回 id（AgentManager 随后复用同一文件） */
function seedKb(name: string): string {
	const db = new Database(knowledgeDbPath(WA_PI_DIR));
	db.exec(KB_SCHEMA_SQL);
	const store = new KnowledgeStore(db, WA_PI_DIR);
	const kb = store.createKb({ folderPath: join(WA_PI_DIR, "kb-src"), name });
	store.close();
	return kb.id;
}

async function setup(opts: { configStore?: any } = {}) {
	const storeFile = join(
		tmpdir(),
		`wa-pi-kbv-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
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
		mcpAdmin: makeFakeMcpAdmin(),
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

function excludedTools(args: string[]): string[] {
	return argValues(args, "--exclude-tools").flatMap((v) => v.split(","));
}

function allowTools(args: string[]): string[] {
	return argValues(args, "--tools").flatMap((v) => v.split(","));
}

function syspromptOf(sessionId: string): string {
	const file = join(WA_PI_DIR, "tmp", "sysprompts", `${sessionId}.md`);
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}

test("未绑定知识库：默认全放行会话把 knowledge_search 并入 --exclude-tools", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	const args = fakes[0].opts.args ?? [];
	expect(excludedTools(args)).toContain("knowledge_search");
	expect(syspromptOf(session.id)).not.toContain("<available_knowledge_bases>");
});

test("绑定知识库：默认全放行会话不排除 knowledge_search，system prompt 出现库清单", async () => {
	const kbId = seedKb("产品文档");
	const configStore = {
		getAgent: mock(async () => ({ displayName: "dev", knowledgeBaseIds: [kbId] })),
	} as any;
	const { project, session, am, fakes } = await setup({ configStore });
	await am.ensureStarted(project.id, "dev", session.id);

	const args = fakes[0].opts.args ?? [];
	expect(excludedTools(args)).not.toContain("knowledge_search");
	expect(syspromptOf(session.id)).toContain("<available_knowledge_bases>");
});

test("未绑定知识库：白名单里显式写了 knowledge_search 也剔除", async () => {
	const configStore = {
		getAgent: mock(async () => ({
			displayName: "dev",
			tools: ["read", "knowledge_search"],
		})),
	} as any;
	const { project, session, am, fakes } = await setup({ configStore });
	await am.ensureStarted(project.id, "dev", session.id);

	const tools = allowTools(fakes[0].opts.args ?? []);
	expect(tools).toContain("read");
	expect(tools).not.toContain("knowledge_search");
});

test("绑定知识库：白名单自动并入 knowledge_search 且不重复", async () => {
	const kbId = seedKb("接口文档");
	const configStore = {
		getAgent: mock(async () => ({
			displayName: "dev",
			tools: ["read", "knowledge_search"],
			knowledgeBaseIds: [kbId],
		})),
	} as any;
	const { project, session, am, fakes } = await setup({ configStore });
	await am.ensureStarted(project.id, "dev", session.id);

	const tools = allowTools(fakes[0].opts.args ?? []);
	expect(tools.filter((t) => t === "knowledge_search")).toHaveLength(1);
	expect(tools).toContain("im_push_to"); // 既有并入不回归
});

// ============ knowledge_read 可见性（与 knowledge_search 同进同出） ============

test("绑定知识库：受限白名单自动并入 knowledge_read（模型才能读已抽取正文而不是去读原文件）", async () => {
	const kbId = seedKb("读取可见性库");
	const configStore = {
		getAgent: mock(async () => ({
			displayName: "dev",
			tools: ["read", "knowledge_search"],
			knowledgeBaseIds: [kbId],
		})),
	} as any;
	const { project, session, am, fakes } = await setup({ configStore });
	await am.ensureStarted(project.id, "dev", session.id);

	const tools = allowTools(fakes[0].opts.args ?? []);
	expect(tools).toContain("knowledge_search");
	expect(tools).toContain("knowledge_read");
	expect(tools.filter((t) => t === "knowledge_read")).toHaveLength(1);
});

test("未绑定知识库：受限白名单里即使写了 knowledge_read 也剔除", async () => {
	const configStore = {
		getAgent: mock(async () => ({
			displayName: "dev",
			tools: ["read", "knowledge_read"],
		})),
	} as any;
	const { project, session, am, fakes } = await setup({ configStore });
	await am.ensureStarted(project.id, "dev", session.id);

	const tools = allowTools(fakes[0].opts.args ?? []);
	expect(tools).toContain("read");
	expect(tools).not.toContain("knowledge_read");
});

test("未绑定知识库：默认全放行会话把 knowledge_read 一并并入 --exclude-tools", async () => {
	const { project, session, am, fakes } = await setup();
	await am.ensureStarted(project.id, "dev", session.id);

	const excluded = excludedTools(fakes[0].opts.args ?? []);
	expect(excluded).toContain("knowledge_search");
	expect(excluded).toContain("knowledge_read");
});
