// agent-manager.test.ts — AgentManager（pi RPC 子进程架构）单元测试
//
// RPC 迁移后 AgentManager 不再 import @earendil-works/pi-coding-agent 的 SDK API：
// 每个会话对应一个 `pi --mode rpc` 子进程（RpcClient 驱动），steer/followUp 队列
// 由 kernel 自管（busy 状态机靠 agent_start/agent_settled/turn_end 事件）。
// 测试经 createClientFn 注入 FakeSessionClient（tests/fixtures/fake-session-client.ts）：
// - prompted/steered/models/thinkingLevels/aborts 记录全部调用供断言；
// - emit(e) 手动注入 pi 事件驱动状态机；autoSettle=false 模拟 agent 运行中（不自动 settled）；
// - simulateCrash() 模拟进程意外退出。
// 系统提示词经 --system-prompt <file> 传入 pi：测试同步读
// HIAGENT_DIR/tmp/sysprompts/<sessionId>.md 断言组合结果（afterEach 统一清理）。
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { AgentManager, HIAGENT_DEFAULT_SYSTEM_PROMPT } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { FakeSessionClient, fakeClientFactory } from "./fixtures/fake-session-client";
import { getBridgeSession } from "../src/bridge-registry";
import { askRegistry } from "../src/ask-registry";
import { SkillManager } from "../src/skill-manager";
import { getGlobalMemoryStore } from "../src/amaster-memory";
import { HIAGENT_DIR, BUILTIN_SKILLS_DIR } from "@hiagent/shared";
import type { AskParams, ThinkingLevel } from "@hiagent/shared";
import type { RpcClient, RpcClientOpts } from "../src/rpc-client";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODEL = "anthropic/test-model";

// 测试过程产生的临时文件 / AgentManager / 系统提示词临时文件，afterEach 统一清理
const tmpPaths: string[] = [];
const managers: AgentManager[] = [];
const syspromptSessionIds: string[] = [];

beforeEach(() => {
  askRegistry.reset();
});

afterEach(async () => {
  for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
  for (const f of tmpPaths.splice(0)) {
    try { rmSync(f, { force: true, recursive: true }); } catch {}
  }
  for (const id of syspromptSessionIds.splice(0)) {
    try { rmSync(syspromptPath(id), { force: true }); } catch {}
  }
});

