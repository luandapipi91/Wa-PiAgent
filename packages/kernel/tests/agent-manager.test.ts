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
import { HIAGENT_DIR, BUILTIN_SKILLS_DIR, DEFAULT_AGENT_TOOLS } from "@hiagent/shared";
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

test("prompt — agent 运行中 → 进本地 followUpList，agent_settled 后 drain", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];
  fake.autoSettle = false;

  await am.prompt(session.id, "第一条", { model: MODEL });
  expect(fake.prompted).toEqual(["第一条"]);

  await am.prompt(session.id, "第二条", { model: MODEL });
  // busy 中不直接 prompt，进本地 followUpList
  expect(fake.prompted).toEqual(["第一条"]);

  // agent_settled → drain 一条
  fake.emit({ type: "agent_settled" });
  expect(fake.prompted).toEqual(["第一条", "第二条"]);
});

test("steerMessage — busy 时调 pi steer()，空闲时降级为 prompt()", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];

  // 空闲 → prompt()
  await am.steerMessage(session.id, "空闲引导");
  expect(fake.prompted).toEqual(["空闲引导"]);
  expect(fake.steered).toEqual([]);

  // busy → steer()
  fake.autoSettle = false;
  await am.prompt(session.id, "进行中", { model: MODEL });
  await am.steerMessage(session.id, "引导消息");
  expect(fake.steered).toEqual(["引导消息"]);
});

test("abort 清空排队列表 + 中断当前运行", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL });
  // 忙时发送排队消息
  await am.prompt(session.id, "排队A", { model: MODEL });
  await am.prompt(session.id, "排队B", { model: MODEL });

  await am.abort(session.id);
  expect(fake.aborts).toBe(1);
});

test("steerMessage — busy 时立即调 pi steer()", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL }); // busy
  await am.steerMessage(session.id, "引导一下");

  // 新版 steerMessage 直接调 client.steer()，不再经过 kernel 队列
  expect(fake.steered).toEqual(["引导一下"]);
});

test("steerMessage — idle 时直接 prompt 生效", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  am.steerMessage(session.id, "引导一下");
  await new Promise((r) => setTimeout(r, 0)); // client.prompt 为异步调用

  expect(fakes[0].prompted).toEqual(["引导一下"]);
});

