import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { rmSync } from "node:fs";
import { join } from "node:path";

// mock 子进程：EventEmitter 原生 on/emit。
// 关键：响应 client.start() 发的 get_state 握手，让 onEvent 收到 state 事件。
function mockSpawn() {
  const stdout = new EventEmitter();
  const child = {
    stdin: {
      write: (s: string) => {
        let obj: any;
        try { obj = JSON.parse(s.trim()); } catch { return; }
        // 模拟 pi 收到 get_state 后回 state_change
        if (obj.type === "get_state") {
          stdout.emit("data", Buffer.from(JSON.stringify({
            type: "state_change",
            state: { status: "idle" },
          }) + "\n"));
        }
      },
      end: () => {},
    },
    stdout,  // EventEmitter 自带 on/emit
    stderr: new EventEmitter(),
    killed: false,
    kill: () => { child.killed = true; },
  };
  return child as any;
}

function tempProjectFile() {
  return join(import.meta.dir, ".tmp-am-" + Math.random().toString(36).slice(2) + ".json");
}

test("ensureStarted 用 projectId+agentName 双 key", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/work" });
  const am = new AgentManager({ projectStore: ps, onEvent: () => {}, spawnFn: mockSpawn });
  const c1 = await am.ensureStarted(p.id, "dev");
  const c2 = await am.ensureStarted(p.id, "dev");
  expect(c1).toBe(c2);  // 同 key 复用
  const events: [string, string][] = [];
  const am2 = new AgentManager({
    projectStore: ps,
    onEvent: (key, e) => events.push([key, e.kind]),
    spawnFn: mockSpawn,
  });
  await am2.ensureStarted(p.id, "product");
  await am.disposeAll();
  await am2.disposeAll();
  rmSync(f, { force: true });
});

test("不同 projectId 是独立进程", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p1 = await ps.createProject({ name: "A", cwd: "/a" });
  const p2 = await ps.createProject({ name: "B", cwd: "/b" });
  const am = new AgentManager({ projectStore: ps, onEvent: () => {}, spawnFn: mockSpawn });
  const c1 = await am.ensureStarted(p1.id, "dev");
  const c2 = await am.ensureStarted(p2.id, "dev");
  expect(c1).not.toBe(c2);
  await am.disposeAll();
  rmSync(f, { force: true });
});

test("onEvent 携带正确 key", async () => {
  const f = tempProjectFile();
  const ps = new ProjectStore(f);
  const p = await ps.createProject({ name: "P", cwd: "/p" });
  const seen: string[] = [];
  const am = new AgentManager({
    projectStore: ps,
    onEvent: (key) => seen.push(key),
    spawnFn: mockSpawn,
  });
  await am.ensureStarted(p.id, "dev");
  expect(seen).toContain(`${p.id}:dev`);
  await am.disposeAll();
  rmSync(f, { force: true });
});
