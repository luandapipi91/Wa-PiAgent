// agent-manager-stored-cwd.test.ts — spawn 前 stored cwd 自愈测试
//
// 背景：存量 IM 会话的 sessionId 内嵌时间戳与会话实体 createdAt 存在约 2 秒错位
// （旧版本各自取 Date.now()），导致 pi 会话文件首行记录的 stored cwd 与 kernel
// 按 createdAt 推导的 spawn 目录不一致；该目录被 workdir-cleaner 按 TTL 清理后，
// pi rpc resume 校验 stored cwd 失败直接 exit(1)，IM 侧收到"pi rpc 进程不可用"。
// 修复：_createSession 在 mkdir(推导 cwd) 之后读 jsonl 首行 stored cwd 并 mkdir 兜底。
import { test, expect, afterEach } from "bun:test";
import { AgentManager, readStoredSessionCwd } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import {
	FakeSessionClient,
	fakeClientFactory,
} from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import { SYSTEM_PROJECT_ID, WA_PI_DIR } from "@wa-pi/shared";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试产生的临时文件/目录/AgentManager，afterEach 统一清理
const tmpPaths: string[] = [];
const managers: AgentManager[] = [];

afterEach(async () => {
	for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
	for (const f of tmpPaths.splice(0)) {
		try {
			rmSync(f, { force: true, recursive: true });
		} catch {
			// 尽力清理临时文件，失败静默（不干扰测试结果）
		}
	}
});

function newProjectStore() {
	const dir = mkdtempSync(join(tmpdir(), "wa-pi-stored-cwd-store-"));
	tmpPaths.push(dir);
	return new ProjectStore(join(dir, "projects.json"));
}

// ─── readStoredSessionCwd 单元测试 ──────────────────────────────────────

test("readStoredSessionCwd：首行含 cwd 字段时返回该目录（只取首行）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wa-pi-stored-cwd-"));
	tmpPaths.push(dir);
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id: "x", cwd: "C:\\some\\cwd" })}\n${JSON.stringify({ type: "message", cwd: "D:\\other" })}\n`,
	);
	expect(await readStoredSessionCwd(file)).toBe("C:\\some\\cwd");
});

test("readStoredSessionCwd：文件不存在返回 null", async () => {
	expect(
		await readStoredSessionCwd(join(tmpdir(), "not-exist-stored-cwd.jsonl")),
	).toBeNull();
});

test("readStoredSessionCwd：首行坏 JSON 返回 null", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wa-pi-stored-cwd-"));
	tmpPaths.push(dir);
	const file = join(dir, "s.jsonl");
	writeFileSync(file, "not-json\n");
	expect(await readStoredSessionCwd(file)).toBeNull();
});

test("readStoredSessionCwd：首行无 cwd 字段返回 null", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wa-pi-stored-cwd-"));
	tmpPaths.push(dir);
	const file = join(dir, "s.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session" })}\n`);
	expect(await readStoredSessionCwd(file)).toBeNull();
});

test("readStoredSessionCwd：首行 cwd 为空字符串返回 null", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wa-pi-stored-cwd-"));
	tmpPaths.push(dir);
	const file = join(dir, "s.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", cwd: "" })}\n`);
	expect(await readStoredSessionCwd(file)).toBeNull();
});

// ─── _createSession stored cwd 自愈集成测试 ────────────────────────────

test("ensureStarted 重建丢失的 stored cwd（错位存量会话自愈）", async () => {
	const root = mkdtempSync(join(tmpdir(), "wa-pi-stored-cwd-root-"));
	tmpPaths.push(root);
	const projectStore = newProjectStore();
	// 默认工作区项目 cwd 指向临时目录，resolveSessionCwd 推导 = <root>/<createdAt>
	await projectStore.createSystemProject({
		id: SYSTEM_PROJECT_ID,
		name: "默认工作区",
		cwd: root,
	});
	// 模拟存量错位：sessionId 内嵌时间戳 1786190534562 ≠ createdAt 1786190536540
	const sessionId = "im-selftest-stored-cwd-1786190534562";
	const session = await projectStore.createSession({
		projectId: SYSTEM_PROJECT_ID,
		primaryAgent: "dev",
		title: "错位会话",
		id: sessionId,
		createdAt: 1786190536540,
	});
	tmpPaths.push(session.piSessionFile);
	// pi 会话首行记录的 stored cwd 指向"已被清理"的目录（不创建）
	const lostDir = join(root, "1786190534562");
	writeFileSync(
		session.piSessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "x", cwd: lostDir })}\n`,
	);
	expect(existsSync(lostDir)).toBe(false);

	const fakes: FakeSessionClient[] = [];
	const am = new AgentManager({
		projectStore,
		configStore: null,
		onEvent: () => {},
		createClientFn: fakeClientFactory(fakes),
		browserManager: NOOP_BROWSER_MANAGER,
	});
	managers.push(am);

	await am.ensureStarted(SYSTEM_PROJECT_ID, "dev", sessionId);

	// 自愈生效：spawn 前按 jsonl 首行 stored cwd 重建目录，pi resume 校验即可通过
	expect(fakes).toHaveLength(1);
	expect(fakes[0].started).toBe(true);
	expect(existsSync(lostDir)).toBe(true);
	// 按 createdAt 推导的目录也照常确保存在（原有行为不回退）
	expect(existsSync(join(root, "1786190536540"))).toBe(true);
	// 清理 _createSession 写入真实目录的系统提示词临时文件
	tmpPaths.push(join(WA_PI_DIR, "tmp", "sysprompts", `${sessionId}.md`));
});
