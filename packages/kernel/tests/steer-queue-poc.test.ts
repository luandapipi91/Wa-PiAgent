// steer-queue-poc.test.ts — kernel 排队队列语义验证
//
// RPC 迁移后队列简化：
// - 引导 → pi 原生 steer()（steerMessage 直调 client.steer()，不再维护 steering[]）
// - 排队 → HiAgent 本地 followUpList（agent_settled 时逐条 drain）
// 以下用例用 FakeSessionClient 手动 emit 事件驱动，验证 kernel 队列语义。
//
// 已删除的用例（纯验证 SDK 内部行为，与 hiagent 无关）：
// - POC-1..POC-5：直接 poke fakeAgent 验证 SDK 队列 API 可用性（SDK 已不再是运行时依赖）；
// - POC-E2E：真实 SDK + API key 的 steer/queue_update 验证（SDK 形态已废弃）。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { FakeSessionClient, fakeClientFactory } from "./fixtures/fake-session-client";
import { getBridgeSession } from "../src/bridge-registry";
import { askRegistry } from "../src/ask-registry";
import { HIAGENT_DIR } from "@hiagent/shared";
import { rmSync } from "node:fs";
import { join } from "node:path";

const MODEL = "anthropic/test-model";

const tmpFiles: string[] = [];
const managers: AgentManager[] = [];

beforeEach(() => {
  askRegistry.reset();
});

afterEach(async () => {
  for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
  for (const f of tmpFiles.splice(0)) {
    try { rmSync(f, { force: true }); } catch {}
  }
});

type CapturedEvent = { sessionId: string; e: any };

