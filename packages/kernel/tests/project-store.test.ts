import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore } from "../src/project-store";
import {
	WA_PI_DIR,
	SYSTEM_PROJECT_ID,
	SYSTEM_PROJECT_NAME,
	SYSTEM_PROJECT_CWD,
} from "@wa-pi/shared";

function tempFile() {
	return join(
		import.meta.dir,
		".tmp-projects-" + Math.random().toString(36).slice(2) + ".json",
	);
}

test("load 空状态返回空数组", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const { projects, sessions } = await store.load();
	expect(projects).toEqual([]);
	expect(sessions).toEqual([]);
	rmSync(f, { force: true });
});

test("createProject 持久化", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "项目A", cwd: "/work/a" });
	expect(p.name).toBe("项目A");
	const { projects } = await store.load();
	expect(projects).toHaveLength(1);
	rmSync(f, { force: true });
});

test("createSession 归属项目", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	const s = await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "会话1",
	});
	expect(s.projectId).toBe(p.id);
	expect(s.primaryAgent).toBe("dev");
	const { sessions } = await store.load();
	expect(sessions).toHaveLength(1);
	rmSync(f, { force: true });
});

test("deleteProject 级联删 session", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "s1",
	});
	await store.deleteProject(p.id);
	const { projects, sessions } = await store.load();
	expect(projects).toEqual([]);
	expect(sessions).toEqual([]);
	rmSync(f, { force: true });
});

test("updateProject 改名", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "旧", cwd: "/p" });
	await store.updateProject(p.id, { name: "新" });
	const { projects } = await store.load();
	expect(projects[0].name).toBe("新");
	rmSync(f, { force: true });
});

test("createSession 生成 piSessionFile 路径", async () => {
	const tmpFile = `/tmp/wa-pi-test-${Date.now()}.json`;
	const store = new ProjectStore(tmpFile);
	const project = await store.createProject({ name: "测试项目", cwd: "/tmp" });
	const session = await store.createSession({
		projectId: project.id,
		primaryAgent: "dev",
		title: "测试会话",
	});
	expect(session.piSessionFile).toBe(
		`${WA_PI_DIR}/sessions/${session.id}.jsonl`,
	);
	rmSync(tmpFile, { force: true });
});

test("createProject 相同 cwd 抛错", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	await store.createProject({ name: "项目A", cwd: "/work/same" });
	expect(
		store.createProject({ name: "项目B", cwd: "/work/same" }),
	).rejects.toThrow("相同目录的项目已存在");
	rmSync(f, { force: true });
});

test("createSystemProject 首次插入固定 id 项目", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createSystemProject({
		id: SYSTEM_PROJECT_ID,
		name: SYSTEM_PROJECT_NAME,
		cwd: SYSTEM_PROJECT_CWD,
	});
	expect(p.id).toBe(SYSTEM_PROJECT_ID);
	expect(p.name).toBe(SYSTEM_PROJECT_NAME);
	const { projects } = await store.load();
	expect(projects).toHaveLength(1);
	expect(projects[0].id).toBe(SYSTEM_PROJECT_ID);
	rmSync(f, { force: true });
});

test("createSystemProject 二次调用幂等不重复插入", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	await store.createSystemProject({
		id: SYSTEM_PROJECT_ID,
		name: SYSTEM_PROJECT_NAME,
		cwd: SYSTEM_PROJECT_CWD,
	});
	const second = await store.createSystemProject({
		id: SYSTEM_PROJECT_ID,
		name: SYSTEM_PROJECT_NAME,
		cwd: SYSTEM_PROJECT_CWD,
	});
	expect(second.id).toBe(SYSTEM_PROJECT_ID);
	const { projects } = await store.load();
	expect(projects).toHaveLength(1);
	rmSync(f, { force: true });
});

test("createSystemProject 不影响 createProject 的 cwd 去重", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	await store.createSystemProject({
		id: SYSTEM_PROJECT_ID,
		name: SYSTEM_PROJECT_NAME,
		cwd: SYSTEM_PROJECT_CWD,
	});
	// 普通项目仍可正常创建
	const normal = await store.createProject({
		name: "普通项目",
		cwd: "/work/foo",
	});
	expect(normal.id).not.toBe(SYSTEM_PROJECT_ID);
	const { projects } = await store.load();
	expect(projects).toHaveLength(2);
	rmSync(f, { force: true });
});

