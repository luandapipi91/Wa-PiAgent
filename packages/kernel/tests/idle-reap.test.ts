// idle-reap.test.ts — reapIdleSessions（空闲会话子进程定时回收）单元测试
//
// 验证 AgentManager.reapIdleSessions 的三个分支：
//   1. lastActiveAt 超过阈值且非 busy → 被 disposeSession 回收（进程 dispose、Map 移除）
//   2. busy=true（无论多旧）→ 跳过，留待 agent_settled 后下一轮回收
//   3. lastActiveAt 在阈值内 → 跳过
//
// 构造范式与 agent-manager.test.ts 一致：createClientFn 注入 FakeSessionClient，
// ensureStarted 建好合法 SessionHandle 后，直接改 (am as any).sessions.get(id) 的字段驱动测试。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { fakeClientFactory, FakeSessionClient } from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import type { RpcClientOpts, RpcClient } from "../src/rpc-client";
import { rmSync } from "node:fs";

const managers: AgentManager[] = [];
const tmpFiles: string[] = [];

beforeEach(() => {});

afterEach(async () => {
  for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
  for (const f of tmpFiles.splice(0)) {
    try { rmSync(f, { force: true, recursive: true }); } catch {}
  }
});

/** 造临时 ProjectStore + 一个会话 + AgentManager（注入 FakeSessionClient） */
async function setup() {
  const tmpFile = `/tmp/wa-pi-idle-reap-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  tmpFiles.push(tmpFile);
  const projectStore = new ProjectStore(tmpFile);
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "t",
  });
  const fakes: FakeSessionClient[] = [];
  const am = new AgentManager({
    projectStore,
    configStore: null,
    onEvent: () => {},
    createClientFn: fakeClientFactory(fakes),
    browserManager: NOOP_BROWSER_MANAGER,
  });
  managers.push(am);
  // ensureStarted 让 AgentManager 自行建好合法 SessionHandle（含真实 FakeSessionClient）
  await am.ensureStarted(project.id, "dev", session.id);
  return { projectStore, project, session, am, fakes };
}

test("reapIdleSessions 回收超时且非 busy 的会话", async () => {
  const { session, am, fakes } = await setup();
  const handle = (am as any).sessions.get(session.id) as any;
  // 模拟 3 分钟前最后活跃（用 5s 阈值测试，避免真实等待）
  handle.busy = false;
  handle.lastActiveAt = Date.now() - 10_000;

  const reaped = await am.reapIdleSessions(5_000);

  expect(reaped).toEqual([session.id]);
  // 进程已 dispose（FakeSessionClient.alive 置 false）
  expect(fakes[0].alive).toBe(false);
  // sessions Map 已移除该会话
  expect((am as any).sessions.has(session.id)).toBe(false);
});

test("reapIdleSessions 跳过 busy 会话（无论多旧）", async () => {
  const { session, am, fakes } = await setup();
  const handle = (am as any).sessions.get(session.id) as any;
  // busy 且很旧 —— 绝不能回收
  handle.busy = true;
  handle.lastActiveAt = Date.now() - 100_000;

  const reaped = await am.reapIdleSessions(5_000);

  expect(reaped).toEqual([]);
  expect(fakes[0].alive).toBe(true);
  expect((am as any).sessions.has(session.id)).toBe(true);
});

test("reapIdleSessions 不回收阈值内的会话", async () => {
  const { session, am, fakes } = await setup();
  const handle = (am as any).sessions.get(session.id) as any;
  // 刚活跃过（2s 前，阈值 5s）
  handle.busy = false;
  handle.lastActiveAt = Date.now() - 2_000;

  const reaped = await am.reapIdleSessions(5_000);

  expect(reaped).toEqual([]);
  expect(fakes[0].alive).toBe(true);
  expect((am as any).sessions.has(session.id)).toBe(true);
});
