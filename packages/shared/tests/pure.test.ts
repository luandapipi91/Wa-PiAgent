import { test, expect } from "bun:test";
import {
  formatRelativeTime, aggregateAgentState, makeAgentStateKey, parseAgentStateKey,
  randomSessionId, resolveSessionCwd,
} from "../src/pure";
import { SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD } from "../src/constants";
import type { AgentState } from "../src/types";

const NOW = new Date("2026-07-06T12:00:00").getTime();

test("formatRelativeTime 各档", () => {
  expect(formatRelativeTime(NOW - 30000, NOW)).toBe("刚刚");
  expect(formatRelativeTime(NOW - 120000, NOW)).toBe("2m");
  expect(formatRelativeTime(NOW - 3600000, NOW)).toBe("1h");
  expect(formatRelativeTime(NOW - 86400000, NOW)).toBe("昨天");
  expect(formatRelativeTime(NOW - 172800000, NOW)).toBe("2d");
});

test("aggregateAgentState 优先级", () => {
  const mk = (status: AgentState["status"]): AgentState => ({ name: "dev", status });
  expect(aggregateAgentState([mk("idle"), mk("blocked")])).toBe("blocked");
  expect(aggregateAgentState([mk("idle"), mk("thinking")])).toBe("thinking");
  expect(aggregateAgentState([mk("idle")])).toBe("idle");
  expect(aggregateAgentState([])).toBe("idle");
});

test("makeAgentStateKey + parse 互逆", () => {
  const k = makeAgentStateKey("p1", "dev");
  expect(k).toBe("p1:dev");
  expect(parseAgentStateKey(k)).toEqual({ projectId: "p1", agentName: "dev" });
});

test("randomSessionId 以 s- 前缀", () => {
  const id = randomSessionId();
  expect(id.startsWith("s-")).toBe(true);
  expect(id.length).toBeGreaterThan(10);
});

test("resolveSessionCwd 普通项目返回 project.cwd", () => {
  const session = { projectId: "p-abc", createdAt: 1721567890123 };
  const project = { cwd: "/work/hiagent" };
  expect(resolveSessionCwd(session, project)).toBe("/work/hiagent");
});

test("resolveSessionCwd 系统项目返回 workdir/<createdAt>", () => {
  const session = { projectId: SYSTEM_PROJECT_ID, createdAt: 1721567890123 };
  const project = { cwd: SYSTEM_PROJECT_CWD };
  const result = resolveSessionCwd(session, project);
  expect(result).toBe(`${SYSTEM_PROJECT_CWD}/1721567890123`);
  expect(result.endsWith("/1721567890123")).toBe(true);
});
