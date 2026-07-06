import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string, kernelProc: any, wsClient: any;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hiagent-e2e-"));
  const agentsDir = join(dir, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, "dev.md"), `---
name: dev
displayName: 研发
avatar: "⚙️"
model: deepseek/deepseek-v4-flash
thinking: off
tools: read
---
简短回答。`);
  kernelProc = spawn("bun", ["run", "packages/kernel/src/index.ts"], {
    cwd: "/Users/pipi/work/HiAgent",
    env: { ...process.env, HIAGENT_AGENTS_DIR: agentsDir, HIAGENT_CWD: dir, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY! },
    stdio: ["pipe", "pipe", "pipe"],
  });
  kernelProc.stderr?.on("data", (d: Buffer) => { /* ignore */ });
  await new Promise(r => setTimeout(r, 2000));
  wsClient = new WebSocket("ws://localhost:9776");
  await new Promise<void>((resolve, reject) => {
    wsClient.onopen = () => resolve();
    setTimeout(() => reject(new Error("WS timeout")), 5000);
  });
}, 15000);

afterAll(async () => { wsClient?.close(); kernelProc?.kill("SIGKILL"); await rm(dir, { recursive: true, force: true }); });

test("完整流程：agents:list → prompt → agent:message", async () => {
  const received: any[] = [];
  wsClient.onmessage = (ev: any) => { try { received.push(JSON.parse(ev.data)); } catch {} };
  wsClient.send(JSON.stringify({ type: "agents:list" }));
  await new Promise(r => setTimeout(r, 500));
  expect(received.some(e => e.type === "agents:list")).toBe(true);
  wsClient.send(JSON.stringify({ type: "agent:prompt", agentName: "dev", message: "只回复 OK" }));
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (received.some(e => e.type === "agent:message")) break;
  }
  const msgs = received.filter(e => e.type === "agent:message");
  expect(msgs.length).toBeGreaterThan(0);
  expect(msgs[msgs.length - 1].message.text).toContain("OK");
}, 30000);
