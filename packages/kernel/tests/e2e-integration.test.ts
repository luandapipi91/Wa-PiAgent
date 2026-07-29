import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { AgentManager } from "../src/agent-manager";
import { WSServer } from "../src/ws-server";
import { FakeSessionClient, fakeClientFactory } from "./fixtures/fake-session-client";
import { WA_PI_DIR } from "@wa-pi/shared";

// 第三层集成测试：HTTP REST + SSE（替代原 WS）+ FakeSessionClient（假 pi rpc client）
// 覆盖「建项目 → 发首条消息 → kernel 自动建会话 → SSE 广播 session:created → prompt 到达 client」全链路
test("[第三层] 建项目→发消息→自动建会话", async () => {
  const tmp = (s: string) => join(import.meta.dir, ".tmp-e2e-" + s + Math.random().toString(36).slice(2));
  const cfgDir = tmp("cfg");
  const projFile = tmp("proj.json");

  const configStore = new ConfigStore(cfgDir);
  const projectStore = new ProjectStore(projFile);
  const providerStore = new ProviderStore(join(projFile, "..", "providers.json"));
  const skillManager = new SkillManager(join(projFile, "..", "skills"));

  const fakes: FakeSessionClient[] = [];
  const agentManager = new AgentManager({
    projectStore,
    configStore,
    onEvent: () => {},
    createClientFn: fakeClientFactory(fakes),
  });

  const server = new WSServer({
    configStore, projectStore, providerStore, skillManager,
    extensionManager: new ExtensionManager(join(projFile, "..")),
    memoryStore: null as any,
    mcpStore: null as any,
    agentManager,
    port: 0,
  });
  await server.start();
  const base = `http://127.0.0.1:${server.actualPort}`;

  // SSE 流用于接收广播事件
  const sseRes = await fetch(`${base}/api/events`);
  if (!sseRes.ok || !sseRes.body) throw new Error("SSE 连接失败");
  const reader = sseRes.body.getReader();
  const dec = new TextDecoder();
  let sseBuf = "";
  const sseEvents: any[] = [];
  async function readNextSse() {
    while (sseEvents.length === 0) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += dec.decode(value, { stream: true });
      for (;;) {
        const idx = sseBuf.indexOf("\n\n");
        if (idx < 0) break;
        const frame = sseBuf.slice(0, idx);
        sseBuf = sseBuf.slice(idx + 2);
        if (frame.startsWith(":")) continue;
        const data = JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? "null");
        sseEvents.push(data);
      }
    }
    return sseEvents.shift();
  }

  try {
    // 1. 建项目
    const projRes = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "测试项目", cwd: "/tmp" }),
    });
    const createdBody = await projRes.json();
    // SSE 也应广播 project:created
    const sseCreated = await readNextSse();
    expect(sseCreated.type).toBe("project:created");
    expect(sseCreated.project.name).toBe("测试项目");
    const projectId = sseCreated.project.id;

    // 2. 发首条消息 → kernel 自动建会话
    const promptRes = await fetch(`${base}/api/agents/${encodeURIComponent(projectId)}/req-nonexistent/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentName: "dev",
        text: "你好世界",
        model: "test-provider/test-model",
      }),
    });
    const promptBody = await promptRes.json();
    // SSE 广播 session:created
    const sessionCreated = await readNextSse();
    expect(sessionCreated.type).toBe("session:created");
    expect(sessionCreated.session.projectId).toBe(projectId);
    expect(sessionCreated.session.primaryAgent).toBe("dev");
    expect(sessionCreated.session.title).toBe("你好世界");

    // 3. prompt 经 AgentManager 到达假 client
    const deadline = Date.now() + 3000;
    while (fakes.flatMap(f => f.prompted).length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }
    expect(fakes).toHaveLength(1);
    expect(fakes[0].prompted).toEqual(["你好世界"]);
  } finally {
    reader.cancel().catch(() => {});
    await server.stop();
    await agentManager.disposeAll().catch(() => {});
    try { rmSync(join(WA_PI_DIR, "tmp", "sysprompts", "req-nonexistent.md"), { force: true }); } catch {}
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(projFile, { force: true });
  }
});
