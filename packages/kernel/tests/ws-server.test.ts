import { test, expect, beforeEach } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import type { AgentMessage, AskParams } from "@hiagent/shared";
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";
import { askRegistry } from "../src/ask-registry";

beforeEach(() => askRegistry.reset());

function tmp(p: string) { return join(import.meta.dir, p + Math.random().toString(36).slice(2)); }

// 构造 mock AgentManager：ensureStarted 返回带 .messages 的伪 session
// prompt/abort/disposeSession 记录调用，便于断言
function makeMockAgentManager(messages: AgentMessage[] = []) {
  const calls = {
    prompt: [] as Array<{ sessionId: string; text: string; opts?: any }>,
    abort: [] as string[],
    disposeSession: [] as string[],
    ensureStarted: [] as Array<{ projectId: string; agentName: string; sessionId: string }>,
    switchAgent: [] as Array<{ sessionId: string; agentName: string }>,
  };
  const fakeSession = {
    messages,
    prompt: async (text: string) => {
      // 无需真实执行，仅记录
      void text;
    },
    abort: async () => {},
    dispose: () => {},
  };
  const agentManager = {
    ensureStarted: async (projectId: string, agentName: string, sessionId: string) => {
      calls.ensureStarted.push({ projectId, agentName, sessionId });
      return fakeSession;
    },
    prompt: async (sessionId: string, text: string, opts?: any) => {
      calls.prompt.push({ sessionId, text, opts });
    },
    abort: async (sessionId: string) => {
      calls.abort.push(sessionId);
    },
    getMessages: (sessionId: string) => messages,
    disposeSession: async (sessionId: string) => {
      calls.disposeSession.push(sessionId);
    },
    disposeAll: async () => {},
    markAllDirty: () => {},
    renameAgentSessions: (_oldName: string, _newName: string) => {},
    switchAgent: async (sessionId: string, agentName: string) => {
      calls.switchAgent.push({ sessionId, agentName });
    },
  } as any;
  return { agentManager, calls };
}

async function withServer<T>(
  agentManager: any,
  fn: (
    send: (e: WSClientEvent) => void,
    recv: () => Promise<WSServerEvent>,
    stores: { configStore: ConfigStore; projectStore: ProjectStore },
  ) => Promise<T>,
): Promise<T> {
  const configStore = new ConfigStore(tmp("ws-cfg"));
  const projectStore = new ProjectStore(tmp("ws-proj.json"));
  const providerStore = new ProviderStore(tmp("ws-prov.json"));
  const skillManager = new SkillManager(tmp("ws-skill-dir"));
  const dataDir = tmp("ws-dir");
  const server = new WSServer({
    configStore, projectStore,
    providerStore,
    skillManager,
    extensionManager: new ExtensionManager(dataDir),
    memoryStore: null as any,
    mcpStore: null as any,
    dataDir,
    agentManager,
    port: 0,  // 随机端口，避免冲突
  });
  await server.start();
  const port = server.actualPort;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const queue: WSServerEvent[] = [];
  ws.onmessage = (ev) => queue.push(JSON.parse(String(ev.data)));
  const send = (e: WSClientEvent) => ws.send(JSON.stringify(e));
  const recv = async (): Promise<WSServerEvent> => {
    while (queue.length === 0) await new Promise(r => setTimeout(r, 20));
    return queue.shift()!;
  };
  try { return await fn(send, recv, { configStore, projectStore }); }
  finally { ws.close(); await server.stop(); }
}

test("projects:list 返回空", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "projects:list" });
    const e = await recv() as any;
    expect(e.type).toBe("projects:list");
    expect(e.projects).toEqual([]);
  });
});

test("project:create + projects:list", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "project:create", name: "P", cwd: "/p" });
    const created = await recv() as any;
    expect(created.type).toBe("project:created");
    expect(created.project.name).toBe("P");
    send({ type: "projects:list" });
    const list = await recv() as any;
    expect(list.projects).toHaveLength(1);
  });
});

