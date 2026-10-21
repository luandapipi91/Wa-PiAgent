import { test, expect } from "bun:test";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore } from "../src/project-store";
import {
	WA_PI_DIR,
	SYSTEM_PROJECT_ID,
	SYSTEM_PROJECT_NAME,
	SYSTEM_PROJECT_CWD,
	type SessionEntity,
} from "@wa-pi/shared";
import { errorCodeOf } from "./helpers/kernel-error-code";

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

test("deleteProject 级联删 session（项目硬删除，会话软删除进回收站）", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "s1",
	});
	await store.deleteProject(p.id);
	// 项目本身硬删除
	const { projects } = await store.load();
	expect(projects).toEqual([]);
	// 会话软删除（进回收站可恢复，非物理移除）
	const { sessions: active } = await store.loadActive();
	expect(active).toEqual([]);
	const { sessions: trashed } = await store.loadTrash();
	expect(trashed).toHaveLength(1);
	expect(trashed[0].deletedAt).toBeTruthy();
	expect(trashed[0].deletedReason).toBe("manual");
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
		await errorCodeOf(store.createProject({ name: "项目B", cwd: "/work/same" })),
	).toBe("project.duplicateCwd");
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

// 定时任务执行会话隔离：不进侧栏列表（loadActive 过滤 source=scheduler + 存量 sched- 前缀兑底），
// load 全量保留（executeTask 执行链、回写执行记录依赖记录存在）
test("scheduler 会话：loadActive 过滤（source 字段 + 存量 sched- 前缀兑底），load 保留", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	// 新建定时任务执行会话：带 source 标记
	await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "定时任务 · 每日报表",
		id: "sched-t1-123",
		source: "scheduler",
	});
	// 存量数据：无 source 字段，只有 id 前缀约定
	await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "定时任务 · 旧任务",
		id: "sched-t2-456",
	});
	await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "正常会话",
		id: "s-normal",
	});
	// load 全量保留（执行记录回填/会话查看依赖）
	const { sessions } = await store.load();
	expect(sessions.length).toBe(3);
	// loadActive：source=scheduler 与存量 sched- 前缀均过滤，正常会话不受影响
	const active = await store.loadActive();
	expect(active.sessions.find((x) => x.id === "sched-t1-123")).toBeUndefined();
	expect(active.sessions.find((x) => x.id === "sched-t2-456")).toBeUndefined();
	expect(active.sessions.find((x) => x.id === "s-normal")).toBeTruthy();
	rmSync(f, { force: true });
});

// IM 会话标记：source=im 显式化（原靠 id 前缀约定），loadActive 不受影响（IM 有独立列表，侧栏项目视图仍需展示）
test("IM 会话 source=im：loadActive 保留（侧栏项目分组原有 im- 前缀过滤不变）", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "IM · u1",
		id: "im-ch1-p1-1",
		source: "im",
	});
	const active = await store.loadActive();
	// kernel 层不过滤 IM 会话（前端项目视图用 im- 前缀排除，历史约定保持）
	expect(active.sessions.find((x) => x.id === "im-ch1-p1-1")).toBeTruthy();
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

// ---------- 自动归档回归：恢复续期 + 活动复活 ----------

/** 直接修改盘上 JSON 中指定会话的字段（构造长期不活动等历史状态用，load 无缓存可安全改盘） */
function mutateSessionOnDisk(
	f: string,
	id: string,
	fn: (s: SessionEntity) => void,
) {
	const raw = JSON.parse(readFileSync(f, "utf8")) as {
		sessions: SessionEntity[];
	};
	const s = raw.sessions.find((x) => x.id === id);
	if (!s) throw new Error(`session ${id} not found`);
	fn(s);
	writeFileSync(f, JSON.stringify(raw, null, 2), "utf8");
}

const DAY = 24 * 60 * 60 * 1000;

