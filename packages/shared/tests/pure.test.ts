import { test, expect } from "bun:test";
import {
  formatRelativeTime,
  aggregateAgentState,
  makeAgentStateKey,
  parseAgentStateKey,
  randomSessionId,
  resolveSessionCwd,
  sanitizeOpenEnv,
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
  const mk = (status: AgentState["status"]): AgentState => ({
    name: "dev",
    status,
  });
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
  const project = { cwd: "/work/wa-pi" };
  expect(resolveSessionCwd(session, project)).toBe("/work/wa-pi");
});

test("resolveSessionCwd 系统项目返回 workdir/<createdAt>", () => {
  const session = { projectId: SYSTEM_PROJECT_ID, createdAt: 1721567890123 };
  const project = { cwd: SYSTEM_PROJECT_CWD };
  const result = resolveSessionCwd(session, project);
  expect(result).toBe(`${SYSTEM_PROJECT_CWD}/1721567890123`);
  expect(result.endsWith("/1721567890123")).toBe(true);
});

test("resolveSessionCwd 系统项目用持久化 project.cwd（打包版非构建机：bundle 常量可能是 macOS 路径）", () => {
  // 根因回归：打包机（macOS）构建时 HOME 被注入 bundle → 前端 SYSTEM_PROJECT_CWD 常量
  // 是 /Users/pipi/.pi/agent/workdir；而 kernel 持久化的 __system__.cwd 是运行时本机路径
  // （Windows: C:/Users/co/.pi/agent/workdir）。若用常量，Windows 上请求 macOS 路径 →
  // listDir ENOENT → fs:error → 默认工作区文件树空白。必须用 project.cwd。
  const session = { projectId: SYSTEM_PROJECT_ID, createdAt: 1786625110972 };
  const runtimeProject = { cwd: "C:/Users/co/.pi/agent/workdir" };
  expect(resolveSessionCwd(session, runtimeProject)).toBe(
    "C:/Users/co/.pi/agent/workdir/1786625110972",
  );
});

test("resolveSessionCwd 系统项目 project.cwd 为空时返回空串（绝不回退常量）", () => {
  // SessionView 在项目数据尚未加载时传 { cwd: "" }。此时回退 SYSTEM_PROJECT_CWD 常量
  // 等于回退到构建机路径（本 bug 根因），必须返回空串：前端 ExplorerPanel 空串渲染空态
  // 不请求；kernel 调用点均有 !project.cwd 前置校验，不会走到这里。
  const session = { projectId: SYSTEM_PROJECT_ID, createdAt: 1721567890123 };
  expect(resolveSessionCwd(session, { cwd: "" })).toBe("");
});

test("sanitizeOpenEnv 剥离 WA_PI_* 内部变量（防 open 出口环境继承）", () => {
  const env = sanitizeOpenEnv({
    PATH: "/usr/bin",
    HOME: "/Users/co",
    LANG: "zh_CN.UTF-8",
    WA_PI_WS_PORT: "9776",
    WA_PI_DIR: "/Users/co/.pi/agent",
    WA_PI_PI_RUNTIME: "/path/to/bun",
    WA_PI_WEB_PORT: "5180",
  });
  // 系统变量原样保留（影响默认应用行为，不能白名单化）
  expect(env.PATH).toBe("/usr/bin");
  expect(env.HOME).toBe("/Users/co");
  expect(env.LANG).toBe("zh_CN.UTF-8");
  // wa-pi 内部命名空间全部剥离：被打开的 .command 继承端口/目录变量后
  // dev.ts 启动即 killPort 会抢占宿主实例端口
  expect(env.WA_PI_WS_PORT).toBeUndefined();
  expect(env.WA_PI_DIR).toBeUndefined();
  expect(env.WA_PI_PI_RUNTIME).toBeUndefined();
  expect(env.WA_PI_WEB_PORT).toBeUndefined();
});

test("sanitizeOpenEnv 跳过 undefined 值键，空输入返回空对象", () => {
  const out = sanitizeOpenEnv({ A: "1", B: undefined });
  expect(out).toEqual({ A: "1" });
  expect(sanitizeOpenEnv({})).toEqual({});
});
