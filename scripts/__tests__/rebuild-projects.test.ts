// 会话列表重建工具测试（P0 事故善后 2026-09-20：根目录裸跑测试打生产 ~/.pi/agent，
// projects.json 被全量覆盖清空，会话列表回初始化态）。
//
// 重建思路：projects.json 丢了，但 sessions/*.jsonl 还在——每个文件首行带 cwd 与创建时间，
// 文件名即会话 id。据此反推会话记录与项目归属。
//
// 关键不变量（本文件覆盖）：
//   1. 标题取「首条真人消息」前 20 字，跳过 <skill …> 之类注入块
//   2. cwd 在 workdir 下 → 默认工作区；同 cwd 的会话归同一项目，项目不重复
//   3. 同一 cwd 重复重建得到相同 projectId（幂等，不会每次跑出新 id）
//   4. 合并时现有记录字段优先——kernel 实写的 title/lastActivity 不被推断值覆盖
import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	scanSessions,
	rebuildProjectsData,
	mergeProjectsData,
	runRebuild,
} from "../rebuild-projects";

const ROOTS: string[] = [];
function makeRoot(): string {
	const d = mkdtempSync(join(tmpdir(), "wa-pi-rebuild-test-"));
	ROOTS.push(d);
	return d;
}
afterAll(() => {
	for (const d of ROOTS) rmSync(d, { recursive: true, force: true });
});

/** 写一个 kernel 会话文件（首行 session / 次行 session_info / 之后 message） */
function writeSession(
	dir: string,
	id: string,
	cwd: string,
	opts: { at?: string; agent?: string; messages?: string[] } = {},
): void {
	mkdirSync(join(dir, "sessions"), { recursive: true });
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "inner-" + id,
			timestamp: opts.at ?? "2026-09-01T00:00:00.000Z",
			cwd,
		}),
		JSON.stringify({
			type: "session_info",
			id: "info-" + id,
			parentId: null,
			timestamp: opts.at ?? "2026-09-01T00:00:01.000Z",
			name: `${opts.agent ?? "高级项目经理"}-${id}`,
		}),
		...(opts.messages ?? ["普通的第一条消息"]).map((text) =>
			JSON.stringify({
				type: "message",
				id: "m-" + Math.random().toString(36).slice(2),
				parentId: null,
				timestamp: opts.at ?? "2026-09-01T00:00:02.000Z",
				message: { role: "user", content: [{ type: "text", text }] },
			}),
		),
	];
	writeFileSync(join(dir, "sessions", `${id}.jsonl`), lines.join("\n") + "\n", "utf8");
}

describe("scanSessions", () => {
	test("文件名即会话 id，cwd/创建时间取自首行，标题取首条真人消息前 20 字", () => {
		const root = makeRoot();
		writeSession(root, "s-aaa", "/work/A", {
			at: "2026-09-01T03:04:05.000Z",
			messages: ["这是一个超过二十个字符的很长很长的用户提问内容"],
		});
		const scans = scanSessions(join(root, "sessions"));
		expect(scans.length).toBe(1);
		expect(scans[0].id).toBe("s-aaa");
		expect(scans[0].cwd).toBe("/work/A");
		expect(scans[0].createdAt).toBe(Date.parse("2026-09-01T03:04:05.000Z"));
		expect(scans[0].title).toBe("这是一个超过二十个字符的很长很长的用户提");
		expect(scans[0].primaryAgent).toBe("高级项目经理");
		expect(scans[0].piSessionFile).toBe(join(root, "sessions", "s-aaa.jsonl"));
	});

	test("标题跳过 <skill …> 注入块，取其后首条真人消息", () => {
		const root = makeRoot();
		writeSession(root, "s-bbb", "/work/A", {
			messages: ['<skill name="x">注入内容</skill>', "真正想问的问题"],
		});
		expect(scanSessions(join(root, "sessions"))[0].title).toBe("真正想问的问题");
	});

	test("非 s- 前缀文件（pi 内部子会话）与其它扩展名不计入", () => {
		const root = makeRoot();
		writeSession(root, "s-ccc", "/work/A");
		mkdirSync(join(root, "sessions"), { recursive: true });
		writeFileSync(join(root, "sessions", "03c9da6d-sub.jsonl"), "{}", "utf8");
		writeFileSync(join(root, "sessions", "readme.txt"), "x", "utf8");
		const scans = scanSessions(join(root, "sessions"));
		expect(scans.map((s) => s.id)).toEqual(["s-ccc"]);
	});
});

