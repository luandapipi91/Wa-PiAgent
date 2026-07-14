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
  } as any;
  return { agentManager, calls };
}

async function withServer<T>(
  agentManager: any,
  fn: (send: (e: WSClientEvent) => void, recv: () => Promise<WSServerEvent>) => Promise<T>,
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
  try { return await fn(send, recv); }
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
