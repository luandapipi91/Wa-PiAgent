// steer-queue-poc.test.ts — kernel 自管 steer/followUp 队列语义验证
//
// 历史：本文件原是 pi SDK 队列 API（session.agent.steer/followUp/clearQueue）的概念验证。
// RPC 迁移后队列由 kernel 自管（AgentManager 内 steering/followUp 数组 + busy 状态机：
// agent_start→busy，agent_settled→idle 并 drain 一条 followUp，turn_end 投递一条 steering）。
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

function lastQueueUpdate(events: CapturedEvent[]) {
  const qu = [...events].reverse().find((x) => x.e.type === "queue_update");
  return qu?.e as { steering: string[]; followUp: string[] } | undefined;
}

test("busy 时 prompt 入 kernel followUp 队列，queue_update 携带队列内容", async () => {
  const events: CapturedEvent[] = [];
  const { session, am, fake } = await setup(events);
  fake.autoSettle = false; // prompt 后不自动 settled → 保持 busy

  await am.prompt(session.id, "第一条", { model: MODEL });
  await am.prompt(session.id, "排队消息", { model: MODEL });

  // busy 中不直接发给 client，进 followUp 队列
  expect(fake.prompted).toEqual(["第一条"]);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: ["排队消息"] });
});

test("agent_settled 后 followUp 逐条 drain（一次一条）", async () => {
  const events: CapturedEvent[] = [];
  const { session, am, fake } = await setup(events);
  fake.autoSettle = false;

  await am.prompt(session.id, "第一条", { model: MODEL });
  await am.prompt(session.id, "F1", { model: MODEL });
  await am.prompt(session.id, "F2", { model: MODEL });

  // 第一次 settled：只 drain F1，F2 仍排队
  fake.emit({ type: "agent_settled" });
  expect(fake.prompted).toEqual(["第一条", "F1"]);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: ["F2"] });

  // 第二次 settled：drain F2，队列清空
  fake.emit({ type: "agent_settled" });
  expect(fake.prompted).toEqual(["第一条", "F1", "F2"]);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: [] });
});

test("turn_end 后 steering 投递一条给 client.steer（one-at-a-time）", async () => {
  const events: CapturedEvent[] = [];
  const { session, am, fake } = await setup(events);
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL }); // busy
  am.steerMessage(session.id, "S1");
  am.steerMessage(session.id, "S2");
  expect(fake.steered).toEqual([]);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: ["S1", "S2"], followUp: [] });

  // 每个完成的 turn 只投一条
  fake.emit({ type: "turn_end" });
  expect(fake.steered).toEqual(["S1"]);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: ["S2"], followUp: [] });

  fake.emit({ type: "turn_end" });
  expect(fake.steered).toEqual(["S1", "S2"]);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: [] });
});

test("steerMessage — idle 时不入队，直接以 prompt 生效", async () => {
  const { session, am, fake } = await setup();

  am.steerMessage(session.id, "引导一下");
  await new Promise((r) => setTimeout(r, 0)); // client.prompt 为异步调用

  expect(fake.prompted).toEqual(["引导一下"]);
});

test("clearAllQueues 后 turn_end / agent_settled 不再投递任何消息", async () => {
  const events: CapturedEvent[] = [];
  const { session, am, fake } = await setup(events);
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL }); // busy
  await am.prompt(session.id, "F1", { model: MODEL });     // followUp
  am.steerMessage(session.id, "S1");                       // steering

  am.clearAllQueues(session.id);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: [] });

  fake.emit({ type: "turn_end" });
  fake.emit({ type: "agent_settled" });
  expect(fake.steered).toEqual([]);
  expect(fake.prompted).toEqual(["进行中"]); // F1 被清空，不再 drain
});

test("clearSteeringQueue 只清 steering，clearFollowUpQueue 只清 followUp", async () => {
  const events: CapturedEvent[] = [];
  const { session, am, fake } = await setup(events);
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL });
  await am.prompt(session.id, "F1", { model: MODEL });
  am.steerMessage(session.id, "S1");

  am.clearSteeringQueue(session.id);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: ["F1"] });

  am.clearFollowUpQueue(session.id);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: [] });
});

test("immediate：abort + 清空队列 + 剩余重入 followUp + 目标消息直发", async () => {
  const events: CapturedEvent[] = [];
  const { session, am, fake } = await setup(events);
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL });
  await am.prompt(session.id, "排队A", { model: MODEL });
  am.steerMessage(session.id, "引导A");

  await am.immediate(session.id, "立即执行", ["剩余A"]);

  expect(fake.aborts).toBe(1);
  // 目标消息作为新回合直发；排队A/引导A 被清空
  expect(fake.prompted).toEqual(["进行中", "立即执行"]);
  expect(fake.steered).toEqual([]);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: ["剩余A"] });
});

test("bridge 上下文在 ensureStarted 后已注册（宿主工具回调入口）", async () => {
  const { session } = await setup();
  expect(getBridgeSession(session.id)).toBeDefined();
});