describe("rebuildProjectsData", () => {
	test("workdir 下的会话归默认工作区，其余按 cwd 归项目，项目不重复", () => {
		const root = makeRoot();
		const workdir = join(root, "workdir");
		writeSession(root, "s-a1", "/work/A");
		writeSession(root, "s-a2", "/work/A"); // 同 cwd 第二条
		writeSession(root, "s-b1", "/work/B");
		writeSession(root, "s-w1", join(workdir, "1787000000000"));

		const data = rebuildProjectsData({
			sessionsDir: join(root, "sessions"),
			workdir,
		});

		expect(data.sessions.length).toBe(4);
		const names = data.projects.map((p) => p.name).sort();
		expect(names).toEqual(["A", "B", "默认工作区"]);
		const byCwd = new Map(data.projects.map((p) => [p.cwd, p.id]));
		const sys = data.projects.find((p) => p.cwd === workdir);
		expect(sys?.id).toBe("__system__");
		const a = data.sessions.filter((s) => s.cwd === "/work/A");
		expect(a.map((s) => s.projectId)).toEqual([byCwd.get("/work/A"), byCwd.get("/work/A")]);
		expect(data.sessions.find((s) => s.cwd.startsWith(workdir))?.projectId).toBe("__system__");
	});

	test("knownProjects 的 id 被复用（保留事故前的原 id）", () => {
		const root = makeRoot();
		writeSession(root, "s-a1", "/work/A");
		const data = rebuildProjectsData({
			sessionsDir: join(root, "sessions"),
			workdir: join(root, "workdir"),
			knownProjects: [{ cwd: "/work/A", id: "keep-me", name: "别名A" }],
		});
		expect(data.projects.find((p) => p.cwd === "/work/A")?.id).toBe("keep-me");
		expect(data.projects.find((p) => p.cwd === "/work/A")?.name).toBe("别名A");
		expect(data.sessions[0].projectId).toBe("keep-me");
	});

		test("同一 cwd 重复重建生成的 projectId 相同（幂等，不每次产生新 id）", () => {
		const root = makeRoot();
		writeSession(root, "s-a1", "/work/A");
		const opts = { sessionsDir: join(root, "sessions"), workdir: join(root, "workdir") };
		const first = rebuildProjectsData(opts);
		const second = rebuildProjectsData(opts);
		const a1 = first.projects.find((p) => p.cwd === "/work/A")!;
		const a2 = second.projects.find((p) => p.cwd === "/work/A")!;
		expect(a1.id).toBe(a2.id);
		expect(a1.id).not.toBe("__system__");
	});
});

