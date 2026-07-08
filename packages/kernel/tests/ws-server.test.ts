import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import type { AgentMessage } from "@hiagent/shared";
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";

function tmp(p: string) { return join(import.meta.dir, p + Math.random().toString(36).slice(2)); }

// 构造 mock AgentManager：ensureStarted 返回带 .messages 的伪 session
// prompt/abort/disposeSession 记录调用，便于断言
function makeMockAgentManager(messages: AgentMessage[] = []) {
  const calls = {
    prompt: [] as Array<{ sessionId: string; text: string }>,
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
    prompt: async (sessionId: string, text: string) => {
      calls.prompt.push({ sessionId, text });
    },
    abort: async (sessionId: string) => {
      calls.abort.push(sessionId);
    },
    getMessages: (sessionId: string) => messages,
    disposeSession: async (sessionId: string) => {
      calls.disposeSession.push(sessionId);
    },
    disposeAll: async () => {},
  } as any;
  return { agentManager, calls };
}

async function withServer<T>(
  agentManager: any,
  fn: (send: (e: WSClientEvent) => void, recv: () => Promise<WSServerEvent>) => Promise<T>,
): Promise<T> {
  const configStore = new ConfigStore(tmp("ws-cfg"));
  const projectStore = new ProjectStore(tmp("ws-proj.json"));
  const server = new WSServer({
    configStore, projectStore,
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
    expect(calls.prompt).toContainEqual({ sessionId: "s-fake", text: "你好" });
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
    // 消费掉后续的 sdk:event（user message_start）等
    while (true) {
      ev = await recv() as any;
      if (ev.type === "sdk:event" && ev.event?.type === "message_start" &&
          ev.event?.message?.role === "user") break;
    }
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

test("agent:prompt 广播用户消息为 sdk:event/message_start", async () => {
  const { agentManager } = makeMockAgentManager();
  await withServer(agentManager, async (send, recv) => {
    send({ type: "project:create", name: "P", cwd: "/p" });
    const created = await recv() as any;
    const projectId = created.project.id;
    send({ type: "agent:prompt", projectId, sessionId: "s-msg", agentName: "dev", text: "hello" });
    // session:created
    let ev = await recv() as any;
    expect(ev.type).toBe("session:created");
    // 下一个应是 sdk:event/message_start（用户消息广播）
    ev = await recv() as any;
    expect(ev.type).toBe("sdk:event");
    expect(ev.event.type).toBe("message_start");
    expect(ev.event.message.role).toBe("user");
    expect(ev.event.message.content).toBe("hello");
    expect(ev.projectId).toBe(projectId);
    expect(ev.sessionId).toBe("s-msg");
    expect(ev.agentName).toBe("dev");
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