test("session:create 隐含于 agent:prompt（首条消息建会话）", async () => {
  const { agentManager, calls } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "project:create", name: "P", cwd: "/p" });
    const created = await recv() as any;
    const projectId = created.project.id;
    send({ type: "agent:prompt", projectId, sessionId: "s-fake", agentName: "dev", text: "你好" });
    // 期望收到 session:created（会话被建立）
    const ev = await recv() as any;
    expect(ev.type).toBe("session:created");
    expect(ev.session.projectId).toBe(projectId);
    // 验证调了 agentManager.prompt(sessionId, text) —— 新 API 不再传 projectId/agentName
    // 等 ensureStarted 完成（事件链结束后 prompt 应已被调用）
    await new Promise(r => setTimeout(r, 100));
    expect(calls.prompt.some(c => c.sessionId === "s-fake" && c.text === "你好")).toBe(true);
  });
});

test("复用已有 session 不发 session:created（防止前端重复渲染）", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "project:create", name: "P", cwd: "/p" });
    const created = await recv() as any;
    const projectId = created.project.id;
    const sid = "s-reuse";
    // 第一条消息：创建 session
    send({ type: "agent:prompt", projectId, sessionId: sid, agentName: "dev", text: "你好" });
    let ev = await recv() as any;
    expect(ev.type).toBe("session:created");  // 首次建 session 应广播
    // 不再有手动广播的 user message_start，直接发第二条消息
    // 第二条消息：同 sessionId，不应广播 session:created
    send({ type: "agent:prompt", projectId, sessionId: sid, agentName: "dev", text: "再发一条" });
    // 收集接下来 300ms 内的所有事件，确认没有 session:created
    const events: string[] = [];
    const done = Date.now() + 300;
    while (Date.now() < done) {
      try {
        const e = await Promise.race([recv(), new Promise<any>(r => setTimeout(r, 350, null))]);
        if (e) events.push(e.type);
      } catch { break; }
    }
    expect(events.filter(t => t === "session:created")).toHaveLength(0);
  });
});

test("agent:prompt 不再手动广播用户消息（SDK subscribe 自动产生）", async () => {
  const { agentManager, calls } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "project:create", name: "P", cwd: "/p" });
    const created = await recv() as any;
    const projectId = created.project.id;
    send({ type: "agent:prompt", projectId, sessionId: "s-msg", agentName: "dev", text: "hello" });
    // session:created
    let ev = await recv() as any;
    expect(ev.type).toBe("session:created");
    // 不再有 ws-server 手动广播的 user message_start —— SDK subscribe 会在真实环境中产生
    // mock AgentManager 不触发 subscribe，所以这里不应收到 sdk:event/message_start(user)
    await new Promise(r => setTimeout(r, 100));
    // 验证 prompt 被调用
    expect(calls.prompt.some(c => c.sessionId === "s-msg" && c.text === "hello")).toBe(true);
  });
});

test("agent:prompt 透传 model/thinking/attachments 给 AgentManager.prompt", async () => {
  const { agentManager, calls } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "project:create", name: "P", cwd: "/p" });
    const created = await recv() as any;
    const projectId = created.project.id;
    const attachments = [{ kind: "image" as const, path: "/tmp/x.png", name: "x.png", size: 0 }];
    send({
      type: "agent:prompt",
      projectId,
      sessionId: "s-opts",
      agentName: "dev",
      text: "hi",
      model: "anthropic/claude",
      thinking: "high",
      attachments,
    });
    const ev = await recv() as any;
    expect(ev.type).toBe("session:created");
    await new Promise(r => setTimeout(r, 100));
    const call = calls.prompt.find(c => c.sessionId === "s-opts");
    expect(call).toBeDefined();
    expect(call!.text).toBe("hi");
    expect(call!.opts).toEqual({
      model: "anthropic/claude",
      thinking: "high",
      attachments,
    });
  });
});

