/**
 * agent:prompt 队列化测试
 *
 * 根因（session s-e34af47e 日志确证）：agent:prompt 的 handle 把 ensureStarted 和
 * am.prompt() 都包在 _promptLocks 锁内。空闲时 session.prompt() 会 await 整个 agent
 * turn。第二条消息"2"的 handle 等到"1"的 turn 完全结束才执行——此时 isStreaming=false，
 * "2"走直发而非 followUp 入队。用户在前端看到"1还在回复中"时发"2"并点引导，steer:promote
 * 把"2"入 steering，但 kernel 那边"2"是直发的——重复发送。
 *
 * 修复：_promptLocks 只覆盖 ensureStarted（防并发建会话），am.prompt() 在锁外且不 await
 * turn（fire-and-forget + catch），让后续消息在 turn 进行中到达时正确走 followUp 入队。
 */
import { test, expect, beforeEach } from "bun:test";
import { WSServer } from "../src/ws-server";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { askRegistry } from "../src/ask-registry";
import type { WSClientEvent } from "@hiagent/shared";
import { join } from "node:path";

beforeEach(() => askRegistry.reset());
function tmp(p: string) { return join(import.meta.dir, p + Math.random().toString(36).slice(2)); }

async function withServer<T>(
  agentManager: any,
  fn: (send: (e: WSClientEvent) => void) => Promise<T>,
): Promise<T> {
  const configStore = new ConfigStore(tmp("plock-cfg"));
  const projectStore = new ProjectStore(tmp("plock-proj.json"));
  const dataDir = tmp("plock-dir");
  // 预置 agent 配置，避免 agent_missing 拦截
  await configStore.createAgent("dev");
  const server = new WSServer({
    configStore, projectStore,
    providerStore: new ProviderStore(tmp("plock-prov.json")),
    skillManager: new SkillManager(tmp("plock-skill")),
    extensionManager: new ExtensionManager(dataDir),
    memoryStore: null as any,
    mcpStore: null as any,
    dataDir,
    agentManager,
    port: 0,
  });
  await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${server.actualPort}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = () => {};
  const send = (e: WSClientEvent) => ws.send(JSON.stringify(e));
  try { return await fn(send); }
  finally { ws.close(); await server.stop(); }
}

test("第二条 agent:prompt 不应等到第一条 turn 完成才执行（否则 isStreaming=false 误走直发）", async () => {
  // gate 控制第一条 prompt（模拟 agent turn 进行中，isStreaming=true）
  let releaseTurn: () => void = () => {};
  const turnGate = new Promise<void>(r => { releaseTurn = r; });

  const callLog: string[] = [];
  const agentManager = {
    ensureStarted: async () => {
      callLog.push("ensureStarted");
      return { messages: [] };
    },
    // prompt 模拟真实场景：第一条启动 turn 并阻塞（isStreaming=true），第二条不应等到它完成
    prompt: async (_sid: string, text: string) => {
      callLog.push(`prompt:${text}`);
      if (text === "1") {
        // 第一条模拟 agent turn 进行中：阻塞直到外部释放
        await turnGate;
      }
    },
    isSessionStreaming: () => false,
    disposeAll: async () => {},
  } as any;

  await withServer(agentManager, async (send) => {
    // 第一条 agent:prompt —— 启动 turn，阻塞在 gate 上
    send({ type: "agent:prompt", sessionId: "s1", projectId: "p1", agentName: "dev", text: "1", model: "test-model" } as any);
    // 确保 prompt:"1" 开始执行（进入 turn gate）
    await new Promise<void>(r => setTimeout(r, 150));

    // 此时"1"的 turn 正在进行中（prompt:"1" 在 await turnGate）
    // 用户发"2"——前端认为运行中，应入队 followUp
    send({ type: "agent:prompt", sessionId: "s1", projectId: "p1", agentName: "dev", text: "2", model: "test-model" } as any);
    await new Promise<void>(r => setTimeout(r, 150));

    // 断言：prompt:"2" 应该已经执行了，不等"1"的 turn 完成
    expect(callLog).toContain("prompt:2");

    // 释放第一条的 turn
    releaseTurn();
    await new Promise<void>(r => setTimeout(r, 150));
  });

  expect(callLog).toContain("prompt:1");
  expect(callLog).toContain("prompt:2");
});