describe("mergeProjectsData", () => {
	test("现有记录字段优先——kernel 实写的 title 与 lastActivity 不被推断值覆盖", () => {
		const rebuilt = {
			projects: [{ id: "__system__", name: "默认工作区", cwd: "/w", createdAt: 1 }],
			sessions: [
				{
					id: "s-a1",
					projectId: "__system__",
					primaryAgent: "推断的智能体",
					title: "推断的标题",
					createdAt: 100,
					lastActivity: 200,
					piSessionFile: "/w/sessions/s-a1.jsonl",
				},
			],
		};
		const current = {
			projects: [],
			sessions: [
				{
					id: "s-a1",
					projectId: "__system__",
					primaryAgent: "产品经理",
					title: "kernel 实写标题",
					createdAt: 100,
					lastActivity: 999,
					piSessionFile: "/w/sessions/s-a1.jsonl",
				},
			],
		};
		const merged = mergeProjectsData(rebuilt, current);
		expect(merged.sessions.length).toBe(1);
		expect(merged.sessions[0].title).toBe("kernel 实写标题");
		expect(merged.sessions[0].primaryAgent).toBe("产品经理");
		expect(merged.sessions[0].lastActivity).toBe(999);
	});

	test("保留现有里重建源中没有的会话，且 lastActivity 取整", () => {
		const rebuilt = { projects: [], sessions: [] };
		const current = {
			projects: [{ id: "__system__", name: "默认工作区", cwd: "/w", createdAt: 5 }],
			sessions: [
				{
					id: "s-gone",
					projectId: "__system__",
					primaryAgent: "A",
					title: "不在 sessions 目录里的会话",
					createdAt: 1,
					lastActivity: 1789869559207,
					piSessionFile: "/w/sessions/s-gone.jsonl",
				},
			],
		};
		const merged = mergeProjectsData(rebuilt, current);
		expect(merged.sessions.map((s) => s.id)).toEqual(["s-gone"]);
	});

	test("现有 projects 非空时优先于重建结果", () => {
		const merged = mergeProjectsData(
			{ projects: [{ id: "new", name: "重建的", cwd: "/n", createdAt: 1 }], sessions: [] },
			{ projects: [{ id: "old", name: "现存的", cwd: "/o", createdAt: 2 }], sessions: [] },
		);
		expect(merged.projects.map((p) => p.name)).toEqual(["现存的"]);
	});
});

describe("runRebuild", () => {
	test("复用现有 projects.json 的项目 id，会话不会挂到不存在的项目上", () => {
		const root = makeRoot();
		writeSession(root, "s-a1", "/work/A");
		writeFileSync(
			join(root, "projects.json"),
			JSON.stringify({
				projects: [{ id: "legacy-id", name: "A", cwd: "/work/A", createdAt: 1 }],
				sessions: [],
			}),
			"utf8",
		);
		const { data } = runRebuild({ waPiDir: root, apply: false, knownProjects: [] });
		expect(data.sessions.find((s) => s.id === "s-a1")!.projectId).toBe("legacy-id");
		expect(data.projects.some((p) => p.id === "legacy-id")).toBe(true);
	});

	test("默认预演不写盘；--apply 才落盘并先备份原文件", () => {
		const root = makeRoot();
		writeSession(root, "s-a1", "/work/A");
		const file = join(root, "projects.json");
		writeFileSync(file, JSON.stringify({ projects: [], sessions: [] }), "utf8");

		const dry = runRebuild({ waPiDir: root, apply: false, knownProjects: [] });
		expect(dry.backupPath).toBeUndefined();
		expect(JSON.parse(readFileSync(file, "utf8")).sessions.length).toBe(0);

		const applied = runRebuild({ waPiDir: root, apply: true, knownProjects: [] });
		expect(applied.backupPath).toBe(`${file}.before-rebuild.bak`);
		expect(existsSync(`${file}.before-rebuild.bak`)).toBe(true);
		const persisted = JSON.parse(readFileSync(file, "utf8"));
		expect(persisted.sessions.length).toBe(1);
		// 落盘不应带上重建过程字段（kernel 的 SessionEntity 没有 cwd）
		expect(persisted.sessions[0].cwd).toBeUndefined();
	});

	test("projects.json 存在但无法解析时中止，不静默当空库覆盖", () => {
		const root = makeRoot();
		writeSession(root, "s-a1", "/work/A");
		writeFileSync(join(root, "projects.json"), "{ 半截", "utf8");
		expect(() => runRebuild({ waPiDir: root, apply: true, knownProjects: [] })).toThrow();
	});
});
