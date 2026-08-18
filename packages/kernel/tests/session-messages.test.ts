import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { WSServer } from "../src/ws-server";
import type { AgentMessage } from "@wa-pi/shared";

// 测试：点历史会话 → kernel 通过 AgentSession.messages 拉 SDK session 的历史消息
// REST 版本（替代原 WS 版本）
// 回退路径：会话文件存在但损坏（无任何有效行）→ 回退进程路径取 AgentSession.messages
test("[第三层] session:messages 走 AgentSession.messages", async () => {
  const tmp = (s: string) =>
    join(import.meta.dir, ".tmp-sm-" + s + Math.random().toString(36).slice(2));
  const cfgDir = tmp("cfg");
  const projFile = tmp("proj.json");

  const configStore = new ConfigStore(cfgDir);
  const projectStore = new ProjectStore(projFile);
  const providerStore = new ProviderStore(
    join(projFile, "..", "providers.json"),
  );
  const skillManager = new SkillManager(join(projFile, "..", "skills"));

  const project = await projectStore.createProject({ name: "P", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id,
    primaryAgent: "dev",
    title: "历史会话",
  });

  // 写入损坏文件（无有效 JSON 行）触发回退；ENOENT 现在是「历史为空」快速分支，不再回退
  mkdirSync(dirname(session.piSessionFile), { recursive: true });
  writeFileSync(session.piSessionFile, "not-json-at-all\n{broken\n");

  const piHistory: AgentMessage[] = [
    { role: "user", content: "历史问题", timestamp: 1 } as AgentMessage,
    {
      role: "assistant",
      content: [{ type: "text", text: "历史回复" }],
      model: "m",
      stopReason: "stop",
      timestamp: 2,
    } as AgentMessage,
  ];
  const fakeSession = {
    messages: piHistory,
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  };
  const agentManager = {
    ensureStarted: async (_pid: string, _an: string, _sid: string) =>
      fakeSession,
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
    isSessionBusy: (_sid: string) => false,
    isSessionActive: (_sid: string, _pq: boolean) => false,
    isSessionAlive: (_sid: string) => false,
    getThinkingSince: (_sid: string) => null,
  } as any;
  const server = new WSServer({
    configStore,
    projectStore,
    providerStore,
    skillManager,
    extensionManager: new ExtensionManager(join(projFile, "..")),
    memoryStore: null as any,
    mcpStore: null as any,
    agentManager,
    channelManager: null,
    port: 0,
  });
  await server.start();
  const base = `http://127.0.0.1:${server.actualPort}`;

  try {
    // HTTP GET 拉历史消息
    const res = await fetch(
      `${base}/api/sessions/${encodeURIComponent(session.id)}/messages`,
    );
    const msgResp = await res.json();

    expect(res.status).toBe(200);
    expect(msgResp.sessionId).toBe(session.id);
    expect(msgResp.messages).toHaveLength(2);
    expect((msgResp.messages[0].message as any).content).toBe("历史问题");
    expect(msgResp.messages[0].agentName).toBe("dev");
    expect((msgResp.messages[1].message as any).content[0].text).toBe(
      "历史回复",
    );
  } finally {
    await server.stop();
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(projFile, { force: true });
    rmSync(session.piSessionFile, { force: true });
  }
});