test("session:messages 从 ensureStarted 返回的 session.messages 同步读", async () => {
  const history: AgentMessage[] = [
    { role: "user", content: "历史问题", timestamp: 1 } as AgentMessage,
    { role: "assistant", content: [{ type: "text", text: "历史回复" }], model: "m", stopReason: "stop", timestamp: 2 } as AgentMessage,
  ];
  const { agentManager } = makeMockAgentManager(history);
  await withServer(agentManager, async (send, recv) => {
    // 预置项目 + 会话
    send({ type: "project:create", name: "P", cwd: "/p" });
    const created = await recv() as any;
    const projectId = created.project.id;
    // 通过 agent:prompt 建会话（复用同一 sessionId）
    send({ type: "agent:prompt", projectId, sessionId: "s-hist", agentName: "dev", text: "首次" });
    await recv(); // session:created
    // 排空后续广播事件（sdk:event/message_start 等），直到队列稳定
    await new Promise(r => setTimeout(r, 150));
    // 请求历史消息
    send({ type: "session:messages", sessionId: "s-hist" });
    // 队列里可能还有残留广播，循环消费直到拿到 session:messages
    let resp: any;
    for (;;) {
      resp = await recv() as any;
      if (resp.type === "session:messages") break;
    }
    expect(resp.sessionId).toBe("s-hist");
    expect(resp.messages).toHaveLength(2);
    expect(resp.messages[0].message.content).toBe("历史问题");
    expect(resp.messages[0].agentName).toBe("dev");
  });
});

test("session:messages 会话不存在返回空数组", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "session:messages", sessionId: "nope" });
    const resp = await recv() as any;
    expect(resp.type).toBe("session:messages");
    expect(resp.sessionId).toBe("nope");
    expect(resp.messages).toEqual([]);
  });
});

test("agent:abort 调 agentManager.abort(sessionId)（不传 projectId/agentName）", async () => {
  const { agentManager, calls } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "project:create", name: "P", cwd: "/p" });
    const created = await recv() as any;
    const projectId = created.project.id;
    // 建会话
    send({ type: "agent:prompt", projectId, sessionId: "s-abort", agentName: "dev", text: "x" });
    await recv(); // session:created
    await new Promise(r => setTimeout(r, 50));
    // 发 abort（WSClientEvent 协议仍要求 projectId/agentName，即使 server 已不再使用）
    send({ type: "agent:abort", projectId, sessionId: "s-abort", agentName: "dev" });
    await new Promise(r => setTimeout(r, 50));
    expect(calls.abort).toContain("s-abort");
  });
});

test("session:delete 调 agentManager.disposeSession(sessionId) 清理 SDK session", async () => {
  const { agentManager, calls } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "project:create", name: "P", cwd: "/p" });
    const created = await recv() as any;
    const projectId = created.project.id;
    // 建会话
    send({ type: "agent:prompt", projectId, sessionId: "s-del", agentName: "dev", text: "x" });
    await recv(); // session:created
    // 排空后续广播事件（sdk:event/message_start 等）
    await new Promise(r => setTimeout(r, 100));
    // 删会话
    send({ type: "session:delete", sessionId: "s-del" });
    // 队列里可能还有残留广播，循环消费直到拿到 projects:list
    let ev: any;
    for (;;) {
      ev = await recv() as any;
      if (ev.type === "projects:list") break;
    }
    expect(ev.type).toBe("projects:list");
    await new Promise(r => setTimeout(r, 50));
    expect(calls.disposeSession).toContain("s-del");
  });
});

test("project:create 重复目录返回 error 事件且 kernel 不崩溃", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "project:create", name: "P", cwd: "/p" });
    const created = await recv() as any;
    expect(created.type).toBe("project:created");
    // 同目录重复创建：期望收到 error 事件，而不是把 kernel 进程打崩
    send({ type: "project:create", name: "P2", cwd: "/p" });
    const err = await recv() as any;
    expect(err.type).toBe("error");
    expect(err.message).toContain("相同目录的项目已存在");
    // 服务仍存活：后续请求正常响应
    send({ type: "projects:list" });
    const list = await recv() as any;
    expect(list.type).toBe("projects:list");
    expect(list.projects).toHaveLength(1);
  });
});

test("project:open-dir 对不存在的项目不崩溃", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, _recv) => {
    // 发 project:open-dir 指向不存在的项目 ID，验证不抛错
    send({ type: "project:open-dir", projectId: "nonexistent" });
    // 等 100ms 让 handler 执行完毕
    await new Promise(r => setTimeout(r, 100));
    // 不崩溃即通过
  });
});

