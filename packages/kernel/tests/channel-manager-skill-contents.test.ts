import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager } from "../src/channel-manager";
import { SkillManager } from "../src/skill-manager";
import { expandSkillTokens } from "../src/channels/skill-expand";
import { MockAdapter } from "../src/channels/mock-adapter";
import type { ChannelConfig } from "@wa-pi/shared";

// 覆盖「渠道附加提示词 / 定时任务链路」的 $[技能名] 展开是否能看到项目技能：
// 这两条链路共用 loadSkillContents，此前无参调用 scan()（只剩内置 + 扩展），项目技能不可见。

let dir: string;
let manager: ChannelManager;
let adapter: MockAdapter | null;
let ensured: any[];
let projectCwd: string;

/** 在 root 下写一个技能（含 SKILL.md） */
async function writeSkill(
	root: string,
	name: string,
	description: string,
	body: string,
): Promise<void> {
	const skillDir = join(root, name);
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
		"utf8",
	);
}

const channel: Omit<ChannelConfig, "id" | "createdAt"> = {
	type: "mock",
	name: "测试机器人",
	enabled: true,
	credentials: { botId: "b", secret: "s" },
	agentName: "前端开发者",
	model: "p/m",
	extraSystemPrompt: "",
	replyGranularity: "standard",
	defaultProjectId: "proj-a",
	allowProjectSwitch: false,
};

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wa-pi-chmgr-skill-"));
	adapter = null;
	ensured = [];
	// WA_PI_DIR 等价物：内置技能目录 = <dataDir>/skills
	const dataDir = join(dir, "wa-pi");
	await writeSkill(
		join(dataDir, "skills"),
		"dup-skill",
		"内置版本",
		"# 内置版本正文",
	);
	// 项目技能目录：<project.cwd>/.pi/skills
	projectCwd = join(dir, "proj-a");
	await writeSkill(
		join(projectCwd, ".pi", "skills"),
		"dup-skill",
		"项目版本",
		"# 项目版本正文",
	);
	await writeSkill(
		join(projectCwd, ".pi", "skills"),
		"project-only",
		"仅项目技能",
		"# 仅项目技能正文",
	);

	manager = new ChannelManager({
		channelsFile: join(dir, "channels.json"),
		mappingsFile: join(dir, "mappings.json"),
		contactsFile: join(dir, "contacts.json"),
		tmpDir: join(dir, "tmp"),
		configStore: {
			listAgents: async () => [{ displayName: "前端开发者", model: null }],
			getAgent: async (name: string) =>
				name === "前端开发者"
					? { displayName: "前端开发者", model: null, thinking: null }
					: null,
		} as any,
		projectStore: {
			load: async () => ({
				projects: [
					{
						id: "proj-a",
						name: "项目A",
						cwd: projectCwd,
						createdAt: 1,
					},
				],
				sessions: [],
			}),
			createSession: async (input: any) => ({ id: input.id, ...input }),
		} as any,
		agentManager: {
			ensureStarted: async (...a: any[]) => {
				ensured.push(a);
			},
			prompt: async () => {},
			getMessages: () => [],
			isSessionBusy: () => false,
			isSessionActive: () => false,
			markAllDirty: () => {},
		} as any,
		broadcast: () => {},
		pushConnectTimeoutMs: 500,
		skillManager: new SkillManager(dataDir),
		adapterFactories: {
			mock: (c) => {
				adapter = new MockAdapter(c);
				return adapter;
			},
		},
	});
});

afterEach(async () => {
	await manager.stop();
	await rm(dir, { recursive: true, force: true });
});

test("loadSkillContents(项目目录)：项目技能可展开，同名时项目版本优先，内置仍保留", async () => {
	const skills = await manager.loadSkillContents(projectCwd);

	// 同名只出现一次，且是项目版本（scan 项目目录排在内置之前）
	const dup = skills.filter((s) => s.name === "dup-skill");
	expect(dup).toHaveLength(1);
	expect(dup[0].content).toContain("项目版本正文");

	// 项目独有技能可见
	expect(skills.some((s) => s.name === "project-only")).toBe(true);

	// 展开链路（渠道附加提示词 / 定时任务 prompt 共用 expandSkillTokens）
	const out = expandSkillTokens("请按 $[project-only] 处理", skills);
	expect(out).toContain('<skill name="project-only"');
	expect(out).toContain("仅项目技能正文");
});

test("loadSkillContents() 缺省不传项目：只剩内置技能（不回退成「全部项目」）", async () => {
	const skills = await manager.loadSkillContents();

	expect(skills.some((s) => s.name === "project-only")).toBe(false);
	const dup = skills.filter((s) => s.name === "dup-skill");
	expect(dup).toHaveLength(1);
	expect(dup[0].content).toContain("内置版本正文");
});

test("渠道进站：附加提示词的 $[技能名] 用该会话当前项目的技能展开", async () => {
	await manager.create({
		...channel,
		extraSystemPrompt: "渠道规则：请按 $[project-only] 与 $[dup-skill] 处理",
	});
	adapter!.inject({ chatId: "u1", text: "你好" });

	// 条件轮询替代固定等待：进站是异步的（含目录扫描 + 读文件）
	const deadline = Date.now() + 5000;
	while (ensured.length === 0 && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10));
	}

	expect(ensured).toHaveLength(1);
	expect(ensured[0][0]).toBe("proj-a");
	const imChannelContext = ensured[0][3]?.imChannelContext as string;
	// 项目独有技能展开
	expect(imChannelContext).toContain('<skill name="project-only"');
	expect(imChannelContext).toContain("仅项目技能正文");
	// 同名技能用项目版本（不是内置版本）
	expect(imChannelContext).toContain("项目版本正文");
	expect(imChannelContext).not.toContain("内置版本正文");
});