test("[第三层] session:messages 会话不存在返回空数组", async () => {
  const tmp = (s: string) =>
    join(
      import.meta.dir,
      ".tmp-sm2-" + s + Math.random().toString(36).slice(2),
    );
  const cfgDir = tmp("cfg");
  const projFile = tmp("proj.json");

  const configStore = new ConfigStore(cfgDir);
  const projectStore = new ProjectStore(projFile);
  const providerStore = new ProviderStore(
    join(projFile, "..", "providers.json"),
  );
  const skillManager = new SkillManager(join(projFile, "..", "skills"));

  const fakeSession = {
    messages: [{ role: "user", content: "x", timestamp: 1 }],
  };
  const agentManager = {
    ensureStarted: async (_pid: string, _an: string, _sid: string) =>
      fakeSession,
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
    isSessionBusy: (_sid: string) => false,
    isSessionActive: (_sid: string, _pq: boolean) => false,
    isSessionAlive: (_sid: string) => false,
    getThinkingSince: (_sid: string) => null,
  } as any;
  const server = new WSServer({
    configStore,
    projectStore,
    providerStore,
    skillManager,
    extensionManager: new ExtensionManager(join(projFile, "..")),
    memoryStore: null as any,
    mcpStore: null as any,
    agentManager,
    channelManager: null,
    port: 0,
  });
  await server.start();
  const base = `http://127.0.0.1:${server.actualPort}`;

  // HTTP GET 拉不存在会话的历史消息
  const res = await fetch(`${base}/api/sessions/nope/messages`);
  const msgResp = await res.json();

  expect(res.status).toBe(200);
  expect(msgResp.sessionId).toBe("nope");
  expect(msgResp.messages).toEqual([]);

  await server.stop();
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(projFile, { force: true });
});

// 快速路径：session.piSessionFile 可读时直接解析文件返回历史，
// 不走 ensureStarted 的进程历史（mock 进程返回不同内容，据此区分走了哪条路径）
test("[第三层] session:messages 文件直读快速路径", async () => {
  const tmp = (s: string) =>
    join(
      import.meta.dir,
      ".tmp-sm3-" + s + Math.random().toString(36).slice(2),
    );
  const cfgDir = tmp("cfg");
  const projFile = tmp("proj.json");

  const configStore = new ConfigStore(cfgDir);
  const projectStore = new ProjectStore(projFile);
  const providerStore = new ProviderStore(
    join(projFile, "..", "providers.json"),
  );
  const skillManager = new SkillManager(join(projFile, "..", "skills"));

  const project = await projectStore.createProject({ name: "P", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id,
    primaryAgent: "dev",
    title: "历史会话",
  });

  // 在会话的 piSessionFile 写入真实 JSONL 历史（与进程返回内容不同，用于区分路径）
  const line = (
    id: string,
    parentId: string | null,
    role: string,
    text: string,
    ts: number,
  ) =>
    JSON.stringify({
      type: "message",
      id,
      parentId,
      message: { role, content: [{ type: "text", text }], timestamp: ts },
    });
  mkdirSync(dirname(session.piSessionFile), { recursive: true });
  writeFileSync(
    session.piSessionFile,
    [
      JSON.stringify({ type: "session", version: 3, id: "uuid-fast-path" }),
      line("m1", null, "user", "文件里的问题", 1),
      line("m2", "m1", "assistant", "文件里的回答", 2),
    ].join("\n"),
  );
  // mock 进程历史：若走了进程路径会返回这两条
  const fakeSession = {
    messages: [
      { role: "user", content: "进程里的问题", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "进程里的回答" }],
        timestamp: 2,
      },
    ],
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  };
  const agentManager = {
    ensureStarted: async (_pid: string, _an: string, _sid: string) =>
      fakeSession,
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
    isSessionBusy: (_sid: string) => false,
    isSessionActive: (_sid: string, _pq: boolean) => false,
    isSessionAlive: (_sid: string) => false,
    getThinkingSince: (_sid: string) => null,
  } as any;
  const server = new WSServer({
    configStore,
    projectStore,
    providerStore,
    skillManager,
    extensionManager: new ExtensionManager(join(projFile, "..")),
    memoryStore: null as any,
    mcpStore: null as any,
    agentManager,
    channelManager: null,
    port: 0,
  });
  await server.start();
  const base = `http://127.0.0.1:${server.actualPort}`;

  try {
    const res = await fetch(
      `${base}/api/sessions/${encodeURIComponent(session.id)}/messages`,
    );
    const msgResp = await res.json();

    expect(res.status).toBe(200);
    expect(msgResp.messages).toHaveLength(2);
    // 断言来自文件而非进程
    expect((msgResp.messages[0].message as any).content[0].text).toBe(
      "文件里的问题",
    );
    expect((msgResp.messages[1].message as any).content[0].text).toBe(
      "文件里的回答",
    );
    expect(msgResp.messages[0].agentName).toBe("dev");
  } finally {
    await server.stop();
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(projFile, { force: true });
    rmSync(session.piSessionFile, { force: true });
  }
});