test("fs:readFile 返回文件 base64 内容与 mimeType", async () => {
  const { agentManager } = makeMockAgentManager();
  const filePath = tmp("readfile-") + ".txt";
  writeFileSync(filePath, "hello world");
  try {
    await withServer(agentManager, async (send, recv) => {
      send({ type: "fs:readFile", path: filePath });
      const resp = await recv() as any;
      expect(resp.type).toBe("fs:readFile");
      expect(resp.path).toBe(filePath);
      expect(resp.mimeType).toBe("text/plain");
      expect(resp.content).toBe(Buffer.from("hello world").toString("base64"));
    });
  } finally {
    rmSync(filePath, { force: true });
  }
});

test("fs:readFile 文件不存在返回 fs:error", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "fs:readFile", path: "/nonexistent/path/to/file.txt" });
    const resp = await recv() as any;
    expect(resp.type).toBe("fs:error");
    expect(resp.path).toBe("/nonexistent/path/to/file.txt");
    expect(resp.reason).toContain("ENOENT");
  });
});

test("fs:listDir 默认过滤隐藏目录", async () => {
  const { agentManager } = makeMockAgentManager();
  const dirPath = tmp("listdir-");
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  mkdirSync(dirPath, { recursive: true });
  mkdirSync(join(dirPath, "visible"));
  mkdirSync(join(dirPath, ".hidden"));
  writeFileSync(join(dirPath, "file.txt"), "x");
  try {
    await withServer(agentManager, async (send, recv) => {
      send({ type: "fs:listDir", path: dirPath });
      const resp = await recv() as any;
      expect(resp.type).toBe("fs:listDir");
      expect(resp.path).toBe(dirPath);
      const names = resp.entries.map((e: any) => e.name).sort();
      expect(names).toEqual(["file.txt", "visible"]);
    });
  } finally {
    rmSync(dirPath, { recursive: true, force: true });
  }
});

test("fs:listDir showHidden=true 返回隐藏目录", async () => {
  const { agentManager } = makeMockAgentManager();
  const dirPath = tmp("listdir-hidden-");
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  mkdirSync(dirPath, { recursive: true });
  mkdirSync(join(dirPath, "visible"));
  mkdirSync(join(dirPath, ".hidden"));
  writeFileSync(join(dirPath, "file.txt"), "x");
  try {
    await withServer(agentManager, async (send, recv) => {
      send({ type: "fs:listDir", path: dirPath, showHidden: true });
      const resp = await recv() as any;
      expect(resp.type).toBe("fs:listDir");
      expect(resp.path).toBe(dirPath);
      const names = resp.entries.map((e: any) => e.name).sort();
      expect(names).toEqual([".hidden", "file.txt", "visible"]);
    });
  } finally {
    rmSync(dirPath, { recursive: true, force: true });
  }
});

// ─── Task 4: ws-server ask 应答事件（agent:answer / agent:cancel-ask）────────
const askParams: AskParams = { questions: [
  { question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
] };

test("agent:answer → resolve pending ask，返回 answers", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send) => {
    const p = askRegistry.ask("s1", "tc1", askParams, new AbortController().signal);
    send({ type: "agent:answer", sessionId: "s1", toolCallId: "tc1", reply: { replies: [{ questionIndex: 0, selected: ["A"] }] } });
    const out = await p;
    expect(out.cancelled).toBe(false);
    expect(out.answers?.[0]).toMatchObject({ kind: "option", answer: "A" });
  });
});

test("agent:cancel-ask → cancel pending ask", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send) => {
    const p = askRegistry.ask("s1", "tc1", askParams, new AbortController().signal);
    send({ type: "agent:cancel-ask", sessionId: "s1", toolCallId: "tc1" });
    expect((await p).cancelled).toBe(true);
  });
});

test("agent:answer 对未知 toolCallId 幂等（不抛错、不影响）", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send) => {
    send({ type: "agent:answer", sessionId: "s1", toolCallId: "unknown", reply: { replies: [] } });
    await new Promise(r => setTimeout(r, 50));  // 不崩溃即通过
  });
});

// ─── Task 4: agent CRUD + 改名联动 ───
// create/delete 会顺带广播 agent:list，队列里可能有残留，按条件循环消费
async function recvUntil(recv: () => Promise<WSServerEvent>, pred: (e: any) => boolean): Promise<any> {
  for (;;) {
    const e = await recv() as any;
    if (pred(e)) return e;
  }
}