function newProjectStore() {
  const tmpFile = `/tmp/hiagent-am-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  tmpPaths.push(tmpFile);
  return new ProjectStore(tmpFile);
}

/** 组合系统提示词的临时文件路径（pi --system-prompt 的入参） */
function syspromptPath(sessionId: string) {
  return join(HIAGENT_DIR, "tmp", "sysprompts", `${sessionId}.md`);
}

function readSysprompt(sessionId: string): string {
  return readFileSync(syspromptPath(sessionId), "utf8");
}

type CapturedEvent = { sessionId: string; projectId: string; agentName: string; e: any };

interface SetupOpts {
  configStore?: any;
  memoryStore?: { getConfig(): Promise<any> };
  skillManager?: SkillManager;
  events?: CapturedEvent[];
  /** 覆盖默认 fakeClientFactory（如慢启动 / 启动失败 / 预置消息） */
  createClientFn?: (opts: RpcClientOpts) => RpcClient;
  agentName?: string;
}

/** 造测试项目 + 会话实体 + 注入 fake client 的 AgentManager */
async function setup(opts: SetupOpts = {}) {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const agentName = opts.agentName ?? "dev";
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: agentName, title: "测试",
  });
  const fakes: FakeSessionClient[] = [];
  const am = new AgentManager({
    projectStore,
    configStore: opts.configStore ?? null,
    onEvent: (sid, pid, name, e) => opts.events?.push({ sessionId: sid, projectId: pid, agentName: name, e }),
    createClientFn: opts.createClientFn ?? fakeClientFactory(fakes),
    ...(opts.memoryStore ? { memoryStore: opts.memoryStore } : {}),
    ...(opts.skillManager ? { skillManager: opts.skillManager } : {}),
  });
  managers.push(am);
  syspromptSessionIds.push(session.id);
  return { projectStore, project, session, am, fakes };
}

/** 取参数数组中某 flag 的全部值（如 --skill a --skill b → [a, b]） */
function argValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
  }
  return out;
}

function lastQueueUpdate(events: CapturedEvent[]) {
  const qu = [...events].reverse().find((x) => x.e.type === "queue_update");
  return qu?.e as { steering: string[]; followUp: string[] } | undefined;
}

/** 慢启动工厂：start 延迟 ms 毫秒（并发 / dispose 竞态 / pendingAborts 用） */
function slowFactory(fakes: FakeSessionClient[], ms: number) {
  return (o: RpcClientOpts) => {
    const fake = new FakeSessionClient(o);
    fake.start = async () => { await new Promise((r) => setTimeout(r, ms)); fake.started = true; };
    fakes.push(fake);
    return fake as unknown as RpcClient;
  };
}

// ─── 创建 / 缓存 / 生命周期 ─────────────────────────────────────────────────

test("ensureStarted 创建 pi rpc client 并传入会话参数（--session / --system-prompt）", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  expect(fakes).toHaveLength(1);
  expect(fakes[0].started).toBe(true);
  const args = fakes[0].opts.args ?? [];
  expect(argValues(args, "--session")).toEqual([session.piSessionFile]);
  expect(argValues(args, "--system-prompt")).toEqual([syspromptPath(session.id)]);
  // bridge 上下文已注册（宿主工具经 hiagent-bridge 扩展回调 kernel）
  expect(getBridgeSession(session.id)).toBeDefined();
});

test("ensureStarted 无显式 tools 时不传 --tools、用 --exclude-tools 排除 subagent", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  const args = fakes[0].opts.args ?? [];
  expect(args).not.toContain("--tools");
  const excluded = argValues(args, "--exclude-tools").flatMap((v) => v.split(","));
  expect(excluded).toContain("subagent");
});

test("ensureStarted 使用 agent 显式配置的 tools（--tools 白名单）", async () => {
  const configStore = {
    getAgent: mock(async () => ({ displayName: "dev", tools: ["read"] })),
  } as any;
  const { project, session, am, fakes } = await setup({ configStore });
  await am.ensureStarted(project.id, "dev", session.id);

  const args = fakes[0].opts.args ?? [];
  const tools = argValues(args, "--tools").flatMap((v) => v.split(","));
  expect(tools).toContain("read");
});

test("ensureStarted 复用已存在的会话（同 sessionId 不重复创建 client）", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  await am.ensureStarted(project.id, "dev", session.id);

  expect(fakes).toHaveLength(1);
});

test("ensureStarted 并发调用同 sessionId 只创建一次（共享创建 Promise）", async () => {
  const fakes: FakeSessionClient[] = [];
  const { project, session, am } = await setup({ createClientFn: slowFactory(fakes, 60) });

  const [a, b] = await Promise.all([
    am.ensureStarted(project.id, "dev", session.id),
    am.ensureStarted(project.id, "dev", session.id),
  ]);

  expect(a).toBe(b);
  expect(fakes).toHaveLength(1);
});

test("ensureStarted 创建失败时清理 starting 锁并允许重试", async () => {
  // 第一阶段：工厂始终失败，并发调用共享同一个失败 Promise
  const failFakes: FakeSessionClient[] = [];
  let calls = 0;
  const failingFactory = (o: RpcClientOpts) => {
    calls++;
    const fake = new FakeSessionClient(o);
    fake.start = async () => {
      await new Promise((r) => setTimeout(r, 30));
      throw new Error("创建失败");
    };
    failFakes.push(fake);
    return fake as unknown as RpcClient;
  };
  const { projectStore, project, session, am } = await setup({ createClientFn: failingFactory });

  const results = await Promise.allSettled([
    am.ensureStarted(project.id, "dev", session.id),
    am.ensureStarted(project.id, "dev", session.id),
  ]);
  expect(results[0].status).toBe("rejected");
  expect(results[1].status).toBe("rejected");
  expect(calls).toBe(1);

  // 第二阶段：换正常工厂，同 sessionId 能重新创建（不阻塞在失败的 Promise 上）
  const recoveryFakes: FakeSessionClient[] = [];
  const recovery = new AgentManager({
    projectStore,
    configStore: null,
    onEvent: () => {},
    createClientFn: fakeClientFactory(recoveryFakes),
  });
  managers.push(recovery);
  await recovery.ensureStarted(project.id, "dev", session.id);
  expect(recoveryFakes).toHaveLength(1);
  expect(recoveryFakes[0].started).toBe(true);
});

test("ensureStarted 创建过程中被 dispose 时清理资源并拒绝", async () => {
  const fakes: FakeSessionClient[] = [];
  const { project, session, am } = await setup({ createClientFn: slowFactory(fakes, 60) });

  const startPromise = am.ensureStarted(project.id, "dev", session.id);
  // 在创建完成前 dispose，模拟 session:delete 与 agent:prompt 并发
  await am.disposeSession(session.id);

  await expect(startPromise).rejects.toThrow("会话已清理");
  expect(fakes).toHaveLength(1);
  expect(fakes[0].alive).toBe(false); // client 已被 dispose
});

test("创建期间收到的 abort 在 client 就绪后立即执行（pendingAborts）", async () => {
  const { project, session, am, fakes } = await setup();

  const startPromise = am.ensureStarted(project.id, "dev", session.id);
  // _createSession 尚在 projectStore.load 阶段（client 未注册）→ 走 pendingAborts 标记
  await am.abort(session.id);
  await startPromise;

  expect(fakes).toHaveLength(1);
  expect(fakes[0].aborts).toBe(1);
});

test("disposeSession 清理 client / bridge 上下文 / 系统提示词临时文件 / 脏标记", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  const promptFile = syspromptPath(session.id);
  expect(existsSync(promptFile)).toBe(true);

  am.markSkillsDirty();
  expect((am as any).skillDirty.has(session.id)).toBe(true);

  await am.disposeSession(session.id);

  expect(fakes[0].alive).toBe(false);
  expect(getBridgeSession(session.id)).toBeUndefined();
  expect((am as any).sessions.has(session.id)).toBe(false);
  expect((am as any).skillDirty.has(session.id)).toBe(false);
  // promptFile 的 rm 是 fire-and-forget，轮询等待落地
  const deadline = Date.now() + 2000;
  while (existsSync(promptFile) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(existsSync(promptFile)).toBe(false);
});

// ─── prompt / 模型 / thinking ───────────────────────────────────────────────

test("prompt — 未选择模型时抛错", async () => {
  const { project, session, am } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  await expect(am.prompt(session.id, "你好")).rejects.toThrow("未选择模型");
});

test("prompt — agent 空闲且无排队 → 直接 prompt", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  await am.prompt(session.id, "你好", { model: MODEL });

  expect(fakes[0].prompted).toEqual(["你好"]);
});

test("prompt — 未启动的会话抛错", async () => {
  const { am } = await setup();
  await expect(am.prompt("nonexistent", "你好", { model: MODEL })).rejects.toThrow("会话未启动");
});

test("prompt — 「provider/modelId」按第一个 / 拆分调 setModel", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  await am.prompt(session.id, "你好", { model: "anthropic/claude-x" });
  expect(fakes[0].models.at(-1)).toEqual({ provider: "anthropic", modelId: "claude-x" });

  // modelId 允许含 "/"
  await am.prompt(session.id, "你好", { model: "openai/gpt-4o/2024" });
  expect(fakes[0].models.at(-1)).toEqual({ provider: "openai", modelId: "gpt-4o/2024" });
});

test("prompt — 裸 modelId 经 get_available_models 解析 provider", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  fakes[0].availableModels = [{ id: "deepseek-chat", provider: "deepseek" }];

  await am.prompt(session.id, "你好", { model: "deepseek-chat" });
  expect(fakes[0].models.at(-1)).toEqual({ provider: "deepseek", modelId: "deepseek-chat" });

  await expect(am.prompt(session.id, "你好", { model: "no-such-model" }))
    .rejects.toThrow("模型解析失败");
});

test("prompt — thinking level 映射（disabled→off，max→xhigh，其余透传）", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  const cases: Array<[ThinkingLevel, string]> = [
    ["disabled", "off"],
    ["medium", "medium"],
    ["high", "high"],
    ["max", "xhigh"],
  ];
  for (const [input, expected] of cases) {
    await am.prompt(session.id, "你好", { model: MODEL, thinking: input });
    expect(fakes[0].thinkingLevels.at(-1)).toBe(expected);
  }
});

// ─── 附件构建 prompt 文本 ───────────────────────────────────────────────────

test("prompt — 图片附件统一用 @相对路径引用", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  const imgPath = `/tmp/hiagent-img-${Date.now()}.png`;
  tmpPaths.push(imgPath);
  writeFileSync(imgPath, Buffer.from("fake-image"));

  await am.prompt(session.id, "描述这张图", {
    model: MODEL,
    attachments: [{ kind: "image", path: imgPath, name: "示例.png", size: 0 }],
  });

  expect(fakes[0].prompted).toHaveLength(1);
  const text = fakes[0].prompted[0];
  expect(text).toContain("描述这张图");
  expect(text).toContain("Attachments:");
  expect(text).toMatch(/@hiagent-img-\d+\.png/);
});

test("prompt — snippet 附件内容直接内联", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  await am.prompt(session.id, "总结这段代码", {
    model: MODEL,
    attachments: [{ kind: "snippet", name: "代码片段", content: "const x = 1;" }],
  });

  expect(fakes[0].prompted).toHaveLength(1);
  expect(fakes[0].prompted[0]).toContain("[片段: 代码片段]\nconst x = 1;");
  expect(fakes[0].prompted[0]).toContain("总结这段代码");
});

// ─── kernel 队列语义（steer / followUp） ────────────────────────────────────

test("prompt — agent 运行中 → 进 kernel followUp 队列并合成 queue_update", async () => {
  const events: CapturedEvent[] = [];
  const { project, session, am, fakes } = await setup({ events });
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];
  fake.autoSettle = false; // prompt 后不自动 settled → 保持 busy

  await am.prompt(session.id, "第一条", { model: MODEL });
  expect(fake.prompted).toEqual(["第一条"]);

  await am.prompt(session.id, "第二条", { model: MODEL });
  // busy 中不直接 prompt，进 followUp 队列
  expect(fake.prompted).toEqual(["第一条"]);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: ["第二条"] });

  // agent_settled → drain 一条 followUp
  fake.emit({ type: "agent_settled" });
  expect(fake.prompted).toEqual(["第一条", "第二条"]);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: [] });
});

test("promoteToSteer 把目标消息从 followUp 移到 steering，不打断当前 agent", async () => {
  const events: CapturedEvent[] = [];
  const { project, session, am, fakes } = await setup({ events });
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL }); // busy
  await am.promoteToSteer(session.id, "目标", ["剩余A", "剩余B"]);

  // 不 abort / 不 prompt，只移动队列
  expect(fake.aborts).toBe(0);
  expect(fake.prompted).toEqual(["进行中"]);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: ["目标"], followUp: ["剩余A", "剩余B"] });

  // 当前 turn 结束后 steering 投递一条
  fake.emit({ type: "turn_end" });
  expect(fake.steered).toEqual(["目标"]);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: ["剩余A", "剩余B"] });
});

test("promoteToSteer — 空闲时目标消息立即以 prompt 生效", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  await am.promoteToSteer(session.id, "目标", []);
  expect(fakes[0].prompted).toEqual(["目标"]);
});

test("immediate 清空队列 + abort + 剩余重入 followUp + 目标消息直发", async () => {
  const events: CapturedEvent[] = [];
  const { project, session, am, fakes } = await setup({ events });
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL });
  await am.prompt(session.id, "排队A", { model: MODEL });
  await am.prompt(session.id, "排队B", { model: MODEL });

  await am.immediate(session.id, "立即执行", ["剩余A", "剩余B"]);

  expect(fake.aborts).toBe(1);
  // 目标消息作为新回合直发（排队A/B 被清空，不会发出）
  expect(fake.prompted).toEqual(["进行中", "立即执行"]);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: ["剩余A", "剩余B"] });
});

test("immediate — abort 后 agent 仍在处理时降级为 steer 插队", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL });
  fake.nextPromptError = new Error("agent already processing");

  await am.immediate(session.id, "立即执行", []);

  expect(fake.aborts).toBe(1);
  expect(fake.steered).toEqual(["立即执行"]);
});

test("immediate 快速连点会串行执行，不并发调用 prompt", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];

  const promptCalls: { start: number; end: number }[] = [];
  fake.prompt = async () => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 50));
    promptCalls.push({ start, end: Date.now() });
  };

  const p1 = am.immediate(session.id, "第一条", []);
  const p2 = am.immediate(session.id, "第二条", []);
  await Promise.all([p1, p2]);

  expect(promptCalls).toHaveLength(2);
  // 第二次 prompt 的开始时间应不早于第一次的结束时间（允许 10ms 误差）
  expect(promptCalls[1].start).toBeGreaterThanOrEqual(promptCalls[0].end - 10);
});

test("clearSteeringQueue / clearFollowUpQueue / clearAllQueues 清空对应队列并发 queue_update", async () => {
  const events: CapturedEvent[] = [];
  const { project, session, am, fakes } = await setup({ events });
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL }); // busy
  await am.prompt(session.id, "F1", { model: MODEL });     // followUp
  am.steerMessage(session.id, "S1");                       // steering

  expect(lastQueueUpdate(events)).toMatchObject({ steering: ["S1"], followUp: ["F1"] });

  am.clearSteeringQueue(session.id);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: ["F1"] });

  am.clearFollowUpQueue(session.id);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: [] });

  // 再塞满后 clearAllQueues 一次清空
  await am.prompt(session.id, "F2", { model: MODEL });
  am.steerMessage(session.id, "S2");
  am.clearAllQueues(session.id);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: [] });
});

test("clearSteeringQueue / clearFollowUpQueue — session 不存在时静默忽略", async () => {
  const { am } = await setup();
  am.clearSteeringQueue("nonexistent");
  am.clearFollowUpQueue("nonexistent");
  am.clearAllQueues("nonexistent");
});

test("steerMessage — busy 时入 steering 队列，turn_end 后投递给 client", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL }); // busy
  am.steerMessage(session.id, "引导一下");

  expect(fake.steered).toEqual([]); // 尚未投递
  fake.emit({ type: "turn_end" });
  expect(fake.steered).toEqual(["引导一下"]);
});

test("steerMessage — idle 时直接 prompt 生效", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  am.steerMessage(session.id, "引导一下");
  await new Promise((r) => setTimeout(r, 0)); // client.prompt 为异步调用

  expect(fakes[0].prompted).toEqual(["引导一下"]);
});

test("abort 清空 kernel 队列并中断当前运行", async () => {
  const events: CapturedEvent[] = [];
  const { project, session, am, fakes } = await setup({ events });
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL });
  await am.prompt(session.id, "排队", { model: MODEL });
  expect(am.isSessionStreaming(session.id)).toBe(true);

  await am.abort(session.id);

  expect(fake.aborts).toBe(1);
  expect(am.isSessionStreaming(session.id)).toBe(false);
  expect(lastQueueUpdate(events)).toMatchObject({ steering: [], followUp: [] });
});

// ─── 事件转发 ───────────────────────────────────────────────────────────────

test("onEvent 把 pi 事件转发给上层并携带 sessionId/projectId/agentName 上下文", async () => {
  const received: CapturedEvent[] = [];
  const { project, session, am, fakes } = await setup({ events: received });
  await am.ensureStarted(project.id, "dev", session.id);

  fakes[0].emit({ type: "turn_start" });

  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ sessionId: session.id, projectId: project.id, agentName: "dev" });
  expect(received[0].e).toEqual({ type: "turn_start" });
});

test("message_end 事件把消息追加进历史快照", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  fakes[0].emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "回复" }] } });

  const msgs = am.getMessages(session.id);
  expect(msgs).toHaveLength(1);
  expect(msgs[0].role).toBe("assistant");
});

test("getMessages 在 session 不存在时返回空数组", async () => {
  const { am } = await setup();
  expect(am.getMessages("不存在的-session")).toEqual([]);
});

// ─── dirty / skillDirty 标脏重建 ────────────────────────────────────────────

test("markAllDirty 后 idle 命中缓存 → 重建（dispose 旧 client + 新建），并清脏", async () => {
  const { project, session, am, fakes } = await setup();
  const first = await am.ensureStarted(project.id, "dev", session.id);
  expect(fakes).toHaveLength(1);

  am.markAllDirty();
  const second = await am.ensureStarted(project.id, "dev", session.id);

  expect(fakes).toHaveLength(2);
  expect(fakes[0].alive).toBe(false);   // 旧 client 被 dispose
  expect(second).not.toBe(first);       // 返回新 handle

  // 清脏后再次命中不再重建
  await am.ensureStarted(project.id, "dev", session.id);
  expect(fakes).toHaveLength(2);
});

test("未标脏的会话命中缓存时不重建", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  await am.ensureStarted(project.id, "dev", session.id);
  expect(fakes).toHaveLength(1);
});

test("markSkillsDirty 后 idle 命中缓存 → 重建（与 markAllDirty 统一为进程重启）", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  am.markSkillsDirty();
  await am.ensureStarted(project.id, "dev", session.id);

  expect(fakes).toHaveLength(2);
  expect(fakes[0].alive).toBe(false);

  // 清脏后不再重建
  await am.ensureStarted(project.id, "dev", session.id);
  expect(fakes).toHaveLength(2);
});

test("busy 时标脏不重建，保留 dirty 等 idle 后补重建", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];
  fake.autoSettle = false;
  await am.prompt(session.id, "进行中", { model: MODEL }); // busy

  am.markAllDirty();
  const r = await am.ensureStarted(project.id, "dev", session.id); // busy → 跳过
  expect(fakes).toHaveLength(1);

  fake.emit({ type: "agent_settled" }); // idle
  const r2 = await am.ensureStarted(project.id, "dev", session.id); // 补重建
  expect(fakes).toHaveLength(2);
  expect(fakes[0].alive).toBe(false);
  expect(r2).not.toBe(r);
});

// ─── switchAgent / renameAgentSessions ──────────────────────────────────────

test("switchAgent: 换体重建，sessionId 不变且 config 取新 agent", async () => {
  const getAgent = mock(async (n: string) => ({ displayName: n, partners: { askTo: [] } }));
  const configStore = { getAgent } as any;
  const { projectStore, project, session, am, fakes } = await setup({ configStore });

  await am.ensureStarted(project.id, "dev", session.id);
  expect(fakes).toHaveLength(1);

  await am.switchAgent(session.id, "pm");

  // 拆除旧 client + 同一 sessionId 重建
  expect(fakes).toHaveLength(2);
  expect(fakes[0].alive).toBe(false);
  expect(getAgent).toHaveBeenCalledWith("pm");
  // ProjectStore 已更新
  const { sessions } = await projectStore.load();
  expect(sessions.find((s) => s.id === session.id)!.primaryAgent).toBe("pm");
  // 重建后命中缓存返回新 handle，不再创建
  await am.ensureStarted(project.id, "pm", session.id);
  expect(fakes).toHaveLength(2);
});

test("switchAgent: 运行中先 abort，abort 失败吞掉不阻塞切换", async () => {
  const { projectStore, project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];
  fake.autoSettle = false;
  await am.prompt(session.id, "进行中", { model: MODEL }); // busy
  fake.abort = async () => { throw new Error("abort 失败"); };

  await am.switchAgent(session.id, "pm"); // abort 失败不应抛错阻塞

  expect(fakes).toHaveLength(2);
  const { sessions } = await projectStore.load();
  expect(sessions.find((s) => s.id === session.id)!.primaryAgent).toBe("pm");
});

test("switchAgent: 会话未启动时从 projectStore 降级取 projectId 并直接建会话", async () => {
  const { projectStore, session, am, fakes } = await setup();
  // 未 ensureStarted，直接切换
  await am.switchAgent(session.id, "pm");

  expect(fakes).toHaveLength(1);
  const { sessions } = await projectStore.load();
  expect(sessions.find((s) => s.id === session.id)!.primaryAgent).toBe("pm");
});

test("switchAgent: 会话不存在时抛错", async () => {
  const { am } = await setup();
  await expect(am.switchAgent("nope", "pm")).rejects.toThrow("会话不存在");
});

test("renameAgentSessions: meta 更新 + 标 skillDirty，下次 ensureStarted 用新名重建", async () => {
  const { project, session, am, fakes } = await setup({ agentName: "旧名" });
  await am.ensureStarted(project.id, "旧名", session.id);
  expect(fakes).toHaveLength(1);

  am.renameAgentSessions("旧名", "新名");

  expect((am as any).sessions.get(session.id).meta.agentName).toBe("新名");
  expect((am as any).skillDirty.has(session.id)).toBe(true);

  await am.ensureStarted(project.id, "新名", session.id);
  expect(fakes).toHaveLength(2);
  expect(fakes[0].alive).toBe(false);
  expect((am as any).sessions.get(session.id).meta.agentName).toBe("新名");
});

test("renameAgentSessions: 不匹配旧名的活跃会话不受影响", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  am.renameAgentSessions("旧名", "新名");

  expect((am as any).sessions.get(session.id).meta.agentName).toBe("dev");
  expect((am as any).skillDirty.has(session.id)).toBe(false);
  // 未标脏：命中缓存不重建
  await am.ensureStarted(project.id, "dev", session.id);
  expect(fakes).toHaveLength(1);
});

// ─── listGlobalTools ────────────────────────────────────────────────────────

test("listGlobalTools 返回内置工具集（含 grep/find/ls 与网络工具），不含 subagent", async () => {
  const { am } = await setup();
  const tools = await am.listGlobalTools();
  const names = tools.map((t) => t.name);

  expect(names).toEqual(expect.arrayContaining([
    "read", "bash", "edit", "write", "grep", "find", "ls",
    "web_search", "fetch_content", "get_search_content",
  ]));
  expect(names).not.toContain("subagent");
});

// ─── 系统提示词（读 sysprompts/<id>.md 断言组合结果） ───────────────────────

test("系统提示词写入 sysprompts 文件：含 base / delegateRoster / env 约束段", async () => {
  const { project, session, am } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  const prompt = readSysprompt(session.id);
  expect(prompt).toContain("You are an expert coding assistant"); // base 段默认兜底
  expect(prompt).toContain("## Available Subagents");             // delegate-roster 段（内置类型始终列出）
  expect(prompt).toContain(`Built-in directory: ${BUILTIN_SKILLS_DIR}`); // env-constraints 段
  expect(prompt).toMatch(/internal terminology/i);
});

test("系统提示词注入记忆快照（memorySnapshot 段）", async () => {
  // 先向真实全局记忆写入一条唯一内容，验证快照拼接进提示词，测完清理
  const unique = `测试记忆-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const globalStore = getGlobalMemoryStore(HIAGENT_DIR);
  await globalStore.add("memory", unique);
  try {
    const { project, session, am } = await setup();
    await am.ensureStarted(project.id, "dev", session.id);

    const prompt = readSysprompt(session.id);
    expect(prompt).toContain(unique);
  } finally {
    await globalStore.remove("memory", unique).catch(() => {});
  }
});

