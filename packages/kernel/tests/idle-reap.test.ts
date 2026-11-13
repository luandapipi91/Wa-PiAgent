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
import {
  AgentManager,
  IDLE_REAP_THRESHOLD_MS,
} from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { tuiHostRegistry } from "../src/tui-host-registry";
import {
  fakeClientFactory,
  FakeSessionClient,
} from "./fixtures/fake-session-client";
import type { RpcClientOpts, RpcClient } from "../src/rpc-client";
import { rmSync } from "node:fs";

const managers: AgentManager[] = [];
const tmpFiles: string[] = [];

beforeEach(() => {});

afterEach(async () => {
  for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
  for (const f of tmpFiles.splice(0)) {
    // 测试收尾清理临时文件：删不掉不影响任何断言（文件本就可能是 never-created/已被删），
    // 所以在 catch 里只记录一句原因、不向上抛。
    try {
      rmSync(f, { force: true, recursive: true });
    } catch {
      /* 清理失败可安全忽略：断言已跑完，残留临时文件不影响测试结果 */
    }
  }
});

/** 造临时 ProjectStore + 一个会话 + AgentManager（注入 FakeSessionClient） */
async function setup() {
  const tmpFile = `/tmp/wa-pi-idle-reap-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  tmpFiles.push(tmpFile);
  const projectStore = new ProjectStore(tmpFile);
  const project = await projectStore.createProject({
    name: "测试",
    cwd: "/tmp",
  });
  const session = await projectStore.createSession({
    projectId: project.id,
    primaryAgent: "dev",
    title: "t",
  });
  const fakes: FakeSessionClient[] = [];
  const am = new AgentManager({
    projectStore,
    configStore: null,
    onEvent: () => {},
    createClientFn: fakeClientFactory(fakes),
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

// 会话销毁路径要清 tui-host 面板状态：不清则同一 sessionId 重建/恢复时会补发已死进程的旧帧与陈旧输入
test("回收会话时清空该会话的 tui-host 面板与输入队列", async () => {
  const { session, am } = await setup();
  const handle = (am as any).sessions.get(session.id) as any;
  handle.busy = false;
  handle.lastActiveAt = Date.now() - 10_000;
  // 用 widget 面板建档：不带 SSE 广播（本用例只验证 clearSession 接线，不依赖广播出口）
  tuiHostRegistry.applyFrame(session.id, {
    type: "open",
    panelId: "w:goal",
    kind: "widget",
    widgetKey: "goal",
  });
  tuiHostRegistry.enqueueInput({
    sessionId: session.id,
    panelId: "p1",
    type: "key",
    data: "a",
  });
  expect(tuiHostRegistry.sessionIds()).toContain(session.id);

  await am.reapIdleSessions(5_000);

  expect(tuiHostRegistry.sessionIds()).not.toContain(session.id);
});

// —— 空闲回收阈值规格 ——
//
// pi ≥1.5.1 默认 cacheWarming: "idle"：进程存活时在两次 run 之间刷新 Anthropic
// 服务端 prompt cache（TTL 300s，刷新间隔 = TTL×0.9 = 270s）。旧阈值 60s 会在
// 首次刷新 tick（真实请求开始 + 270s）前回收进程，保温一次都发不出；改 300s
// 让进程活过首次刷新，缓存单次续命到 ~9.5 分钟。
// 值即规格（产品拍板），两处断言：契约值 + 无参默认阈值行为。
test("IDLE_REAP_THRESHOLD_MS 契约值为 5 分钟（300_000）", () => {
  expect(IDLE_REAP_THRESHOLD_MS).toBe(300_000);
});

test("无参调用 reapIdleSessions 用默认阈值：空闲 2 分钟的会话不回收", async () => {
  const { session, am, fakes } = await setup();
  const handle = (am as any).sessions.get(session.id) as any;
  // 120s 介于旧默认 60s（会被回收）与新阈值 300s（保留）之间
  handle.busy = false;
  handle.lastActiveAt = Date.now() - 120_000;

  const reaped = await am.reapIdleSessions();

  expect(reaped).toEqual([]);
  expect(fakes[0].alive).toBe(true);
  expect((am as any).sessions.has(session.id)).toBe(true);
});