// ENOENT 快速分支：会话记录存在但 pi 文件未生成（新建会话/从未成功对话）
// → 直接返回空历史，不等进程、不打错误日志；mock 进程返回不同内容，据此区分路径
test("[第三层] session:messages 文件缺失（ENOENT）返回空数组", async () => {
  const tmp = (s: string) =>
    join(
      import.meta.dir,
      ".tmp-sm4-" + s + Math.random().toString(36).slice(2),
    );
  const cfgDir = tmp("cfg");
  const projFile = tmp("proj.json");

  const configStore = new ConfigStore(cfgDir);
  const projectStore = new ProjectStore(projFile);
  const providerStore = new ProviderStore(
    join(projFile, "..", "providers.json"),
  );
  const skillManager = new SkillManager(join(projFile, "..", "skills"));

  const project = await projectStore.createProject({ name: "P", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id,
    primaryAgent: "dev",
    title: "空会话",
  });
  // 故意不写 piSessionFile → ENOENT

  const fakeSession = {
    messages: [{ role: "user", content: "进程里的消息", timestamp: 1 }],
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  };
  const agentManager = {
    ensureStarted: async (_pid: string, _an: string, _sid: string) =>
      fakeSession,
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
    isSessionBusy: (_sid: string) => false,
    isSessionActive: (_sid: string, _pq: boolean) => false,
    isSessionAlive: (_sid: string) => false,
    getThinkingSince: (_sid: string) => null,
  } as any;
  const server = new WSServer({
    configStore,
    projectStore,
    providerStore,
    skillManager,
    extensionManager: new ExtensionManager(join(projFile, "..")),
    memoryStore: null as any,
    mcpStore: null as any,
    agentManager,
    channelManager: null,
    port: 0,
  });
  await server.start();
  const base = `http://127.0.0.1:${server.actualPort}`;

  try {
    const res = await fetch(
      `${base}/api/sessions/${encodeURIComponent(session.id)}/messages`,
    );
    const msgResp = await res.json();

    expect(res.status).toBe(200);
    expect(msgResp.sessionId).toBe(session.id);
    // ENOENT = 历史为空；若走了进程路径会返回 mock 的 1 条消息
    expect(msgResp.messages).toEqual([]);
  } finally {
    await server.stop();
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(projFile, { force: true });
  }
});

test("[第三层] session:messages 会话 busy 时返回 isActive:true", async () => {
  const tmp = (s: string) =>
    join(
      import.meta.dir,
      ".tmp-sm5-" + s + Math.random().toString(36).slice(2),
    );
  const cfgDir = tmp("cfg");
  const projFile = tmp("proj.json");

  const configStore = new ConfigStore(cfgDir);
  const projectStore = new ProjectStore(projFile);
  const providerStore = new ProviderStore(
    join(projFile, "..", "providers.json"),
  );
  const skillManager = new SkillManager(join(projFile, "..", "skills"));

  const project = await projectStore.createProject({ name: "P", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id,
    primaryAgent: "dev",
    title: "进行中",
  });

  const fakeSession = {
    messages: [],
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  };
  const agentManager = {
    ensureStarted: async (_pid: string, _an: string, _sid: string) =>
      fakeSession,
    isSessionBusy: (_sid: string) => true,
    isSessionActive: (_sid: string, _pq: boolean) => true,
    isSessionAlive: (_sid: string) => false,
    getThinkingSince: (_sid: string) => 1720000000000,
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
  } as any;
  const server = new WSServer({
    configStore,
    projectStore,
    providerStore,
    skillManager,
    extensionManager: new ExtensionManager(join(projFile, "..")),
    memoryStore: null as any,
    mcpStore: null as any,
    agentManager,
    channelManager: null,
    port: 0,
  });
  await server.start();
  const base = `http://127.0.0.1:${server.actualPort}`;

  try {
    const res = await fetch(
      `${base}/api/sessions/${encodeURIComponent(session.id)}/messages`,
    );
    const msgResp = await res.json();
    expect(res.status).toBe(200);
    expect(msgResp.isActive).toBe(true);
  } finally {
    await server.stop();
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(projFile, { force: true });
  }
});