test("createSession 支持外部传入 createdAt", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	const FIXED = 1721567890123;
	const s = await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "会话",
		createdAt: FIXED,
	});
	expect(s.createdAt).toBe(FIXED);
	rmSync(f, { force: true });
});

test("createSession 不传 createdAt 时仍用 Date.now()", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	const before = Date.now();
	const s = await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "会话",
	});
	const after = Date.now();
	expect(s.createdAt).toBeGreaterThanOrEqual(before);
	expect(s.createdAt).toBeLessThanOrEqual(after);
	rmSync(f, { force: true });
});

test("createSession 同 id 重复调用幂等：不新增重复记录、不覆盖已有 title", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	// 首次创建，title 来自用户首条消息
	const s1 = await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "帮我写个功能",
		id: "s-dup",
	});
	// 模拟 getCommands 兜底分支：用 agentName 作 title 再次 createSession 同 id
	const s2 = await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "dev",
		id: "s-dup",
	});
	// 应返回已有 session（幂等），不新建重复记录
	const { sessions } = await store.load();
	expect(sessions.filter((x) => x.id === "s-dup")).toHaveLength(1);
	// title 不应被覆盖成 agentName
	expect(s2.title).toBe("帮我写个功能");
	rmSync(f, { force: true });
});

// fillSessionTitleIfEmpty：兜底创建的空标题会话，首次发送时填充标题
test("fillSessionTitleIfEmpty: 空标题时填充，返回 true", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	// 模拟 getCommands 兜底创建：标题留空
	const s = await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "",
		id: "s-empty",
	});
	expect(s.title).toBe("");
	// 首次发送消息时填充
	const filled = await store.fillSessionTitleIfEmpty("s-empty", "帮我写个功能");
	expect(filled).toBe(true);
	const { sessions } = await store.load();
	expect(sessions.find((x) => x.id === "s-empty")?.title).toBe("帮我写个功能");
	rmSync(f, { force: true });
});

test("fillSessionTitleIfEmpty: 已有标题不覆盖，返回 false", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "已有标题",
		id: "s-has",
	});
	const filled = await store.fillSessionTitleIfEmpty("s-has", "新消息内容");
	expect(filled).toBe(false);
	const { sessions } = await store.load();
	expect(sessions.find((x) => x.id === "s-has")?.title).toBe("已有标题");
	rmSync(f, { force: true });
});

test("fillSessionTitleIfEmpty: 会话不存在返回 false", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const filled = await store.fillSessionTitleIfEmpty("不存在", "标题");
	expect(filled).toBe(false);
	rmSync(f, { force: true });
});

// placeholder：getCommands 兜底创建的预热占位会话，首次发消息前不进侧栏（loadActive 过滤）
test("placeholder 会话：loadActive 过滤、load 保留", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	// 模拟 getCommands 兜底：预热占位记录（空标题 + placeholder 标记）
	await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "",
		id: "s-ph",
		placeholder: true,
	});
	await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "正常会话",
		id: "s-normal",
	});
	// load 全量保留（ensureStarted 依赖记录存在）
	const { sessions } = await store.load();
	expect(sessions.find((x) => x.id === "s-ph")).toBeTruthy();
	expect(sessions.find((x) => x.id === "s-ph")?.placeholder).toBe(true);
	// loadActive（侧栏）过滤 placeholder，正常会话不受影响
	const active = await store.loadActive();
	expect(active.sessions.find((x) => x.id === "s-ph")).toBeUndefined();
	expect(active.sessions.find((x) => x.id === "s-normal")).toBeTruthy();
	rmSync(f, { force: true });
});

test("placeholder 会话首次发消息转正：fillSessionTitleIfEmpty 填标题并清除 placeholder", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "",
		id: "s-ph2",
		placeholder: true,
	});
	const filled = await store.fillSessionTitleIfEmpty("s-ph2", "帮我写个功能");
	expect(filled).toBe(true);
	// 转正后：标题已填、placeholder 已清除、出现在 loadActive（侧栏）
	const { sessions } = await store.load();
	const s = sessions.find((x) => x.id === "s-ph2");
	expect(s?.title).toBe("帮我写个功能");
	expect(s?.placeholder).toBeUndefined();
	const active = await store.loadActive();
	expect(active.sessions.find((x) => x.id === "s-ph2")).toBeTruthy();
	rmSync(f, { force: true });
});