test("restoreSession 恢复时续期 lastActivity，重启后扫描不再二次归档", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	const s = await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "旧会话",
	});
	// 构造 20 天不活动 → 按 15 天阈值归档命中
	mutateSessionOnDisk(f, s.id, (x) => {
		x.lastActivity = Date.now() - 20 * DAY;
	});
	const archived = await store.archiveStaleSessions(15 * DAY);
	expect(archived.map((x) => x.id)).toContain(s.id);
	// 用户从归档区恢复 → lastActivity 被续期
	await store.restoreSession(s.id);
	const restored = (await store.load()).sessions.find((x) => x.id === s.id);
	expect(restored?.deletedAt).toBeUndefined();
	expect(restored!.lastActivity).toBeGreaterThan(Date.now() - 60_000);
	// 下次启动再扫（同样阈值）：不再归档（修复前会立即重删）
	const again = await store.archiveStaleSessions(15 * DAY);
	expect(again.map((x) => x.id)).not.toContain(s.id);
	rmSync(f, { force: true });
});

test("touchSession 自动归档会话复活：清删除标记并回到活跃列表", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	const s = await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "在归档区里继续用",
	});
	mutateSessionOnDisk(f, s.id, (x) => {
		x.lastActivity = Date.now() - 20 * DAY;
	});
	await store.archiveStaleSessions(15 * DAY);
	expect(
		(await store.loadActive()).sessions.find((x) => x.id === s.id),
	).toBeUndefined();
	// 归档区会话继续发消息 → touchSession 自动复活
	const revived = await store.touchSession(s.id);
	expect(revived).toBe(true);
	const after = (await store.load()).sessions.find((x) => x.id === s.id);
	expect(after?.deletedAt).toBeUndefined();
	expect(after?.deletedReason).toBeUndefined();
	expect(
		(await store.loadActive()).sessions.find((x) => x.id === s.id),
	).toBeTruthy();
	expect(
		(await store.loadTrash()).sessions.find((x) => x.id === s.id),
	).toBeUndefined();
	rmSync(f, { force: true });
});

test("touchSession 手动删除的会话不复活", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	const s = await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "手动删的",
	});
	await store.deleteSession(s.id);
	const revived = await store.touchSession(s.id);
	expect(revived).toBe(false);
	const after = (await store.load()).sessions.find((x) => x.id === s.id);
	expect(after?.deletedAt).toBeTruthy();
	expect(after?.deletedReason).toBe("manual");
	rmSync(f, { force: true });
});

test("touchSession 正常会话仅续期活动时间，返回 false", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	const s = await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "正常会话",
	});
	mutateSessionOnDisk(f, s.id, (x) => {
		x.lastActivity = Date.now() - 60_000;
	});
	const revived = await store.touchSession(s.id);
	expect(revived).toBe(false);
	const after = (await store.load()).sessions.find((x) => x.id === s.id);
	expect(after!.lastActivity).toBeGreaterThan(Date.now() - 60_000);
	rmSync(f, { force: true });
});

test("deleteSessionIfPlaceholder 仅清理预热占位记录，非占位不动", async () => {
	const f = tempFile();
	const store = new ProjectStore(f);
	const p = await store.createProject({ name: "P", cwd: "/p" });
	// 占位会话（getCommands 预热场景）：可被孤儿回滚清理
	const ph = await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "",
		id: "s-ph",
		placeholder: true,
	});
	expect(await store.deleteSessionIfPlaceholder(ph.id)).toBe(true);
	const phAfter = (await store.load()).sessions.find((x) => x.id === ph.id);
	expect(phAfter?.deletedAt).toBeTruthy();

	// 非占位会话（已转正/用户创建）：孤儿回滚不得触碰
	const normal = await store.createSession({
		projectId: p.id,
		primaryAgent: "dev",
		title: "新建还没发消息",
	});
	expect(await store.deleteSessionIfPlaceholder(normal.id)).toBe(false);
	const nAfter = (await store.load()).sessions.find((x) => x.id === normal.id);
	expect(nAfter?.deletedAt).toBeUndefined();

	// 不存在的 id：静默返回 false
	expect(await store.deleteSessionIfPlaceholder("s-none")).toBe(false);
	rmSync(f, { force: true });
});