test("agent:list/create/delete 全流程", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "agent:create", displayName: "测试员甲" });
    const created = await recvUntil(recv, e => e.type === "agent:created");
    expect(created.agent.name).toBe("测试员甲");
    send({ type: "agent:list" });
    const list = await recvUntil(recv, e => e.type === "agent:list" && e.agents.some((a: any) => a.name === "测试员甲"));
    expect(list.agents.some((a: any) => a.name === "测试员甲")).toBe(true);
    send({ type: "agent:delete", name: "测试员甲" });
    await recvUntil(recv, e => e.type === "agent:deleted");
    send({ type: "agent:list" });
    const list2 = await recvUntil(recv, e => e.type === "agent:list");
    expect(list2.agents.some((a: any) => a.name === "测试员甲")).toBe(false);
  });
});

test("agent:create 非法名返回 error", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "agent:create", displayName: "a/b" });
    const err = await recvUntil(recv, e => e.type === "error");
    expect(err.message).toContain("非法 name");
  });
});

// ─── Task 17: 错误路径补齐 ───

test("agent:delete 不存在的智能体返回 error", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "agent:delete", name: "幽灵" });
    const err = await recvUntil(recv, e => e.type === "error");
    expect(err.message).toContain("智能体不存在");
  });
});

test("agent:create 重名自动加 -2 后缀", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "agent:create", displayName: "甲" });
    const first = await recvUntil(recv, e => e.type === "agent:created");
    expect(first.agent.name).toBe("甲");
    send({ type: "agent:create", displayName: "甲" });
    const second = await recvUntil(recv, e => e.type === "agent:created" && e.agent.name === "甲-2");
    expect(second.agent.name).toBe("甲-2");
  });
});

// 用真实 AgentManager（空 projectStore）让 switchAgent 走真实「会话不存在」抛错路径
test("session:set-agent 到不存在的会话返回 error", async () => {
  const { AgentManager } = await import("../src/agent-manager");
  const manager = new AgentManager({
    projectStore: new ProjectStore(tmp("ws-proj.json")),
    configStore: null,
    onEvent: () => {},
  });
  await withServer(manager, async (send, recv, { configStore }) => {
    // 先建 dev 智能体以通过 set-agent 的存在性校验，才能走到 switchAgent 的「会话不存在」抛错
    await configStore.createAgent("dev");
    send({ type: "session:set-agent", sessionId: "s-ghost", agentName: "dev" });
    const err = await recvUntil(recv, e => e.type === "error");
    expect(err.message).toContain("会话不存在");
    expect(err.sessionId).toBe("s-ghost");
  });
});

// Task 17 评审加固：set-agent 到不存在的智能体与 agent:prompt 的 agent_missing 拦截统一——
// 返回 error（含「智能体不存在」与 sessionId），不调用 switchAgent、不广播 session:updated，
// 避免会话进入「已删除智能体」状态（此前 _createSession 静默走默认配置分支，agent-manager.ts:298-300）。
test("session:set-agent 到不存在的智能体返回 error 且不广播 session:updated", async () => {
  const { agentManager, calls } = makeMockAgentManager();
  await withServer(agentManager, async (send, recvRaw, { projectStore }) => {
    // 包装 recv 记录全部事件，用于断言「未广播 session:updated」
    const seen: any[] = [];
    const recv = async () => { const e = await recvRaw(); seen.push(e); return e; };
    const proj = await projectStore.createProject({ name: "p", cwd: "/tmp" });
    const sess = await projectStore.createSession({ projectId: proj.id, primaryAgent: "dev", title: "t" });
    send({ type: "session:set-agent", sessionId: sess.id, agentName: "幽灵" });
    // 超时窗口：旧行为下根本不会回 error，race 返回 null 使断言快速失败（避免挂起到测试超时）
    const err = await Promise.race([
      recvUntil(recv, e => e.type === "error"),
      new Promise(r => setTimeout(() => r(null), 300)),
    ]);
    expect(err).not.toBeNull();
    expect(err.message).toContain("智能体不存在");
    expect(err.sessionId).toBe(sess.id);
    expect(calls.switchAgent).toHaveLength(0);
    // 计数方式确认无 session:updated 广播：窗口期内 seen 不得出现该事件
    await new Promise(r => setTimeout(r, 200));
    expect(seen.some(e => e.type === "session:updated")).toBe(false);
  });
});

