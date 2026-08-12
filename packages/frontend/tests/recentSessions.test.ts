import { test, expect } from "bun:test";
import type { ProjectEntity, SessionEntity } from "@wa-pi/shared";
import { buildRecentSessions, MAX_RECENT_SESSIONS, dayLabelOf } from "../src/util/recentSessions";

const projects: ProjectEntity[] = [
  { id: "__system__", name: "默认工作区", cwd: "", createdAt: 0 },
  { id: "p1", name: "HiAgent", cwd: "/a", createdAt: 0 },
];
const mk = (id: string, projectId: string, lastActivity: number, extra: Partial<SessionEntity> = {}): SessionEntity => ({
  id, projectId, primaryAgent: "a", title: `t-${id}`, createdAt: 0, lastActivity, piSessionFile: "", ...extra,
});
const NOW = new Date(2026, 7, 12, 10, 0, 0).getTime(); // 2026-08-12 10:00
const t = (k: string) => (k === "recentSessions.today" ? "今天" : k === "recentSessions.yesterday" ? "昨天" : k === "projectList.systemProjectName" ? "默认工作区" : k);

test("过滤 IM 会话与已删除会话", () => {
  const sessions = [
    mk("s1", "p1", NOW - 60000),
    mk("im-1", "p1", NOW - 2000),                 // IM 会话，排除
    mk("s2", "p1", NOW - 30000, { deletedAt: 1 }), // 已删除，排除
  ];
  const items = buildRecentSessions(projects, sessions, NOW, t);
  expect(items.map((i) => i.session.id)).toEqual(["s1"]);
});

test("按 lastActivity 倒序，项目名正确映射（系统项目 → 默认工作区）", () => {
  const sessions = [
    mk("s1", "__system__", NOW - 5000),
    mk("s2", "p1", NOW - 60000),
    mk("s3", "p1", NOW - 1000),
  ];
  const items = buildRecentSessions(projects, sessions, NOW, t);
  expect(items.map((i) => i.session.id)).toEqual(["s3", "s1", "s2"]);
  expect(items[1].projectName).toBe("默认工作区");
  expect(items[0].projectName).toBe("HiAgent");
});

test("截断到 MAX_RECENT_SESSIONS 条", () => {
  const sessions = Array.from({ length: MAX_RECENT_SESSIONS + 20 }, (_, i) =>
    mk(`s${i}`, "p1", NOW - i * 1000),
  );
  const items = buildRecentSessions(projects, sessions, NOW, t);
  expect(items.length).toBe(MAX_RECENT_SESSIONS);
  expect(items[0].session.id).toBe("s0");
});

test("dayLabelOf：今天/昨天/M月D日/跨年加年份", () => {
  expect(dayLabelOf(NOW, NOW, t)).toBe("今天");
  expect(dayLabelOf(NOW - 86400000, NOW, t)).toBe("昨天");
  expect(dayLabelOf(new Date(2026, 7, 5, 9, 0).getTime(), NOW, t)).toBe("8月5日");
  expect(dayLabelOf(new Date(2025, 11, 20, 9, 0).getTime(), NOW, t)).toBe("2025年12月20日");
});

test("按天分组键正确（组内保持倒序）", () => {
  const sessions = [
    mk("s1", "p1", NOW - 3600000), // 今天
    mk("s2", "p1", NOW - 90000000), // 昨天
    mk("s3", "p1", NOW - 5000),     // 今天
  ];
  const items = buildRecentSessions(projects, sessions, NOW, t);
  expect(items.map((i) => i.dayKey)).toEqual([
    "2026-8-12", "2026-8-12", "2026-8-11",
  ]);
});