test("[第三层] session:messages 的 isActive 传递 _promptLocks 信号（prompt 排队中 true / 空闲 false）", async () => {
  const calls: { sid: string; pq: boolean }[] = [];
  let releaseStart: () => void = () => {};
  const startGate = new Promise<void>((r) => {
    releaseStart = r;
  });
  const agentManager = {
    ensureStarted: async (_p: string, _a: string, _s: string) => {
      await startGate;
      return { messages: [] };
    },
    getCommands: async () => [],
    prompt: async () => {},
    abort: async () => {},
    isSessionBusy: () => false,
    isSessionActive: (sid: string, pq: boolean) => {
      calls.push({ sid, pq });
      return pq;
    },
    isSessionAlive: () => false,
    getThinkingSince: () => null,
    getMessages: () => [],
    disposeSession: async () => {},
    disposeAll: async () => {},
  } as any;
  const server = new WSServer({
    projectStore: {
      load: async () => ({ projects: [], sessions: [] }),
      createSession: async (s: any) => s,
      touchSession: async () => {},
      setSessionAgent: async () => {},
      fillSessionTitleIfEmpty: async () => false,
    },
    configStore: { getAgent: async () => ({ displayName: "dev" }) },
    agentManager,
    channelManager: null,
  } as any);
  (server as any).broadcast = () => {};

  try {
    // 1. 发起 agent:prompt：ensureStarted 挂起 → currentLock 未完成 → _promptLocks 持有该 sessionId
    const promptPromise = server.callApi({
      type: "agent:prompt",
      sessionId: "s1",
      projectId: "p1",
      agentName: "dev",
      model: "m",
      text: "你好",
    } as any);
    await new Promise((r) => setTimeout(r, 20)); // 让 currentLock 进入 ensureStarted、_promptLocks 已 set

    // 2. 冷启动中 + prompt 排队 → GET /messages 应传 promptQueued=true，isActive=true
    const res1 = await server.callApi({
      type: "session:messages",
      sessionId: "s1",
    } as any);
    const body1 = await res1.json();
    expect(body1.isActive).toBe(true);
    expect(calls[calls.length - 1]).toEqual({ sid: "s1", pq: true });

    // 3. 释放冷启动 → agent:prompt 完成 → _promptLocks 删除
    releaseStart();
    await promptPromise;

    // 4. 无 prompt 排队 → GET /messages 应传 promptQueued=false，isActive=false
    const res2 = await server.callApi({
      type: "session:messages",
      sessionId: "s1",
    } as any);
    const body2 = await res2.json();
    expect(body2.isActive).toBe(false);
    expect(calls[calls.length - 1]).toEqual({ sid: "s1", pq: false });
  } finally {
    await server.stop();
  }
});