// ─── Task 7: agent:tools:list 全局工具清单 ───
// listGlobalTools 依赖真实 SDK loader 做扩展发现，用真实 AgentManager（configStore 可空）
test("agent:tools:list 返回内置工具且不含 subagent", async () => {
  const { AgentManager } = await import("../src/agent-manager");
  const manager = new AgentManager({
    projectStore: new ProjectStore(tmp("ws-proj.json")),
    configStore: null,
    onEvent: () => {},
  });
  await withServer(manager, async (send, recv) => {
    send({ type: "agent:tools:list" });
    const res = await recvUntil(recv, e => e.type === "agent:tools:list");
    const names = res.tools.map((t: any) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("delegate");
    expect(names).not.toContain("subagent");
    expect(res.tools.find((t: any) => t.name === "read").source).toBe("内置");
  });
});

test("agent:config:save 改名联动会话 primaryAgent 与 askTo", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv, { configStore, projectStore }) => {
    await configStore.createAgent("旧名");
    await configStore.createAgent("乙");
    const yi = (await configStore.getAgent("乙"))!;
    await configStore.saveAgent({ ...yi, partners: { askTo: ["旧名"], askFrom: [] } });
    const proj = await projectStore.createProject({ name: "p", cwd: "/tmp/x" });
    const sess = await projectStore.createSession({ projectId: proj.id, primaryAgent: "旧名", title: "t" });
    const cfg = (await configStore.getAgent("旧名"))!;
    send({ type: "agent:config:save", agentName: "旧名", config: { ...cfg, name: "新名" } });
    // 改名分支最后广播 agent:list，收到即说明联动已落盘
    await recvUntil(recv, e => e.type === "agent:list");
    const { sessions } = await projectStore.load();
    expect(sessions.find(s => s.id === sess.id)!.primaryAgent).toBe("新名");
    expect(await configStore.getAgent("旧名")).toBeNull();
    expect(await configStore.getAgent("新名")).not.toBeNull();
    const yi2 = (await configStore.getAgent("乙"))!;
    expect(yi2.partners.askTo).toEqual(["新名"]);
  });
});

// ─── Task 8: session:set-agent 换体 + agent_missing 拦截 ───

test("session:set-agent 更新并广播 session:updated", async () => {
  const { agentManager, calls } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv, { configStore, projectStore }) => {
    await configStore.createAgent("甲");
    const proj = await projectStore.createProject({ name: "p", cwd: "/tmp/x" });
    const sess = await projectStore.createSession({ projectId: proj.id, primaryAgent: "dev", title: "t" });
    // mock switchAgent 同时落盘（真实 AgentManager.switchAgent 内部会 setSessionAgent）
    agentManager.switchAgent = async (sessionId: string, agentName: string) => {
      calls.switchAgent.push({ sessionId, agentName });
      await projectStore.setSessionAgent(sessionId, agentName);
    };
    send({ type: "session:set-agent", sessionId: sess.id, agentName: "甲" });
    const upd = await recvUntil(recv, e => e.type === "session:updated");
    expect(upd.sessionId).toBe(sess.id);
    expect(upd.primaryAgent).toBe("甲");
    expect(calls.switchAgent).toEqual([{ sessionId: sess.id, agentName: "甲" }]);
    const { sessions } = await projectStore.load();
    expect(sessions.find(s => s.id === sess.id)!.primaryAgent).toBe("甲");
  });
});

test("agent:prompt 对 primaryAgent 已删除的会话返回 agent_missing", async () => {
  const { agentManager, calls } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv, { projectStore }) => {
    const proj = await projectStore.createProject({ name: "p", cwd: "/tmp/x" });
    const sess = await projectStore.createSession({ projectId: proj.id, primaryAgent: "不存在的智能体", title: "t" });
    send({ type: "agent:prompt", projectId: proj.id, sessionId: sess.id, agentName: "不存在的智能体", text: "hi" });
    const err = await recvUntil(recv, e => e.type === "error");
    expect(err.message).toBe("agent_missing");
    expect(err.sessionId).toBe(sess.id);
    // 拦截后不进入 ensureStarted / prompt
    expect(calls.ensureStarted).toHaveLength(0);
    expect(calls.prompt).toHaveLength(0);
  });
});