test("注入提示关闭（memoryPolicyStyle=none）时系统提示词不追加记忆快照", async () => {
  const unique = `测试记忆-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const globalStore = getGlobalMemoryStore(HIAGENT_DIR);
  await globalStore.add("memory", unique);
  try {
    const { project, session, am } = await setup({
      memoryStore: { getConfig: async () => ({ reviewEnabled: true, memoryPolicyStyle: "none" as const }) },
    });
    await am.ensureStarted(project.id, "dev", session.id);

    const prompt = readSysprompt(session.id);
    expect(prompt).not.toContain(unique);
    // memory-snapshot 段为空被过滤，env-constraints 成为最后一段
    expect(prompt.trimEnd().endsWith("plain, user-facing language.")).toBe(true);
  } finally {
    await globalStore.remove("memory", unique).catch(() => {});
  }
});

test("config systemPromptMode=append 时 systemPromptBody 作为 base 段", async () => {
  const configStore = {
    getAgent: mock(async () => ({
      displayName: "dev",
      systemPromptMode: "append",
      systemPromptBody: "自定义 BODY 提示词",
    })),
  } as any;
  const { project, session, am } = await setup({ configStore });
  await am.ensureStarted(project.id, "dev", session.id);

  const prompt = readSysprompt(session.id);
  expect(prompt).toContain("自定义 BODY 提示词");
});

test("config systemPromptMode=replace 时 systemPromptBody 替代默认 base 提示词", async () => {
  const configStore = {
    getAgent: mock(async () => ({
      displayName: "dev",
      systemPromptMode: "replace",
      systemPromptBody: "你是前端开发者角色提示词",
    })),
  } as any;
  const { project, session, am } = await setup({ configStore });
  await am.ensureStarted(project.id, "dev", session.id);

  const prompt = readSysprompt(session.id);
  expect(prompt).toContain("你是前端开发者角色提示词");
  // replace：默认 base 兜底文案不再出现
  expect(prompt).not.toContain("You are an expert coding assistant");
});

test("askTo 非空时 delegate-roster 段含命名智能体与委托引导", async () => {
  const configs: Record<string, any> = {
    dev: { displayName: "dev", partners: { askTo: ["代码审查"] } },
    代码审查: {
      displayName: "代码审查", description: "评审改动", partners: { askTo: [] },
      delegationHints: { whenToDelegate: "代码变更需要评审时", benefit: "结构化审查反馈" },
    },
  };
  const configStore = { getAgent: mock(async (n: string) => configs[n] ?? null) } as any;
  const { project, session, am } = await setup({ configStore });
  await am.ensureStarted(project.id, "dev", session.id);

  const prompt = readSysprompt(session.id);
  expect(prompt).toContain("代码审查");
  expect(prompt).toContain("评审改动");
  expect(prompt).toContain("代码变更需要评审时");
  expect(prompt).toContain("结构化审查反馈");
});

test("askTo 为空时 roster 段仍含内置 subagent 类型", async () => {
  const configStore = {
    getAgent: mock(async () => ({ displayName: "dev", partners: { askTo: [] } })),
  } as any;
  const { project, session, am } = await setup({ configStore });
  await am.ensureStarted(project.id, "dev", session.id);

  const prompt = readSysprompt(session.id);
  expect(prompt).toContain("## Available Subagents");
  expect(prompt).toContain("general-purpose");
});

// ─── 宿主工具（bridge ctx） ─────────────────────────────────────────────────

test("bridge ctx 的 delegate 工具：不在可调起列表时返回错误", async () => {
  const configStore = {
    getAgent: mock(async () => ({ displayName: "dev", partners: { askTo: [] } })),
  } as any;
  const { project, session, am } = await setup({ configStore });
  await am.ensureStarted(project.id, "dev", session.id);

  const ctx = getBridgeSession(session.id)!;
  const result = await ctx.handleTool(
    "delegate", "tc1", { agent: "不存在的智能体", task: "做点什么" }, new AbortController().signal,
  );
  expect(result.content[0].text).toContain("不在可调起列表中");
});

test("自动学习关闭（reviewEnabled=false）时记忆工具返回关闭提示", async () => {
  const { project, session, am } = await setup({
    memoryStore: { getConfig: async () => ({ reviewEnabled: false, memoryPolicyStyle: "full" as const }) },
  });
  await am.ensureStarted(project.id, "dev", session.id);

  const ctx = getBridgeSession(session.id)!;
  const result = await ctx.handleTool(
    "memory_read", "tc1", { target: "memory", scope: "global" }, new AbortController().signal,
  );
  expect(result.content[0].text).toContain("记忆功能已关闭");
  expect((result.details as any).error).toBe("memory_disabled");
});

test("默认（不传 memoryStore）记忆工具可用", async () => {
  const { project, session, am } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  const ctx = getBridgeSession(session.id)!;
  const result = await ctx.handleTool(
    "memory_read", "tc1", { target: "memory", scope: "global" }, new AbortController().signal,
  );
  expect(result.content[0].text).not.toContain("记忆功能已关闭");
});

// ─── 中断清理（askRegistry.cancelAll）接线 ──────────────────────────────────

const askParams: AskParams = { questions: [
  { question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
] };

test("abort 取消该 session 的 pending ask（同步 cancelAll）", async () => {
  const { project, session, am } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  const p = askRegistry.ask(session.id, "tc1", askParams, new AbortController().signal);
  await am.abort(session.id);
  expect((await p).cancelled).toBe(true);
});

test("immediate(_jumpQueue interrupt) 取消 pending ask", async () => {
  const { project, session, am } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  const p = askRegistry.ask(session.id, "tc1", askParams, new AbortController().signal);
  await am.immediate(session.id, "立即执行", []);
  expect((await p).cancelled).toBe(true);
});

test("disposeSession 取消 pending ask", async () => {
  const { project, session, am } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  const p = askRegistry.ask(session.id, "tc1", askParams, new AbortController().signal);
  await am.disposeSession(session.id);
  expect((await p).cancelled).toBe(true);
});

// ─── 历史消息 reconcile 兜底 ────────────────────────────────────────────────

test("ensureStarted 对 dangling ask 调用注入 cancelled toolResult（重启兜底）", async () => {
  // 构造一条 dangling ask 调用的历史：assistant 消息含 ask_user_question toolCall，无对应 toolResult
  const danglingMessages = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-dangling", name: "ask_user_question", arguments: askParams }],
      model: "test-model",
      stopReason: "tool_use",
      timestamp: 1,
    },
  ];
  const fakes: FakeSessionClient[] = [];
  const factory = (o: RpcClientOpts) => {
    const fake = new FakeSessionClient(o);
    fake.messagesToReturn = danglingMessages;
    fakes.push(fake);
    return fake as unknown as RpcClient;
  };
  const { project, session, am } = await setup({ createClientFn: factory });
  await am.ensureStarted(project.id, "dev", session.id);

  const msgs = am.getMessages(session.id);
  expect(msgs.length).toBe(danglingMessages.length + 1);
  const last = msgs[msgs.length - 1];
  expect(last.role).toBe("toolResult");
  expect(last.isError).toBe(false);
  expect(last.toolCallId).toBe("tc-dangling");
});

// ─── skill 路径（--skill 参数） ─────────────────────────────────────────────

function tmpSkillRoot() {
  const root = `/tmp/hiagent-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(root, "skills"), { recursive: true }); // builtin（空）
  return root;
}
function createSkillAt(dir: string, name: string, desc: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`);
}

test("ensureStarted 把启用 skill 路径作为 --skill 传给 pi", async () => {
  const skillRoot = tmpSkillRoot();
  tmpPaths.push(skillRoot);
  const userDir = join(skillRoot, "user-skills");
  mkdirSync(userDir, { recursive: true });
  createSkillAt(userDir, "my-skill", "测试技能");
  const skillManager = new SkillManager(skillRoot);
  await skillManager.addDir(userDir);

  const { project, session, am, fakes } = await setup({ skillManager });
  await am.ensureStarted(project.id, "dev", session.id);

  const skills = argValues(fakes[0].opts.args ?? [], "--skill");
  expect(skills).toContain(join(userDir, "my-skill"));
});

test("--skill 包含 builtin 来源的 skill（因为已禁用 Pi 默认扫描，必须由 HiAgent 显式传入）", async () => {
  const skillRoot = tmpSkillRoot();
  tmpPaths.push(skillRoot);
  createSkillAt(join(skillRoot, "skills"), "builtin-skill", "内置"); // builtin
  const userDir = join(skillRoot, "user-skills");
  mkdirSync(userDir, { recursive: true });
  createSkillAt(userDir, "user-skill", "用户");
  const skillManager = new SkillManager(skillRoot);
  await skillManager.addDir(userDir);

  const { project, session, am, fakes } = await setup({ skillManager });
  await am.ensureStarted(project.id, "dev", session.id);

  const args = fakes[0].opts.args ?? [];
  expect(args).toContain("--no-skills");
  const skills = argValues(args, "--skill");
  expect(skills).toContain(join(userDir, "user-skill"));
  expect(skills).toContain(join(join(skillRoot, "skills"), "builtin-skill"));
});

test("skillManager 为空时仍传 --no-skills 但不传 --skill", async () => {
  const { project, session, am, fakes } = await setup(); // 不传 skillManager
  await am.ensureStarted(project.id, "dev", session.id);

  const args = fakes[0].opts.args ?? [];
  expect(args).toContain("--no-skills");
  expect(args).not.toContain("--skill");
});

// ─── 进程崩溃 ───────────────────────────────────────────────────────────────

test("进程意外退出 → 合成 message_end 错误事件 + 下次 ensureStarted 重建新 client", async () => {
  const events: CapturedEvent[] = [];
  const { project, session, am, fakes } = await setup({ events });
  await am.ensureStarted(project.id, "dev", session.id);
  expect(fakes).toHaveLength(1);

  fakes[0].simulateCrash(3);

  // 合成错误事件（前端 ⚠️ 渲染管线）
  const crashEvent = events.find((x) => x.e.type === "message_end" && x.e.message?.stopReason === "error");
  expect(crashEvent).toBeDefined();
  expect(crashEvent!.sessionId).toBe(session.id);
  expect(crashEvent!.e.message.errorMessage).toContain("agent 进程意外退出");
  expect(crashEvent!.e.message.errorMessage).toContain("code=3");

  // 崩溃后下次 ensureStarted 拆除重建
  await am.ensureStarted(project.id, "dev", session.id);
  expect(fakes).toHaveLength(2);
  expect(fakes[1]).not.toBe(fakes[0]);
  expect(fakes[1].started).toBe(true);
});

// ─── 静态断言 ───────────────────────────────────────────────────────────────

test("HIAGENT_DEFAULT_SYSTEM_PROMPT 含 @[agentName] 委托规则文案", () => {
  // 委托规则在 delegate-mechanism 段（DEFAULT_DELEGATE_MECHANISM_PROMPT）
  const { DEFAULT_DELEGATE_MECHANISM_PROMPT } = require("../src/system-prompt");
  const fullDefault = `${HIAGENT_DEFAULT_SYSTEM_PROMPT}\n\n${DEFAULT_DELEGATE_MECHANISM_PROMPT}`;
  expect(fullDefault).toContain("@[agentName]");
  expect(fullDefault).toContain("delegate");
  expect(fullDefault).toContain("task contract");
});