// scheduler 会话只读回放：session:messages 跳过 touchSession + prewarm
// （定时任务执行存档仅查看，不该拉起 pi 进程，也不刷新 lastActivity 排序）
test("[第三层] session:messages scheduler 会话跳过 touch 与 prewarm", async () => {
  const tmp = (s: string) =>
    join(
      import.meta.dir,
      ".tmp-sm5-" + s + Math.random().toString(36).slice(2),
    );
  const cfgDir = tmp("cfg");
  const projFile = tmp("proj.json");

  const configStore = new ConfigStore(cfgDir);
  const projectStore = new ProjectStore(projFile);
  const providerStore = new ProviderStore(
    join(projFile, "..", "providers.json"),
  );
  const skillManager = new SkillManager(join(projFile, "..", "skills"));

  const project = await projectStore.createProject({ name: "P", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id,
    primaryAgent: "dev",
    title: "定时任务 · 日报",
    source: "scheduler",
  });

  // 写入 JSONL 历史（走文件直读路径即可返回）
  const line = (
    id: string,
    parentId: string | null,
    role: string,
    text: string,
    ts: number,
  ) =>
    JSON.stringify({
      type: "message",
      id,
      parentId,
      message: { role, content: [{ type: "text", text }], timestamp: ts },
    });
  mkdirSync(dirname(session.piSessionFile), { recursive: true });
  writeFileSync(
    session.piSessionFile,
    [
      JSON.stringify({ type: "session", version: 3, id: "uuid-sched" }),
      line("m1", null, "user", "定时任务指令", 1),
      line("m2", "m1", "assistant", "任务执行结果", 2),
    ].join("\n"),
  );

  // 探针：ensureStarted 若被调（prewarm）则记录；touchSession 若被调则记录
  const started: string[] = [];
  const touched: string[] = [];
  const agentManager = {
    ensureStarted: async (_pid: string, _an: string, sid: string) => {
      started.push(sid);
      return {
        messages: [],
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
      };
    },
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
    isSessionBusy: (_sid: string) => false,
    isSessionActive: (_sid: string, _pq: boolean) => false,
    isSessionAlive: (_sid: string) => false,
    getThinkingSince: (_sid: string) => null,
  } as any;
  const server = new WSServer({
    configStore,
    projectStore,
    providerStore,
    skillManager,
    extensionManager: new ExtensionManager(join(projFile, "..")),
    memoryStore: null as any,
    mcpStore: null as any,
    agentManager,
    channelManager: null,
    port: 0,
  });
  // 包装 projectStore.touchSession 探针（server 内部持有同一引用，包装其方法即可）
  const origTouch = projectStore.touchSession.bind(projectStore);
  (projectStore as any).touchSession = async (sid: string) => {
    touched.push(sid);
    return origTouch(sid);
  };
  await server.start();
  const base = `http://127.0.0.1:${server.actualPort}`;

  try {
    const res = await fetch(
      `${base}/api/sessions/${encodeURIComponent(session.id)}/messages`,
    );
    const msgResp = await res.json();

    // 消息正常返回（只读不牺牲功能）
    expect(res.status).toBe(200);
    expect(msgResp.messages).toHaveLength(2);
    expect((msgResp.messages[0].message as any).content[0].text).toBe(
      "定时任务指令",
    );

    // 关键断言：不 touch、不 prewarm
    expect(touched).toEqual([]);
    expect(started).toEqual([]);

    // 新规则：普通会话查看同样不再 touch（点击查看不更新 lastActivity，
    // 只有发送消息 agent:prompt / 收到回复 message_end 才更新）
    const session2 = await projectStore.createSession({
      projectId: project.id,
      primaryAgent: "dev",
      title: "普通会话",
    });
    mkdirSync(dirname(session2.piSessionFile), { recursive: true });
    writeFileSync(
      session2.piSessionFile,
      [
        JSON.stringify({ type: "session", version: 3, id: "uuid-normal" }),
        line("m1", null, "user", "普通问题", 1),
      ].join("\n"),
    );
    await fetch(
      `${base}/api/sessions/${encodeURIComponent(session2.id)}/messages`,
    );
    expect(touched).toEqual([]);
  } finally {
    await server.stop();
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(projFile, { force: true });
  }
});