test("abort 清空 followUpList 并中断当前运行", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  const fake = fakes[0];
  fake.autoSettle = false;

  await am.prompt(session.id, "进行中", { model: MODEL });
  await am.prompt(session.id, "排队", { model: MODEL });
  expect(am.isSessionStreaming(session.id)).toBe(true);

  await am.abort(session.id);

  expect(fake.aborts).toBe(1);
  expect(am.isSessionStreaming(session.id)).toBe(false);
  // 新版 abort 清空本地 followUpList
  const handle = (am as any).sessions.get(session.id);
  expect(handle.followUpList).toEqual([]);
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

test("listGlobalTools 内置工具 source='内置'，非内置工具不应显示泛化'扩展'", async () => {
  const { am } = await setup();
  const tools = await am.listGlobalTools();

  // 所有 DEFAULT_AGENT_TOOLS 中的工具 source 应为 "内置"
  for (const t of tools) {
    if (DEFAULT_AGENT_TOOLS.includes(t.name as any)) {
      expect(t.source).toBe("内置");
    }
  }

  // web_search 是内置工具，不应显示 "扩展" 或 "插件"
  const ws = tools.find(t => t.name === "web_search");
  expect(ws?.source).toBe("内置");

  // 非内置工具（MCP/动态插件）的 source 应为具体名称，不再是泛化 "扩展"
  const extTools = tools.filter(t => !DEFAULT_AGENT_TOOLS.includes(t.name as any));
  for (const t of extTools) {
    expect(t.source).not.toBe("扩展");
  }
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

test("系统提示词注入记忆快照（经 --append-system-prompt 独立文件）", async () => {
  // 先向真实全局记忆写入一条唯一内容，验证快照写入独立 memory 文件而非 composePrompt。
  // composePrompt 静态化以最大化 LLM 缓存命中率。
  const unique = `测试记忆-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const globalStore = getGlobalMemoryStore(HIAGENT_DIR);
  await globalStore.add("memory", unique);
  try {
    const { project, session, am } = await setup();
    await am.ensureStarted(project.id, "dev", session.id);

    // composePrompt（--system-prompt）不应包含记忆快照
    const prompt = readSysprompt(session.id);
    expect(prompt).not.toContain(unique);

    // 记忆快照应在 --append-system-prompt 独立文件中
    const memoryFile = join(HIAGENT_DIR, "tmp", "sysprompts", `${session.id}-memory.md`);
    expect(existsSync(memoryFile)).toBe(true);
    const memoryContent = readFileSync(memoryFile, "utf8");
    expect(memoryContent).toContain(unique);
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

test("skills 白名单下 delegate 工具仍可用（不因 skill 过滤误关 bridge 扩展）", async () => {
  // agent 有 skills 白名单 → 只排除技能 extension，bridge 扩展应照常加载
  const configStore = {
    getAgent: mock(async () => ({
      displayName: "pm",
      skills: ["chinese-code-review"],  // 有白名单
      partners: { askTo: ["代码审查"] },
    })),
  } as any;
  const { project, session, am } = await setup({ configStore });
  await am.ensureStarted(project.id, "pm", session.id);

  // bridge session 应存在（bridge 扩展未被排除）
  const ctx = getBridgeSession(session.id)!;
  expect(ctx).toBeTruthy();

  // delegate 工具应可用
  const result = await ctx.handleTool(
    "delegate", "tc1", { agent: "代码审查", task: "review this" }, new AbortController().signal,
  );
  // 即使 spawn 失败（测试环境无真实子进程），也不应报"工具不存在"
  expect(result.content[0].text).not.toContain("not found");
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

test("abort 取消 pending ask", async () => {
  const { project, session, am } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  const p = askRegistry.ask(session.id, "tc1", askParams, new AbortController().signal);
  await am.abort(session.id);
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
  expect(fullDefault).toContain("Task Contract");
});

// ─── 队列：followUpList / steerMessage / abort ────────────────────────────

test("prompt 在 busy 时追加到 followUpList（不直接发送）", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  // 模拟 agent 运行中
  fakes[0].autoSettle = false;
  fakes[0].prompted = [];

  await am.prompt(session.id, "测试消息1", { model: MODEL });

  // 第一条消息直接发送（agent 尚未 busy）
  expect(fakes[0].prompted).toHaveLength(1);
  expect(fakes[0].prompted[0]).toContain("测试消息1");

  // 模拟 agent 开始运行（busy=true），再发第二条
  fakes[0].emit({ type: "agent_start" });
  fakes[0].prompted = [];

  await am.prompt(session.id, "排队消息2", { model: MODEL });

  // busy 状态时追加到本地列表，不调 prompt
  expect(fakes[0].prompted).toHaveLength(0);

  // 验证 followUpList 内容
  const handle = (am as any).sessions.get(session.id);
  expect(handle.followUpList).toEqual(["排队消息2"]);
});

test("agent_settled 自动 drain followUpList", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  // 手动设置 followUpList 内容
  const handle = (am as any).sessions.get(session.id);
  handle.followUpList = ["消息1", "消息2"];
  handle.busy = true;
  fakes[0].autoSettle = false;

  // 注入 agent_settled 事件
  fakes[0].prompted = [];
  fakes[0].emit({ type: "agent_settled" });

  // 第一条消息已被 drain（_sendPromptNow 重设 busy=true）
  expect(fakes[0].prompted).toHaveLength(1);
  expect(fakes[0].prompted[0]).toBe("消息1");

  // 第二条还在列表
  expect(handle.followUpList).toEqual(["消息2"]);
});

test("steerMessage 空闲时降级为 prompt", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  // agent 空闲（默认 autoSettle=true 已 settled）
  fakes[0].steered = [];
  fakes[0].prompted = [];

  await am.steerMessage(session.id, "引导消息");

  // 空闲时降级为 prompt，不走 steer
  expect(fakes[0].steered).toHaveLength(0);
  expect(fakes[0].prompted).toHaveLength(1);
  expect(fakes[0].prompted[0]).toBe("引导消息");
});

test("steerMessage 运行中时调用 pi steer", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  // agent 运行中
  fakes[0].autoSettle = false;
  fakes[0].emit({ type: "agent_start" });
  fakes[0].steered = [];
  fakes[0].prompted = [];

  await am.steerMessage(session.id, "运行中引导");

  // 运行中时走 pi 原生 steer
  expect(fakes[0].steered).toHaveLength(1);
  expect(fakes[0].steered[0]).toBe("运行中引导");
  expect(fakes[0].prompted).toHaveLength(0);
});

test("abort 清空 followUpList 并调用 client.abort", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  const handle = (am as any).sessions.get(session.id);
  handle.followUpList = ["排队消息"];
  handle.busy = true;

  await am.abort(session.id);

  // abort 后清空本地列表
  expect(handle.followUpList).toEqual([]);
  // busy 归 false
  expect(handle.busy).toBe(false);
  // 调用了 client.abort
  expect(fakes[0].aborts).toBe(1);
});

test("agent skills 白名单：只传 config.skills 指定的技能路径给 pi", async () => {
  const skillRoot = tmpSkillRoot();
  tmpPaths.push(skillRoot);
  createSkillAt(join(skillRoot, "skills"), "skill-a", "A");
  createSkillAt(join(skillRoot, "skills"), "skill-b", "B");
  const userDir = join(skillRoot, "user-skills");
  mkdirSync(userDir, { recursive: true });
  createSkillAt(userDir, "skill-c", "C");
  const skillManager = new SkillManager(skillRoot);
  await skillManager.addDir(userDir);

  // agent 配置只允许 skill-a 和 skill-c
  const configStore = {
    getAgent: mock(async () => ({
      displayName: "pm",
      skills: ["skill-a", "skill-c"],
      partners: { askTo: [] },
    })),
  } as any;

  const { project, session, am, fakes } = await setup({ skillManager, configStore });
  await am.ensureStarted(project.id, "pm", session.id);

  const skills = argValues(fakes[0].opts.args ?? [], "--skill");
  // skill-a 和 skill-c 在列表中，skill-b 不在
  expect(skills.some(s => s.includes("skill-a"))).toBe(true);
  expect(skills.some(s => s.includes("skill-c"))).toBe(true);
  expect(skills.some(s => s.includes("skill-b"))).toBe(false);
});

test("agent skills 空数组 = 全量（不传白名单时所有启用技能都传给 pi）", async () => {
  const skillRoot = tmpSkillRoot();
  tmpPaths.push(skillRoot);
  createSkillAt(join(skillRoot, "skills"), "skill-a", "A");
  createSkillAt(join(skillRoot, "skills"), "skill-b", "B");
  const skillManager = new SkillManager(skillRoot);

  // agent 配置 skills 为空数组 → 全量
  const configStore = {
    getAgent: mock(async () => ({
      displayName: "dev",
      skills: [],
      partners: { askTo: [] },
    })),
  } as any;

  const { project, session, am, fakes } = await setup({ skillManager, configStore });
  await am.ensureStarted(project.id, "dev", session.id);

  const skills = argValues(fakes[0].opts.args ?? [], "--skill");
  expect(skills.some(s => s.includes("skill-a"))).toBe(true);
  expect(skills.some(s => s.includes("skill-b"))).toBe(true);
});

test("message_end 透传 usage 字段到消息历史", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  // 模拟 Pi 的 message_end 事件，携带 usage
  const usageData = {
    input: 3200,
    output: 1100,
    cacheRead: 1500,
    cacheWrite: 200,
    totalTokens: 4300,
  };
  fakes[0].emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      model: "test-model",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: usageData,
    },
  });

  // usage 应被保留在消息历史中
  const messages = am.getMessages(session.id);
  expect(messages.length).toBe(1);
  expect(messages[0].usage).toEqual(usageData);
});

// ─── getCommands：拉取 pi 运行时 slash 命令 ─────────────────────────────────

test("getCommands 转发 pi get_commands 并返回合并的命令清单", async () => {
  const { am, project, session, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);
  // 预置 pi 返回三类命令（模拟插件 / prompt / skill）
  fakes[0].commandsToReturn = [
    { name: "goal", description: "设定目标", source: "extension" },
    { name: "review", description: "代码审查模板", source: "prompt" },
    { name: "skill:writer", description: "写作技能", source: "skill" },
  ];

  const commands = await am.getCommands(session.id);

  // 应原样返回 pi 的三类命令（过滤 skill 是前端 store 的职责，kernel 不过滤）
  expect(commands).toHaveLength(3);
  expect(commands.map(c => c.name)).toEqual(["goal", "review", "skill:writer"]);
  expect(commands[0]).toEqual({ name: "goal", description: "设定目标", source: "extension" });
});

test("getCommands 无活跃进程时触发冷启动守卫", async () => {
  const { am, session, fakes } = await setup();
  // 不先 ensureStarted，直接调 getCommands → 应触发冷启动（同 reloadSession 守卫）
  // 冷启动是异步的，且 getCommands 在 ensureStarted 完成后立即读 commandsToReturn；
  // 这里只验证冷启动被触发（fake.started=true），命令返回值不依赖时序断言。
  await am.getCommands(session.id).catch(() => {});  // commandsToReturn 默认空，返回 []
  expect(fakes[0].started).toBe(true);
});

test("getCommands 会话不存在时返回空数组（未提供 projectId/agentName）", async () => {
  const { am } = await setup();
  // 无 projectId/agentName 时无法自动创建 session，返回空数组
  const commands = await am.getCommands("不存在的session");
  expect(commands).toEqual([]);
});

test("getCommands 会话不存在时自动创建 session 并返回命令", async () => {
  // 自定义工厂：让新创建的 fake client 预设 commandsToReturn
  const fakes2: FakeSessionClient[] = [];
  const customFactory = (opts: RpcClientOpts) => {
    const fake = new FakeSessionClient(opts);
    fake.commandsToReturn = [
      { name: "goal", description: "设定目标", source: "extension" },
    ];
    fakes2.push(fake);
    return fake as unknown as RpcClient;
  };

  const { am, project } = await setup({ createClientFn: customFactory });

  // session 不存在但有 projectId+agentName → 自动创建 + 启动 pi 进程 + 返回命令
  const commands = await am.getCommands("new-session-id", project.id, "dev");

  expect(commands).toHaveLength(1);
  expect(commands[0].name).toBe("goal");

  // session 已被创建并存到 ProjectStore
  const { sessions } = await (am as any).opts.projectStore.load();
  expect(sessions.find((s: any) => s.id === "new-session-id")).toBeTruthy();
});

// ─── 扩展命令拦截 prompt 时不卡在 thinking 状态 ─────────────────────────────
// 当扩展命令（如 /goal）拦截 prompt 时，agent_start 不会触发，
// _sendPromptNow 的乐观 busy=true 必须能复位，否则前端永远显示"思考中"。
test("扩展命令拦截 prompt 时不卡在 busy 状态", async () => {
  const { project, session, am, fakes } = await setup();
  await am.ensureStarted(project.id, "dev", session.id);

  // 模拟扩展命令拦截：prompt 返回成功但 agent_start 不触发
  fakes[0].autoSettle = false;

  await am.prompt(session.id, "/goal", { model: MODEL });

  // prompt 返回后乐观 busy=true，等待 _sendPromptNow 内延迟检查复位
  await new Promise(r => setTimeout(r, 60));

  // session 不应 busy（扩展命令已处理完毕，agent 未启动）
  expect(am.isSessionBusy(session.id)).toBe(false);

  // thinkingSince 也应为 null（没有 agent_start）
  expect(am.getThinkingSince(session.id)).toBeNull();
});
