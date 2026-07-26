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

test("bridge 上下文在 ensureStarted 后已注册（宿主工具回调入口）", async () => {
  const { session } = await setup();
  expect(getBridgeSession(session.id)).toBeDefined();
});