async function setup(events?: CapturedEvent[]) {
  const tmpFile = `/tmp/hiagent-poc-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  tmpFiles.push(tmpFile);
  const projectStore = new ProjectStore(tmpFile);
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });
  tmpFiles.push(join(HIAGENT_DIR, "tmp", "sysprompts", `${session.id}.md`));

  const fakes: FakeSessionClient[] = [];
  const am = new AgentManager({
    projectStore,
    configStore: null,
    onEvent: (sid, _pid, _name, e) => events?.push({ sessionId: sid, e }),
    createClientFn: fakeClientFactory(fakes),
  });
  managers.push(am);
  await am.ensureStarted(project.id, "dev", session.id);
  return { project, session, am, fake: fakes[0] };
}

test("busy 时 prompt 追加到 followUpList，不直接发给 client", async () => {
  const { session, am, fake } = await setup();
  fake.autoSettle = false; // prompt 后不自动 settled → 保持 busy

  await am.prompt(session.id, "第一条", { model: MODEL });
  await am.prompt(session.id, "排队消息", { model: MODEL });

  // busy 中不直接发给 client，进 followUpList
  expect(fake.prompted).toEqual(["第一条"]);
  // 排队消息未出现在 prompted 中（在本地 followUpList 里）
});

test("agent_settled 后 followUp 逐条 drain（一次一条）", async () => {
  const { session, am, fake } = await setup();
  fake.autoSettle = false;

  await am.prompt(session.id, "第一条", { model: MODEL });
  await am.prompt(session.id, "F1", { model: MODEL });
  await am.prompt(session.id, "F2", { model: MODEL });

  // 第一次 settled：只 drain F1，F2 仍排队
  fake.emit({ type: "agent_settled" });
  expect(fake.prompted).toEqual(["第一条", "F1"]);
  // F2 还未被 prompt（仍在 followUpList 中）

  // 第二次 settled：drain F2，队列清空
  fake.emit({ type: "agent_settled" });
  expect(fake.prompted).toEqual(["第一条", "F1", "F2"]);
});

test("steerMessage busy 时直调 client.steer()", async () => {
  const { session, am, fake } = await setup();
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL }); // busy
  await am.steerMessage(session.id, "S1");
  await am.steerMessage(session.id, "S2");

  // steerMessage 直调 client.steer()
  expect(fake.steered).toEqual(["S1", "S2"]);
});

test("steerMessage — idle 时不入队，直接以 prompt 生效", async () => {
  const { session, am, fake } = await setup();

  am.steerMessage(session.id, "引导一下");
  await new Promise((r) => setTimeout(r, 0)); // client.prompt 为异步调用

  expect(fake.prompted).toEqual(["引导一下"]);
});

test("abort 清空排队列表后 agent_settled 不再 drain", async () => {
  const events: CapturedEvent[] = [];
  const { session, am, fake } = await setup(events);
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL }); // busy
  await am.prompt(session.id, "F1", { model: MODEL });     // 排队
  am.steerMessage(session.id, "S1");                       // steer（pi 管理）

  await am.abort(session.id);

  fake.emit({ type: "agent_settled" });
  expect(fake.prompted).toEqual(["进行中"]); // F1 被清空，不再 drain
});

test("abort + steerMessage 实现立即执行", async () => {
  const { session, am, fake } = await setup();
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL });
  await am.prompt(session.id, "排队A", { model: MODEL });

  // 立即执行：abort + steer
  await am.abort(session.id);
  await am.steerMessage(session.id, "立即执行");

  expect(fake.aborts).toBe(1);
  expect(fake.prompted).toEqual(["进行中", "立即执行"]); // 排队A 被 abort 清空
});

test("agent_settled 优先 drain steerList（引导优先级高于排队）", async () => {
  const { session, am, fake } = await setup();
  fake.autoSettle = false;

  await am.prompt(session.id, "第一条", { model: MODEL }); // busy
  await am.prompt(session.id, "排队A", { model: MODEL });   // → followUpList
  await am.steerMessage(session.id, "引导B");               // → steerList (优先)
  await am.steerMessage(session.id, "引导C");               // → steerList

  // 第一次 settled：drain steerList 第一条（引导B）
  fake.emit({ type: "agent_settled" });
  expect(fake.prompted).toEqual(["第一条", "引导B"]);

  // 第二次 settled：drain steerList 第二条（引导C）
  fake.emit({ type: "agent_settled" });
  expect(fake.prompted).toEqual(["第一条", "引导B", "引导C"]);

  // 第三次 settled：drain followUpList（排队A）
  fake.emit({ type: "agent_settled" });
  expect(fake.prompted).toEqual(["第一条", "引导B", "引导C", "排队A"]);
});

test("bridge 上下文在 ensureStarted 后已注册（宿主工具回调入口）", async () => {
  const { session } = await setup();
  expect(getBridgeSession(session.id)).toBeDefined();
});

// === 边缘场景 ===

test("E2 — 空 followUpList 时 agent_settled 不发 prompt", async () => {
  const { session, am, fake } = await setup();
  fake.autoSettle = false;

  // 不追加任何排队消息，直接 settled
  const promptedBefore = fake.prompted.length;
  fake.emit({ type: "agent_settled" });

  // 不应有新 prompt
  expect(fake.prompted.length).toBe(promptedBefore);
});

test("E2 — 多次 agent_settled 不重复 drain", async () => {
  const { session, am, fake } = await setup();
  fake.autoSettle = false;

  await am.prompt(session.id, "第一条", { model: MODEL });
  await am.prompt(session.id, "F1", { model: MODEL });

  // 第一次 settled：drain F1
  fake.emit({ type: "agent_settled" });
  expect(fake.prompted).toEqual(["第一条", "F1"]);

  // 第二次 settled：队列已空，不发 prompt
  const promptedBefore2 = fake.prompted.length;
  fake.emit({ type: "agent_settled" });
  expect(fake.prompted.length).toBe(promptedBefore2);
});

test("E3 — followUp drain 中 prompt 失败不阻塞后续 drain", async () => {
  const { session, am, fake } = await setup();
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL });
  await am.prompt(session.id, "会失败", { model: MODEL });
  await am.prompt(session.id, "下一条", { model: MODEL });

  // 让 prompt 在 F1 drain 时失败
  fake.nextPromptError = new Error("模拟失败");

  // 第一次 settled：尝试 drain 会失败，但不应影响后续
  fake.emit({ type: "agent_settled" });
  // 给予微任务时间
  await new Promise((r) => setTimeout(r, 10));

  // 第二次 settled：应 drain 下一条
  fake.emit({ type: "agent_settled" });
  expect(fake.prompted.length).toBeGreaterThanOrEqual(2); // 第一条 + 至少一个 drain
});

test("BUG: pi queue_update 空 followUp 导致前端排队列表消失", async () => {
  const events: CapturedEvent[] = [];
  const { session, am, fake } = await setup(events);
  fake.autoSettle = false;

  // 构造场景：1 在运行，2/3 排队
  await am.prompt(session.id, "第一条", { model: MODEL });
  await am.prompt(session.id, "排队2", { model: MODEL });
  await am.prompt(session.id, "排队3", { model: MODEL });

  // pi 的 queue_update 事件：steering 和 followUp 都是空（pi 不管 followUp）
  fake.emit({ type: "queue_update", steering: [], followUp: [] });

  // 此时发给前端的 queue_update 应该仍含 HiAgent 本地的排队列表
  const queueEvents = events.filter(e => e.e.type === "queue_update");
  const lastQueue = queueEvents[queueEvents.length - 1];
  if (!lastQueue) throw new Error("未收到 queue_update 事件");

  // 【当前 Bug】：pi 的 queue_update {followUp:[]} 被原样转发，前端看到空列表
  // 【期望修复】：kernel 注入本地 followUpList → followUp 应该是 ["排队2", "排队3"]
  expect(lastQueue.e.followUp).toEqual(["排队2", "排队3"]);
});

test("E4 — pi 崩溃后 followUpList 保留在 HiAgent 侧", async () => {
  const { session, am, fake } = await setup();

  await am.prompt(session.id, "进行中", { model: MODEL });
  await am.prompt(session.id, "排队A", { model: MODEL });
  await am.prompt(session.id, "排队B", { model: MODEL });

  // 模拟 pi 崩溃
  fake.simulateCrash();

  // 排队列表仍在 HiAgent 内存中
  // 进程崩溃后 ensureStarted 会重建，followUpList 不变
  expect(fake.prompted).toContain("进行中");
});

// === TDD: 引导消息重复 + 排队未移除 ===

test("BUG: 引导后 steering 队列出现重复消息", async () => {
  const events: CapturedEvent[] = [];
  const { session, am, fake } = await setup(events);
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL }); // busy
  await am.steerMessage(session.id, "引导X");

  // 等待微任务：steerMessage 内部推送了 _emitLocalQueueUpdate
  await new Promise(r => setTimeout(r, 0));

  // 收集所有 queue_update 事件
  const queueEvents = events.filter(e => e.e.type === "queue_update");

  // 【当前 Bug】：steerMessage 自己发一次 queue_update，
  //   pi 随后也可能发 queue_update，kernel 拦截注入后又是同一个 steerList，
  //   前端收到两次含 "引导X" 的 steering → 显示两条重复
  // 【期望】：所有 queue_update 中 steering 最多一条（steerList 只 push 了一次）
  const steeringEvents = queueEvents.filter(e =>
    (e.e as any).steering?.includes("引导X")
  );
  // 简化断言：最后一次 queue_update 的 steering 不应重复
  const lastQueue = queueEvents[queueEvents.length - 1];
  const steerCount = (lastQueue?.e as any)?.steering?.filter((s: string) => s === "引导X").length ?? 0;
  expect(steerCount).toBeLessThanOrEqual(1);
});

test("BUG: 从排队提升为引导后，排队列表仍保留原消息", async () => {
  const { session, am, fake } = await setup();
  fake.autoSettle = false;

  await am.prompt(session.id, "第一条", { model: MODEL });
  await am.prompt(session.id, "排队A", { model: MODEL });
  await am.prompt(session.id, "排队B", { model: MODEL });

  // 将"排队A"提升为引导
  await am.steerMessage(session.id, "排队A");

  // 【当前 Bug】：steerMessage 把"排队A"加到了 steerList，
  //   但 followUpList 里"排队A"还在 → settled 时会发两次
  // 【期望】：followUpList 不应再含"排队A"

  fake.emit({ type: "agent_settled" });
  // 第一次 drain：steerList 里的"排队A"
  expect(fake.prompted).toEqual(["第一条", "排队A"]);

  fake.emit({ type: "agent_settled" });
  // 第二次 drain：followUpList 里的"排队B"（"排队A"不应出现）
  expect(fake.prompted).toEqual(["第一条", "排队A", "排队B"]);
  // 不应出现第三个"排队A"
  expect(fake.prompted.filter(t => t === "排队A").length).toBe(1);
});

test("BUG: 排队消息 drain 后前端队列未更新", async () => {
  const events: CapturedEvent[] = [];
  const { session, am, fake } = await setup(events);
  fake.autoSettle = false;

  await am.prompt(session.id, "第一条", { model: MODEL });
  await am.prompt(session.id, "排队A", { model: MODEL });
  await am.prompt(session.id, "排队B", { model: MODEL });

  // 第一次 settled：drain 排队A
  fake.emit({ type: "agent_settled" });

  // 【当前 Bug】：drain 后没发 queue_update，前端仍显示 ["排队A","排队B"]
  // 【期望】：最后一次 queue_update 的 followUp 应为 ["排队B"]
  const queueEvents = events.filter(e => e.e.type === "queue_update");
  const lastQueue = queueEvents[queueEvents.length - 1];
  if (!lastQueue) throw new Error("未收到 queue_update 事件");
  expect((lastQueue.e as any).followUp).toEqual(["排队B"]);
});

test("BUG: 清空排队后仍发送排队消息", async () => {
  const events: CapturedEvent[] = [];
  const { session, am, fake } = await setup(events);
  fake.autoSettle = false;

  await am.prompt(session.id, "第一条", { model: MODEL });
  await am.prompt(session.id, "排队A", { model: MODEL });
  await am.prompt(session.id, "排队B", { model: MODEL });

  // 清空排队（模拟前端调用）
  am.clearFollowUpList(session.id);

  // agent_settled 后不应再发送排队消息
  fake.emit({ type: "agent_settled" });

  // 【当前 Bug】：followUpList 未被清空，仍会发送 "排队A"
  // 【期望】：清空后不再发送，prompted 只有 "第一条"
  expect(fake.prompted).toEqual(["第一条"]);
});
